import { type Compiled, Compiler, PolicyInvalid } from "@gauntlet/dsl"
import type { Mode } from "@gauntlet/ir"
import { Context, Data, Effect, FileSystem, Layer, Option, Path } from "effect"
import { Git, type GitFailure } from "./git.ts"

export const GAUNTLET_DIR = ".gauntlet"
export const POLICY_PATH = ".gauntlet/policy.gx"

/** A difference between the working copy's `.gauntlet/` and the base ref's. */
export interface Drift {
  readonly path: string
  readonly change: "added" | "modified" | "deleted"
}

export interface LoadedPolicy {
  readonly compiled: Compiled
  readonly text: string
  /** Where the policy text came from. In CI this is always `base` unless the base has no policy yet. */
  readonly origin: "base" | "working-copy"
  /** The commit the policy was loaded from or compared against, when there is one. */
  readonly baseSha: Option.Option<string>
  /** `.gauntlet/` differences between the working copy and the base. */
  readonly drift: ReadonlyArray<Drift>
  /** The base has no policy, so this change adopts Gauntlet; it always runs in shadow mode. */
  readonly firstAdoption: boolean
  /** The mode to run in. Differs from the IR's mode only on first adoption. */
  readonly effectiveMode: Mode
  /** Things the user should know about how the policy was chosen. */
  readonly notes: ReadonlyArray<string>
}

export class PolicyNotFound extends Data.TaggedError("PolicyNotFound")<{ readonly repo: string; readonly looked: ReadonlyArray<string> }> {}
export class BaseRefNotFound extends Data.TaggedError("BaseRefNotFound")<{ readonly ref: string }> {}

export interface LoadRequest {
  readonly repo: string
  /** CI: load policy from this ref (the PR base). Never from the head. */
  readonly policyRef?: string
  /** Local: compare the working copy with this ref. Defaults to the merge base with the default branch. */
  readonly baseRef?: string
}

/** Chooses, loads and compiles the policy that judges a change (ADR 0003). */
export class PolicySource extends Context.Service<PolicySource, {
  readonly load: (request: LoadRequest) => Effect.Effect<LoadedPolicy, PolicyInvalid | PolicyNotFound | BaseRefNotFound | GitFailure>
}>()("@gauntlet/core/PolicySource") {}

const DEFAULT_BRANCHES = ["origin/HEAD", "origin/main", "origin/master", "main", "master"]

export const PolicySourceLive = Layer.effect(
  PolicySource,
  Effect.gen(function*() {
    const git = yield* Git
    const compiler = yield* Compiler
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const readWorking = (repo: string, file: string) =>
      fs.readFileString(path.join(repo, file)).pipe(Effect.option)

    const defaultBase = (repo: string) =>
      Effect.gen(function*() {
        for (const branch of DEFAULT_BRANCHES) {
          const sha = yield* git.resolve(repo, branch)
          if (Option.isSome(sha)) return Option.some(yield* git.mergeBase(repo, "HEAD", sha.value))
        }
        return Option.none<string>()
      })

    const driftAgainst = (repo: string, base: string) =>
      Effect.gen(function*() {
        const baseBlobs = yield* git.blobIds(repo, base, GAUNTLET_DIR)
        const working = (yield* git.listWorkingFiles(repo)).filter((f) => f.startsWith(`${GAUNTLET_DIR}/`))
        const drift: Drift[] = []
        for (const file of working) {
          const id = yield* git.hashWorkingFile(repo, file)
          const baseId = baseBlobs.get(file)
          if (baseId === undefined) drift.push({ path: file, change: "added" })
          else if (Option.isSome(id) && id.value !== baseId) drift.push({ path: file, change: "modified" })
        }
        for (const file of baseBlobs.keys()) if (!working.includes(file)) drift.push({ path: file, change: "deleted" })
        return drift.sort((a, b) => (a.path < b.path ? -1 : 1))
      })

    const compile = (text: string, files: ReadonlyArray<string>) => compiler.compile({ file: POLICY_PATH, text, files })

    return {
      load: (request: LoadRequest) =>
        Effect.gen(function*() {
          const { repo } = request
          const working = yield* readWorking(repo, POLICY_PATH)

          if (request.policyRef !== undefined) {
            const baseSha = yield* git.resolve(repo, request.policyRef)
            if (Option.isNone(baseSha)) return yield* new BaseRefNotFound({ ref: request.policyRef })
            const base = baseSha.value
            const drift = yield* driftAgainst(repo, base)
            const baseText = yield* git.show(repo, base, POLICY_PATH)
            if (Option.isSome(baseText)) {
              const compiled = yield* compile(baseText.value, yield* git.listTree(repo, base))
              const notes = drift.length > 0
                ? [`This change edits ${GAUNTLET_DIR}/; it is judged by the policy at ${base.slice(0, 12)} and the edit nominates owner.`]
                : []
              return { compiled, text: baseText.value, origin: "base" as const, baseSha, drift, firstAdoption: false, effectiveMode: compiled.ir.mode, notes }
            }
            // First adoption: the base has no policy yet, so the change's own policy is used, in shadow mode.
            if (Option.isNone(working)) return yield* new PolicyNotFound({ repo, looked: [`${base}:${POLICY_PATH}`, POLICY_PATH] })
            const compiled = yield* compile(working.value, yield* git.listWorkingFiles(repo))
            return {
              compiled, text: working.value, origin: "working-copy" as const, baseSha, drift, firstAdoption: true, effectiveMode: "shadow" as const,
              notes: [`${base.slice(0, 12)} has no ${POLICY_PATH}, so this change adopts Gauntlet. Its own policy is used, in shadow mode.`],
            }
          }

          // Local: the working copy's policy, with a clear note when it differs from the base.
          const baseSha = request.baseRef !== undefined
            ? yield* git.resolve(repo, request.baseRef).pipe(
              Effect.flatMap((sha) => Option.isSome(sha) ? Effect.succeed(sha) : Effect.fail(new BaseRefNotFound({ ref: request.baseRef! }))),
            )
            : yield* defaultBase(repo)
          const drift = Option.isSome(baseSha) ? yield* driftAgainst(repo, baseSha.value) : []
          const notes: string[] = []
          let text: string
          let origin: "base" | "working-copy" = "working-copy"
          if (Option.isSome(working)) {
            text = working.value
          } else {
            const baseText = Option.isSome(baseSha) ? yield* git.show(repo, baseSha.value, POLICY_PATH) : Option.none<string>()
            if (Option.isNone(baseText)) return yield* new PolicyNotFound({ repo, looked: [POLICY_PATH] })
            text = baseText.value
            origin = "base"
            notes.push(`${POLICY_PATH} is missing from the working copy, so the base's policy is used.`)
          }
          if (Option.isNone(baseSha)) {
            notes.push("No base branch was found, so differences from the base policy were not checked. Pass --base <ref> to compare.")
          } else if (drift.length > 0) {
            notes.push(
              `Using the working copy's ${GAUNTLET_DIR}/, which differs from ${baseSha.value.slice(0, 12)} (${drift.map((d) => `${d.change} ${d.path}`).join(", ")}). CI judges with the base policy; pass --policy-ref ${baseSha.value.slice(0, 12)} to reproduce that.`,
            )
          }
          const compiled = yield* compile(text, yield* git.listWorkingFiles(repo))
          return { compiled, text, origin, baseSha, drift, firstAdoption: false, effectiveMode: compiled.ir.mode, notes }
        }),
    }
  }),
)

import { globMatches } from "@gauntlet/dsl"
import type { ProtectGroup, ProtectKind } from "@gauntlet/ir"
import { Context, Data, Effect, FileSystem, Layer, Path, type PlatformError, Scope } from "effect"
import { type ChangeStatus, Git, type GitFailure } from "./git.ts"

// The judged checkout (ADR 0003, PLAN section 9). Gates never run in the
// user's working tree: they run in a fresh worktree at head, with protected
// files and runner config put back to their base content first. Tool output
// goes to directories Gauntlet creates outside that tree (ADR 0012).

/** What happened to one changed protected file before gates ran. */
export interface Materialised {
  readonly path: string
  readonly group: string
  readonly kind: ProtectKind | "runner-config"
  readonly change: ChangeStatus
  /** restored: base content put back. removed: head-only file taken out. kept: head file left to run. */
  readonly action: "restored" | "removed" | "kept"
}

export interface OutputFile {
  readonly path: string
  readonly content: string
}

export interface PreparedWorkspace {
  readonly dir: string
  readonly base: string
  readonly head: string
  readonly materialised: ReadonlyArray<Materialised>
  /** A new, empty directory for one check's output, outside the checkout. Each check gets one. */
  readonly outputDir: (check: string) => Effect.Effect<string, OutputDirUnavailable>
  /** Regular files written into a check's output directory. Nothing else is ever read as evidence. */
  readonly collect: (check: string) => Effect.Effect<ReadonlyArray<OutputFile>, OutputDirUnavailable>
}

export class OutputDirUnavailable extends Data.TaggedError("OutputDirUnavailable")<{ readonly check: string; readonly reason: string }> {}

export interface PrepareRequest {
  readonly repo: string
  readonly base: string
  readonly head: string
  readonly protect: ReadonlyArray<ProtectGroup>
  readonly runnerConfig: ReadonlyArray<string>
}

export class Workspace extends Context.Service<Workspace, {
  readonly prepare: (request: PrepareRequest) => Effect.Effect<PreparedWorkspace, GitFailure | PlatformError.PlatformError, Scope.Scope>
}>()("@gauntlet/core/Workspace") {}

// Stricter kinds win when a path matches more than one group.
const RANK: Record<Materialised["kind"], number> = { gauntlet: 3, config: 2, fixtures: 2, other: 2, "runner-config": 2, tests: 1 }

interface Protection {
  readonly group: string
  readonly kind: Materialised["kind"]
}

export const protectionFor = (path: string, protect: ReadonlyArray<ProtectGroup>, runnerConfig: ReadonlyArray<string>): Protection | undefined => {
  const hits: Protection[] = [
    ...protect.filter((g) => g.globs.some((glob) => globMatches(glob, path))).map((g) => ({ group: g.group, kind: g.kind })),
    ...(runnerConfig.some((glob) => globMatches(glob, path)) ? [{ group: "runner-config", kind: "runner-config" as const }] : []),
  ]
  return hits.sort((a, b) => RANK[b.kind] - RANK[a.kind] || (a.group < b.group ? -1 : 1))[0]
}

/**
 * Decides what to do with each changed protected path. New files in a `tests`
 * group run; every other head-side change to protected content is undone.
 */
export const planMaterialisation = (
  changes: ReadonlyArray<{ readonly status: ChangeStatus; readonly path: string; readonly oldPath?: string }>,
  protect: ReadonlyArray<ProtectGroup>,
  runnerConfig: ReadonlyArray<string>,
): Materialised[] => {
  const out: Materialised[] = []
  const at = (path: string) => protectionFor(path, protect, runnerConfig)
  for (const c of changes) {
    if (c.status === "renamed" && c.oldPath !== undefined) {
      const from = at(c.oldPath)
      const to = at(c.path)
      // A rename is a delete plus an add. When protected content moves, the
      // base file comes back and the moved copy goes, so nothing runs twice.
      if (from) out.push({ path: c.oldPath, ...from, change: "renamed", action: "restored" })
      if (to) out.push({ path: c.path, ...to, change: "renamed", action: from || to.kind !== "tests" ? "removed" : "kept" })
      continue
    }
    const p = at(c.path)
    if (!p) continue
    const action = c.status === "added" ? (p.kind === "tests" ? "kept" : "removed") : "restored"
    out.push({ path: c.path, ...p, change: c.status, action })
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

const CHECK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export const WorkspaceLive = Layer.effect(
  Workspace,
  Effect.gen(function*() {
    const git = yield* Git
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    return {
      prepare: (request: PrepareRequest) =>
        Effect.gen(function*() {
          // The real path, so it matches what tools report (on macOS /var is a symlink to /private/var).
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "gauntlet-" }).pipe(Effect.flatMap((dir) => fs.realPath(dir)))
          const dir = path.join(root, "checkout")
          const outputs = path.join(root, "outputs")
          yield* fs.makeDirectory(outputs)
          yield* Effect.acquireRelease(
            git.addWorktree(request.repo, dir, request.head),
            () => git.removeWorktree(request.repo, dir).pipe(Effect.ignore),
          )

          const changes = yield* git.diff(request.repo, request.base, request.head)
          const materialised = planMaterialisation(changes, request.protect, request.runnerConfig)
          yield* git.restore(dir, request.base, materialised.filter((m) => m.action === "restored").map((m) => m.path))
          for (const m of materialised) {
            if (m.action === "removed") yield* fs.remove(path.join(dir, m.path), { force: true })
          }

          const checkDir = (check: string) =>
            CHECK_NAME.test(check)
              ? Effect.succeed(path.join(outputs, check))
              : Effect.fail(new OutputDirUnavailable({ check, reason: "check names use letters, digits, '.', '_' and '-'" }))

          const outputDir = (check: string) =>
            Effect.gen(function*() {
              const target = yield* checkDir(check)
              const taken = yield* fs.exists(target).pipe(Effect.orElseSucceed(() => true))
              if (taken) return yield* new OutputDirUnavailable({ check, reason: "this check already has an output directory" })
              yield* fs.makeDirectory(target).pipe(
                Effect.mapError((e) => new OutputDirUnavailable({ check, reason: String(e) })),
              )
              return target
            })

          const collect = (check: string) =>
            Effect.gen(function*() {
              const target = yield* checkDir(check)
              const exists = yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false))
              if (!exists) return yield* new OutputDirUnavailable({ check, reason: "no output directory was created for this check" })
              const entries = yield* fs.readDirectory(target, { recursive: true })
              const files: OutputFile[] = []
              for (const entry of [...entries].sort()) {
                const full = path.join(target, entry)
                // Only regular files: a symlink could point back into the checkout.
                const info = yield* fs.stat(full)
                const link = yield* fs.readLink(full).pipe(Effect.option)
                if (info.type !== "File" || link._tag === "Some") continue
                files.push({ path: entry, content: yield* fs.readFileString(full) })
              }
              return files
            }).pipe(Effect.mapError((e) => e._tag === "OutputDirUnavailable" ? e : new OutputDirUnavailable({ check, reason: String(e) })))

          return { dir, base: request.base, head: request.head, materialised, outputDir, collect }
        }),
    }
  }),
)

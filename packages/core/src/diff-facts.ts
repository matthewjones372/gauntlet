import { globMatches } from "@gauntlet/dsl"
import type { PolicyIR, ProtectKind } from "@gauntlet/ir"
import { Effect, Option } from "effect"
import { type AddedLine, type ChangeStatus, type FileChange, Git, type GitFailure, type LineCount } from "./git.ts"
import type { Pack } from "./pack-registry.ts"
import { BASELINE_PATH } from "./baseline-store.ts"
import { GAUNTLET_DIR, POLICY_PATH } from "./policy-source.ts"
import { holdoutsOf, planMaterialisation } from "./workspace.ts"

// What a change did, as facts the review policy and integrity checks read.
// Everything here comes from git and the policy IR; nothing is probabilistic.

export interface ChangedFile {
  readonly path: string
  readonly status: ChangeStatus
  readonly oldPath?: string
  readonly added: number
  readonly removed: number
}

export interface ProtectedTouch {
  readonly path: string
  readonly group: string
  readonly kind: ProtectKind | "runner-config"
  readonly change: ChangeStatus
  /** What the workspace does with it: undo the change, or let a new test run. */
  readonly action: "restored" | "removed" | "kept"
}

export interface ZoneTouch {
  readonly zone: string
  readonly files: ReadonlyArray<string>
  readonly owners: ReadonlyArray<string>
}

export interface DependencyChange {
  readonly manifest: string
  readonly added: ReadonlyArray<string>
  readonly removed: ReadonlyArray<string>
  /** No parser for this manifest: lines were added, so a dependency may have been. */
  readonly unparsed: boolean
}

export interface DiffFacts {
  readonly base: string
  readonly head: string
  readonly files: ReadonlyArray<ChangedFile>
  readonly linesChanged: number
  readonly protectedTouched: ReadonlyArray<ProtectedTouch>
  readonly zonesTouched: ReadonlyArray<ZoneTouch>
  readonly dependencyChanges: ReadonlyArray<DependencyChange>
  readonly budgetsChanged: ReadonlyArray<string>
  readonly policyChanged: boolean
  readonly baselineChanged: boolean
  /** Any change under `.gauntlet/`, which always nominates owner. */
  readonly gauntletChanged: boolean
  /** Lines added at head, per path, for the integrity checks. */
  readonly addedLines: ReadonlyMap<string, ReadonlyArray<AddedLine>>
}

export interface FactsInput {
  readonly base: string
  readonly head: string
  readonly changes: ReadonlyArray<FileChange>
  readonly lineCounts: ReadonlyMap<string, LineCount>
  readonly addedLines: ReadonlyMap<string, ReadonlyArray<AddedLine>>
  readonly ir: PolicyIR
  readonly runnerConfig: ReadonlyArray<string>
  readonly dependencyChanges: ReadonlyArray<DependencyChange>
}

const touched = (c: FileChange) => [c.path, ...(c.oldPath !== undefined ? [c.oldPath] : [])]

/** The pure part: facts from a diff that has already been read. */
export const computeFacts = (input: FactsInput): DiffFacts => {
  const { ir, changes } = input
  const files = changes.map((c): ChangedFile => ({
    path: c.path,
    status: c.status,
    ...(c.oldPath !== undefined ? { oldPath: c.oldPath } : {}),
    ...(input.lineCounts.get(c.path) ?? { added: 0, removed: 0 }),
  }))
  const zonesTouched = ir.zones.flatMap((z): ZoneTouch[] => {
    const hit = changes.flatMap(touched).filter((p) => z.globs.some((g) => globMatches(g, p)))
    return hit.length > 0 ? [{ zone: z.name, files: [...new Set(hit)].sort(), owners: z.owners }] : []
  })
  const budgetsChanged = ir.budgets
    .filter((b) => {
      const script = b.command.split(/\s+/)[0]?.replace(/^\.\//, "")
      return script !== undefined && changes.some((c) => touched(c).includes(script))
    })
    .map((b) => b.name)
  const paths = changes.flatMap(touched)
  return {
    base: input.base,
    head: input.head,
    files,
    linesChanged: files.reduce((n, f) => n + f.added + f.removed, 0),
    protectedTouched: planMaterialisation(changes, ir.protect, input.runnerConfig, holdoutsOf(ir)),
    zonesTouched,
    dependencyChanges: input.dependencyChanges,
    budgetsChanged,
    policyChanged: paths.includes(POLICY_PATH),
    baselineChanged: paths.includes(BASELINE_PATH),
    gauntletChanged: paths.some((p) => p.startsWith(`${GAUNTLET_DIR}/`)),
    addedLines: input.addedLines,
  }
}

const sortedDiff = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => [...new Set(a.filter((x) => !b.includes(x)))].sort()

/**
 * Dependency changes in the manifests the used packs declare. A pack that can
 * parse a manifest reports real additions; otherwise any added line in a
 * manifest is treated as a possible new dependency, which only raises caution.
 */
export const dependencyChanges = (repo: string, base: string, head: string, changes: ReadonlyArray<FileChange>, packs: ReadonlyArray<Pack>, addedLines: ReadonlyMap<string, ReadonlyArray<AddedLine>>) =>
  Effect.gen(function*() {
    const git = yield* Git
    const out: DependencyChange[] = []
    for (const c of changes) {
      const pack = packs.find((p) => p.manifests.some((g) => globMatches(g, c.path)))
      if (!pack) continue
      if (!pack.dependencies) {
        if ((addedLines.get(c.path) ?? []).some((l) => l.text.trim() !== "")) out.push({ manifest: c.path, added: [], removed: [], unparsed: true })
        continue
      }
      const before = c.status === "added" ? Option.none<string>() : yield* git.show(repo, base, c.oldPath ?? c.path)
      const after = c.status === "deleted" ? Option.none<string>() : yield* git.show(repo, head, c.path)
      const was = Option.match(before, { onNone: () => [], onSome: (t) => pack.dependencies!(c.oldPath ?? c.path, t) })
      const now = Option.match(after, { onNone: () => [], onSome: (t) => pack.dependencies!(c.path, t) })
      const added = sortedDiff(now, was)
      const removed = sortedDiff(was, now)
      if (added.length > 0 || removed.length > 0) out.push({ manifest: c.path, added, removed, unparsed: false })
    }
    return out
  })

/** Reads the diff between two commits and computes its facts. */
export const diffFacts = (repo: string, base: string, head: string, ir: PolicyIR, packs: ReadonlyArray<Pack>, runnerConfig: ReadonlyArray<string>): Effect.Effect<DiffFacts, GitFailure, Git> =>
  Effect.gen(function*() {
    const git = yield* Git
    const changes = yield* git.diff(repo, base, head)
    const lineCounts = yield* git.lineCounts(repo, base, head)
    const added = yield* git.addedLines(repo, base, head)
    const used = packs.filter((p) => ir.packs.includes(p.spec.name))
    const deps = yield* dependencyChanges(repo, base, head, changes, used, added)
    return computeFacts({ base, head, changes, lineCounts, addedLines: added, ir, runnerConfig, dependencyChanges: deps })
  })

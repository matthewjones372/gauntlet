import { globMatches } from "@gauntlet/dsl"
import type { PolicyIR, ProtectGroup } from "@gauntlet/ir"
import type { TestMap } from "@gauntlet/sarif"
import { buildsOf, fromBuild, hasBuilds, ownerDir } from "./builds.ts"
import type { DependencyChange, DiffFacts } from "./diff-facts.ts"
import type { ChangeStatus } from "./git.ts"
import type { Pack } from "./pack-registry.ts"

// Running the tests a change affects (spec 0013). `gauntlet baseline` records,
// per test class, the files it executed. A check of an `affected` suite runs
// the classes that executed a file the change touches, and the test files it
// adds. The change is everything that differs from the commit the map was
// recorded at, not just from the base: what reached trunk since could have
// changed what a test executes. Whatever the map can't vouch for runs
// everything, as before.

export interface SelectionInput {
  /** The baseline's map, or undefined when it has none. */
  readonly map: TestMap | undefined
  /** Files changed between the map's commit and the judged head; undefined when they couldn't be read. */
  readonly changes: ReadonlyArray<{ readonly path: string; readonly status: ChangeStatus; readonly oldPath?: string }> | undefined
  /** The build's folder ("." for one at the root). */
  readonly dir: string
  readonly buildDirs: ReadonlyArray<string>
  /** The policy names build folders, so the map's classes start "<folder>:" (ADR 0022). */
  readonly prefixed: boolean
  /** The suite's location, from the repository's root. */
  readonly location: string
  readonly isTestPath: (path: string) => boolean
  readonly protect: ReadonlyArray<ProtectGroup>
  /** The build's configuration files, from the repository's root: the pack's manifests and runner configuration. */
  readonly buildConfig: ReadonlyArray<string>
  readonly dependencyChanges: ReadonlyArray<DependencyChange>
}

export type Selection =
  | { readonly kind: "all"; readonly reason: string }
  | {
    readonly kind: "some"
    /** Test classes to run, as the build names them (without its folder). */
    readonly classes: ReadonlyArray<string>
    /** Test files the change adds, which the map can't know: they run by file. */
    readonly files: ReadonlyArray<string>
    /** The map's classes left out, as the map names them. */
    readonly deselected: ReadonlyArray<string>
  }

/** Never executed by a test, so editing it can't change what one does: documentation, and Gauntlet's own policy and baseline. */
const NOT_RUN = /\.(md|markdown|adoc|rst)$|^\.gauntlet\//i

export const selectTests = (input: SelectionInput): Selection => {
  const prefix = input.prefixed ? `${input.dir}:` : ""
  const classes = Object.entries(input.map ?? {}).filter(([name]) => name.startsWith(prefix))
  if (classes.length === 0) return { kind: "all", reason: "the baseline has no map of what this build's tests execute (gauntlet baseline records one)" }
  if (input.changes === undefined) return { kind: "all", reason: "the commit the map was recorded at couldn't be compared with this one" }

  const mine = (p: string) => ownerDir(input.buildDirs, p) === input.dir
  const changes = input.changes.filter((c) => mine(c.path) || (c.oldPath !== undefined && mine(c.oldPath)))
  const paths = (c: (typeof changes)[number]) => [c.path, ...(c.oldPath !== undefined ? [c.oldPath] : [])].filter(mine)
  for (const p of changes.flatMap(paths)) {
    const group = input.protect.find((g) => g.kind !== "tests" && g.kind !== "gauntlet" && g.globs.some((glob) => globMatches(glob, p)))
    if (group) return { kind: "all", reason: `the change touches ${p} (${group.kind}), which every test may depend on` }
    if (input.buildConfig.some((glob) => globMatches(glob, p))) return { kind: "all", reason: `the change touches ${p}, the build's configuration` }
  }
  const dependency = input.dependencyChanges.find((d) => mine(d.manifest) && (d.added.length > 0 || d.unparsed))
  if (dependency) return { kind: "all", reason: `the change adds a dependency in ${dependency.manifest}` }

  const users = new Map<string, string[]>()
  for (const [name, files] of classes) for (const f of files) users.set(f, [...(users.get(f) ?? []), name])
  const selected = new Set<string>()
  const files: string[] = []
  for (const c of changes) {
    if (NOT_RUN.test(c.path)) continue
    const known = paths(c).flatMap((p) => users.get(p) ?? [])
    if (known.length > 0) {
      known.forEach((n) => selected.add(n))
      continue
    }
    if (input.isTestPath(c.path)) {
      // A deleted test file is in the diff, where integrity sees it; a new one runs by its file.
      if (c.status === "deleted" || !globMatches(input.location, c.path)) continue
      if (c.status === "added" || c.status === "renamed") {
        files.push(c.path)
        continue
      }
      return { kind: "all", reason: `the change edits ${c.path}, a test file the map doesn't know` }
    }
    return { kind: "all", reason: `the change ${c.status === "added" ? "adds" : "touches"} ${c.path}, which no test executed when the map was recorded` }
  }
  if (selected.size === 0 && files.length === 0) return { kind: "all", reason: "the change touches nothing the map knows of in this build" }
  return {
    kind: "some",
    classes: [...selected].map((n) => n.slice(prefix.length)).sort(),
    files: [...new Set(files)].sort(),
    deselected: classes.map(([name]) => name).filter((n) => !selected.has(n)).sort(),
  }
}

/** The base's test ids that belong to classes selection left out (a nested class's tests, `Outer$Inner.x`, belong to `Outer`). */
export const excusedBySelection = (baseIds: ReadonlyArray<string>, deselected: ReadonlyArray<string>): string[] => {
  if (deselected.length === 0) return []
  const left = new Set(deselected)
  return baseIds.filter((id) => {
    for (let i = id.indexOf("."); i >= 0; i = id.indexOf(".", i + 1)) if (left.has(id.slice(0, i).replace(/\$.*$/, ""))) return true
    return false
  })
}

/** Each \`affected\` suite's selection, by suite name and then build folder. */
export type SuiteSelections = ReadonlyMap<string, ReadonlyMap<string, Selection>>

/**
 * What each \`affected\` suite runs in each build, for a check (never while
 * recording a baseline). The same inputs give the same selections, so the
 * trusted half of the GitHub workflow works them out again for itself.
 */
export const suiteSelections = (input: {
  readonly ir: PolicyIR
  readonly packs: ReadonlyArray<Pack>
  readonly facts: Pick<DiffFacts, "base" | "head" | "dependencyChanges">
  readonly map: TestMap | undefined
  readonly changes: SelectionInput["changes"]
  readonly isTestPath: (path: string) => boolean
}): SuiteSelections => {
  const out = new Map<string, Map<string, Selection>>()
  const builds = buildsOf(input.ir)
  const buildDirs = [...new Set(builds.map((b) => b.dir))]
  // Coverage of the whole project needs every test; coverage of the changed lines needs only the tests that run them.
  const wholeCoverage = input.ir.gates.some((t) => t.checks.some((c) => c.kind === "gate" && c.name === "coverage" && c.scope !== "changed"))
  for (const suite of input.ir.suites) {
    if (suite.kind !== "suite" || suite.affected !== true) continue
    const mine = new Map<string, Selection>()
    for (const build of builds) {
      const pack = input.packs.find((p) => p.spec.name === build.pack)
      if (!pack?.runSuite) continue
      mine.set(build.dir, input.facts.base === input.facts.head
        ? { kind: "all", reason: "the check runs on trunk" }
        : wholeCoverage
        ? { kind: "all", reason: "the policy measures coverage of the whole project, which needs every test" }
        : !pack.testMaps || !pack.reruns
        ? { kind: "all", reason: `the ${pack.spec.name} pack can't run part of a suite by test class` }
        : selectTests({
          map: input.map,
          changes: input.changes,
          dir: build.dir,
          buildDirs,
          prefixed: hasBuilds(input.ir),
          location: suite.location,
          isTestPath: input.isTestPath,
          protect: input.ir.protect,
          buildConfig: [...pack.manifests, ...pack.runnerConfig].map((g) => fromBuild(build.dir, g)),
          dependencyChanges: input.facts.dependencyChanges,
        }))
    }
    out.set(suite.name, mine)
  }
  return out
}

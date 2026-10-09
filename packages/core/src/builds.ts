import { type Build, type PolicyIR, sha256 } from "@gauntlet/ir"
import type { Metric, Run } from "@gauntlet/sarif"
import type { DiffFacts } from "./diff-facts.ts"
import type { GateRun } from "./gate.ts"

// Several builds in one repository (ADR 0022): `use jvm in "lark-bank", scala
// in "bank-checks"`. A pack runs each of its builds in that build's folder and
// sees paths from there, as if the build were the whole repository. Gauntlet
// turns what comes back into paths from the repository's root and merges the
// builds into one result per check, so the baseline, ratchets, review rules
// and reports work as they do for one build.

/** Every build the policy runs: its own list, or each pack at the root. */
export const buildsOf = (ir: Pick<PolicyIR, "packs" | "builds">): ReadonlyArray<Build> => ir.builds ?? ir.packs.map((pack) => ({ pack, dir: "." }))

/** Whether the policy names build folders (otherwise every pack runs at the root, as before). */
export const hasBuilds = (ir: Pick<PolicyIR, "builds">): boolean => ir.builds !== undefined

const holds = (dir: string, path: string) => dir === "." || path.startsWith(`${dir}/`)
const depth = (dir: string) => (dir === "." ? 0 : dir.split("/").length)

/**
 * The folder of the build a path belongs to: the deepest build folder that
 * holds it, so a build included in another (Gradle's `includeBuild("events")`)
 * owns its own files. Undefined when no build holds the path.
 */
export const ownerDir = (dirs: ReadonlyArray<string>, path: string): string | undefined =>
  dirs.filter((d) => holds(d, path)).sort((a, b) => depth(b) - depth(a))[0]

export const toBuild = (dir: string, path: string) => (dir === "." ? path : path.slice(dir.length + 1))
export const fromBuild = (dir: string, path: string) => (dir === "." ? path : `${dir}/${path}`)

/** The paths a build owns, as the build sees them. */
export const ownedBy = (dirs: ReadonlyArray<string>, dir: string, paths: ReadonlyArray<string>): string[] =>
  paths.filter((p) => ownerDir(dirs, p) === dir).map((p) => toBuild(dir, p))

/** The diff as one build sees it: only its files, with paths from its folder. */
export const factsForBuild = (facts: DiffFacts, dirs: ReadonlyArray<string>, dir: string): DiffFacts => {
  if (dir === "." && dirs.length === 1) return facts
  const mine = (p: string) => ownerDir(dirs, p) === dir
  return {
    ...facts,
    files: facts.files.filter((f) => mine(f.path)).map((f) => ({
      ...f,
      path: toBuild(dir, f.path),
      ...(f.oldPath !== undefined ? { oldPath: mine(f.oldPath) ? toBuild(dir, f.oldPath) : f.oldPath } : {}),
    })),
    addedLines: new Map([...facts.addedLines].filter(([p]) => mine(p)).map(([p, lines]) => [toBuild(dir, p), lines])),
  }
}

const ABSOLUTE = /^([a-z][a-z0-9+.-]*:|\/)/i

/** A build's results with paths from the repository's root. */
export const runFromBuild = (run: GateRun, dir: string): GateRun => {
  if (dir === ".") return run
  const uri = (u: string) => (ABSOLUTE.test(u) ? u : fromBuild(dir, u))
  const runs = run.runs.map((r): Run => ({
    ...r,
    results: r.results.map((x) => ({
      ...x,
      ...(x.locations
        ? {
          locations: x.locations.map((l) => {
            const a = l.physicalLocation?.artifactLocation
            return a?.uri !== undefined ? { ...l, physicalLocation: { ...l.physicalLocation, artifactLocation: { ...a, uri: uri(a.uri) } } } : l
          }),
        }
        : {}),
    })),
  }))
  const metrics = run.metrics === undefined ? undefined : Object.fromEntries(Object.entries(run.metrics).map(([name, m]): [string, Metric] => [
    name,
    m.perFile ? { ...m, perFile: Object.fromEntries(Object.entries(m.perFile).map(([p, v]) => [fromBuild(dir, p), v])) } : m,
  ]))
  return { ...run, runs, ...(metrics ? { metrics } : {}) }
}

/**
 * One result from several builds. A build with nothing in scope is left out.
 * A metric takes the worst build's value, so a floor holds for every build;
 * per-file values are kept for each file.
 */
export const mergeBuildRuns = (parts: ReadonlyArray<{ readonly dir: string; readonly run: GateRun }>): GateRun => {
  const ran = parts.filter((p) => p.run.nothingInScope === undefined)
  if (ran.length === 0) {
    return { command: [], exitCode: 0, runs: [], nothingInScope: parts.length === 0 ? "the change touches none of the builds" : [...new Set(parts.map((p) => p.run.nothingInScope!))].join("; ") }
  }
  const errored = ran.find((p) => p.run.error !== undefined)
  const command = ran.flatMap((p) => [`[${p.dir}]`, ...p.run.command])
  const exitCode = ran.find((p) => p.run.exitCode !== 0)?.run.exitCode ?? 0
  const tested = ran.flatMap((p) => (p.run.tests ? [p.run.tests] : []))
  const tests = tested.length === 0 ? undefined : {
    counts: tested.reduce((a, t) => ({
      executed: a.executed + t.counts.executed,
      passed: a.passed + t.counts.passed,
      failed: a.failed + t.counts.failed,
      errored: a.errored + t.counts.errored,
      skipped: a.skipped + t.counts.skipped,
    }), { executed: 0, passed: 0, failed: 0, errored: 0, skipped: 0 }),
    ids: [...new Set(tested.flatMap((t) => t.ids))].sort(),
  }
  const metrics: Record<string, Metric> = {}
  for (const p of ran) {
    for (const [name, m] of Object.entries(p.run.metrics ?? {})) {
      const seen = metrics[name]
      if (!seen) {
        metrics[name] = m
        continue
      }
      const worse = m.higherIsBetter ? Math.min(seen.value, m.value) : Math.max(seen.value, m.value)
      const perFile = seen.perFile || m.perFile ? { ...seen.perFile, ...m.perFile } : undefined
      metrics[name] = { ...seen, value: worse, ...(perFile ? { perFile } : {}) }
    }
  }
  return {
    command,
    exitCode,
    runs: ran.flatMap((p) => p.run.runs),
    ...(tests ? { tests } : {}),
    ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
    ...(errored ? { error: `${errored.dir}: ${errored.run.error}` } : {}),
  }
}

/** Runner configuration globs from the repository's root: each build's, under its folder. */
export const runnerConfigForBuilds = (builds: ReadonlyArray<Build>, runnerConfigOf: (pack: string) => ReadonlyArray<string>): string[] =>
  [...new Set(builds.flatMap((b) => runnerConfigOf(b.pack).map((g) => fromBuild(b.dir, g))))].sort()

/**
 * The name of a build's output directories: one per build, shared by its
 * checks. The folder's hash keeps "a/b" and "a-b" apart.
 */
export const buildSlug = (dir: string) => `build-${dir === "." ? "root" : `${dir.replace(/[^A-Za-z0-9._-]+/g, "-")}-${sha256(dir).slice(0, 8)}`}`

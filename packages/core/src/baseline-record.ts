import type { PolicyIR } from "@gauntlet/ir"
import type { Metric, Result } from "@gauntlet/sarif"
import { Effect, Option } from "effect"
import { computeFacts } from "./diff-facts.ts"
import { runGates } from "./gate-runner.ts"
import { Git } from "./git.ts"
import { runImports } from "./imports.ts"
import { runIntegrity, testPathMatcher } from "./integrity.ts"
import { PackRegistry, runnerConfigFor } from "./pack-registry.ts"
import type { CheckRecord } from "./report/build.ts"
import { Workspace } from "./workspace.ts"

// `gauntlet baseline`: run every gate over the whole project at a trunk
// commit and record what it found, so later changes are compared with it.

export interface RecordedBaseline {
  readonly metrics: Readonly<Record<string, Metric>>
  /** Findings to grandfather, keyed by tool. */
  readonly results: Readonly<Record<string, ReadonlyArray<Result>>>
  readonly testIds: ReadonlyArray<string>
  /** Every check, so the user can see what wasn't recorded. */
  readonly checks: ReadonlyArray<CheckRecord>
}

export const recordBaseline = (repo: string, commit: string, ir: PolicyIR) =>
  Effect.gen(function*() {
    const git = yield* Git
    const registry = yield* PackRegistry
    const used = registry.packs.filter((p) => ir.packs.includes(p.spec.name))
    const runnerConfig = runnerConfigFor(registry.packs, ir.packs)
    const facts = computeFacts({ base: commit, head: commit, changes: [], lineCounts: new Map(), addedLines: new Map(), ir, runnerConfig, dependencyChanges: [] })
    const violationGates = new Set(used.flatMap((p) => p.spec.gates.filter((g) => g.produces === "violations").map((g) => g.name)))
    const metricGates = new Set(used.flatMap((p) => p.spec.gates.filter((g) => g.produces === "metric").map((g) => g.name)))

    return yield* Effect.scoped(Effect.gen(function*() {
      const workspace = yield* (yield* Workspace).prepare({ repo, base: commit, head: commit, protect: ir.protect, runnerConfig })
      const files = yield* git.listWorkingFiles(workspace.dir)
      const gates = yield* runGates({ ir, facts, workspace, packs: used, baseline: Option.none(), renames: new Map(), recording: true, files })
      const imports = yield* runImports(ir, workspace, Option.none(), new Map())
      const isTestPath = testPathMatcher(ir)
      const read = (path: string) => git.show(repo, commit, path).pipe(Effect.orElseSucceed(() => Option.none<string>()))
      const integrity = yield* runIntegrity({
        ir, facts, readBase: read, readHead: read, isTestPath, baselineMetrics: {},
        ...(gates.tests ? { headTests: gates.tests } : {}),
        headFiles: yield* git.listTree(repo, commit),
        dir: workspace.dir,
      }, used.flatMap((p) => p.detectors))

      const results: Record<string, Result[]> = {}
      const evidenceImports = new Set(ir.imports.filter((i) => i.trust === "evidence").map((i) => i.name))
      for (const run of [...gates.runs, ...imports.runs]) {
        const check = run.properties?.gauntlet?.check ?? ""
        if (!violationGates.has(check) && !evidenceImports.has(check)) continue
        const tool = run.tool.driver.name
        results[tool] = [...(results[tool] ?? []), ...run.results]
      }
      const metrics: Record<string, Metric> = {}
      for (const [name, value] of Object.entries(gates.metrics)) if (metricGates.has(name)) metrics[name] = value
      Object.assign(metrics, integrity.metrics)
      return { metrics, results, testIds: gates.tests?.ids ?? [], checks: [...gates.checks, ...imports.checks] } satisfies RecordedBaseline
    }))
  })

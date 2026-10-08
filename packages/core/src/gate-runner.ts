import { type GateSpec, globMatches } from "@gauntlet/dsl"
import { type Check, type PolicyIR, sha256 } from "@gauntlet/ir"
import { type Baseline, compareMetrics, compareWithBaseline, type Metric, type MetricDelta, type Proof, resultPath, resultRegion, type Run } from "@gauntlet/sarif"
import { Clock, Effect, type FileSystem, Option, type Path } from "effect"
import { buildSlug, buildsOf, factsForBuild, hasBuilds, mergeBuildRuns, ownedBy, runFromBuild, toBuild } from "./builds.ts"
import { judgeBudget, parseBudgetResults } from "./budget.ts"
import type { DiffFacts } from "./diff-facts.ts"
import { ProcessRunner } from "./process-runner.ts"
import { fingerprintRuns } from "./fingerprints.ts"
import { GateProgress } from "./gate-progress.ts"
import type { GateContext, GateRun, SuiteImpl, TestSubset } from "./gate.ts"
import type { TestRecord } from "./integrity.ts"
import type { Pack } from "./pack-registry.ts"
import type { CheckRecord } from "./report/build.ts"
import type { NewViolation, Regression } from "./review.ts"
import { assessStability, failuresOf, REPEATS } from "./stability.ts"
import type { PreparedWorkspace } from "./workspace.ts"

// Runs the policy's gate tiers in order (PLAN section 7). A tier with a
// failed check stops the tiers after it; their checks are reported as not
// executed, which is missing evidence. The runner decides every outcome
// itself, and a gate that can't prove it ran never passes (ADR 0012).

export interface GateRunnerInput {
  readonly ir: PolicyIR
  readonly facts: DiffFacts
  readonly workspace: PreparedWorkspace
  readonly packs: ReadonlyArray<Pack>
  readonly baseline: Option.Option<Baseline>
  readonly renames: ReadonlyMap<string, string>
  /** Recording a baseline: run every tier even after a failure, and every gate over the whole project. */
  readonly recording?: boolean
  /**
   * Setup's first baseline (\`gauntlet apply\`): skip a mutation check scoped to
   * changed lines rather than mutate the whole project, which took an hour.
   * \`gauntlet baseline\` still records it.
   */
  readonly skipChangedMutation?: boolean
  /** Every file in the judged checkout. */
  readonly files: ReadonlyArray<string>
  /** The judged commit's date (YYYY-MM-DD), for quarantines. */
  readonly today?: string
  /** Run holdouts that name their files (`check --holdouts`, the evidence job only; ADR 0019). */
  readonly holdouts?: boolean
}

export interface GateRunnerOutput {
  readonly checks: ReadonlyArray<CheckRecord>
  readonly runs: ReadonlyArray<Run>
  readonly newViolations: ReadonlyArray<NewViolation>
  readonly regressions: ReadonlyArray<Regression>
  readonly ratchets: ReadonlyArray<MetricDelta>
  /** Tests from every suite that ran, merged. */
  readonly tests?: TestRecord
  /** Every metric the gates reported, including `integrity/*` values. */
  readonly metrics: Readonly<Record<string, Metric>>
  readonly durationsMs: Readonly<Record<string, number>>
}

const NOT_IN_V1: Partial<Record<Check["kind"], string>> = {
  holdout: "holdout pending: holdouts run only in CI and are not executed in v1",
  "llm-review": "llm review is not executed in v1",
}

/** How many failing tests a report names per suite. */
const MAX_FAILURES = 10

const checkName = (c: Check) => (c.kind === "budget" ? `budget ${c.budget}` : c.kind === "llm-review" ? "llm review" : c.name)
const dirName = (tier: number, index: number, c: Check) => `${tier}-${index}-${checkName(c).replace(/[^A-Za-z0-9._-]+/g, "-")}`

/** The directory every holdout glob sits under ("" for the whole project), for the suite runner. */
export const holdoutDir = (globs: ReadonlyArray<string>): string => {
  const dirs = globs.map((g) => {
    const parts = g.split("/")
    const literal: string[] = []
    for (const part of parts.slice(0, -1)) {
      if (/[*?[{]/.test(part)) break
      literal.push(part)
    }
    return literal
  })
  const common: string[] = []
  for (let i = 0; dirs.every((d) => i < d.length && d[i] === dirs[0]![i]); i++) common.push(dirs[0]![i]!)
  return common.join("/")
}

const parentOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")))

const compareThreshold = (value: number, op: string, limit: number) =>
  op === "<" ? value < limit : op === "<=" ? value <= limit : op === ">" ? value > limit : op === ">=" ? value >= limit : op === "==" ? value === limit : value !== limit

export const runGates = (input: GateRunnerInput): Effect.Effect<GateRunnerOutput, never, ProcessRunner | FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const { ir, facts, workspace, packs, baseline, renames } = input
    const checks: CheckRecord[] = []
    const runs: Run[] = []
    const newViolations: NewViolation[] = []
    const regressions: Regression[] = []
    const ratchets: MetricDelta[] = []
    const metrics: Record<string, Metric> = {}
    const durationsMs: Record<string, number> = {}
    const suiteTests: TestRecord[] = []
    const changed = facts.files.filter((f) => f.status !== "deleted").map((f) => f.path)
    const specOf = (name: string): { pack: Pack; spec: GateSpec } | undefined => {
      for (const pack of packs) {
        const spec = pack.spec.gates.find((g) => g.name === name)
        if (spec) return { pack, spec }
      }
      return undefined
    }
    // Several builds (ADR 0022): each gate runs once per build of a pack that implements it.
    const multi = hasBuilds(ir)
    const builds = buildsOf(ir)
    const buildDirs = [...new Set(builds.map((b) => b.dir))]
    /** The builds a pack runs, with the pack. */
    const targetsFor = (has: (p: Pack) => boolean) =>
      builds.flatMap((b) => {
        const pack = packs.find((p) => p.spec.name === b.pack)
        return pack && has(pack) ? [{ build: b, pack }] : []
      })
    // Each build's tools are stopped in its own folder once the gates are done.
    const startedBuilds = new Map<string, { readonly pack: Pack; readonly dir: string; readonly root: string }>()
    let stoppedBy: string | undefined
    const progress = yield* GateProgress
    // The directory every check's output directory sits in, once one was made.
    let outputsRoot: string | undefined

    for (const [t, tier] of ir.gates.entries()) {
      let tierFailed = false
      for (const [i, check] of tier.checks.entries()) {
        const pointer = `/gates/${t}/checks/${i}`
        const base = { tier: tier.name, check: checkName(check), pointer, advisory: tier.advisory }
        const record = (r: Omit<CheckRecord, keyof typeof base>) => checks.push({ ...base, ...r })

        if (stoppedBy !== undefined) {
          record({ status: "not-executed", reason: `tier '${stoppedBy}' failed, so later tiers didn't run` })
          continue
        }
        if (check.kind === "holdout" && input.holdouts) {
          const started = yield* Clock.currentTimeMillis
          yield* progress.start(base.check)
          const outcome = yield* runHoldout(check.name, dirName(t, i, check))
          if (outcome) {
            durationsMs[base.check] = (yield* Clock.currentTimeMillis) - started
            yield* progress.end(base.check, outcome.status, durationsMs[base.check]!)
            record(outcome)
            if (outcome.status === "failed") tierFailed = true
            continue
          }
          yield* progress.end(base.check, "not-executed", (yield* Clock.currentTimeMillis) - started)
        }
        // Mutation testing the whole project took an hour on a real one. A check that mutates only
        // each change's own lines needs nothing from the baseline but its floor, so recording skips it.
        if (input.recording && input.skipChangedMutation && check.kind === "gate" && check.name === "mutation" && check.scope === "changed") {
          record({ status: "passed", reason: "mutation runs on each change's own lines, so setup skips the whole-project run; gauntlet baseline --update records it" })
          continue
        }
        if (check.kind === "budget") {
          const started = yield* Clock.currentTimeMillis
          yield* progress.start(base.check)
          const outcome = yield* runBudget(check.budget, dirName(t, i, check))
          durationsMs[base.check] = (yield* Clock.currentTimeMillis) - started
          yield* progress.end(base.check, outcome.status, durationsMs[base.check]!)
          record(outcome)
          if (outcome.status === "failed") tierFailed = true
          continue
        }
        const notInV1 = NOT_IN_V1[check.kind]
        if (notInV1) {
          record({ status: "not-executed", reason: notInV1 })
          continue
        }

        const started = yield* Clock.currentTimeMillis
        yield* progress.start(base.check)
        const outcome = yield* runOne(check, dirName(t, i, check))
        durationsMs[base.check] = (yield* Clock.currentTimeMillis) - started
        yield* progress.end(base.check, outcome.status, durationsMs[base.check]!)
        record(outcome)
        if (outcome.status === "failed") tierFailed = true
      }
      if (tierFailed && !input.recording) stoppedBy = tier.name
    }
    // Daemons and servers the gates shared end with the check (ADR 0020).
    if (multi) {
      for (const b of startedBuilds.values()) if (b.pack.stop) yield* b.pack.stop({ dir: b.dir, root: b.root })
    } else if (outputsRoot !== undefined) {
      for (const pack of packs) if (pack.stop) yield* pack.stop({ dir: workspace.dir, root: outputsRoot })
    }

    const tests: TestRecord | undefined = suiteTests.length === 0 ? undefined : {
      counts: suiteTests.reduce((a, t) => ({
        executed: a.executed + t.counts.executed,
        passed: a.passed + t.counts.passed,
        failed: a.failed + t.counts.failed,
        errored: a.errored + t.counts.errored,
        skipped: a.skipped + t.counts.skipped,
      }), { executed: 0, passed: 0, failed: 0, errored: 0, skipped: 0 }),
      ids: [...new Set(suiteTests.flatMap((t) => t.ids))].sort(),
    }
    return { checks, runs, newViolations, regressions, ratchets, ...(tests ? { tests } : {}), metrics, durationsMs }

    /**
     * Runs a check in each of the builds given, each in its folder with its own
     * output directory and paths from there, and merges what comes back with
     * paths from the repository's root. A build with nothing of a scoped
     * check's files is left out.
     */
    function acrossBuilds(
      targets: ReadonlyArray<{ readonly build: { readonly pack: string; readonly dir: string }; readonly pack: Pack }>,
      name: string,
      ctx: GateContext,
      run: (bctx: GateContext, target: { readonly build: { readonly pack: string; readonly dir: string }; readonly pack: Pack }) => Effect.Effect<GateRun, never, ProcessRunner | FileSystem.FileSystem | Path.Path>,
    ) {
      return Effect.gen(function*() {
        const parts: { dir: string; run: GateRun }[] = []
        for (const target of targets) {
          const { build, pack } = target
          const scope = ctx.scope === undefined ? undefined : ownedBy(buildDirs, build.dir, ctx.scope)
          if (scope !== undefined && scope.length === 0) continue
          const sub = `${buildSlug(build.dir)}/${name}`
          const made = yield* Effect.exit(workspace.outputDir(sub))
          if (made._tag === "Failure") {
            parts.push({ dir: build.dir, run: { command: [], exitCode: -1, runs: [], error: "couldn't create an output directory" } })
            continue
          }
          const dir = build.dir === "." ? workspace.dir : `${workspace.dir}/${build.dir}`
          startedBuilds.set(`${pack.spec.name} ${build.dir}`, { pack, dir, root: parentOf(made.value) })
          const { scope: _whole, ...rest } = ctx
          const bctx: GateContext = {
            ...rest,
            dir,
            outputDir: made.value,
            collect: workspace.collect(sub).pipe(Effect.orElseSucceed(() => [])),
            facts: factsForBuild(ctx.facts, buildDirs, build.dir),
            files: ownedBy(buildDirs, build.dir, ctx.files),
            ...(scope !== undefined ? { scope } : {}),
          }
          const r = runFromBuild(yield* run(bctx, target), build.dir)
          const fingerprinted = yield* fingerprintRuns(r.runs, workspace.dir, {
            ...(pack.locate ? { locate: pack.locate } : {}),
            ...(pack.normalise ? { normalise: pack.normalise } : {}),
          }).pipe(Effect.orElseSucceed(() => r.runs))
          parts.push({ dir: build.dir, run: { ...r, runs: fingerprinted } })
        }
        return mergeBuildRuns(parts)
      })
    }

    /** Every report the builds wrote for a check, under each build's directory name. */
    function collectBuilds(name: string) {
      return Effect.forEach(buildDirs, (d) =>
        workspace.collect(`${buildSlug(d)}/${name}`).pipe(
          Effect.map((files) => files.map((f) => ({ ...f, path: `${buildSlug(d)}/${f.path}` }))),
          Effect.orElseSucceed(() => []),
        )).pipe(Effect.map((all) => all.flat()))
    }

    /**
     * A performance budget (spec 0006): its command runs in the judged
     * checkout and writes its measurements to {json}, a fresh file in the
     * check's output directory, which is the only thing read.
     */
    function runBudget(name: string, dir: string): Effect.Effect<Omit<CheckRecord, "tier" | "check" | "pointer" | "advisory">, never, ProcessRunner | FileSystem.FileSystem | Path.Path> {
      return Effect.gen(function*() {
        const budget = ir.budgets.find((b) => b.name === name)
        if (!budget) return { status: "not-executed", reason: `the policy has no budget '${name}'` }
        const made = yield* Effect.exit(workspace.outputDir(dir))
        if (made._tag === "Failure") return { status: "errored", reason: "couldn't create an output directory" }
        const target = `${made.value}/budget.json`
        const command = budget.command.replaceAll("{json}", `'${target.replaceAll("'", "'\\''")}'`)
        const runner = yield* ProcessRunner
        const result = yield* Effect.exit(runner.run({ command: "sh", args: ["-c", command], cwd: workspace.dir, env: { GAUNTLET_OUT: made.value } }))
        const files = yield* workspace.collect(dir).pipe(Effect.orElseSucceed(() => []))
        const exitCode = result._tag === "Success" ? result.value.exitCode : -1
        const proof: Proof = { command: ["sh", "-c", budget.command], exitCode, reports: Object.fromEntries(files.map((f) => [f.path, sha256(f.content)])) }
        if (result._tag === "Failure") return { status: "errored", reason: "the budget's command couldn't be started or timed out", proof }
        if (exitCode !== 0) return { status: "failed", reason: `the budget's command exited with ${exitCode}`, proof }
        const report = files.find((f) => f.path === "budget.json")
        if (!report) return { status: "not-executed", reason: "the budget's command wrote nothing to {json}", proof }
        const parsed = parseBudgetResults(report.content)
        if (!parsed) return { status: "errored", reason: "{json} isn't JSON Gauntlet can read (its own format, hyperfine's --export-json or k6's --summary-export)", proof }
        const outcome = judgeBudget(budget, parsed, Option.match(baseline, { onNone: () => ({}), onSome: (b) => b.metrics }))
        Object.assign(metrics, outcome.metrics)
        return { status: outcome.status, ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}), proof }
      })
    }

    /** Runs part of a suite again in its own fresh output directory. */
    function rerun(s: { readonly suite: { readonly name: string; readonly location: string }; readonly runner: SuiteImpl }, ctx: GateContext, dir: string, subset: TestSubset, label: string) {
      return Effect.gen(function*() {
        const made = yield* Effect.exit(workspace.outputDir(`${dir}-${label}`))
        if (made._tag === "Failure") return { command: [], exitCode: -1, runs: [], error: "couldn't create an output directory" } satisfies GateRun
        return yield* s.runner(s.suite, { ...ctx, outputDir: made.value, collect: workspace.collect(`${dir}-${label}`).pipe(Effect.orElseSucceed(() => [])) }, subset)
      })
    }

    /**
     * A holdout with files (ADR 0019): the base commit's holdout files are put
     * into the checkout, the suite runner runs over their directory, and they
     * are taken out again. Output is cut down to test names (invariant 11).
     * Undefined when the holdout can't run here, which leaves it pending.
     */
    function runHoldout(name: string, dir: string): Effect.Effect<Omit<CheckRecord, "tier" | "check" | "pointer" | "advisory"> | undefined, never, ProcessRunner | FileSystem.FileSystem | Path.Path> {
      return Effect.gen(function*() {
        const suite = ir.suites.find((s) => s.name === name)
        if (!suite || suite.kind !== "holdout" || suite.globs === undefined || suite.globs.length === 0 || !workspace.withHoldout) return undefined
        const runner = packs.find((p) => p.runSuite)?.runSuite
        if (!runner) return { status: "not-executed", reason: "no used pack runs test suites" }
        const made = yield* Effect.exit(workspace.outputDir(dir))
        if (made._tag === "Failure") return { status: "errored", reason: "couldn't create an output directory" }
        outputsRoot ??= parentOf(made.value)
        const ctx: GateContext = {
          dir: workspace.dir,
          outputDir: made.value,
          collect: workspace.collect(dir).pipe(Effect.orElseSucceed(() => [])),
          ir,
          facts,
          files: input.files,
          legacy: [],
        }
        const location = holdoutDir(suite.globs)
        const ran = yield* Effect.exit(workspace.withHoldout(suite.globs, (paths) =>
          paths.length === 0 ? Effect.succeed(undefined) : runner({ name, location }, ctx)))
        if (ran._tag === "Failure") return { status: "errored", reason: "couldn't put the holdout's files from the base commit in place" }
        const run = ran.value
        if (run === undefined) return { status: "failed", reason: "the base commit has no files matching the holdout's paths" }
        const files = yield* ctx.collect
        const placeholder = (arg: string) => arg.replaceAll(ctx.outputDir, "{out}").replaceAll(ctx.dir, "{checkout}")
        const proof: Proof = {
          command: run.command.map(placeholder),
          exitCode: run.exitCode,
          reports: Object.fromEntries(files.map((f) => [f.path, sha256(f.content)])),
          ...(run.tests ? { executed: run.tests.counts.executed } : {}),
        }
        // Only test names leave a holdout run.
        runs.push(...run.runs.map((r): Run => ({
          ...r,
          results: r.results.map((x) => ({ ...x, message: { text: "holdout test failed" } })),
          properties: { ...r.properties, gauntlet: { ...r.properties?.gauntlet, check: name, proof } },
        })))
        if (run.error !== undefined) return { status: "errored", reason: run.error, proof }
        if (!run.tests || files.length === 0) return { status: "failed", reason: "no test report was produced (a silent green fails)", proof }
        const c = run.tests.counts
        if (c.executed === 0) return { status: "failed", reason: "no tests ran (a silent green fails)", proof, tests: c }
        const failing = [...new Set(failuresOf(run).map((f) => f.id))].sort()
        if (failing.length === 0) return { status: "passed", proof, tests: c }
        const suiteNames = new Set(ir.suites.filter((s) => s.kind === "suite").map((s) => s.name))
        const visiblePassed = checks.filter((r) => suiteNames.has(r.check)).every((r) => r.status === "passed")
        const failed = `${failing.length} test${failing.length === 1 ? "" : "s"} failed with the holdout's files in place`
        return {
          status: "failed",
          reason: visiblePassed ? `holdout gap: ${failed}, while the visible suites passed` : failed,
          proof,
          tests: c,
          failures: failing.slice(0, MAX_FAILURES),
          ...(visiblePassed ? { holdoutGap: true as const } : {}),
        }
      })
    }

    function runOne(check: Check, dir: string): Effect.Effect<Omit<CheckRecord, "tier" | "check" | "pointer" | "advisory">, never, ProcessRunner | FileSystem.FileSystem | Path.Path> {
      return Effect.gen(function*() {
        let start: (ctx: GateContext) => Effect.Effect<GateRun, never, ProcessRunner | FileSystem.FileSystem | Path.Path>
        let suiteRun: { readonly suite: { readonly name: string; readonly location: string }; readonly runner: SuiteImpl; readonly reruns: boolean } | undefined
        let owner: Pack | undefined
        let spec: GateSpec | undefined
        let scope: ReadonlyArray<string> | undefined
        let multiRerun: ((ctx: GateContext, subset: TestSubset, label: string) => Effect.Effect<GateRun, never, ProcessRunner | FileSystem.FileSystem | Path.Path>) | undefined
        if (check.kind === "suite" && multi) {
          const suite = ir.suites.find((s) => s.name === check.name)
          const targets = targetsFor((p) => p.runSuite !== undefined)
          if (targets.length === 0 || !suite || suite.kind !== "suite") return { status: "not-executed", reason: "no used pack runs test suites" }
          // A suite's location is from the repository's root; a build sees its own part of it.
          const located = (d: string) => ({ name: suite.name, location: suite.location.startsWith(`${d}/`) ? toBuild(d, suite.location) : suite.location })
          suiteRun = { suite: { name: suite.name, location: suite.location }, runner: targets[0]!.pack.runSuite!, reruns: targets.every((t) => t.pack.reruns === true) }
          start = (ctx) => acrossBuilds(targets, dir, ctx, (bctx, t) => t.pack.runSuite!(located(t.build.dir), bctx))
          multiRerun = (ctx, subset, label) =>
            acrossBuilds(targets.filter((t) => ownedBy(buildDirs, t.build.dir, subset.files).length > 0), `${dir}-${label}`, ctx, (bctx, t) =>
              t.pack.runSuite!(located(t.build.dir), bctx, { ...subset, files: ownedBy(buildDirs, t.build.dir, subset.files) }))
        } else if (check.kind === "suite") {
          const suite = ir.suites.find((s) => s.name === check.name)
          const suitePack = packs.find((p) => p.runSuite)
          const runner = suitePack?.runSuite
          if (!runner || !suite || suite.kind !== "suite") return { status: "not-executed", reason: "no used pack runs test suites" }
          suiteRun = { suite: { name: suite.name, location: suite.location }, runner, reruns: suitePack.reruns === true }
          start = (ctx) => runner({ name: suite.name, location: suite.location }, ctx)
        } else if (check.kind === "gate") {
          const found = specOf(check.name)
          const impl = found?.pack.gates[check.name]
          if (!found || !impl) return { status: "not-executed", reason: `no used pack implements the '${check.name}' gate` }
          spec = found.spec
          owner = found.pack
          const zone = check.zone !== undefined ? ir.zones.find((z) => z.name === check.zone) : undefined
          const inScope = (p: string) => (check.scope !== "changed" || input.recording || changed.includes(p)) && (!zone || zone.globs.some((g) => globMatches(g, p)))
          const changedOnly = check.scope === "changed" && !input.recording
          scope = changedOnly || zone ? [...new Set([...changed, ...facts.files.map((f) => f.path)])].filter(inScope).sort() : undefined
          start = multi
            ? (ctx) => acrossBuilds(targetsFor((p) => p.gates[check.name] !== undefined), dir, ctx, (bctx, t) => t.pack.gates[check.name]!(check, bctx))
            : (ctx) => impl(check, ctx)
        } else {
          return { status: "not-executed", reason: "not executed in v1" }
        }

        const made = yield* Effect.exit(workspace.outputDir(dir))
        if (made._tag === "Failure") return { status: "errored", reason: "couldn't create an output directory" }
        outputsRoot ??= parentOf(made.value)
        const ctx: GateContext = {
          dir: workspace.dir,
          outputDir: made.value,
          collect: multi ? collectBuilds(dir) : workspace.collect(dir).pipe(Effect.orElseSucceed(() => [])),
          ir,
          facts,
          ...(scope ? { scope } : {}),
          files: input.files,
          legacy: Option.match(baseline, { onNone: () => [], onSome: (b) => b.legacy }),
        }
        const run = yield* start(ctx)
        const files = yield* ctx.collect
        // Temporary paths would make identical runs differ (invariant 4). Builds write under the outputs root.
        const placeholder = (arg: string) =>
          multi && outputsRoot !== undefined
            ? arg.replaceAll(outputsRoot, "{outputs}").replaceAll(ctx.dir, "{checkout}")
            : arg.replaceAll(ctx.outputDir, "{out}").replaceAll(ctx.dir, "{checkout}")
        const proof: Proof = {
          command: run.command.map(placeholder),
          exitCode: run.exitCode,
          reports: Object.fromEntries(files.map((f) => [f.path, sha256(f.content)])),
          ...(run.tests ? { executed: run.tests.counts.executed } : {}),
        }
        // Builds fingerprinted their own results, each with its pack's locator.
        const fingerprinted = multi ? run.runs : yield* fingerprintRuns(run.runs, workspace.dir, {
          ...(owner?.locate ? { locate: owner.locate } : {}),
          ...(owner?.normalise ? { normalise: owner.normalise } : {}),
        }).pipe(Effect.orElseSucceed(() => run.runs))
        const tagged = fingerprinted.map((r): Run => ({ ...r, properties: { ...r.properties, gauntlet: { ...r.properties?.gauntlet, check: checkName(check), proof } } }))
        runs.push(...tagged)
        Object.assign(metrics, run.metrics ?? {})

        if (run.error !== undefined) return { status: "errored", reason: run.error, proof }
        if (run.nothingInScope !== undefined) return { status: "passed", reason: run.nothingInScope, proof }

        if (check.kind === "suite") {
          if (!run.tests || files.length === 0) return { status: "failed", reason: "no test report was produced (a silent green fails)", proof }
          suiteTests.push(run.tests)
          const c = run.tests.counts
          if (c.executed === 0) return { status: "failed", reason: "no tests ran (a silent green fails)", proof, tests: c }
          // A baseline records what trunk does; flakiness is judged on changes.
          const st = input.recording || !suiteRun
            ? { rerunFlaky: [], newFlaky: [], quarantined: [], failures: failuresOf(run), expired: [], notes: [] }
            : yield* assessStability({
              suite: suiteRun.suite,
              main: run,
              facts,
              quarantine: ir.quarantine ?? [],
              today: input.today ?? "0000-00-00",
              files: input.files,
              ...(suiteRun.reruns
                ? { rerun: (subset: TestSubset, label: string) => (multiRerun ? multiRerun(ctx, subset, label) : rerun(suiteRun!, ctx, dir, subset, label)) }
                : {}),
            })
          // Name the failures, so whoever fixes the change knows where to look.
          // Each line starts with the test's id, as quarantines and the flaky history name it.
          const named = st.failures.map((f) => (f.text.startsWith(f.id) ? f.text : `${f.id}: ${f.text.includes(": ") ? f.text.slice(f.text.indexOf(": ") + 2) : f.text}`)).slice(0, MAX_FAILURES)
          const flaky = [...st.rerunFlaky, ...st.newFlaky]
          const details = {
            proof,
            tests: c,
            ...(named.length > 0 ? { failures: named } : {}),
            ...(flaky.length > 0 ? { flaky } : {}),
            ...(st.quarantined.length > 0 ? { quarantined: [...st.quarantined] } : {}),
          }
          const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
          if (st.newFlaky.length > 0) {
            return { status: "failed", reason: `${plural(st.newFlaky.length, "new or changed test is", "new or changed tests are")} flaky: passed and failed across ${REPEATS + 1} runs`, ...details }
          }
          const expired = st.expired.map((q) => `the quarantine of ${q.test} expired after ${q.until}`)
          if (st.failures.length > 0) return { status: "failed", reason: [`${c.failed + c.errored} of ${c.executed} tests failed`, ...expired].join("; "), ...details }
          const notes = [
            ...(st.rerunFlaky.length > 0 ? [`${plural(st.rerunFlaky.length, "failure", "failures")} passed when run again alone (flaky)`] : []),
            ...(st.quarantined.length > 0 ? [`${plural(st.quarantined.length, "quarantined failure", "quarantined failures")} excused by the policy`] : []),
            ...st.notes,
          ]
          return { status: "passed", ...(notes.length > 0 ? { reason: notes.join("; ") } : {}), ...details }
        }

        const gate = check as Extract<Check, { kind: "gate" }>
        switch (spec!.produces) {
          case "outcome":
            return run.exitCode === 0 ? { status: "passed", proof } : { status: "failed", reason: `exited with ${run.exitCode}`, proof }
          case "violations": {
            if (files.length === 0) return { status: "failed", reason: "no report was produced (a silent green fails)", proof }
            const inScope = (p: string | undefined) => scope === undefined || (p !== undefined && scope.includes(p))
            let found = 0
            for (const r of tagged) {
              const results = r.results.filter((x) => inScope(resultPath(x)))
              const grandfathered = Option.match(baseline, { onNone: () => [], onSome: (b) => b.results[r.tool.driver.name] ?? [] })
              const fresh = gate.ratchet
                ? compareWithBaseline(grandfathered, results, { renames, unstableLocations: r.properties?.gauntlet?.unstableLocations ?? false }).results.filter((x) => x.baselineState === "new")
                : results
              found += fresh.length
              for (const v of fresh) {
                const path = resultPath(v)
                const line = resultRegion(v)?.startLine
                newViolations.push({ check: gate.name, ruleId: v.ruleId, message: v.message.text, ...(path ? { path } : {}), ...(line ? { line } : {}) })
              }
            }
            if (found === 0) return { status: "passed", proof }
            const why = gate.ratchet
              ? Option.isNone(baseline) ? `${found} finding${found === 1 ? "" : "s"} and no baseline yet; run \`gauntlet baseline\` on trunk` : `${found} new finding${found === 1 ? "" : "s"} not in the baseline`
              : `${found} finding${found === 1 ? "" : "s"}`
            return { status: "failed", reason: why, proof }
          }
          case "metric": {
            const value = run.metrics?.[gate.name]
            if (files.length === 0 || !value) return { status: "not-executed", reason: `no ${gate.name} value was reported`, proof }
            const reasons: string[] = []
            if (gate.threshold && !compareThreshold(value.value, gate.threshold.op, gate.threshold.value.value)) {
              reasons.push(`${gate.name} ${value.value}${value.unit === "%" ? "%" : ""} doesn't meet ${gate.threshold.op} ${gate.threshold.value.value}${gate.threshold.value.unit ?? ""}`)
            }
            if (gate.ratchet && Option.isSome(baseline)) {
              const recorded = baseline.value.metrics[gate.name]
              if (recorded) {
                const c = compareMetrics({ [gate.name]: recorded }, { [gate.name]: value }, { scoped: scope !== undefined })
                ratchets.push(...c.deltas)
                for (const r of c.regressions) {
                  regressions.push({ metric: r.metric, ...(r.file ? { file: r.file } : {}), base: r.base, head: r.head })
                  reasons.push(`${gate.name}${r.file ? ` for ${r.file}` : ""} fell from ${r.base} to ${r.head}`)
                }
              }
            }
            return reasons.length > 0 ? { status: "failed", reason: reasons.join("; "), proof } : { status: "passed", proof }
          }
        }
      })
    }
  })

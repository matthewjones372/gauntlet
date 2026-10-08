import { globMatches, type PolicyInvalid } from "@gauntlet/dsl"
import type { PolicyIR } from "@gauntlet/ir"
import type { MetricDelta, Run } from "@gauntlet/sarif"
import { Clock, Data, Effect, Option } from "effect"
import { BaselineStore, renamesOf } from "./baseline-store.ts"
import { diffFacts } from "./diff-facts.ts"
import { type GateRunnerOutput, runGates } from "./gate-runner.ts"
import { Git } from "./git.ts"
import { inferZones } from "./infer.ts"
import { runImports } from "./imports.ts"
import { runIntegrity, type TestRecord, testPathMatcher } from "./integrity.ts"
import { Overrides } from "./overrides.ts"
import { PackRegistry, runnerConfigFor } from "./pack-registry.ts"
import { PolicySource } from "./policy-source.ts"
import { protectOnlyDecision, protectOnlyIr } from "./protect-only.ts"
import { buildReport, type CheckRecord, type ImportRecord } from "./report/build.ts"
import { Reporter } from "./report/reporter.ts"
import type { Report, ReportAgent, RunRecord } from "./report/schema.ts"
import { type CautionSignal, decide, type Evidence, type NewViolation, type Regression } from "./review.ts"
import { ShadowLog, shadowRecordOf } from "./shadow-log.ts"
import { holdoutsOf, Workspace } from "./workspace.ts"

// `gauntlet check`: load the policy, run the evidence, decide, report.
// The same steps without running anything back the trusted half of the
// GitHub workflow (`judgeWithEvidence`): everything that needs no execution
// is recomputed there, and only gate outcomes come from the evidence job.

export interface CheckRequest {
  readonly repo: string
  /** CI: the PR base. Policy, baseline and protected files come from here. */
  readonly policyRef?: string
  /** Local: compare against this ref instead of the default branch's merge base. */
  readonly baseRef?: string
  /** The commit to judge. Defaults to HEAD. */
  readonly head?: string
  /** Where to write the report files. */
  readonly outDir: string
  readonly gauntletVersion: string
  readonly agent?: ReportAgent
  /** Set when the agent called `report_blocked`. */
  readonly blocked?: { readonly reason: string }
  /** Append a shadow record as a git note (default true). */
  readonly record?: boolean
  /**
   * Judge without running any gate: only what needs no execution (diff facts,
   * policy and integrity detectors) is evaluated, and every gate is reported as
   * not executed. `selftest` uses it for fixtures caught that way.
   */
  readonly skipGates?: boolean
  /**
   * The verification boundary only (spec 0001): the base commit's policy,
   * reduced to checks that need no baseline, zones or review ladder; the
   * verdict is pass or fail, always enforced.
   */
  readonly protectOnly?: boolean
  /** Run holdouts that name their files (the GitHub evidence job only; ADR 0019). */
  readonly holdouts?: boolean
  /**
   * The adoption window is open (spec 0005): protected tests are judged as
   * edited rather than restored from base. Local working-tree checks only.
   */
  readonly adoption?: boolean
}

export interface CheckResult {
  readonly report: Report
  readonly exitCode: 0 | 1
}

/** The check couldn't run: bad policy, missing base, git failure. Exit code 2. */
export class CheckFailed extends Data.TaggedError("CheckFailed")<{ readonly message: string; readonly cause?: PolicyInvalid | unknown }> {}

const iso = (ms: number) => new Date(ms).toISOString()

/** Gate outcomes: what running the project's tools produced. */
interface Executed {
  readonly checks: ReadonlyArray<CheckRecord>
  readonly newViolations: ReadonlyArray<NewViolation>
  readonly regressions: ReadonlyArray<Regression>
  readonly ratchets: ReadonlyArray<MetricDelta>
  readonly runs: ReadonlyArray<Run>
  readonly tests?: TestRecord
  readonly caution: ReadonlyArray<CautionSignal>
  readonly imports: ReadonlyArray<ImportRecord>
  readonly durationsMs: Readonly<Record<string, number>>
}

const prepare = (request: { readonly repo: string; readonly policyRef?: string; readonly baseRef?: string; readonly head?: string; readonly protectOnly?: boolean }) =>
  Effect.gen(function*() {
    const git = yield* Git
    const registry = yield* PackRegistry
    const source = yield* PolicySource
    let loaded = yield* source.load({
      repo: request.repo,
      ...(request.policyRef !== undefined ? { policyRef: request.policyRef } : {}),
      ...(request.baseRef !== undefined ? { baseRef: request.baseRef } : {}),
    })
    if (Option.isNone(loaded.baseSha)) {
      return yield* new CheckFailed({ message: "No base commit to compare with. Pass --base <ref> (locally) or --policy-ref <sha> (in CI)." })
    }
    // Protect-only takes the policy from the base commit locally too, as CI always does.
    if (request.protectOnly && request.policyRef === undefined) loaded = yield* source.load({ repo: request.repo, policyRef: loaded.baseSha.value })
    if (Option.isNone(loaded.baseSha)) {
      return yield* new CheckFailed({ message: "No base commit to compare with. Pass --base <ref> (locally) or --policy-ref <sha> (in CI)." })
    }
    const ir = request.protectOnly ? protectOnlyIr(loaded.compiled.ir) : loaded.compiled.ir
    const base = loaded.baseSha.value
    const head = yield* git.revParse(request.repo, request.head ?? "HEAD")
    const runnerConfig = runnerConfigFor(registry.packs, ir.packs)
    // Protect-only judges with the base's tests, pass or fail; otherwise an edited test runs as edited and needs review.
    const facts = yield* diffFacts(request.repo, base, head, ir, registry.packs, runnerConfig, !request.protectOnly)
    const baseline = yield* (yield* BaselineStore).at(request.repo, base)
    const renames = renamesOf(facts.files.map((f) => ({ status: f.status, path: f.path, ...(f.oldPath !== undefined ? { oldPath: f.oldPath } : {}) })))
    return { loaded, ir, base, head, used: registry.packs.filter((p) => ir.packs.includes(p.spec.name)), runnerConfig, facts, baseline, renames }
  })

type Prepared = Effect.Success<ReturnType<typeof prepare>>

/** Integrity in the judged checkout, then the decision and the report. */
const judge = (
  repo: string,
  p: Prepared,
  request: { readonly gauntletVersion: string; readonly agent?: ReportAgent; readonly blocked?: { readonly reason: string }; readonly protectOnly?: boolean },
  executed: Executed,
  dir: string,
) =>
  Effect.gen(function*() {
    const git = yield* Git
    const read = (ref: string) => (path: string) => git.show(repo, ref, path).pipe(Effect.orElseSucceed(() => Option.none<string>()))
    const integrity = yield* runIntegrity({
      ir: p.ir,
      facts: p.facts,
      readBase: read(p.base),
      readHead: read(p.head),
      isTestPath: testPathMatcher(p.ir),
      baselineMetrics: Option.match(p.baseline, { onNone: () => ({}), onSome: (b) => b.metrics }),
      ...(executed.tests ? { headTests: executed.tests } : {}),
      ...(executed.tests && executed.tests.ids.length > 0 && Option.isSome(p.baseline) && p.baseline.value.testIds.length > 0 ? { baseTestIds: p.baseline.value.testIds } : {}),
      headFiles: yield* git.listTree(repo, p.head),
      dir,
    }, p.used.flatMap((pack) => pack.detectors))
    const evidence: Evidence = {
      checks: executed.checks,
      newViolations: executed.newViolations,
      regressions: executed.regressions,
      integrity,
      caution: executed.caution,
      ...(request.blocked ? { blocked: request.blocked } : {}),
    }
    const { sourceMap, hash } = p.loaded.compiled
    const ir = p.ir
    const decided = decide({ ir, sourceMap, facts: p.facts, evidence, mode: p.loaded.effectiveMode })
    const decision = request.protectOnly ? protectOnlyDecision(decided) : decided
    const overrides = (yield* (yield* Overrides).forHead(repo, p.head)).map((o) => ({
      approver: o.approver,
      reason: o.reason,
      requestedBy: o.requestedBy,
      honoured: false,
      note: "approval is checked by the GitHub integration; a local override is only recorded",
    }))
    return buildReport({
      gauntletVersion: request.gauntletVersion,
      policy: { ir, irHash: hash, sourceMap, origin: p.loaded.origin, firstAdoption: p.loaded.firstAdoption, drift: p.loaded.drift, notes: [...p.loaded.notes, ...zoneSuggestions(p)] },
      ...(request.agent ? { agent: request.agent } : {}),
      facts: p.facts,
      checks: executed.checks,
      ratchets: executed.ratchets,
      integrity,
      violations: executed.newViolations,
      imports: executed.imports,
      decision,
      ...(request.protectOnly ? { scope: "protect-only" as const } : {}),
      overrides,
    })
  })

/**
 * Areas this change adds that look sensitive (payments, auth, migrations; see
 * infer.ts) but that no zone covers: a note suggesting the policy be reviewed.
 * Never part of the decision; the policy is the person's to change.
 */
const zoneSuggestions = (p: { readonly ir: PolicyIR; readonly facts: { readonly files: ReadonlyArray<{ readonly path: string; readonly status: string }> }; readonly used: ReadonlyArray<{ readonly spec: { readonly rules: ReadonlyArray<{ readonly name: string }> } }> }) => {
  const added = p.facts.files.filter((f) => f.status === "added").map((f) => f.path)
  const uncovered = added.filter((f) => !p.ir.zones.some((z) => z.globs.some((g) => globMatches(g, f))))
  if (uncovered.length === 0) return []
  const protectedGlobs = p.ir.protect.flatMap((g) => g.globs)
  return inferZones(uncovered, protectedGlobs, p.used.flatMap((u) => u.spec.rules.map((r) => r.name)), true).map((z) =>
    `This change adds ${z.globs.join(", ")}, which looks like ${z.why} but isn't in a zone. To protect it, run /gauntlet-setup in Claude Code (or add a zone to .gauntlet/policy.gx).`)
}

export const runCheck = (request: CheckRequest) =>
  Effect.gen(function*() {
    const started = yield* Clock.currentTimeMillis
    const git = yield* Git
    const p = yield* prepare(request)
    const { report, executed } = yield* Effect.scoped(Effect.gen(function*() {
      const protect = request.adoption ? p.ir.protect.filter((g) => g.kind !== "tests") : p.ir.protect
      const workspace = yield* (yield* Workspace).prepare({ repo: request.repo, base: p.base, head: p.head, protect, runnerConfig: p.runnerConfig, holdouts: holdoutsOf(p.ir), testsAsEdited: !request.protectOnly })
      const files = yield* git.listWorkingFiles(workspace.dir)
      const today = yield* git.commitDate(request.repo, p.head)
      const gates: GateRunnerOutput = request.skipGates
        ? { checks: [], newViolations: [], regressions: [], ratchets: [], runs: [], metrics: {}, durationsMs: {} }
        : yield* runGates({ ir: p.ir, facts: p.facts, workspace, packs: p.used, baseline: p.baseline, renames: p.renames, files, today, ...(request.holdouts ? { holdouts: true } : {}) })
      const imports = request.skipGates
        ? { checks: [], newViolations: [], runs: [], caution: [], records: [] }
        : yield* runImports(p.ir, workspace, p.baseline, p.renames)
      const executed: Executed = {
        checks: [...gates.checks, ...imports.checks],
        newViolations: [...gates.newViolations, ...imports.newViolations],
        regressions: gates.regressions,
        ratchets: gates.ratchets,
        runs: [...gates.runs, ...imports.runs],
        ...(gates.tests ? { tests: gates.tests } : {}),
        caution: imports.caution,
        imports: imports.records,
        durationsMs: gates.durationsMs,
      }
      return { report: yield* judge(request.repo, p, request, executed, workspace.dir), executed }
    }))
    const finished = yield* Clock.currentTimeMillis
    const run: RunRecord = { startedAt: iso(started), finishedAt: iso(finished), durationsMs: { ...executed.durationsMs, total: finished - started } }
    yield* (yield* Reporter).write(request.outDir, report, executed.runs, run)
    if (request.record !== false) yield* (yield* ShadowLog).append(request.repo, shadowRecordOf(report, run.finishedAt))
    return { report, exitCode: report.decision.blocking ? 1 : 0 } satisfies CheckResult
  })

export interface JudgeRequest {
  readonly repo: string
  readonly policyRef: string
  readonly head: string
  /** The report from the job that ran the pull request's code, if it produced one. Only its gate outcomes are used. */
  readonly evidence?: Report
  readonly outDir: string
  readonly gauntletVersion: string
  readonly record?: boolean
  /** Judge as `check --protect-only` (spec 0001). */
  readonly protectOnly?: boolean
}

/**
 * The trusted half of the GitHub workflow (ADR 0015). Never runs the change's
 * code. Recomputes the policy, diff facts, protected changes and integrity
 * findings itself, and takes only gate outcomes from the evidence report.
 * A check the base policy requires that the evidence doesn't account for is
 * not executed: missing evidence, never a pass.
 */
export const judgeWithEvidence = (request: JudgeRequest) =>
  Effect.gen(function*() {
    const started = yield* Clock.currentTimeMillis
    const p = yield* prepare({ repo: request.repo, policyRef: request.policyRef, head: request.head, ...(request.protectOnly ? { protectOnly: true } : {}) })
    const ev = request.evidence ?? { checks: [], violations: [], ratchets: [], imports: [] } as unknown as Report
    const claimed = (tier: string, check: string) => ev.checks.find((c) => c.tier === tier && c.check === check)
    const checks: CheckRecord[] = []
    p.ir.gates.forEach((t, ti) => t.checks.forEach((c, ci) => {
      const name = c.kind === "budget" ? `budget ${c.budget}` : c.kind === "llm-review" ? "llm review" : c.name
      const base = { tier: t.name, check: name, pointer: `/gates/${ti}/checks/${ci}`, advisory: t.advisory }
      const got = claimed(t.name, name)
      checks.push(got
        ? { ...base, status: got.status, ...(got.reason !== undefined ? { reason: got.reason } : {}), ...(got.proof ? { proof: got.proof } : {}), ...(got.tests ? { tests: got.tests } : {}), ...(got.failures ? { failures: got.failures } : {}), ...(got.flaky ? { flaky: got.flaky } : {}), ...(got.quarantined ? { quarantined: got.quarantined } : {}), ...(got.holdoutGap ? { holdoutGap: true as const } : {}) }
        : { ...base, status: "not-executed", reason: "the evidence job reported no outcome for this check" })
    }))
    p.ir.imports.forEach((imp, i) => {
      const got = claimed("imports", imp.name)
      checks.push(got
        ? { tier: "imports", check: imp.name, pointer: `/imports/${i}`, advisory: imp.trust === "caution", status: got.status, ...(got.reason !== undefined ? { reason: got.reason } : {}), ...(got.proof ? { proof: got.proof } : {}) }
        : { tier: "imports", check: imp.name, pointer: `/imports/${i}`, advisory: imp.trust === "caution", status: "not-executed", reason: "the evidence job reported no outcome for this import" })
    })
    const suiteNames = new Set(p.ir.suites.map((s) => s.name))
    const suiteCounts = checks.filter((c) => suiteNames.has(c.check) && c.tests).map((c) => c.tests!)
    const executed: Executed = {
      checks,
      newViolations: ev.violations.map((v) => ({ check: v.check, ruleId: v.ruleId, message: v.message, ...(v.path ? { path: v.path } : {}), ...(v.line ? { line: v.line } : {}) })),
      regressions: ev.ratchets.filter((r) => r.regressed).map((r) => ({ metric: r.metric, ...(r.file ? { file: r.file } : {}), base: r.base, head: r.head })),
      ratchets: ev.ratchets.map((r) => ({ metric: r.metric, ...(r.file ? { file: r.file } : {}), base: r.base, head: r.head, delta: r.delta, regressed: r.regressed })),
      runs: [],
      ...(suiteCounts.length > 0
        ? { tests: { counts: suiteCounts.reduce((a, c) => ({ executed: a.executed + c.executed, passed: a.passed + c.passed, failed: a.failed + c.failed, errored: a.errored + c.errored, skipped: a.skipped + c.skipped }), { executed: 0, passed: 0, failed: 0, errored: 0, skipped: 0 }), ids: [] } }
        : {}),
      caution: ev.imports.filter((i) => i.trust === "caution").flatMap((i) => i.new.map((r) => ({ source: i.source, message: r.message.text, raise: true }))),
      imports: ev.imports.map((i) => ({ source: i.source, trust: i.trust, results: i.new })),
      durationsMs: {},
    }
    // A checkout of the head to read files from; nothing in it is executed.
    const report = yield* Effect.scoped(Effect.gen(function*() {
      const workspace = yield* (yield* Workspace).prepare({ repo: request.repo, base: p.base, head: p.head, protect: p.ir.protect, runnerConfig: p.runnerConfig, holdouts: holdoutsOf(p.ir) })
      return yield* judge(request.repo, p, { gauntletVersion: request.gauntletVersion, ...(request.protectOnly ? { protectOnly: true } : {}) }, executed, workspace.dir)
    }))
    const finished = yield* Clock.currentTimeMillis
    yield* (yield* Reporter).write(request.outDir, report, [], { startedAt: iso(started), finishedAt: iso(finished), durationsMs: { total: finished - started } })
    if (request.record !== false) yield* (yield* ShadowLog).append(request.repo, shadowRecordOf(report, iso(finished)))
    return report
  })

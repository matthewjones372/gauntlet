import { canonicalJson, type PolicyIR, type SourceMap, sourceRef, TIER_ORDER } from "@gauntlet/ir"
import type { MetricDelta, Proof, Result, TestCounts } from "@gauntlet/sarif"
import type { DiffFacts } from "../diff-facts.ts"
import type { IntegrityResult } from "../integrity.ts"
import type { Drift } from "../policy-source.ts"
import type { CheckOutcome, Decision, NewViolation } from "../review.ts"
import { REPORT_SCHEMA_VERSION, type Report, type ReportAgent } from "./schema.ts"

/** A check outcome plus the proof and test counts it produced, if any. */
export interface CheckRecord extends CheckOutcome {
  readonly proof?: Proof
  readonly tests?: TestCounts
  /** The first failing tests of a suite, with their messages. */
  readonly failures?: ReadonlyArray<string>
  /** Tests that both passed and failed: on a rerun alone, or across repeated runs of new and changed tests. */
  readonly flaky?: ReadonlyArray<string>
  /** Failures a quarantine in the policy excused. */
  readonly quarantined?: ReadonlyArray<string>
  /** A holdout failed while the visible suites passed (ADR 0019). */
  readonly holdoutGap?: true
}

export interface ImportRecord {
  readonly source: string
  readonly trust: "evidence" | "caution"
  readonly results: ReadonlyArray<Result>
}

export interface ReportInput {
  readonly gauntletVersion: string
  readonly policy: {
    readonly ir: PolicyIR
    readonly irHash: string
    readonly sourceMap: SourceMap
    readonly origin: "base" | "working-copy"
    readonly firstAdoption: boolean
    readonly drift: ReadonlyArray<Drift>
    readonly notes: ReadonlyArray<string>
  }
  readonly agent?: ReportAgent
  readonly facts: DiffFacts
  readonly checks: ReadonlyArray<CheckRecord>
  readonly ratchets: ReadonlyArray<MetricDelta>
  readonly integrity: IntegrityResult
  readonly violations: ReadonlyArray<NewViolation>
  readonly imports: ReadonlyArray<ImportRecord>
  readonly decision: Decision
  /** Set for `check --protect-only` (spec 0001). */
  readonly scope?: "protect-only"
  readonly overrides?: ReadonlyArray<{ readonly approver: string; readonly reason: string; readonly requestedBy: string; readonly honoured: boolean; readonly note: string }>
}

const by = <A>(key: (a: A) => string) => (a: A, b: A) => {
  const ka = key(a)
  const kb = key(b)
  return ka < kb ? -1 : ka > kb ? 1 : 0
}
const pad = (n: number | undefined) => String(n ?? 0).padStart(9, "0")
const opt = <K extends string, V>(key: K, value: V | undefined) => (value === undefined ? {} : { [key]: value } as { [P in K]: V })

/** Builds the report. Every list is put in a fixed order so equal inputs give equal bytes. */
export const buildReport = (input: ReportInput): Report => {
  const { ir, sourceMap } = input.policy
  const { facts, decision } = input
  const tierIndex = (t: string) => {
    const i = ir.gates.findIndex((g) => g.name === t)
    return String(i < 0 ? 999 : i).padStart(3, "0")
  }

  const checks = [...input.checks]
    .sort(by((c) => `${tierIndex(c.tier)}\0${c.check}`))
    .map((c) => ({
      tier: c.tier,
      check: c.check,
      status: c.status,
      advisory: c.advisory,
      ...opt("reason", c.reason),
      ...opt("proof", c.proof),
      ...opt("tests", c.tests),
      ...(c.failures && c.failures.length > 0 ? { failures: [...c.failures] } : {}),
      ...(c.flaky && c.flaky.length > 0 ? { flaky: [...c.flaky] } : {}),
      ...(c.quarantined && c.quarantined.length > 0 ? { quarantined: [...c.quarantined] } : {}),
      ...(c.holdoutGap ? { holdoutGap: true as const } : {}),
      ...(c.failingOnBase && c.failingOnBase.length > 0 ? { failingOnBase: [...c.failingOnBase] } : {}),
      ...(c.failedBefore ? { failedBefore: true as const } : {}),
      ...opt("source", sourceRef(sourceMap, c.pointer)),
    }))

  const notExecuted = [
    ...input.checks
      .filter((c) => c.status === "not-executed" || c.status === "errored")
      .map((c) => ({ what: `${c.tier}: ${c.check}`, why: c.reason ?? (c.status === "errored" ? "the check errored" : "not executed") })),
    ...input.integrity.notExecuted.map((check) => ({ what: `integrity: ${check.replaceAll("-", " ")}`, why: "no used pack implements it, or it had no data" })),
  ].sort(by((n) => n.what))

  const failed = new Set(input.checks.filter((c) => c.status === "failed").map((c) => c.check))
  const remediation = ir.remediation.filter((r) => failed.has(r.gate)).map((r) => ({ check: r.gate, fix: r.fix })).sort(by((r) => r.check))

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    gauntletVersion: input.gauntletVersion,
    policy: {
      irHash: input.policy.irHash,
      origin: input.policy.origin,
      baseSha: facts.base,
      headSha: facts.head,
      firstAdoption: input.policy.firstAdoption,
      mode: decision.mode,
      drift: [...input.policy.drift].sort(by((d) => d.path)),
      notes: [...input.policy.notes],
      owners: [...ir.owners].sort(),
    },
    agent: input.agent ?? {},
    facts: {
      files: [...facts.files].sort(by((f) => f.path)).map((f) => ({ path: f.path, status: f.status, ...opt("oldPath", f.oldPath), added: f.added, removed: f.removed })),
      linesChanged: facts.linesChanged,
      protectedTouched: [...facts.protectedTouched].sort(by((p) => p.path)).map((p) => ({ path: p.path, group: p.group, kind: p.kind, change: p.change, action: p.action })),
      zonesTouched: [...facts.zonesTouched].sort(by((z) => z.zone)).map((z) => ({ zone: z.zone, files: [...z.files].sort(), owners: [...z.owners].sort() })),
      dependencyChanges: [...facts.dependencyChanges].sort(by((d) => d.manifest)).map((d) => ({ manifest: d.manifest, added: [...d.added].sort(), removed: [...d.removed].sort(), unparsed: d.unparsed })),
      budgetsChanged: [...facts.budgetsChanged].sort(),
      gauntletChanged: facts.gauntletChanged,
    },
    checks,
    ratchets: [...input.ratchets].sort(by((r) => `${r.metric}\0${r.file ?? ""}`)).map((r) => ({
      metric: r.metric, ...opt("file", r.file), base: r.base, head: r.head, delta: r.delta, regressed: r.regressed,
    })),
    integrity: {
      findings: [...input.integrity.findings]
        .sort(by((f) => `${f.kind}\0${f.check}\0${f.path ?? ""}\0${pad(f.line)}\0${f.message}`))
        .map((f) => ({ check: f.check, kind: f.kind, message: f.message, ...opt("path", f.path), ...opt("line", f.line), detector: f.detector })),
      notExecuted: [...input.integrity.notExecuted].sort(),
    },
    violations: [...input.violations]
      .sort(by((v) => `${v.check}\0${v.path ?? ""}\0${pad(v.line)}\0${v.ruleId}\0${v.message}`))
      .map((v) => ({ check: v.check, ruleId: v.ruleId, message: v.message, ...opt("path", v.path), ...opt("line", v.line) })),
    imports: [...input.imports].sort(by((i) => i.source)).map((i) => ({
      source: i.source,
      trust: i.trust,
      total: i.results.length,
      new: i.results.filter((r) => r.baselineState === "new" || r.baselineState === undefined).sort(by((r) => canonicalJson(r))),
    })),
    notExecuted,
    remediation,
    decision: {
      ...opt("scope", input.scope),
      tier: decision.tier,
      mode: decision.mode,
      wouldBlock: decision.wouldBlock,
      blocking: decision.blocking,
      owners: [...decision.owners].sort(),
      // Most cautious first; within a tier, what blocks comes before what doesn't.
      nominations: decision.nominations.map((n, i) => ({ n, i })).sort((a, b) =>
        TIER_ORDER.indexOf(b.n.tier) - TIER_ORDER.indexOf(a.n.tier) || Number(b.n.blocking) - Number(a.n.blocking) || a.i - b.i
      ).map(({ n }) => ({
        tier: n.tier,
        reason: n.reason,
        blocking: n.blocking,
        rule: n.source.kind === "policy" ? "policy" : n.source.rule,
        ...opt("source", n.source.ref),
      })),
      overrides: [...(input.overrides ?? [])].sort(by((o) => `${o.approver}\u0000${o.reason}`)).map((o) => ({ ...o })),
    },
  }
}

import { Mode, SourceRef, Tier } from "@gauntlet/ir"
import { Proof, Result, TestCounts } from "@gauntlet/sarif"
import { Schema } from "effect"

// The evidence report (PLAN section 11). It is a pure function of its inputs:
// no timestamps, no durations, fixed ordering, so the same inputs give the
// same bytes (invariant 4). Timing lives in a separate run record.

export const REPORT_SCHEMA_VERSION = 1 as const

const ChangeStatus = Schema.Literals(["added", "modified", "deleted", "renamed"])

export const ReportPolicy = Schema.Struct({
  irHash: Schema.String,
  origin: Schema.Literals(["base", "working-copy"]),
  baseSha: Schema.String,
  headSha: Schema.String,
  firstAdoption: Schema.Boolean,
  mode: Mode,
  drift: Schema.Array(Schema.Struct({ path: Schema.String, change: Schema.Literals(["added", "modified", "deleted"]) })),
  notes: Schema.Array(Schema.String),
  /** The policy's owners: who owns `.gauntlet/` changes and can approve overrides. */
  owners: Schema.Array(Schema.String),
})

/** Who wrote the change, when known. Recorded only; never read by the decision (invariant 7). */
export const ReportAgent = Schema.Struct({
  agent: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  session: Schema.optionalKey(Schema.String),
})
export type ReportAgent = typeof ReportAgent.Type

export const ReportFacts = Schema.Struct({
  files: Schema.Array(Schema.Struct({
    path: Schema.String,
    status: ChangeStatus,
    oldPath: Schema.optionalKey(Schema.String),
    added: Schema.Number,
    removed: Schema.Number,
  })),
  linesChanged: Schema.Number,
  protectedTouched: Schema.Array(Schema.Struct({
    path: Schema.String,
    group: Schema.String,
    kind: Schema.String,
    change: ChangeStatus,
    action: Schema.Literals(["restored", "removed", "kept"]),
  })),
  zonesTouched: Schema.Array(Schema.Struct({ zone: Schema.String, files: Schema.Array(Schema.String), owners: Schema.Array(Schema.String) })),
  dependencyChanges: Schema.Array(Schema.Struct({
    manifest: Schema.String,
    added: Schema.Array(Schema.String),
    removed: Schema.Array(Schema.String),
    unparsed: Schema.Boolean,
  })),
  budgetsChanged: Schema.Array(Schema.String),
  gauntletChanged: Schema.Boolean,
})

export const ReportCheck = Schema.Struct({
  tier: Schema.String,
  check: Schema.String,
  status: Schema.Literals(["passed", "failed", "not-executed", "errored"]),
  advisory: Schema.Boolean,
  reason: Schema.optionalKey(Schema.String),
  proof: Schema.optionalKey(Proof),
  tests: Schema.optionalKey(TestCounts),
  failures: Schema.optionalKey(Schema.Array(Schema.String)),
  flaky: Schema.optionalKey(Schema.Array(Schema.String)),
  quarantined: Schema.optionalKey(Schema.Array(Schema.String)),
  /** A holdout failed while the visible suites passed (ADR 0019). */
  holdoutGap: Schema.optionalKey(Schema.Literal(true)),
  source: Schema.optionalKey(SourceRef),
})
export type ReportCheck = typeof ReportCheck.Type

export const ReportRatchet = Schema.Struct({
  metric: Schema.String,
  file: Schema.optionalKey(Schema.String),
  base: Schema.Number,
  head: Schema.Number,
  delta: Schema.Number,
  regressed: Schema.Boolean,
})

export const ReportFinding = Schema.Struct({
  check: Schema.String,
  kind: Schema.Literals(["ratchet", "forbid", "flag"]),
  message: Schema.String,
  path: Schema.optionalKey(Schema.String),
  line: Schema.optionalKey(Schema.Number),
  detector: Schema.String,
})

export const ReportViolation = Schema.Struct({
  check: Schema.String,
  ruleId: Schema.String,
  message: Schema.String,
  path: Schema.optionalKey(Schema.String),
  line: Schema.optionalKey(Schema.Number),
})

export const ReportImport = Schema.Struct({
  source: Schema.String,
  trust: Schema.Literals(["evidence", "caution"]),
  total: Schema.Number,
  /** Findings not grandfathered by the baseline. */
  new: Schema.Array(Result),
})

export const ReportNotExecuted = Schema.Struct({ what: Schema.String, why: Schema.String })

export const ReportNomination = Schema.Struct({
  tier: Tier,
  reason: Schema.String,
  blocking: Schema.Boolean,
  rule: Schema.String,
  source: Schema.optionalKey(SourceRef),
})

export const ReportDecision = Schema.Struct({
  /** `"protect-only"` for `check --protect-only` (spec 0001): the verdict is `blocking`, and the tier isn't a review decision. Absent otherwise. */
  scope: Schema.optionalKey(Schema.Literal("protect-only")),
  tier: Tier,
  mode: Mode,
  wouldBlock: Schema.Boolean,
  blocking: Schema.Boolean,
  owners: Schema.Array(Schema.String),
  nominations: Schema.Array(ReportNomination),
  /** Overrides recorded for this head. Only the GitHub integration can honour one (ADR 0014). */
  overrides: Schema.Array(Schema.Struct({
    approver: Schema.String,
    reason: Schema.String,
    requestedBy: Schema.String,
    honoured: Schema.Boolean,
    note: Schema.String,
  })),
})

export const Report = Schema.Struct({
  schemaVersion: Schema.Literal(REPORT_SCHEMA_VERSION),
  gauntletVersion: Schema.String,
  policy: ReportPolicy,
  agent: ReportAgent,
  facts: ReportFacts,
  checks: Schema.Array(ReportCheck),
  ratchets: Schema.Array(ReportRatchet),
  integrity: Schema.Struct({ findings: Schema.Array(ReportFinding), notExecuted: Schema.Array(Schema.String) }),
  violations: Schema.Array(ReportViolation),
  imports: Schema.Array(ReportImport),
  notExecuted: Schema.Array(ReportNotExecuted),
  remediation: Schema.Array(Schema.Struct({ check: Schema.String, fix: Schema.String })),
  decision: ReportDecision,
})
export type Report = typeof Report.Type

/** Timing for a run. Kept out of the report so the report stays deterministic. */
export const RunRecord = Schema.Struct({
  startedAt: Schema.String,
  finishedAt: Schema.String,
  durationsMs: Schema.Record(Schema.String, Schema.Number),
})
export type RunRecord = typeof RunRecord.Type

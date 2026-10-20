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
    action: Schema.Literals(["restored", "removed", "kept", "edited"]),
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
  /** The change only removes main code and removes no test: the review condition `code removed` holds (spec 0017). */
  codeRemoved: Schema.optionalKey(Schema.Literal(true)),
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
  /** Failing tests that fail on the base too: already failing before the change. */
  failingOnBase: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Every failure that counts fails on the base too, so the change isn't blocked for it. */
  failedBefore: Schema.optionalKey(Schema.Literal(true)),
  /** The mutation gate confirmed that a change that only removes tests loses no kills (spec 0016). */
  pruning: Schema.optionalKey(Schema.Literal("confirmed")),
  /** An affected suite (spec 0013): how many tests ran of how many, why the rest didn't (or why all did), and the test classes left out. */
  selection: Schema.optionalKey(Schema.Struct({
    ran: Schema.Number,
    of: Schema.Number,
    why: Schema.Array(Schema.String),
    deselected: Schema.optionalKey(Schema.Array(Schema.String)),
  })),
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
  /** Why the base isn't the baseline's value as recorded, or what a drop may come from (spec 0017 §3). */
  note: Schema.optionalKey(Schema.String),
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

const ScenarioMutant = Schema.Struct({
  path: Schema.String,
  line: Schema.Number,
  method: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  killedBy: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
})

/** The scenarios check's verdicts (spec 0012): one per scenario, and the changed code no scenario's test catches. */
export const ReportScenarios = Schema.Struct({
  mutation: Schema.Literals(["reported", "not-reported", "not-run", "not-in-policy"]),
  scenarios: Schema.Array(Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    file: Schema.String,
    line: Schema.Number,
    verdict: Schema.Literals(["unbound", "not-run", "failing", "vacuous", "unchallenged", "proven", "unaffected", "passing"]),
    text: Schema.Array(Schema.String),
    tests: Schema.Array(Schema.Struct({
      id: Schema.String,
      status: Schema.Literals(["passed", "failed", "skipped", "not-run", "left-out"]),
      holdout: Schema.optionalKey(Schema.Literal(true)),
      path: Schema.optionalKey(Schema.String),
      line: Schema.optionalKey(Schema.Number),
      assertions: Schema.optionalKey(Schema.Number),
      vacuous: Schema.optionalKey(Schema.String),
    })),
    killers: Schema.Literals(["reported", "not-reported", "not-run", "not-in-policy"]),
    killed: Schema.Array(ScenarioMutant),
    reachedOnly: Schema.Array(ScenarioMutant),
    holdout: Schema.optionalKey(Schema.Literal(true)),
  })),
  noScenario: Schema.Array(Schema.Struct({ function: Schema.String, path: Schema.String, line: Schema.Number, mutants: Schema.Number })),
})
export type ReportScenarios = typeof ReportScenarios.Type

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
  /** Findings that don't block on their own (spec 0011): an `advise` gate's, and surviving mutants on changed lines. Absent when there are none. */
  advice: Schema.optionalKey(Schema.Array(ReportViolation)),
  /** The scenarios check's verdicts (spec 0012). Absent when the policy has no scenarios check, or it didn't run. */
  scenarios: Schema.optionalKey(ReportScenarios),
  imports: Schema.Array(ReportImport),
  notExecuted: Schema.Array(ReportNotExecuted),
  remediation: Schema.Array(Schema.Struct({ check: Schema.String, fix: Schema.String })),
  /** For a big change over several parts: stacked pull requests to split it into, in review order. A suggestion only. */
  stack: Schema.optionalKey(Schema.Struct({
    lines: Schema.Number,
    steps: Schema.Array(Schema.Struct({
      title: Schema.String, files: Schema.Array(Schema.String), lines: Schema.Number, needsOwner: Schema.Boolean,
      /** About how many mutants the step brings, when the split is for a mutation budget (spec 0020). */
      mutants: Schema.optionalKey(Schema.Number),
    })),
    /** The change is over a mutation gate's budget (spec 0020): the estimate and the budget the split keeps each step within. */
    mutation: Schema.optionalKey(Schema.Struct({ estimate: Schema.Number, budget: Schema.Number })),
  })),
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

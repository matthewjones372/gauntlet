import { Schema } from "effect"

// The Policy IR: what a policy means, with no source positions. Everything
// downstream of the compiler reads only this. See ADR 0002.

export const IR_VERSION = 1 as const

const Finite = Schema.Finite

export const Unit = Schema.Literals(["ms", "s", "m", "rps", "%", "lines"])
export type Unit = typeof Unit.Type

export const Comparator = Schema.Literals(["<", "<=", ">", ">=", "==", "!="])
export type Comparator = typeof Comparator.Type

export const Tier = Schema.Literals(["auto", "skim", "review", "owner"])
export type Tier = typeof Tier.Type

export const TIER_ORDER: ReadonlyArray<Tier> = ["auto", "skim", "review", "owner"]

export const Mode = Schema.Literals(["shadow", "enforce"])
export type Mode = typeof Mode.Type

export const Quantity = Schema.Struct({ value: Finite, unit: Schema.optionalKey(Unit) })
export type Quantity = typeof Quantity.Type

export const Threshold = Schema.Struct({ op: Comparator, value: Quantity })
export type Threshold = typeof Threshold.Type

/** How a protect group is materialised from base (PLAN section 9). */
export const ProtectKind = Schema.Literals(["tests", "config", "fixtures", "gauntlet", "other"])
export type ProtectKind = typeof ProtectKind.Type

export const ProtectGroup = Schema.Struct({
  group: Schema.String,
  kind: ProtectKind,
  globs: Schema.Array(Schema.String),
})
export type ProtectGroup = typeof ProtectGroup.Type

export const Zone = Schema.Struct({
  name: Schema.String,
  globs: Schema.Array(Schema.String),
  owners: Schema.Array(Schema.String),
  rules: Schema.Array(Schema.String),
})
export type Zone = typeof Zone.Type

export const ArchRule = Schema.Struct({
  module: Schema.String,
  mustNotDependOn: Schema.Array(Schema.String),
})
export type ArchRule = typeof ArchRule.Type

export const Suite = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("suite"), name: Schema.String, location: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("holdout"),
    name: Schema.String,
    ciOnly: Schema.Boolean,
    /** The holdout's files (ADR 0019). Without them the holdout is pending. */
    globs: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
])
export type Suite = typeof Suite.Type

export const RatchetCheck = Schema.Literals([
  "executed-tests",
  "assertions-per-test",
  "skipped-tests",
  "suppressions",
  "quarantined-tests",
  "property-tests",
])
export type RatchetCheck = typeof RatchetCheck.Type

export const ForbidCheck = Schema.Literals([
  "deleted-tests",
  "weakened-assertions",
  "new-skips",
  "new-suppressions",
  "test-refs-in-main",
  "exit-in-tests",
  "added-retries",
])
export type ForbidCheck = typeof ForbidCheck.Type

export const FlagCheck = Schema.Literals([
  "equality-overrides",
  "catch-all-near-changed-code",
  "env-branching",
  "mocks-of-class-under-test",
  "test-special-case-comments",
  "flaky-patterns",
])
export type FlagCheck = typeof FlagCheck.Type

export const Integrity = Schema.Struct({
  ratchet: Schema.Array(RatchetCheck),
  forbid: Schema.Array(ForbidCheck),
  flag: Schema.Array(FlagCheck),
})
export type Integrity = typeof Integrity.Type

export const BudgetThreshold = Schema.Struct({
  aggregate: Schema.optionalKey(Schema.String),
  metric: Schema.String,
  op: Comparator,
  value: Quantity,
  vsBaseline: Schema.Boolean,
})
export type BudgetThreshold = typeof BudgetThreshold.Type

export const Budget = Schema.Struct({
  name: Schema.String,
  command: Schema.String,
  thresholds: Schema.Array(BudgetThreshold),
})
export type Budget = typeof Budget.Type

export const Check = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("gate"),
    name: Schema.String,
    ratchet: Schema.Boolean,
    threshold: Schema.optionalKey(Threshold),
    scope: Schema.Literals(["changed", "all"]),
    zone: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("suite"), name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("holdout"), name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("budget"), budget: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("llm-review"), reviews: Finite }),
])
export type Check = typeof Check.Type

export const GateTier = Schema.Struct({
  name: Schema.String,
  advisory: Schema.Boolean,
  checks: Schema.Array(Check),
})
export type GateTier = typeof GateTier.Type

export const Remediation = Schema.Struct({ gate: Schema.String, fix: Schema.String })
export type Remediation = typeof Remediation.Type

export const Import = Schema.Struct({
  name: Schema.String,
  command: Schema.String,
  trust: Schema.Literals(["evidence", "caution"]),
})
export type Import = typeof Import.Type

export const FactCondition = Schema.Literals([
  "zone-touched",
  "no-zone-touched",
  "protected-changed",
  "dependency-added",
  "budget-changed",
  "evidence-missing",
  "all-gates-pass",
])
export type FactCondition = typeof FactCondition.Type

export const Condition = Schema.Union([
  Schema.Struct({ kind: FactCondition }),
  Schema.Struct({ kind: Schema.Literal("diff"), op: Comparator, lines: Finite }),
  Schema.Struct({ kind: Schema.Literal("predicate"), name: Schema.String }),
])
export type Condition = typeof Condition.Type

export const Predicate = Schema.Struct({ name: Schema.String, conditions: Schema.Array(Condition) })
export type Predicate = typeof Predicate.Type

/** A review rule nominates `tier` when all its conditions hold (ADR 0005). */
export const ReviewRule = Schema.Struct({ tier: Tier, conditions: Schema.Array(Condition) })
export type ReviewRule = typeof ReviewRule.Type

export const LayerProperty = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("unchanged"), subject: Schema.String }),
  Schema.Struct({ kind: Schema.Literals(["additive", "reversible"]) }),
  Schema.Struct({ kind: Schema.Literal("red-to-green"), suite: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("touches"), subjects: Schema.Array(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("only"), subjects: Schema.Array(Schema.String) }),
])
export type LayerProperty = typeof LayerProperty.Type

export const Stack = Schema.Struct({
  layers: Schema.Array(Schema.Struct({ name: Schema.String, properties: Schema.Array(LayerProperty) })),
  maxLayerDiffLines: Schema.optionalKey(Finite),
  reviewStackWhen: Schema.optionalKey(Schema.Struct({ op: Comparator, tier: Tier })),
})
export type Stack = typeof Stack.Type

/**
 * A known flaky test, excused by an owner until a date (inclusive). It still
 * runs; while the quarantine holds its failure doesn't fail the suite. "Today"
 * is the judged commit's date, so a decision never depends on when it runs.
 */
export const Quarantine = Schema.Struct({
  test: Schema.String,
  until: Schema.String,
  owners: Schema.Array(Schema.String),
})
export type Quarantine = typeof Quarantine.Type

/** A build a pack runs in a folder of its own (\`use jvm in "lark-bank"\`); "." is the repository's root. */
export const Build = Schema.Struct({
  pack: Schema.String,
  dir: Schema.String,
})
export type Build = typeof Build.Type

export const PolicyIR = Schema.Struct({
  irVersion: Schema.Literal(IR_VERSION),
  name: Schema.String,
  mode: Mode,
  packs: Schema.Array(Schema.String),
  owners: Schema.Array(Schema.String),
  protect: Schema.Array(ProtectGroup),
  zones: Schema.Array(Zone),
  arch: Schema.Array(ArchRule),
  suites: Schema.Array(Suite),
  integrity: Integrity,
  budgets: Schema.Array(Budget),
  gates: Schema.Array(GateTier),
  remediation: Schema.Array(Remediation),
  imports: Schema.Array(Import),
  predicates: Schema.Array(Predicate),
  review: Schema.Array(ReviewRule),
  stack: Schema.optionalKey(Stack),
  /** Omitted when empty, so policies without quarantines keep their hashes. */
  quarantine: Schema.optionalKey(Schema.Array(Quarantine)),
  /** Builds in folders of their own. Omitted when every pack builds at the root, so those policies keep their hashes. */
  builds: Schema.optionalKey(Schema.Array(Build)),
})
export type PolicyIR = typeof PolicyIR.Type

/** Everything the integrity checks cover when a policy says nothing (ADR 0013). */
export const DEFAULT_INTEGRITY: Integrity = {
  ratchet: RatchetCheck.literals,
  forbid: ForbidCheck.literals,
  flag: FlagCheck.literals,
}

/** Paths every policy protects, whether or not it lists them. */
export const IMPLICIT_PROTECT: ProtectGroup = { group: "gauntlet", kind: "gauntlet", globs: [".gauntlet/**"] }

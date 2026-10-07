import type { FactCondition, FlagCheck, ForbidCheck, ProtectKind, RatchetCheck, Tier, Unit } from "@gauntlet/ir"

export const MODES = ["shadow", "enforce"] as const
export const SCOPES = ["changed", "all"] as const
export const TIERS: ReadonlyArray<Tier> = ["auto", "skim", "review", "owner"]
export const UNITS: ReadonlyArray<Unit> = ["ms", "s", "m", "rps", "%", "lines"]
export const TIME_UNITS: ReadonlyArray<Unit> = ["ms", "s", "m"]

export const DEFAULT_POLICY_FILE = ".gauntlet/policy.gx"

/** Fact conditions, keyed by the words that spell them. */
export const FACT_CONDITIONS: Record<string, FactCondition> = {
  "zone touched": "zone-touched",
  "no zone touched": "no-zone-touched",
  "protected changed": "protected-changed",
  "dependency added": "dependency-added",
  "budget changed": "budget-changed",
  "evidence missing": "evidence-missing",
  "all gates pass": "all-gates-pass",
}

/** Integrity phrases by list keyword (ADR 0013). */
export const RATCHET_PHRASES: Record<string, RatchetCheck> = {
  "executed tests": "executed-tests",
  "assertions per test": "assertions-per-test",
  "skipped tests": "skipped-tests",
  "suppressions": "suppressions",
  "quarantined tests": "quarantined-tests",
  "property tests": "property-tests",
}
export const FORBID_PHRASES: Record<string, ForbidCheck> = {
  "deleted tests": "deleted-tests",
  "weakened assertions": "weakened-assertions",
  "new skips": "new-skips",
  "new suppressions": "new-suppressions",
  "test refs in main": "test-refs-in-main",
  "exit in tests": "exit-in-tests",
  "added retries": "added-retries",
}
export const FLAG_PHRASES: Record<string, FlagCheck> = {
  "equality overrides": "equality-overrides",
  "catch-all near changed code": "catch-all-near-changed-code",
  "env branching": "env-branching",
  "mocks of class under test": "mocks-of-class-under-test",
  "test special-case comments": "test-special-case-comments",
  "flaky patterns": "flaky-patterns",
}
export const INTEGRITY_PHRASES = { ratchet: RATCHET_PHRASES, forbid: FORBID_PHRASES, flag: FLAG_PHRASES } as const

/** Protect groups whose names carry materialisation behaviour (PLAN section 9). */
export const RESERVED_GROUPS: Record<string, ProtectKind> = { tests: "tests", config: "config", fixtures: "fixtures" }

/** Budget metrics and the units each accepts. */
export const BUDGET_METRICS: Record<string, ReadonlyArray<Unit>> = {
  p50: TIME_UNITS,
  p90: TIME_UNITS,
  p95: TIME_UNITS,
  p99: TIME_UNITS,
  p999: TIME_UNITS,
  mean: TIME_UNITS,
  max: TIME_UNITS,
  errors: ["%"],
  throughput: ["rps"],
  regression: ["%"],
}

export const AGGREGATES = ["avg", "min", "max", "sum"] as const

export const TOP_LEVEL_BLOCKS = [
  "use", "mode", "owners", "protect", "zone", "arch", "suites", "integrity", "import", "budget",
  "gates", "on fail", "predicate", "review", "stack", "quarantine",
] as const

export const ADVISORY_TIER = "advisory"

export const LAYER_PROPERTY_FORMS = [
  "<subject> unchanged (tests, results, perf)",
  "additive",
  "reversible",
  "<suite> red -> green",
  "touches <names>",
  "<names> only",
]

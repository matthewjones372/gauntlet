import type { PackSpec } from "../../src/index.ts"

// Stands in for the JVM pack's catalog until packs/jvm exists (M8).
export const jvm: PackSpec = {
  name: "jvm",
  description: "Gradle, JUnit, Pitest, Kover, ArchUnit, detekt",
  runsSuites: true,
  gates: [
    { name: "build", description: "compile", produces: "outcome", units: [], higherIsBetter: true, scopable: false, zoneScopable: false },
    { name: "lint", description: "detekt and pack rules", produces: "violations", units: [], higherIsBetter: false, scopable: true, zoneScopable: true },
    { name: "arch", description: "ArchUnit rules", produces: "violations", units: [], higherIsBetter: false, scopable: false, zoneScopable: false },
    { name: "mutation", description: "Pitest score", produces: "metric", units: ["%"], higherIsBetter: true, scopable: true, zoneScopable: true },
    { name: "coverage", description: "Kover line coverage", produces: "metric", units: ["%"], higherIsBetter: true, scopable: true, zoneScopable: true },
  ],
  rules: [{ name: "kotlin.no-floating-money", description: "no Double or Float for money" }],
  integrity: [
    "executed-tests", "assertions-per-test", "skipped-tests", "suppressions", "quarantined-tests", "property-tests",
    "deleted-tests", "weakened-assertions", "new-skips", "new-suppressions", "test-refs-in-main", "exit-in-tests",
    "equality-overrides", "catch-all-near-changed-code", "env-branching", "mocks-of-class-under-test", "test-special-case-comments", "added-retries", "flaky-patterns",
  ],
}

/** A pack with gates but no suites or integrity, for "not implemented" cases. */
export const lintOnly: PackSpec = {
  name: "lintonly",
  description: "a linter and nothing else",
  runsSuites: false,
  gates: [{ name: "lint", description: "lint", produces: "violations", units: [], higherIsBetter: false, scopable: true, zoneScopable: false }],
  rules: [],
  integrity: [],
}

export const installed: ReadonlyArray<PackSpec> = [jvm, lintOnly]

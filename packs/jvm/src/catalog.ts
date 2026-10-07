import type { PackSpec } from "@gauntlet/dsl"
import { RULES } from "./kotlin/rules.ts"

export const spec: PackSpec = {
  name: "jvm",
  description: "Kotlin on Gradle: JUnit suites, detekt, Pitest, Kover, import-based arch rules, Kotlin integrity detectors",
  runsSuites: true,
  gates: [
    { name: "build", description: "compiles main and test code", produces: "outcome", units: [], higherIsBetter: true, scopable: false, zoneScopable: false },
    { name: "lint", description: "detekt plus the zones' Kotlin rules", produces: "violations", units: [], higherIsBetter: false, scopable: true, zoneScopable: true },
    { name: "arch", description: "module dependency rules, from imports", produces: "violations", units: [], higherIsBetter: false, scopable: false, zoneScopable: false },
    { name: "mutation", description: "Pitest mutation score", produces: "metric", units: ["%"], higherIsBetter: true, scopable: true, zoneScopable: true },
    { name: "coverage", description: "Kover line coverage (changed lines with `on changed`)", produces: "metric", units: ["%"], higherIsBetter: true, scopable: true, zoneScopable: true },
  ],
  rules: RULES,
  integrity: [
    "executed-tests", "assertions-per-test", "skipped-tests", "suppressions", "quarantined-tests", "property-tests",
    "deleted-tests", "weakened-assertions", "new-skips", "new-suppressions", "test-refs-in-main", "exit-in-tests",
    "equality-overrides", "catch-all-near-changed-code", "env-branching", "mocks-of-class-under-test", "test-special-case-comments", "added-retries", "flaky-patterns",
  ],
}

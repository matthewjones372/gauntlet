import type { PackSpec } from "@gauntlet/dsl"
import { RULES } from "./rules.ts"

export const spec: PackSpec = {
  name: "scala",
  description: "Scala on sbt: ScalaTest, munit, munit-cats-effect, ZIO Test or weaver; scalafix; Stryker4s; scoverage",
  runsSuites: true,
  gates: [
    { name: "build", description: "compiles main and test code", produces: "outcome", units: [], higherIsBetter: true, scopable: false, zoneScopable: false },
    { name: "warnings", description: "scalac warnings (`warnings ratchet`: new ones fail)", produces: "violations", units: [], higherIsBetter: false, scopable: true, zoneScopable: true },
    { name: "lint", description: "scalafix --check, plus the zones' Scala rules", produces: "violations", units: [], higherIsBetter: false, scopable: true, zoneScopable: true },
    { name: "arch", description: "package dependency rules, from imports", produces: "violations", units: [], higherIsBetter: false, scopable: false, zoneScopable: false },
    { name: "mutation", description: "Stryker4s mutation score", produces: "metric", units: ["%"], higherIsBetter: true, scopable: true, zoneScopable: true },
    { name: "coverage", description: "scoverage line coverage (changed lines with `on changed`)", produces: "metric", units: ["%"], higherIsBetter: true, scopable: true, zoneScopable: true },
  ],
  rules: RULES,
  integrity: [
    "executed-tests", "assertions-per-test", "skipped-tests", "suppressions", "quarantined-tests", "property-tests",
    "deleted-tests", "weakened-assertions", "new-skips", "new-suppressions", "test-refs-in-main", "exit-in-tests",
    "equality-overrides", "catch-all-near-changed-code", "env-branching", "mocks-of-class-under-test", "test-special-case-comments", "added-retries", "flaky-patterns",
  ],
}

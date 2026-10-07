import type { PackSpec } from "@gauntlet/dsl"
import { RULES } from "./rules.ts"

export const spec: PackSpec = {
  name: "typescript",
  description: "TypeScript and JavaScript: vitest, jest or bun test; tsc; Biome or eslint; StrykerJS; lcov coverage",
  runsSuites: true,
  gates: [
    { name: "build", description: "type checks with tsc --noEmit", produces: "outcome", units: [], higherIsBetter: true, scopable: false, zoneScopable: false },
    { name: "lint", description: "Biome or eslint, plus the zones' TypeScript rules", produces: "violations", units: [], higherIsBetter: false, scopable: true, zoneScopable: true },
    { name: "arch", description: "module dependency rules, from imports", produces: "violations", units: [], higherIsBetter: false, scopable: false, zoneScopable: false },
    { name: "mutation", description: "StrykerJS mutation score", produces: "metric", units: ["%"], higherIsBetter: true, scopable: true, zoneScopable: true },
    { name: "coverage", description: "line coverage from lcov (changed lines with `on changed`)", produces: "metric", units: ["%"], higherIsBetter: true, scopable: true, zoneScopable: true },
  ],
  rules: RULES,
  integrity: [
    "executed-tests", "assertions-per-test", "skipped-tests", "suppressions", "quarantined-tests", "property-tests",
    "deleted-tests", "weakened-assertions", "new-skips", "new-suppressions", "test-refs-in-main", "exit-in-tests",
    "equality-overrides", "catch-all-near-changed-code", "env-branching", "mocks-of-class-under-test", "test-special-case-comments", "added-retries", "flaky-patterns",
  ],
}

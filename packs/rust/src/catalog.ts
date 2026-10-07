import type { PackSpec } from "@gauntlet/dsl"
import { RULES } from "./rules.ts"

export const spec: PackSpec = {
  name: "rust",
  description: "Rust with Cargo: cargo build, cargo-nextest, clippy, cargo-mutants, cargo-llvm-cov",
  runsSuites: true,
  gates: [
    { name: "build", description: "compiles every target, tests included", produces: "outcome", units: [], higherIsBetter: true, scopable: false, zoneScopable: false },
    { name: "lint", description: "clippy, plus the zones' Rust rules", produces: "violations", units: [], higherIsBetter: false, scopable: true, zoneScopable: true },
    { name: "arch", description: "module dependency rules, from use declarations", produces: "violations", units: [], higherIsBetter: false, scopable: false, zoneScopable: false },
    { name: "mutation", description: "cargo-mutants mutation score", produces: "metric", units: ["%"], higherIsBetter: true, scopable: true, zoneScopable: true },
    { name: "coverage", description: "cargo-llvm-cov line coverage (changed lines with `on changed`)", produces: "metric", units: ["%"], higherIsBetter: true, scopable: true, zoneScopable: true },
  ],
  rules: RULES,
  integrity: [
    "executed-tests", "assertions-per-test", "skipped-tests", "suppressions", "quarantined-tests", "property-tests",
    "deleted-tests", "weakened-assertions", "new-skips", "new-suppressions", "test-refs-in-main", "exit-in-tests",
    "equality-overrides", "catch-all-near-changed-code", "env-branching", "mocks-of-class-under-test", "test-special-case-comments", "added-retries", "flaky-patterns",
  ],
}

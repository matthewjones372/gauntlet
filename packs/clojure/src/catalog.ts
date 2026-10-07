import type { PackSpec } from "@gauntlet/dsl"
import { RULES } from "./rules.ts"

export const spec: PackSpec = {
  name: "clojure",
  description: "Clojure on the JVM with deps.edn or Leiningen: clojure.test run by kaocha, clj-kondo, cloverage",
  runsSuites: true,
  gates: [
    { name: "build", description: "loads every namespace, main and test", produces: "outcome", units: [], higherIsBetter: true, scopable: false, zoneScopable: false },
    { name: "lint", description: "clj-kondo, plus the zones' Clojure rules", produces: "violations", units: [], higherIsBetter: false, scopable: true, zoneScopable: true },
    { name: "arch", description: "namespace dependency rules, from ns :require", produces: "violations", units: [], higherIsBetter: false, scopable: false, zoneScopable: false },
    // Listed so a policy can name it, and reported not executed: Clojure has no mature mutation tool.
    { name: "mutation", description: "not executed: Clojure has no mature mutation tool, so this is missing evidence", produces: "metric", units: ["%"], higherIsBetter: true, scopable: true, zoneScopable: true },
    { name: "coverage", description: "cloverage line coverage (changed lines with `on changed`)", produces: "metric", units: ["%"], higherIsBetter: true, scopable: true, zoneScopable: true },
  ],
  rules: RULES,
  integrity: [
    "executed-tests", "assertions-per-test", "skipped-tests", "suppressions", "quarantined-tests", "property-tests",
    "deleted-tests", "weakened-assertions", "new-skips", "new-suppressions", "test-refs-in-main", "exit-in-tests",
    "equality-overrides", "catch-all-near-changed-code", "env-branching", "mocks-of-class-under-test", "test-special-case-comments", "added-retries", "flaky-patterns",
  ],
}

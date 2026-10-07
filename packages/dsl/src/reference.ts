// A compact reference to the policy language, for agents: the authoring
// agent's prompt and the MCP `get_grammar` tool share it.

export const POLICY_REFERENCE = `Policy syntax (.gauntlet/policy.gx), one block per construct:

protect {
  tests    "src/test/**"            // reserved groups: tests, config, fixtures; others are allowed
  config   "*.gradle.kts", "gradle/**"
}
zone money {                         // code that needs its owners' review; scopes stricter rules
  paths "src/**/settlement/**"
  owner @payments                    // optional
  rule kotlin.no-floating-money      // rules from the catalog
}
arch { module domain must not depend on infra, web }
suites { unit "src/test/**" }
integrity {                          // only adds or tightens; defaults always apply
  ratchet executed tests, assertions per test
  forbid  new skips, new suppressions
  flag    env branching
}
import semgrep { command "semgrep scan --sarif --output {sarif}" }
gates {
  fast   { build, lint ratchet, arch }
  verify { unit, coverage >= 90% on changed, mutation ratchet >= 80% on changed in zone money }
}
on fail mutation { fix "Kill the surviving mutants listed in the report. Do not weaken tests." }
quarantine {                         // a known flaky test, excused by an owner until a date
  "svc.FxTest.rounding" until 2026-11-01 owner @payments
}
predicate small = diff < 150 lines and no zone touched
review {
  owner  when zone touched
  review when protected changed
  review when dependency added
  auto   when small and all gates pass
}

Review conditions: zone touched, no zone touched, protected changed, dependency added, budget changed, evidence missing, all gates pass, diff < N lines, or a predicate name. The most cautious matching rule wins; with no match the tier is review.`

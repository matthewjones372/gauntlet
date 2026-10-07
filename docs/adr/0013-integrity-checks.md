# 0013. Integrity checks: generic in core, language detectors in packs

Status: proposed

## Context
Checking that the verification wasn't weakened is what sets Gauntlet apart. Some checks can be derived from SARIF, JUnit and the diff alone. Others need language knowledge (what counts as an assertion, a skip, a suppression or an enclosing symbol).

## Decision
- Core defines the integrity framework: ratchets (which can't drop below base), forbids (which fail) and flags (which nominate `review`). It also implements the checks that need no language knowledge: executed counts, skipped counts, deleted test ids, test paths referenced from main code, and proximity to changed lines.
- Packs implement detectors behind a `Detector` interface that returns SARIF results and metrics. The JVM pack uses web-tree-sitter with the tree-sitter-kotlin grammar compiled to WASM and embedded in the binary.
- All integrity checks are on by default. The `integrity` block can only add or tighten (PLAN Q-G1). A check that no used pack implements is reported as not executed.
- `gauntlet selftest` proves the checks work against the project's real files, using built-in and project tamper fixtures.

- The `assertions per test` ratchet compares the total number of assertions in test code, not an average: an average fell whenever a small new test was added, which blocked good changes. Per-test weakening is caught by the `weakened assertions` forbid, which also covers a new test with no assertions.
- Suppression counts read comments only, so the same words in code or strings (a linter's own patterns, for example) don't count.

## Consequences
- Adding a language means adding a detector set and tamper-fixture instantiation, with no change to core.
- tree-sitter-kotlin in WASM is unproven in the compiled binary. It is the first task of the JVM milestone. If it fails, line-based detectors are the fallback, and the plan will say they are weaker evidence.

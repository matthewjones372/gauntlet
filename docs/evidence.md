# Evidence and testing the verifier

Back to the [README](../README.md).

## Evidence

Every check writes four files to its output directory:

| File | Contents |
| --- | --- |
| `gauntlet-report.json` | The decision, every nomination with its source line, checks, findings and failing tests |
| `gauntlet-report.md` | The same, for people (posted as the pull request comment) |
| `gauntlet-evidence.sarif` | Canonical SARIF 2.1.0 evidence: sorted, no timestamps, byte-identical for the same inputs |
| `gauntlet-run.json` | Timings and other run details, kept apart so they never affect the evidence |

The baseline (`.gauntlet/baseline.sarif`) is SARIF too. Findings carry
fingerprints that survive line shifts and renames, so a grandfathered finding
stays grandfathered when unrelated code moves.

## Testing the verifier

A verifier needs testing like anything else. `gauntlet selftest` applies known
tampering to a copy of your own project and confirms the policy catches each
one: a deleted test, a weakened assertion, an added skip, an added suppression,
a hardcoded expected value, test code referenced from main code, edited test
setup, a lowered threshold, an edited baseline and a planted result file. A
control run with no tampering must pass.

### The tamper corpus

`selftest` proves a policy against your own project. The **tamper corpus**
([spec 0002](specs/0002-tamper-corpus.md)) measures the detectors
themselves, in public: 56 committed cases under `corpus/tamper/`, one per
directory, each a patch against a pack's fixture in `examples/fixtures` with
the expected finding and a short note. Five per pack are tampering that must be
caught (a deleted test, an added skip, a weakened assertion, an added
suppression, test code referenced from main code). Three per pack must **not**
fire: a renamed test, an extracted helper and a tightened assertion.

```bash
gauntlet corpus
```

Measured on the current corpus:

| | Detected | False positives |
| --- | --- | --- |
| Each pack (Clojure, Go, JVM, Python, Rust, Scala, TypeScript) | 5/5 | 1/3 |
| All | 35/35 (100%) | 7/21 (33.3%) |

Every false positive is the same case: renaming a test with its body unchanged
reads as a deleted test. It's reported as it is until the detectors learn
renames. The corpus runs with the ordinary test suite, so a change that loses a
detection or adds a false positive fails CI.

When a change edits `.gauntlet/`, the GitHub workflow runs the selftest against
the proposed policy too, so a weaker policy has to prove it still catches
tampering.

Gauntlet is built under its own policy, in enforce mode. While it was being
developed, its own Stop hook blocked the coding agent working on it: for
renaming a protected test (which reads as a deleted test), for test changes
that had to wait for an owner, and for a skipped-test count that rose. In each
case the agent had to stop and report the block instead of working around it.


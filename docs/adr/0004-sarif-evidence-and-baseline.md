# 0004. SARIF 2.1.0 is the evidence and baseline format

Status: proposed (revision 2, replaces "grandfather by content fingerprint")

## Context
Gauntlet consumes many tools (test runners, mutation, coverage, linters, external scanners) and must grandfather existing findings without breaking when lines move. SARIF is the common format most scanners already emit. It has fields for fingerprints (`partialFingerprints`) and for baseline comparison (`baselineState`).

## Decision
- Every check's output is converted to a SARIF run. The evidence report ships a SARIF log, and the baseline is `.gauntlet/baseline.sarif`.
- Test counts, proof of execution and metrics live in `invocations` and `properties.gauntlet`.
- **Fingerprint `gauntlet/ctx/v1`** = `sha256(ruleId, normalised code window, enclosing symbol)`. The window is the result's lines plus two either side, with whitespace collapsed (and comments stripped when the pack supplies a normaliser). Results with no enclosing symbol use `gauntlet/ctx/v1/nosym`. The version is part of the key, so the algorithm can change without silently re-matching.
- **The path is part of the match key, not the hash.** The baseline doesn't store the code window, so a hash that included the path could never follow a rename. Instead, baseline paths are mapped through the diff's renames before matching on (path, rule, fingerprint).
- **Secondary keys** `gauntlet/symbol/v1` (rule and enclosing symbol) and `gauntlet/line/v1` (rule and the normalised offending line) let a finding whose surroundings changed still match as `updated`.
- Matching sets `baselineState`:
  - `unchanged`: exact match
  - `updated`: same rule and path, and the same enclosing symbol or the same offending line text, but a different window
  - `new`: no match
  - `absent`: in the baseline but no longer present
- `new` fails. `updated` is grandfathered and listed (PLAN Q-B1).
- **Fallback:** per-file counts for tools without stable locations. If a count rises, every result in that file for that rule is reported.
- Matching is one-to-one, so a second copy of a grandfathered finding is `new`.
- **Imports:** detekt baselines become a legacy grandfathered set in v1, stored in `baseline.sarif` and handed back to detekt as a generated baseline when it runs, so the repository's own `baseline.xml` is never trusted. External SARIF producers are run by Gauntlet itself (ADR 0012).

## Consequences
- Unrelated line moves don't invalidate the baseline. Editing around a finding marks it `updated`, which stays visible.
- External scanners plug in without per-tool code.
- The SARIF subset Gauntlet relies on is pinned in an Effect Schema. Fields outside it are dropped when external logs are decoded.

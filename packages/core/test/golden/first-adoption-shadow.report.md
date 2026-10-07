## Gauntlet: owner

**Tier owner.** Gauntlet doesn't block. Mode shadow (first adoption).

Policy `e2dfb6cfa346` from the working copy; base `111111111111`, head `222222222222`.

### Why

| Tier | Reason | Source | Blocks |
| --- | --- | --- | --- |
| owner | 1 caution signal (reviewer) raised the tier one step. | `caution` |  |
| review | The integrity check 'assertions per test' was not executed. | `integrity-not-executed` |  |
| review | The integrity check 'mocks of class under test' was not executed. | `integrity-not-executed` |  |
| review | trade-holdout was not executed: holdout pending: holdouts run only in CI | `.gauntlet/policy.gx:17` `behaviour { trade-holdout }` |  |
| review | No review rule matched, so the change needs review. | `no-rule-matched` |  |

### Checks

| Tier | Check | Status | Evidence |
| --- | --- | --- | --- |
| fast | build | passed | exit 0; 1 report (aaaaaaaaaaaa…) |
| fast | lint | passed | exit 0; 1 report (aaaaaaaaaaaa…) |
| verify | mutation | passed | exit 0; 1 report (aaaaaaaaaaaa…) |
| verify | unit | passed | 42 run, 0 failed, 0 skipped; exit 0; 1 report (aaaaaaaaaaaa…) |
| behaviour | trade-holdout | not executed | holdout pending: holdouts run only in CI |

### Imported findings

- **reviewer** (caution only): 1 new of 2

### Not executed

Each of these is missing evidence and nominates review.

- behaviour: trade-holdout: holdout pending: holdouts run only in CI
- integrity: assertions per test: no used pack implements it, or it had no data
- integrity: mocks of class under test: no used pack implements it, or it had no data

### Change

0 files, 12 lines changed.

### Policy

- 111111111111 has no .gauntlet/policy.gx, so this change adopts Gauntlet. Its own policy is used, in shadow mode.

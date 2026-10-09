## Gauntlet: owner

> [!WARNING]
> **Needs careful review by an owner (@platform)** because a check didn't run and no rule in the policy marks it as safe. It changes 0 files (12 lines).
>
> 5 things to look at:
>
> 1. 1 caution signal (reviewer) raised the tier one step.
> 2. Gauntlet has no evidence for one of its checks: the integrity check 'assertions per test' was not executed.
> 3. Gauntlet has no evidence for one of its checks: the integrity check 'mocks of class under test' was not executed.
> 4. Gauntlet has no evidence for one of its checks: trade-holdout was not executed: holdout pending: holdouts run only in CI
> 5. No rule in the policy says a change like this can merge on its own, so a person should look at it.

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

## Gauntlet: review

> [!CAUTION]
> **Blocked** because mutation failed, unit failed, it weakens or skips a test, it adds a lint finding, a score dropped below the baseline, it has a risky pattern and no rule in the policy marks it as safe. It changes 0 files (12 lines).
>
> 5 things to fix, and 2 more things to look at:
>
> 1. mutation failed: mutation score 71% is below the baseline 80%
> 2. unit failed: 1 test failed
> 3. A new @Disabled skips a test. (src/test/FxTest.kt:12)
> 4. New detekt.style.MagicNumber finding from lint (src/main/Fx.kt:5): 1.1 is a magic number
> 5. mutation dropped below the baseline (80 to 71).
> 6. System.getenv is used in a condition. (src/main/Fx.kt:20)
> 7. No rule in the policy says a change like this can merge on its own, so a person should look at it.

**Tier review.** Gauntlet blocks this change. Mode enforce.

Policy `e2dfb6cfa346` from the base; base `111111111111`, head `222222222222`.

### Why

| Tier | Reason | Source | Blocks |
| --- | --- | --- | --- |
| review | mutation failed: mutation score 71% is below the baseline 80% | `.gauntlet/policy.gx:16` `verify { unit, mutation ratchet on changed }` | yes |
| review | unit failed: 1 test failed | `.gauntlet/policy.gx:16` `verify { unit, mutation ratchet on changed }` | yes |
| review | A new @Disabled skips a test. (src/test/FxTest.kt:12) | `integrity-forbid` | yes |
| review | New detekt.style.MagicNumber finding from lint (src/main/Fx.kt:5): 1.1 is a magic number | `new-violation` | yes |
| review | mutation dropped below the baseline (80 to 71). | `ratchet-regression` | yes |
| review | System.getenv is used in a condition. (src/main/Fx.kt:20) | `integrity-flag` |  |
| review | No review rule matched, so the change needs review. | `no-rule-matched` |  |

### How to fix

- **mutation**: Kill the surviving mutants listed in the report. Do not delete or weaken tests.

### Checks

| Tier | Check | Status | Evidence |
| --- | --- | --- | --- |
| fast | build | passed | exit 0; 1 report (aaaaaaaaaaaa…) |
| fast | lint | passed | exit 0; 1 report (aaaaaaaaaaaa…) |
| verify | mutation | **failed** | exit 0; 1 report (aaaaaaaaaaaa…); mutation score 71% is below the baseline 80% |
| verify | unit | **failed** | 42 run, 1 failed, 0 skipped; exit 0; 1 report (aaaaaaaaaaaa…); 1 test failed |

<details><summary>What's mutation testing, and why does it take longer?</summary>

Mutation testing makes small deliberate bugs in your code (turning a `>` into `>=`, say) and runs your tests against each one. A bug that no test catches shows a test that runs the code but doesn't really check it.

It runs your tests once for every bug it makes, so it's by far the slowest check: minutes where your tests take seconds, and far longer across a whole project.

To keep it quick, run it only on the lines a change touches (`mutation >= 60% on changed`), only in the zones that matter (`... on changed in zone money`), or leave it out of the policy.

</details>

### Integrity

| Kind | Check | Where | Finding |
| --- | --- | --- | --- |
| flag | env-branching | `src/main/Fx.kt:20` | System.getenv is used in a condition. |
| forbid | new-skips | `src/test/FxTest.kt:12` | A new @Disabled skips a test. |

### New findings

| Check | Rule | Where | Message |
| --- | --- | --- | --- |
| lint | `detekt.style.MagicNumber` | `src/main/Fx.kt:5` | 1.1 is a magic number |

### Ratchets

| Metric | Base | Head | Change |
| --- | --- | --- | --- |
| mutation | 80 | 71 | -9 **worse** |

### Change

0 files, 12 lines changed.

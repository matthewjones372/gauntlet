## Gauntlet: auto

> [!TIP]
> **Low-risk change**: it can merge without anyone's approval. It changes 1 file (12 lines).

**Tier auto.** Gauntlet doesn't block. Mode enforce.

Policy `e2dfb6cfa346` from the base; base `111111111111`, head `222222222222`.

### Why

| Tier | Reason | Source | Blocks |
| --- | --- | --- | --- |
| auto | The policy's auto rule matched. | `.gauntlet/policy.gx:24` `auto when small and all gates pass` |  |

### Checks

| Tier | Check | Status | Evidence |
| --- | --- | --- | --- |
| fast | build | passed | exit 0; 1 report (aaaaaaaaaaaa…) |
| fast | lint | passed | exit 0; 1 report (aaaaaaaaaaaa…) |
| verify | mutation | passed | exit 0; 1 report (aaaaaaaaaaaa…) |
| verify | unit | passed | 42 run, 0 failed, 0 skipped; exit 0; 1 report (aaaaaaaaaaaa…) |

<details><summary>What's mutation testing, and why does it take longer?</summary>

Mutation testing makes small deliberate bugs in your code (turning a `>` into `>=`, say) and runs your tests against each one. A bug that no test catches shows a test that runs the code but doesn't really check it.

It runs your tests once for every bug it makes, so it's by far the slowest check: minutes where your tests take seconds, and far longer across a whole project.

To keep it quick, run it only on the lines a change touches (`mutation >= 60% on changed`), only in the zones that matter (`... on changed in zone money`), or leave it out of the policy.

</details>

### Change

1 file, 12 lines changed.

<sub>Written by claude-code, claude-sonnet-5-5, session s-123. Recorded only; agent identity never changes the decision.</sub>

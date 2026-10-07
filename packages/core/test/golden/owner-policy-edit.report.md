## Gauntlet: owner

**Tier owner.** Gauntlet doesn't block. Mode enforce.

Policy `e2dfb6cfa346` from the base; base `111111111111`, head `222222222222`.

Suggested reviewers: @payments, @platform

### Why

| Tier | Reason | Source | Blocks |
| --- | --- | --- | --- |
| owner | .gauntlet/policy.gx is under .gauntlet/; policy, baseline and self-test changes need an owner. | `gauntlet-changed` |  |
| owner | The policy's owner rule matched. | `.gauntlet/policy.gx:22` `owner when zone touched` |  |
| review | build.gradle.kts is protected (config); the change is undone for the run and needs review. | `.gauntlet/policy.gx:7` `config "*.gradle.kts"` |  |
| review | The policy's review rule matched. | `.gauntlet/policy.gx:23` `review when protected changed` |  |

### Checks

| Tier | Check | Status | Evidence |
| --- | --- | --- | --- |
| fast | build | passed | exit 0; 1 report (aaaaaaaaaaaa…) |
| fast | lint | passed | exit 0; 1 report (aaaaaaaaaaaa…) |
| verify | mutation | passed | exit 0; 1 report (aaaaaaaaaaaa…) |
| verify | unit | passed | 42 run, 0 failed, 0 skipped; exit 0; 1 report (aaaaaaaaaaaa…) |

### Change

0 files, 12 lines changed. Touches zone money (1 file); 2 protected files; dependencies in `build.gradle.kts`.

### Policy

- This change edits .gauntlet/; it is judged by the policy at 111111111111 and the edit nominates owner.

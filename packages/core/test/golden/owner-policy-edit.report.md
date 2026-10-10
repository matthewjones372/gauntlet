## Gauntlet: owner

> [!WARNING]
> **Needs careful review by an owner (@payments, @platform)** because it touches the money zone, it changes Gauntlet's policy or baseline and it changes protected build configuration. It changes 0 files (12 lines).
>
> 3 things to look at:
>
> 1. It changes code in the **money** zone (owner @payments): `src/main/money/Fx.kt`.
> 2. .gauntlet/policy.gx is under .gauntlet/; policy, baseline and self-test changes need an owner.
> 3. build.gradle.kts is protected (config); the change is undone for the run and needs review.

**Tier owner.** Gauntlet doesn't block. Mode enforce.

Policy `e2dfb6cfa346` from the base; base `111111111111`, head `222222222222`.

Suggested reviewers: @payments, @platform

### Needs your attention

- Zone **money** (owner @payments): `src/main/money/Fx.kt`

### How to approve

An owner (@payments, @platform) ticks this box, and the `gauntlet` check turns green:

- [ ] **Approve this change** (commit `222222222222`)

Or approve the pull request in Files changed, Review changes, Approve (GitHub doesn't allow that on a pull request you opened, including one an agent opened for you), or comment `/gauntlet approve 222222222222`. An approval counts for this commit only: a new push needs a new one.

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

<details><summary>What's mutation testing, and why does it take longer?</summary>

Mutation testing makes small deliberate bugs in your code (turning a `>` into `>=`, say) and runs your tests against each one. A bug that no test catches shows a test that runs the code but doesn't really check it.

It runs your tests once for every bug it makes, so it's by far the slowest check: minutes where your tests take seconds, and far longer across a whole project.

To keep it quick, run it only on the lines a change touches (`mutation >= 60% on changed`), only in the zones that matter (`... on changed in zone money`), or leave it out of the policy.

</details>

### Change

0 files, 12 lines changed. Touches zone money (1 file); 2 protected files; dependencies in `build.gradle.kts`.

### Policy

- This change edits .gauntlet/; it is judged by the policy at 111111111111 and the edit nominates owner.

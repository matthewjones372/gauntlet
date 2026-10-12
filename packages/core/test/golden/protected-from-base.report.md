## Gauntlet: owner

> [!WARNING]
> **Needs careful review by an owner (@platform)** because it changes Gauntlet's policy or baseline, a check didn't run and it changes protected build configuration. It changes 0 files (8 lines).
>
> 4 things to look at:
>
> 1. It changes Gauntlet's own settings (`.gauntlet/policy.gx`), so an owner needs to approve.
> 2. Gauntlet has no evidence for one of its checks: lint errored: scalafix isn't applied: add sbt-scalafix to project/plugins.sbt
> 3. It changes `project/plugins.sbt`, which is protected. Gauntlet checked the change without that edit, so a person needs to look at it.
> 4. It adds `project/scalafix.sbt`, which is protected. Gauntlet left it out of the run, so a person needs to look at it.

@platform: tick the box to approve this commit, and the `gauntlet` check turns green.

- [ ] **Approve this change** (commit `222222222222`)

**Tier owner.** Gauntlet doesn't block. Mode enforce.

Policy `237b8825c787` from the base; base `111111111111`, head `222222222222`.

Suggested reviewers: @platform

### Ran as the base has them

This change edits protected files, and Gauntlet ran them as the base has them, not as the change has them:

- `project/plugins.sbt` (config)
- `project/scalafix.sbt` (config), which the change adds, was left out
- `.gauntlet/policy.gx` (policy): rules, gates and budgets the change adds to it don't run yet

The change's version takes effect once it merges. **lint** errored with these files as the base has them: if the change adds what it needs there (a build plugin, a tool's configuration), this run didn't have it.

### How to approve

Tick **Approve this change** above, or approve the pull request in Files changed, Review changes, Approve (GitHub doesn't allow that on a pull request you opened, including one an agent opened for you), or comment `/gauntlet approve 222222222222`. An approval counts for this commit only: a new push needs a new one.

### Why

| Tier | Reason | Source | Blocks |
| --- | --- | --- | --- |
| owner | .gauntlet/policy.gx is under .gauntlet/; policy, baseline and self-test changes need an owner. | `gauntlet-changed` |  |
| review | lint errored: scalafix isn't applied: add sbt-scalafix to project/plugins.sbt | `.gauntlet/policy.gx:12` `fast   { build, lint }` |  |
| review | project/plugins.sbt is protected (config); the change is undone for the run and needs review. | `.gauntlet/policy.gx:7` `config "project/**"` |  |
| review | project/scalafix.sbt is protected (config); the change is left out of the run and needs review. | `.gauntlet/policy.gx:7` `config "project/**"` |  |
| review | The policy's review rule matched. | `.gauntlet/policy.gx:16` `review when protected changed` |  |

### Checks

| Tier | Check | Status | Evidence |
| --- | --- | --- | --- |
| fast | build | passed |  |
| fast | lint | **errored** | scalafix isn't applied: add sbt-scalafix to project/plugins.sbt |
| verify | unit | passed |  |

### Not executed

Each of these is missing evidence and nominates review.

- fast: lint: scalafix isn't applied: add sbt-scalafix to project/plugins.sbt

### Change

0 files, 8 lines changed. Touches 4 protected files.

# 0003. Load policy from the base ref and materialise protected files from it

Status: proposed (revision 2)

## Context
The coding agent can edit anything in its branch: policy, tests, test setup, runner config and baselines. If any of these came from the PR head, the agent could lower the bar and then pass it.

## Decision
- In CI, `gauntlet check --policy-ref <base-sha>` reads all of `.gauntlet/` from the base SHA.
- Before any gate runs, Gauntlet builds a worktree at head and materialises these from base:
  - every `protect` group
  - the runner config the pack declares (for the JVM pack: Gradle test configuration, `settings.gradle.kts`, `gradle/`, `junit-platform.properties`, test resources)
- Suites run in a fresh process in that worktree.
- Head differences in protected files are protected changes. They nominate a tier and never affect how the change is judged.
- `.gauntlet/` is always protected, and any change to it nominates `owner`.
- Locally, the working-copy policy is used. Gauntlet prints a clear drift warning and records which policy it used.
- If base config can't build the head, the gate is `not-executed` with a stated reason. That is missing evidence, never a pass.

## Consequences
- Policy changes take effect only after merge and always pass an owner.
- A PR that legitimately changes build config gets missing evidence and a `review` nomination until it merges. That cost is deliberate.
- New test files in the `tests` group do run (PLAN Q-P1), so adding tests is not penalised.

# 0019. Holdouts name their files in the policy and run only in the evidence job, from base

Status: accepted (spec 0003)

## Context
`holdout "<name>" ci only` was parse-only: it named a holdout without saying which files it was, so nothing could run it. PLAN Q-H1 proposed that CI supply the holdout from a directory outside the repository (`--holdout name=<dir>`). That needs a second secret store, a trusted checkout of it and a way to keep it in sync with the code it tests. For a first version, holdout files kept in the repository and judged from the base commit give most of the value with none of that.

## Decision
- **One construct.** A holdout takes an optional `paths "<glob>", ...`, the same shape as a zone's `paths`. It compiles to `globs` on the holdout suite in the IR, omitted when absent, so existing policies keep their IR hash. Without `paths` a holdout is pending, as before.
- **Taken out everywhere else.** Every worktree Gauntlet prepares removes the files matching holdout globs after materialising protected files. They aren't protected tests: they are never restored for an ordinary run. A head change to a holdout path is left out of the run and nominates review (`protected-changed`, group `holdout <name>`).
- **Run only with `--holdouts`.** `gauntlet check --holdouts` is the evidence job's flag. A holdout check then copies the base commit's holdout files into the worktree, runs the suite-running pack over the holdouts' common directory, and removes them again, so later checks and the integrity detectors never see them. Without the flag the check is "holdout pending" (not executed).
- **A holdout gap is its own outcome.** A failing holdout while every visible suite passed is reported with `holdoutGap: true` and counted separately in the gate line of the GitHub summary.
- **Redacted output.** Holdout failures name test ids only; SARIF result messages become "holdout test failed". Holdout tests don't join the executed-tests count, and holdout runs aren't rerun for flakiness.
- **The agent's sandbox.** `connect claude-code` denies Read, Edit, Write, Grep and Glob on holdout paths.

## Consequences
- Anyone with repository read access can read the holdouts; the boundary is the agent's sandbox and Gauntlet's worktrees, not secrecy. A source outside the repository (Q-H1) can be added later behind the same `paths` construct.
- Running the holdout's directory runs the visible tests there too. The visible suites already passed, so a failure is attributed to the holdout; a flaky visible test can show up as a holdout gap.
- The trusted status job takes the holdout outcome from the evidence report, like every other gate (ADR 0015).

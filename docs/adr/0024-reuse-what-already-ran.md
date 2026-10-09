# 0024. What the project's CI, or a local run, already ran isn't run again

Status: accepted. Narrows ADR 0012 for tests, coverage and the build.

## Context
ADR 0012 has Gauntlet produce its own evidence: it trusts only what a process it started wrote into a fresh directory, because an agent could plant a passing report. So on a project with its own CI, every pull request built and tested twice, once by the CI and once by Gauntlet, and locally Gauntlet ran tests the agent had just run.

## Decision
- **GitHub.** `gauntlet connect github` adds steps to each of the project's build jobs that keep their JUnit and coverage reports (Gradle, Kover, JaCoCo, sbt, scoverage) as artifacts named `gauntlet-reports-<job>`, under paths from the repository's root. It also asks builds that have Kover or scoverage to measure coverage while their tests run. Gauntlet's evidence job waits for the project's runs on the same commit and downloads those artifacts. `check --ci-reports` then reads a build's tests, coverage and compile from them, and runs nothing for those checks.
- **Locally.** The working-tree check reads the same report files from a run on the machine when git ignores them and they're newer than every file the change touches. A repeat check of the same tree already reused its own last report.
- **When it's trusted.** Never when the change edits the CI's workflows or a protected file other than a test (build files, fixtures, runner configuration, `.gauntlet/`): those could shape the CI's run. Never for a report that is a file in the repository. A pack reads such reports only if it says it can (`readsCi`: the JVM and Scala packs); for others, and for any build the CI kept nothing for, the check runs as before.
- **Proof.** A check read this way records `ci` and where the reports came from (the CI run's URL, or "your local run") as its command. The CI's failures are failures: there's no rerun, since its run can't be repeated here.
- **What still runs.** Checks the CI didn't run, mutation testing for example, and lint, arch or budgets.

## Consequences
- A pull request is built and tested once, by the project's CI. Gauntlet's job spends the CI's run time waiting (up to an hour) instead of building.
- A local report could be written by an agent. That only spares the local check a run: the GitHub check judges the pull request from the CI's own run, which the agent can't write.
- Flaky tests are no longer told apart from failures when the reports come from CI.

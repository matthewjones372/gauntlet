# 0017. Flaky tests are caught where they enter, and excused only by an owner until a date

Status: accepted (implemented in M15)

## Context
A flaky test blocks good changes at random, and teaches people to retry until green, which hides real failures. Agent-written tests are where most flakiness will enter. The usual fixes (retry plugins, quarantine tags in test code) are themselves ways to weaken verification without anyone deciding to.

## Decision
- **New flakiness blocks.** New and changed test files in a suite run three more times, shuffled, with seeds derived from the judged commit. A test that both passes and fails across the four runs is a new flaky test, and the suite fails.
- **Old flakiness needs a person.** A failed test is run again on its own. If it passes, it's classified flaky rather than fixed: the suite passes, and the check nominates review naming the test. If it fails again, it's a real failure.
- **Packs opt in.** A pack's suite runner takes a subset (files and test ids) and a seed, and declares `reruns`. The JVM pack selects classes with `--tests` and seeds JUnit's random class and method orderers through the init script; the TypeScript pack passes files and the runner's shuffle and seed flags (bun, vitest, jest); the Python pack maps test ids to modules, sets `PYTHONHASHSEED`, and uses pytest-randomly's seed when the project has it. Without reruns the report says so.
- **Retries are forbidden.** `added retries` (Gradle test-retry, JUnit Pioneer's `@RetryingTest`, `jest.retryTimes`, retry counts, pytest-rerunfailures, the flaky package) is a default forbid, found in added lines of test files and build and test configuration. `flaky patterns` flags real sleeps, the wall clock, unseeded randomness and real network calls in new test code.
- **Quarantine is policy.** `quarantine { "<test id>" until <date> owner @team }` is a top-level block. A quarantined test still runs; until the date (inclusive) its failure doesn't fail the suite, and the report lists it. After the date the failure blocks and the reason says the quarantine expired. "Today" is the judged commit's committer date in UTC, so a decision never depends on when it runs. Adding a quarantine or extending its date is a policy change (owner tier, judged by the base policy) and counts as loosening for the authoring agent.
- **History.** Each check records its suites' failing and flaky tests in the shadow notes; `gauntlet report flaky` lists tests that both passed and failed on identical code.

## Consequences
- The two new default integrity checks changed every policy's IR hash once.
- Repeat runs cost three runs of the changed test files only, never the whole suite.
- Flakiness that needs more than four runs to show can still get through; the history and the rerun of every failure catch it later.

# 0021. An edited protected test runs as edited and needs review

Status: accepted

## Context
Every change to an existing protected test was undone before the gates ran, and Claude Code's edit hook refused it. That kept an agent from weakening a test to pass, but it also blocked the ordinary case: a requirement changes, and the tests that state it must change with the code. The agent had to stop and report itself blocked, the person had to edit the test by hand, and the pull request still failed because the base's test ran against the new code.

## Decision
- The edit hook allows changes to existing files in a `tests` protect group, as it already allowed new ones. Protected configuration, fixtures, runner configuration and `.gauntlet/` stay locked.
- In `check` and the full-policy GitHub check, a modified, deleted or renamed protected test is left as the change has it (action `edited`) and runs. Each one nominates the change for review (`protected-changed`), so it is never auto-approved. Integrity checks are unchanged: new skips, weakened assertions, deleted tests and test special-cases in main code are still found in the diff.
- `check --protect-only` (spec 0001) keeps restoring protected tests from the base. It is pass or fail with no review step, so the base's tests are its only defence.

## Consequences
- A requirement change no longer blocks; it waits for a person's review, which the GitHub check enforces through the ruleset's code owner review.
- A test weakened in a way the integrity checks don't recognise now runs as weakened. Review is what catches it, which is why an edited test always raises the tier.
- The adoption window (spec 0005) no longer gates test edits; it still records the tests edited while it is open.

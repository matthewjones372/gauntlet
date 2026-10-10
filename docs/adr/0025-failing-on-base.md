# 0025. A test already failing before the change doesn't block it

Status: accepted. Narrows the rule that a failed check blocks in enforce mode, for tests only.

## Context
A suite that fails blocks the change in enforce mode. When a test was already failing on the base (broken on main, or by the environment), every change after it was blocked for something it didn't do, and the only ways out were to fix an unrelated test or to override.

## Decision
- A failure that counts (not flaky when run again alone, not quarantined) runs once more with the files the change touches as the base has them: changed files go back to their base content, added ones are taken out, deleted ones come back. Afterwards the checkout is exactly as it was, so protected files already put back to the base stay that way (`PreparedWorkspace.withBase`).
- A test that ran there and failed again was failing before the change. One that passed there, or didn't run there (new with the change), is the change's.
- If every failure that counts fails on the base too, the check is still `failed` and names them `(fails on the base too)`, but it nominates `review` without blocking (`failing-on-base`). If any failure is the change's, it blocks as before. An expired quarantine still blocks.
- Only for packs that can run single tests (`reruns`), and not for failures read from CI reports (ADR 0024), which can't be run again here.

## Consequences
- A broken main no longer blocks every change; a person still sees the failing test.
- The rerun costs one run of only the failing tests, and only when tests fail.
- Files the change doesn't touch are the head's in that run: a failure caused by an earlier commit on the same branch, outside this change's files, would count as already failing. The base here is the pull request's base, so for a pull request that is the whole branch.

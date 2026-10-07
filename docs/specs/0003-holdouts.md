# Spec 0003: thin holdouts

Status: implemented on branch `holdouts`.

## Problem

An agent that can read every test can write code that passes those tests and
nothing else. A holdout is a set of tests the agent never sees, run only where
the agent can't reach. The DSL already has `holdout "<name>" ci only`, but it
names a holdout without saying which files it is, so nothing can run it and
every policy that uses one reports "holdout pending" forever.

## What it is

One construct (ADR 0019): an optional `paths` list on a holdout.

```text
suites {
  unit    "internal/**"
  holdout "acceptance" paths "internal/**/*_holdout_test.go" ci only
}
gates {
  tests { unit }
  behaviour { acceptance }
}
```

A holdout without `paths` keeps working exactly as today (parsed, reported as
pending). With `paths`, the files it matches are the holdout:

1. **Never in an ordinary run.** Every worktree Gauntlet builds (local checks,
   baselines, the GitHub evidence job's visible run, the trusted job's checkout)
   has the holdout files taken out after protected files are put back. They are
   not restored as protected tests and don't count toward executed tests or
   integrity.
2. **Never in the agent's reach.** `gauntlet connect claude-code` adds deny
   rules for reading, searching and editing the holdout paths.
3. **Run only in the evidence job.** `gauntlet check --holdouts` (which
   `connect github` adds to the evidence job, and nothing else uses) runs a
   holdout check by putting the **base commit's** holdout files into the
   worktree, running the pack's suite runner over the holdout's directory, and
   taking them out again. Anywhere else the check is "holdout pending".
4. **Head changes are ignored.** A change that adds, edits or deletes a file
   under a holdout path is left out of the run and nominates review, like any
   protected change. Deleting a holdout test is also a `deleted-tests` forbid,
   as for any test.

## Verdict

- The holdout's tests all pass: the check passes.
- A holdout test fails while every visible suite passed: the check **fails**
  and is reported as a **holdout gap**, not as a unit failure. The report marks
  the check `holdoutGap: true`, the reason says "holdout gap", and the GitHub
  summary's gate line counts it separately:

  ```text
  Integrity: no forbidden changes.
  Gates: 2 passed, 1 holdout gap (acceptance).
  ```

- No holdout tests ran, or no report was produced: the check fails (a silent
  green fails).
- Output is cut down to test names (PLAN invariant 11). Failure messages and
  the SARIF results' text are replaced with "holdout test failed"; the report
  names only the failing test ids. Holdout runs aren't rerun for flakiness.

## Not in this change

- No suite generator.
- No holdout source outside the repository (PLAN Q-H1's `--holdout name=<dir>`).
  Holdout files live in the repository, so anyone with read access can see
  them; the boundary is the agent's sandbox and Gauntlet's worktrees.

## Tests

- DSL: `paths` compiles to IR `globs`; an IR without it is byte-identical.
- Workspace: holdout files are absent from the judged checkout; head edits to
  them are left out and reported.
- Gate runner: pending without `--holdouts` or without `paths`; with both, a
  failing holdout after passing visible suites is a holdout gap with only test
  names.
- End to end, real Go fixture (`examples/fixtures/go-service`): a holdout test
  added at base; a change that keeps the visible tests green but breaks the
  holdout fails as a holdout gap; an unchanged head passes.

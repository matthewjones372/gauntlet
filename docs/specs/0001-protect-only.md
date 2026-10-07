# Spec 0001: protect-only mode

Status: implemented on branch `protect-only`.

## Problem

A sceptical reviewer's first question is "what's the smallest useful thing
this does?" Today the answer comes with zones, a review ladder, ratchets,
mutation and a baseline. Most of that is valuable, but none of it is needed to
show the core claim: an agent can't weaken the checks that judge its change.

## What it is

`gauntlet check --protect-only` runs the verification boundary and nothing else:

1. The policy, the protected paths and each pack's runner configuration come
   from the **base commit**, locally as well as in CI (normally a local check
   uses the working copy's policy).
2. Protected paths and runner configuration are **restored** from the base in a
   fresh worktree.
3. The existing gates run there, each writing to a **fresh evidence directory**.
   Only output from processes Gauntlet started is read.
4. The normal report files are written.

What it leaves out:

- **No zones.** Zones, zone rules and zone-scoped checks are ignored.
- **No review ladder.** Review rules aren't evaluated. The verdict is pass or
  fail.
- **No mutation.** Mutation checks don't run.
- **No ratchets.** No comparison with a baseline. A check whose only criterion
  is a ratchet (`lint ratchet`, `coverage ratchet on changed`) is dropped. A
  check with an absolute rule keeps it (`coverage >= 80% on changed`, `arch`,
  `build`, suites). Integrity ratchets are dropped; integrity forbids and flags
  stay.
- **No imports, holdouts, budgets or `llm review`.**

## Verdict

The change **fails** if any of these hold, and passes otherwise:

- a gate failed, errored or wasn't executed (missing evidence is never a pass,
  and a suite that runs no tests fails);
- an integrity forbid fired (deleted, skipped or weakened tests, suppressions,
  test references in main code, `exit` in tests, added retries).

Integrity flags and protected-path edits are reported but don't fail the
change. Protect-only always enforces, even if the policy says `mode shadow`:
it's an explicit request for the minimal boundary, and its job is to fail.

In the report, `decision.scope` is `"protect-only"`, the tier is `review` (a
person still reviews as usual) and `blocking` is the verdict. Reports without
the flag are unchanged, byte for byte.

## GitHub

`gauntlet connect github --protect-only` writes the same two-job workflow with
`--protect-only` on both jobs. The check's title is "Protect-only: passed" or
"Protect-only: failed".

For every check run, protect-only or not, the summary starts with two lines
that can't collapse into one badge: the **integrity verdict**, then the **gate
results**. The `auto` title is unchanged.

```text
Integrity: 1 forbidden change (weakened assertion).
Gates: 3 passed, 1 failed (unit).
```

## Not changed

`gauntlet check` without the flag behaves exactly as before. The DSL, the
policy file and the baseline format are unchanged.

## Tests

- Unit: the IR reduction (what's dropped and kept), the verdict, the two-line
  summary.
- CLI: `check --protect-only` on a repository whose policy says `mode shadow`.
- End to end, real Go fixture (`examples/fixtures/go-service`): a clean change
  passes; replacing an assertion with a tautology fails, with the original
  protected test run and the forbid reported.

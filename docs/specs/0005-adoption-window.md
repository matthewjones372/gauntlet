# Spec 0005: first-run fixes and the adoption window

Status: implemented on branch `setup-prompt-installs`.

## Problem

A project adopting Gauntlet often has checks that already fail: a broken test,
lint findings, a coverage floor it doesn't meet yet. Two things went wrong:

- `/gauntlet-setup` never offered to fix them, so the person was left to work
  out what to do.
- The Stop hook judged the setup session, whose only change was the proposal
  file, against failures the agent didn't cause and couldn't fix (protected
  tests are locked). Every turn ended with the same block: a loop.

## What changes

1. **Nothing to judge, nothing to block.** When the working tree changes
   nothing but Gauntlet's own setup files (`gauntlet.proposal.gx`,
   `.claude/**`, `.mcp.json`, `CLAUDE.md`, `AGENTS.md`) compared with its
   base, the Stop hook lets the agent stop without running any gate.
2. **`/gauntlet-setup` offers to fix first-run failures.** After `gauntlet
   apply`, it runs a check. If anything fails it says what, asks "Do you want
   me to try to fix these? I'll report every change I make", fixes what it
   can, and reports every file it changed, protected tests separately. It also
   asks, per missing tool, whether to set it up or skip it.
3. **The adoption window** (`gauntlet adopt`) is the one time an agent may
   edit protected tests:
   - Only a person opens it: it needs a terminal and the typed word `adopt`,
     which an agent's shell can't provide.
   - It covers protected tests only. `.gauntlet/`, protected configuration (the
     deny rules) and `.git/` stay locked.
   - While it's open the Stop hook judges the edited tests instead of
     restoring the base copies. Integrity checks still run, so weakening a test
     is still caught.
   - Every protected test the agent edits is recorded. `gauntlet adopt
     --status` and `--close` print the report.
   - It closes by itself at the next commit: it's tied to the commit HEAD
     pointed at when it opened.
   - CI is unchanged: protected tests are still restored from the base, and a
     pull request that changes them still needs review.

## Not a security boundary

The window relaxes a local guard. An agent with a shell could still write
files directly; the boundary that can't be bypassed is CI, which this doesn't
change.

## Tests

- Stop hook: only setup files changed on an already-failing project passes; a
  code change on the same project is judged and blocked.
- `adopt`: refused without a terminal; any word but `adopt` leaves it shut;
  open, a protected test edit is allowed and recorded while `.gauntlet/` and
  `.git/` stay denied; a commit closes it; `--close` prints the report.

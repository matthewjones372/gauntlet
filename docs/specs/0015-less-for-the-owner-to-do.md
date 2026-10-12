# Spec 0015: less for the owner to do

Status: proposed.

## Problem

Gauntlet is meant to help a developer, but on a real repository the owner spends much of their time feeding it. In
one day on tweet-street, with an agent doing the work:

- **Each owner decision was several steps.** A forbidden finding the owner accepts (a test moved to a budget, skips
  from an opt-in e2e file) took `gauntlet override` on the right commit, a push of `refs/notes/gauntlet-overrides`,
  then `/gauntlet approve <sha>`, then another `/gauntlet approve` because pushing the note doesn't re-run the check.
  The agent had to look up each SHA for them.
- **A baseline PR blocks itself.** `gauntlet baseline --update --allow-lower` writes the new baseline, but its PR is
  judged against the base's old one, so it always fails its own check and always needs an override.
- **A stack loses its approvals.** Rebasing a stack onto a moved main gives every PR a new commit, so each approval
  is void even when its code is unchanged; stack parts merged into their stack branches, not main, because nothing
  retargeted them; and reopening a PR to re-run the check kept its stale base commit.
- **The agent can't touch protected paths, so the owner types every config change.** Moving a timing test into a
  budget needed a line in `.gauntlet/policy.gx` and one in `.github/workflows/build.yml`; the agent could only paste
  the owner instructions. That's the point of protection, but there's no middle ground between "agent may" and "owner
  types it".

## Behaviour

### 1. One command per owner decision

`gauntlet approve <pr>` approves the pull request's current head as the owner: it posts the approval, and with
`--override "<reason>"` it records the override for that commit, pushes the note and approves in one go, so the check
re-runs once. It refuses if the head moved since the owner last looked (`--head <sha>` to name it), and it never runs
for an agent identity (the identity check of ADR 0012).

### 2. A baseline PR carries its own decision

A pull request whose only change is `.gauntlet/baseline.sarif`, written by `gauntlet baseline`, is judged against the
baseline it brings for the metrics it lowers, and is owner tier. The owner's approval accepts the lower bar; no
separate override. Any other file in the same PR, and it's judged as now.

### 3. Approvals follow the code, not the commit

An approval records the tree of the approved commit and the base it was judged against. A new commit whose tree and
judged diff are the same (a rebase that changed nothing, a merge of identical content) keeps the approval; any change
to the diff voids it, as now. `gauntlet connect github` adds stack support: when a stack PR's base branch merges, the
PR above is retargeted to main before its branch is deleted. A reopened PR is judged against the base branch's current
tip, not the stale base commit in the event.

### 4. The owner can let the agent edit a protected path, once

`gauntlet grant <pr> <path>... --reason "<why>"` (owner only) records in a note that, for this pull request, the
agent may change those paths. Claude Code's hook allows the edit, and the check then judges the change as owner tier
naming the grant: it's reviewed, not hidden. A grant covers one PR, never `.gauntlet/` decisions such as approvals or
overrides, and expires when the PR merges or closes.

## Not covered

- Changing what is protected, or the tiers.
- Approving on the owner's behalf: every decision above is still the owner's, made in fewer steps.

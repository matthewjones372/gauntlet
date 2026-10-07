# 0014. Overrides are explicit, recorded and approved; no comment commands

Status: proposed

## Context
Teams sometimes need to merge despite a failing gate. Comment commands such as "/approve" can be posted by the agent or by anyone who can comment.

## Decision
- Gauntlet never reads PR comments as commands.
- `gauntlet override --reason <text> --approver @x` records `{ headSha, irHash, reason, approver, requestedBy }` as a git note under `refs/notes/gauntlet-overrides`.
- An override never changes the computed tier. It turns blocking into non-blocking and appears in the report.
- On GitHub, an override is honoured only if `@x` is a policy owner (PLAN Q-O1) or an owner of a touched zone, and has an approving review on that exact head SHA. A new push invalidates it.
- Locally, overrides are shown but never count as approved.

## Consequences
- The agent can request an override but can't make one take effect.
- Overrides are auditable and counted in `report shadow`.

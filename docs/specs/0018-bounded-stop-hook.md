# Spec 0018: a bounded exit for the Stop hook

Status: implemented. Decision in ADR 0026.

## Problem

The Stop hook keeps an agent working while Gauntlet would block its change. With an
orchestrator dispatching subagents, that hook has to do three things it didn't:

- check subagents at all (`SubagentStop`), each against its own worktree;
- give a worker that can't make the change pass a way to stop that is bounded,
  explicit and never a pass;
- let the orchestrator read the outcome without parsing prose.

Before this spec, the hook let any agent stop silently on its second stop
(`stop_hook_active`). Without that rule it would loop until the context ran out.

## Behaviour

### 1. Events and the tree checked

`gauntlet connect claude-code` installs `gauntlet hook stop` for both `Stop` and
`SubagentStop`. The hook reads `cwd` from its input and judges the git worktree
that contains it (`git rev-parse --show-toplevel`). Two subagents in two
worktrees are each judged on their own tree and counted on their own branch.
`stop_hook_active` is no longer read: the attempt limits are the bound.

### 2. Attempts

An **attempt** is a stop whose check would block, unless it is the block the
agent already reported with `report_blocked` (§5).

The **fingerprint** of an attempt is the sha256 of a sorted, de-duplicated list of
lines drawn from the report's blocking findings:

| Source | Line |
|---|---|
| a required check that failed (not one already failing on the base) | `gate <check> <status>`, and `test <check> <id>` for each failing test id |
| a new violation | `violation <check> <rule id> <path>` |
| a regressed ratchet | `ratchet <metric> <file>` |
| a forbid or ratchet integrity finding | `integrity <kind> <check> <path>` |
| every blocking nomination | `rule <rule>` |

Messages, counts, durations and line numbers are left out, so the same problem
gives the same fingerprint run after run and after unrelated edits move it.

The record for a branch holds `unchanged` (consecutive attempts with this
fingerprint) and `total` (attempts since the branch last passed). For each attempt:

```
unchanged = (fingerprint == previous fingerprint) ? previous unchanged + 1 : 1
total     = previous total + 1
exhausted = unchanged > limit.unchanged  or  total > limit.total
```

So with the defaults the hook blocks three times on the same findings, and the
fourth stop on them is exhausted. Or it blocks eight times in all, and the ninth
blocking stop is exhausted. A stop that passes deletes the record. A stop on an
exhausted branch stays exhausted until the branch passes or a person runs
`gauntlet hook reset`.

The branch is the checked-out branch's name. On a detached HEAD it is
`detached:<worktree>`, where `<worktree>` is the linked worktree's name (`main`
for the main one).

### 3. Limits in the policy

```
attempts { unchanged 3, total 8 }
```

Both limits are optional whole numbers from 1. A limit that is left out takes its default
(3 and 8). `unchanged` above `total` is an error, because it could never be
reached. The IR keeps only what the policy states (`attempts?: { unchanged?, total? }`),
so policies without the block keep their hashes. The hook reads the limits from
the base policy, as CI does, never from the working copy.

Raising either effective limit is a loosening (`looseningsBetween`), with its own
confirmation. Lowering one tightens. Any edit under `.gauntlet/` needs an owner.

### 4. State, and what happens when it's tampered with

- File: `<git common dir>/gauntlet/attempts/<hex of branch>.json`.
- Witness: `refs/gauntlet/attempts/<hex of branch>`, pointing at the blob of the
  file's exact bytes (`git hash-object -w`). Both live in the common directory, so
  every worktree of a repository shares them and none of them holds them.
- Neither exists: a fresh branch, counts 0.
- Both exist, the witness names the file's bytes and the file parses: those counts.
- Anything else (file missing, witness missing, mismatch, unparseable or
  unreadable): the record counts as already at both limits, with the current
  fingerprint. The next blocking stop is exhausted, with `state: "missing"` or
  `"corrupt"`. It is never a fresh start, and never a quiet stop.
- The written record has no timestamps. File and witness are written file first,
  then witness. A crash between the two leaves a mismatch, which counts as at the limit.

The generated deny rules add `//**/.git/gauntlet/**` for each tool that writes
files. The PreToolUse hook refuses writes anywhere in the git common directory
(not just `.git/` inside the worktree). It also refuses Bash commands that name
`gauntlet/attempts`, `refs/gauntlet` or `gauntlet hook reset`.

### 5. Outcomes

`gauntlet hook status [--branch <name>] --json` and the MCP resource
`gauntlet://attempts` give records of this shape:

```json
{
  "status": "blocked" | "exhausted" | "reported-blocked",
  "branch": "feature/x",
  "attempts": { "unchanged": 4, "total": 4 },
  "limits": { "unchanged": 3, "total": 8 },
  "fingerprint": "<sha256>",
  "findings": ["gate unit failed", "rule gate-failed", "test unit AddTest.adds"],
  "reasons": ["gate-failed: unit failed: 1 of 2 tests failed"],
  "state": "ok" | "missing" | "corrupt",
  "reportedReason": "…"
}
```

- **blocked**: the hook blocked this stop. The reason says which attempt this
  is. On the last one before exhaustion it says that the next stop on the same
  findings will end the attempt, and to say so in the final message.
- **exhausted**: the hook let the agent stop. Its single line (`systemMessage`)
  is `Gauntlet: exhausted on <branch> after <n> blocked attempts (<why>). The
  change still fails its checks; details: gauntlet hook status --json`.
- **reported-blocked**: the agent's `report_blocked` still matches, so it is waiting
  on the owner. The counts are kept and not advanced. This is a different outcome from exhausted.

The resource returns every branch's record, sorted by branch, as
`{ "branches": [ … ] }`. A record that fails its witness is listed with
`state: "corrupt"` and no counts, rather than being left out.

### 6. Exhausted is still a failure

Nothing else reads the attempt state. `gauntlet check` judges the tree as before
and exits 1 when it blocks. The GitHub status job recomputes its decision from the
base policy, git and the evidence job. A review level is satisfied only by an
approval on GitHub. An exhausted branch fails exactly as it would have without the
hook.

### 7. Selftest and the corpus

State tampering is a new tamper category. `gauntlet selftest` gains a
`hookState` section, kept apart from the commit fixtures. In a scratch
repository, under the policy's limits, it records one attempt, then tampers by
deleting the file, corrupting it, deleting the witness, or forging a lower count.
It requires the next attempt to be exhausted, and requires a control run with no
tampering to still block. Any miss fails the selftest.

`corpus/stop-hook/<case>/case.json` holds the same cases as data, each with a
`NOTE.md`. `gauntlet corpus --stop-hook` runs them.

## Not covered

- An agent that deletes both the file and its witness gets a fresh count. The deny
  rules and the PreToolUse hook are what stop it. It never changes a verdict.
- Codex, Cursor and Copilot adapters: the hook spec gains `subagent-stop`, and
  only the Claude Code renderer ships.

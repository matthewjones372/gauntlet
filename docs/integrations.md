# Claude Code and GitHub

Back to the [README](../README.md).

## Coding agents

`gauntlet connect claude-code` gives Claude Code:

- **Stop and SubagentStop hooks**: the agent, or a subagent, can't finish while
  Gauntlet would block the change, up to the policy's attempt limits;
- a **PreToolUse hook** and **deny rules** for protected paths, `.gauntlet/`
  and Gauntlet's state in the git directory;
- the **Gauntlet MCP server** (`check`, `explain`, `validate`, `get_grammar`,
  `get_examples`, `author_draft`, `report_blocked`, and the `gauntlet://attempts`
  resource);
- a short instructions block in `CLAUDE.md` and `AGENTS.md`;
- the `/gauntlet-setup` command.

When a requirement changes, the agent may change the tests that state it: the
change then needs review, never auto. When a task can't be done without
changing protected configuration or policy, the agent calls `report_blocked`
with the reason. That's a legitimate outcome: the change
goes to a person instead of the agent weakening the checks. While the owner
works on it, the Stop hook doesn't raise the same block again: it says "still
waiting on the owner" in a line, for as long as the blocking findings are the
ones reported and only files the agent can't edit (protected files other than
tests) have changed. A new or different finding, or any other edit, blocks again.

### The hooks and their bounded exit

The same `gauntlet hook stop` runs for `Stop` (the main agent) and
`SubagentStop` (a subagent). It judges the git worktree that holds the hook
input's `cwd`, so a subagent working in its own worktree is checked against
that worktree and its branch, not the repository's root.

Each stop the check blocks is an **attempt**, counted per branch. The hook
fingerprints what blocks: the gate and its failing tests, each finding's kind,
check and file, and the blocking rules, never messages or line numbers. It
blocks at most 3 times in a row on the same fingerprint and at most 8 times on
a branch. The policy can lower or raise both limits (`attempts`, see
[the policy](policy.md#agent-attempts)). A different fingerprint starts the
"same findings" count again, but not the branch total. A stop that passes
clears both. Each block tells the agent which attempt it is on, and the
one before the last says what the next stop means.

The next blocking stop after a limit is **exhausted**. The hook lets the agent
stop, prints one line (`Gauntlet: exhausted on <branch> (<why>). The change
still fails its checks; …`), and records the outcome. Exhausted is a failure
everywhere else. `gauntlet check` still blocks, the GitHub job never reads hook
state, and nothing about it satisfies a review level. A person clears a branch's
attempts with `gauntlet hook reset`.

There are three outcomes, and they are reported separately:

| Status | Meaning |
|---|---|
| `blocked` | The hook blocked the last stop; the agent is still working. |
| `exhausted` | The agent ran out of attempts and stopped. The change still fails. |
| `reported-blocked` | The agent called `report_blocked`, and it still matches: waiting on the owner. It doesn't count as an attempt. |

The state lives in the git common directory (`gauntlet/attempts/`), so every
worktree shares it and none of them contains it. A witness ref
(`refs/gauntlet/attempts/…`) names the exact bytes of each record. The agent's
deny rules and PreToolUse hook refuse edits there, and refuse shell commands
that name the record, the ref or `gauntlet hook reset`. A record that is
missing, unreadable or doesn't match its witness counts as every attempt
used, so deleting or forging it brings the exhaustion forward and never buys
more attempts. `gauntlet selftest` and `gauntlet corpus --stop-hook` check this.

### With an orchestrator and subagents

When an orchestrator hands work to subagents (each ideally in its own
worktree and branch):

- Each subagent gets the SubagentStop hook: it can't report done while its
  change would be blocked, and it can't loop forever either.
- Read each worker's outcome as JSON instead of parsing its last message:
  `gauntlet hook status --json` (or `--branch <name>`), or the MCP resource
  `gauntlet://attempts`. Both list every branch with `status`, `branch`,
  `attempts`, `limits`, `fingerprint`, `findings` (the fingerprint's lines),
  `reasons` and `state`.
- `exhausted`: the worker couldn't make the change pass. Retry with more
  context, or give it to a person; don't merge it. `reported-blocked`: the task
  needs a protected change, which only the owner can make (`reportedReason` says
  what). No record for the branch, after the worker stopped: its last stop
  passed, or there was nothing to judge. Confirm with `gauntlet check`.
- Don't reset a branch's attempts to keep a worker going. That is the person's
  call, which is why the agent's hook refuses `gauntlet hook reset`.

The optional authoring agent (`gauntlet author`) drafts and critiques policies
with a separate model key. It only proposes; every proposal must cite evidence
Gauntlet verified, and anything that loosens the policy needs its own
confirmation.

Codex, Cursor, Copilot and Gemini adapters are planned after v1.

## GitHub

`gauntlet connect github` writes a workflow with two jobs. The **evidence** job
runs the change with a read-only token and no secrets. The **status** job never
runs pull request code: it recomputes everything that needs no execution from
the base policy and git (diff facts, protected changes and every integrity
finding), takes only gate outcomes from the evidence job, posts the report and
sets the `gauntlet` check. Reviews re-run the status job, so an approval can
satisfy a `review` or `owner` level. `--mode org` generates a central policy
repository and an org ruleset instead. See
[`.github/GAUNTLET.md`](../.github/GAUNTLET.md) for the threat model.

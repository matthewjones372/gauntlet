# Claude Code and GitHub

Back to the [README](../README.md).

## Coding agents

`gauntlet connect claude-code` gives Claude Code:

- a **Stop hook**: the agent can't finish while Gauntlet would block the change;
- a **PreToolUse hook** and **deny rules** for protected paths and `.gauntlet/`;
- the **Gauntlet MCP server** (`check`, `explain`, `validate`, `get_grammar`,
  `get_examples`, `author_draft`, `report_blocked`);
- a short instructions block in `CLAUDE.md` and `AGENTS.md`;
- the `/gauntlet-setup` command.

When a task can't be done without changing protected tests or policy, the agent
calls `report_blocked` with the reason. That's a legitimate outcome: the change
goes to a person instead of the agent weakening the checks.

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

# 0026. The Stop hook has a bounded exit, and running out of attempts is a failure

Status: accepted. Replaces the Stop hook's `stop_hook_active` rule (PLAN section 14, ADR 0015). Spec 0018 has the details.

## Context
The Stop hook blocks an agent from finishing while Gauntlet would block the change. To keep it from looping, it returned as soon as Claude Code said `stop_hook_active`. In practice that rule did two things wrong:

- Every agent got one block and then stopped without a word. The second stop wasn't checked at all, so nothing recorded that the agent gave up, and nobody could tell it apart from a pass.
- It was the only bound there was. Claude Code's own cap (eight hook-forced continuations in a row, reset by any tool call) doesn't hold for an agent that keeps editing.

With an orchestrator dispatching subagents, both matter. Subagents fire `SubagentStop`, which Gauntlet didn't install, so their work went unchecked. Without the `stop_hook_active` escape, a worker that can't make the change pass would loop until its context ran out. Either way the orchestrator gets nothing it can act on.

## Decision
- **Both events.** `connect claude-code` installs the same `gauntlet hook stop` for `Stop` and `SubagentStop`. The tree checked is the git worktree of the hook input's `cwd`, so a subagent in its own worktree is judged on that worktree and its branch.
- **Attempts are counted per branch.** Each stop the check blocks is an attempt. Its fingerprint is a hash of the blocking findings, reduced to what is stable across runs: the gate and its failing test ids, the finding kind and check, the file, the rule. Messages, counts and line numbers are left out. The hook blocks on the same fingerprint at most `unchanged` times in a row (default 3) and at most `total` times on a branch (default 8). The next blocking stop after that is **exhausted**. A different fingerprint starts the `unchanged` count again, but `total` never resets on its own. A pass clears both.
- **The limits come from the base policy**, in `attempts { unchanged 3, total 8 }`. Either one left out takes its default. Raising either one is a loosening (ADR 0009). Like any other `.gauntlet/` edit, it needs an owner.
- **State is out of the agent's reach and fails closed.** It lives in the git common directory (`gauntlet/attempts/`), never in a worktree, with a witness ref (`refs/gauntlet/attempts/…`) holding the blob id of the file's exact bytes. The deny rules and the PreToolUse hook refuse edits there and Bash commands that name either. A file without its witness, a witness without its file, a mismatch, or a file that doesn't parse all count as **already at both limits**: the next blocking stop is exhausted, never a fresh start. Only "neither exists" is a fresh branch.
- **Exhausted is explicit.** The hook lets the agent stop and writes a result with the status, branch, attempts, limits, fingerprint and last findings. It prints one line, served as JSON by `gauntlet hook status --json` and by the MCP resource `gauntlet://attempts`. The block before the last one tells the agent that its next stop on the same findings ends the attempt, so its final message can say so.
- **Exhausted is a failure everywhere else.** `gauntlet check`, the GitHub status job and the review decision never read the attempt state. An exhausted branch is judged exactly as it would have been.
- **Reported-blocked stays separate.** A `report_blocked` that still matches is "waiting on the owner": it neither counts as an attempt nor resets the count, and it is reported with its own status.
- **Deterministic.** Counting and deciding are pure functions of the report, the stored record and the limits. No model is involved, and nothing in the record depends on a clock.

## Consequences
- An orchestrator always gets an outcome from a worker: a pass, reported-blocked or exhausted. Each one can be read without parsing prose.
- A single session gets up to three tries at the same findings instead of one, then stops with an explicit result instead of a silent one.
- Tampering with the state can only bring the exhaustion forward. The result says why (`state: "missing"` or `"corrupt"`), and the change still fails. Deleting both the file and its witness looks like a fresh branch. That is the one way to get more attempts, and the deny rules exist to prevent it. It never changes whether the change passes: CI judges from the base and reads no hook state.
- A person clears an exhausted branch with `gauntlet hook reset`, which the agent's hook refuses.

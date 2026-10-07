# 0009. Keep the authoring agent apart from coding agents

Status: accepted (implemented in M12)

## Context
The authoring agent can change the bar. If a coding agent can drive it, the coding agent can loosen its own policy.

## Decision
- The authoring agent only proposes. Writes happen in the CLI after per-block human acceptance, and loosenings need a second, typed confirmation.
- It uses its own credential (`GAUNTLET_AUTHOR_API_KEY`) and never reads a provider's usual variable such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` (ADR 0010).
- It refuses to run when a coding-agent marker is present in the environment (`CLAUDECODE` and others the connectors know about) or when there is no TTY.
- The same separation applies to the LLM reviewer behind `advisory` when it is built (ADR 0011).
- MCP `author_draft` returns proposals only. It needs the author key in the MCP server's environment, and it does not accept one passed in a request.
- Every proposal must cite its evidence (detected sensitive code, an unprotected test directory, an escape during the shadow period, a selftest gap, an uncovered path). Proposals without a valid citation are dropped.
- A deterministic `LooseningDetector`, not the LLM, decides what counts as loosening.
- Documentation tells users to run authoring from a separate shell with separate credentials. Any resulting policy change is still a protected change judged by the base policy (ADR 0003).

## Consequences
- These checks are best-effort locally. A determined local process can fake a TTY or clear env vars. The real guarantee is ADR 0003: policy changes only land through reviewed merges.

## Implementation (M12)
- `packages/author` holds the agent. Its tools only read what Gauntlet gathered before the model ran (files, search, coverage, catalog, shadow history, a selftest dry run, policy validation, git log); none writes, runs project code or reaches the network.
- The CLI refuses authoring when `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CODEX_SANDBOX`, `CURSOR_AGENT`, `GEMINI_CLI` or `GAUNTLET_AGENT` is set, or stdin or stdout isn't a terminal. It checks this before building the model layer, so no request is ever sent. `gauntlet init` then falls back to the template and says why.
- `looseningsBetween` compares compiled IR. It counts removed owners, protections, zone paths, zone owners, rules, arch rules, suites, integrity items, budgets, imports and required gates, gates made advisory, lost ratchets, eased or removed thresholds, `all` narrowed to `on changed`, removed `owner` or `review` rules, new `auto` or `skim` rules, and changed predicates that a lenient rule uses. Loosening is judged when a block is applied, against the policy as it stands then, so a person's own edit is checked too.
- The person types `loosen` to apply a loosening. The terminal acceptor shows each block before and after, the rationale and the cited evidence; `e` opens the block in `$VISUAL` or `$EDITOR`.

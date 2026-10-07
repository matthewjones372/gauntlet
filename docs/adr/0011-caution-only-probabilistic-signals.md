# 0011. Probabilistic signals are caution-only

Status: proposed

## Context
LLM reviews, imported LLM findings (CodeRabbit and similar) and trajectory signals are useful but not reproducible. Agent identity and history are not evidence about this change.

## Decision
- These signals are typed as `CautionSignal`. A caution signal can nominate at most one step above the current computed tier, and never below it. It is never the sole gate: the validator rejects a gates block that is advisory only.
- SARIF imports declared `caution` are converted to caution signals no matter what their severity is.
- Agent, model and session ids are recorded in the report. The decision function does not receive them as input.

## Consequences
- An LLM reviewer can make Gauntlet more careful but can never let a change through.
- `llm review` is parse-only in v1. Its design (N independent reviews, recorded agreement) is fixed now so that the IR is stable.

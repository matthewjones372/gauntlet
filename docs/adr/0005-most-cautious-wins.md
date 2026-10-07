# 0005. Review tiers: most cautious wins

Status: proposed (revision 2, replaces "tiers only go up")

## Context
Humans must be able to trust `auto`. If rules acted like ordered actions, a later rule could undo an earlier one, and a policy edit could loosen things in ways that are hard to see.

## Decision
- Review rules are not actions. Every rule whose condition matches **nominates** a tier, and the decision is the maximum over all nominations. Each nomination cites its source: a DSL line through the source map, or a named implicit rule.
- `auto` and `skim` win only when nothing stricter is nominated. If no rule matches, the tier is `review` (PLAN Q-R2).
- Implicit nominations:
  - missing evidence: `review`
  - gate failure, regression or integrity forbid: `review`, and blocking in enforce mode
  - integrity flag: `review`
  - any `.gauntlet/` change: `owner`
- An override never changes the tier. It only changes enforcement, and it is recorded (ADR 0014).

## Consequences
- No rule can undercut another nomination: adding a rule never lowers the tier below anything else nominated, and adding a `review` or `owner` rule never lowers it at all. Property tests assert both. (The "no rule matched" default is not a rule; an `auto` rule that matches replaces it, which is the point of `auto`.)
- Caution signals step up exactly one tier from the deterministic decision, never more and never below it.
- The decision is order-independent, which helps determinism (ADR 0012).

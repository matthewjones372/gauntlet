# Spec 0009: zones keep up as the project grows

Status: implemented on branch `spec-0009-zones` (see "Zones as a project grows" in `docs/policy.md`). Zone defaults are expanded into each zone's gates at compile time, so only policies with a `zones` block change their IR hash. The signs of sensitive code are a fixed list of names, imports, annotations and paths in `packages/core/src/sensitive.ts`, since setup's own reading of the code is Claude's, in its prompt; a new folder that setup's folder-name inference recognises keeps that note instead. Nothing is left out.

## Problem
Zones are drawn once, at setup. As a project grows, new sensitive code appears (a refunds service, a new permissions module, a table of personal data) outside every zone, so a change to it needs nobody's review. And a zone added later gets an owner's review but none of the stricter checks the first zones have, unless someone remembers to name it in each gate.

## Behaviour

### 1. Zone defaults
```
zones {
  coverage >= 90% on changed
  mutation >= 60% on changed
}
```
Checks every zone gets unless its own gates say otherwise. A new zone is covered the moment it's added. `compile` warns about a zone with no checks of its own and no defaults ("zone billing only gets an owner's review; add checks or zone defaults").

### 2. Sensitive code outside any zone
On every check, Gauntlet looks at the change's new files and new top-level symbols for the signs setup looks for: money and payments, authentication, permissions and secrets, personal data, contracts other systems depend on (APIs, schemas, events), data stores and migrations. Signs are names and imports (`Refund`, `Ledger`, `jwt`, `BCrypt`, `@RestController`, `migration`), not guesses about meaning.

When a change adds such code outside every zone, the report and the agent's summary say so:
> This adds `src/refunds/RefundService.kt`, which handles money, outside every zone. Add it to `payments`, or make a new zone?

A suggestion only: the agent tells the person and never changes the policy, and the decision doesn't change. The same list is in `gauntlet doctor`, for the project as it is.

### 3. A new zone's baseline
When the policy gains a zone, its coverage and mutation baseline is recorded for that zone on the next `gauntlet baseline --update`, so the zone's ratchets start from today rather than holding nothing.

## Not covered
- Drawing zones automatically: a zone is a person's decision about where review matters.

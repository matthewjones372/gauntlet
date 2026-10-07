# 0002. The DSL compiles to a canonical Policy IR

Status: proposed (revision 2)

## Context
Agents write `.gauntlet/policy.gx` from validator feedback, so error quality is a core feature. Every report must also state exactly which policy judged a change, in a form that can be compared across runs.

## Decision
- The grammar is written in Langium. The generated parser is committed. Parser errors are rewritten into Gauntlet diagnostics, each with a code, location, expected and fix.
- The grammar fixes structure. The validator owns vocabulary, names, units, references and conflicts.
- The compiler emits a **Policy IR**, defined with Effect Schema in `packages/ir`. Only `packages/dsl` depends on Langium. Everything downstream reads only the IR.
- Source locations are kept in a separate source map. Reasons cite DSL lines through it.
- **Canonical JSON:** sorted keys, a fixed array order, shortest-form numbers, no whitespace. The IR hash is `sha256` of the canonical JSON and goes into every report together with the base and head SHAs.
- The IR carries `irVersion`.

## Consequences
- Comment and formatting edits don't change the hash, so the hash identifies meaning.
- Stacks, perf, holdouts and LLM review are already in the IR, so building them later adds executors, not syntax.
- Org-level inheritance (later) can merge IRs without touching the parser.

# Spec 0008: formal proofs as evidence

Status: proposed.

## Problem
Tests show that code works for the cases someone wrote down. For the code where a mistake is expensive (money that must balance, a permission check, a protocol two services rely on), "for the cases we thought of" isn't enough, and an agent writing that code is exactly when it matters most. Formal methods can show a property holds for every input, and AI makes proofs far cheaper to write. But a proof is only as good as what it proves: an agent that weakens the property, adds an assumption or marks a lemma as admitted can make any proof pass. That's the same problem Gauntlet already solves for tests.

## The idea
Split each proof into the **statement** (what must be true: the spec, the contract, the invariant) and the **proof** (why it's true). The statement is the person's: protected, like a test, and changes to it need an owner. The proof is the agent's to write and change freely. Gauntlet checks that the prover accepts the proof, that the statement is the one the owner agreed, and that nothing in the proof quietly assumes what it should prove.

## Behaviour

### 1. A `proof` check
```
proof ledger {
  command "dafny verify src/ledger/Ledger.dfy"
  reads dafny
  statements "src/ledger/**/*.spec.dfy"
  when zone payments touched
}

gates {
  verify { unit, proof ledger }
}
```
- `command` runs the prover; `reads` names its output format. Gauntlet records each obligation as proved, failed or timed out, as SARIF.
- `statements` are the files that hold what is proved. They're protected: a change to them is undone for the run and needs an owner, as for protected tests.
- `when ... touched` runs it only when its code changes (provers can be slow), as for budgets (spec 0007).
- A timeout or an unknown result is **not executed**, never passed.

### 2. Integrity: proofs that prove nothing
New integrity checks, forbidden by default in code a `proof` covers:

| Check | What it catches |
| --- | --- |
| `admitted-proofs` | `sorry` (Lean), `admit`/`Admitted` (Rocq), `assume false`, `{:verify false}` and `{:axiom}` (Dafny), `#[trusted]` (Verus, Prusti), `@Pure` without a body proof |
| `new-assumptions` | an added `assume`, `axiom`, `requires` on a public entry point, or `kani::assume` |
| `weakened-statements` | a postcondition (`ensures`), invariant or theorem made weaker or removed, compared with the base |
| `smaller-bounds` | a model checker's bound reduced (`#[kani::unwind]`, TLC's constants, JBMC's `--unwind`) |
| `proved-obligations` (ratchet) | the number of proved obligations can't drop |

### 3. Tools by language
Gauntlet reads their results; the wizard suggests the lightest one that fits.

| Kind | Tools | Good for |
| --- | --- | --- |
| Design models | TLA+ (TLC, Apalache), Alloy, P | protocols, concurrency, state machines, in any language |
| Bounded model checking | Kani (Rust), JBMC (Java bytecode), CBMC (C) | "no input up to size n breaks this" on real code |
| Symbolic checking | CrossHair (Python), Stainless (a Scala subset) | contracts checked on real code |
| Full proofs | Dafny (compiles to Java, C#, Go, Python, JavaScript), Verus (Rust), Lean 4, Rocq | a small verified core, such as a ledger or a pricing function |

Kotlin, TypeScript and Clojure have no mainstream prover for real code: there, Gauntlet suggests a design model, or a verified core in Dafny compiled to the target language.

### 4. The wizard
An optional decision, offered only for zones with a clear invariant ("money is conserved", "only an owner can approve"). The agent explains the idea in plain words, proposes the lightest tool, writes the statement for the owner to read and agree, and only then writes the proof. It warns that proofs are slower than tests and run only when their zone changes.

## Stages
1. The `proof` check with `statements`, readers for Dafny, Kani and TLC.
2. The integrity checks above.
3. The wizard's decision.
4. More readers (Verus, Lean, CrossHair, Stainless, Apalache, JBMC).

## Not covered
- Proving the compiler or the prover correct.
- Generating statements without the owner: the statement is the person's decision; the agent drafts it, the owner agrees it.

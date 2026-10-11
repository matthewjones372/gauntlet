# Spec 0011: mutation testing on changed lines, as review findings

Status: proposed.

## Problem

`mutation ... on changed` mutates every changed file and scores the whole file. On a
real project that's slow and noisy. tweet-street's daily-limit change touched two
lines' worth of logic in `Account.kt` and was held to all 125 mutants in that file and
`Bank.kt`, most of them generated data-class getters it never wrote; the check ran past
30 minutes. Teams that run mutation testing per change do the opposite: Google mutates
only the changed lines (median 7 mutants per change, against 820 for whole files),
drops code nobody wants findings on (logging, timeouts), and shows survivors as review
comments rather than gating on a score; Arcmutate's GitHub integration warns by
default. See `docs/research.md` for the sources.

## Behaviour

### 1. Only mutants on changed lines count

With `on changed`, a mutant counts only if its line is one the change added or edited
(`facts.addedLines`). Packs still mutate whole changed classes, since that's what the
tools offer; core filters the mutants by line. Each pack's mutation gate reports
mutants (path, line, killed or not) through one shared helper instead of computing its
own score, so every pack scores the same way.

A change with no mutant on its lines (a rename, a comment) has nothing in scope, as
today.

### 2. A threshold counts changed lines; a ratchet counts new survivors

`mutation >= 80% on changed` is the share of mutants on the changed lines that are
killed. `mutation ratchet on changed` compared each file with its baseline score, and a
changed-lines score can't be compared with a whole-file one, so with `on changed` the
ratchet works as lint's does: survivors are findings, the baseline grandfathers the
ones it recorded, and a survivor that isn't grandfathered blocks. A changed line is new
code, so in practice every mutant on it must be killed or the policy must `advise`.
Whole-project scoring (`on all`, and `gauntlet baseline`) keeps the per-file ratchet.

### 3. Survivors are findings first

Each surviving mutant on a changed line is a finding on that line: in the report, in
the agent summary, and as a PR annotation through the GitHub check. A policy chooses
what they do:

- `mutation ... on changed` with a threshold blocks below it, as today;
- `mutation advise on changed` reports survivors and blocks nothing;
- `gauntlet init` drafts `advise`; existing policies keep what they say.

### 4. Kotlin's generated code isn't mutated

The JVM pack excludes compiler-generated methods from mutation: data classes'
`componentN`, `copy`, `equals`, `hashCode` and `toString`, and property accessors with
no body. A finding nobody can act on is noise.

### 5. Faster runs

Pitest runs with one thread per core, and the narrowed `targetClasses` keeps the
build's own `targetTests` (done: the init script applies Gauntlet's targets after the
build script). History reuse is left out: Pitest marks it experimental.

## Not covered

- Choosing operators per language or learning "not useful" rules (Google's arid-node
  filter). A later spec, once findings have feedback.
- A cap on mutants per change.

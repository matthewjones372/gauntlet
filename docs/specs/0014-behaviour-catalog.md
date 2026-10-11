# Spec 0014: the behaviour catalog

Status: proposed. Depends on spec 0012 (scenarios).

## Problem

Spec 0012 judges one change against its scenarios. Nothing records what the
application does as it stands: which scenarios hold on trunk, which code each one
reaches, what was decided against, and which code nobody stated an intent for. A
person or an agent who wants to know "does it do X?" reads the code and guesses, and
an agent about to change behaviour has no way to learn what was meant first.

A hand-written list goes stale, and one an agent can write is self-reporting. The
record has to come from evidence.

## What it is

The **behaviour catalog** is what trunk's evidence says about every scenario,
recorded in the baseline and read on demand. Scenario text is the human's; every
verdict, test and code edge in the catalog is Gauntlet's.

```text
$ gauntlet explain behaviour
Behaviour at main (a1b2c3d, map from 2026-10-11)

Does (proven):
  FX-003 Converting EUR to USD: €1.00 at 1.10 gives $1.10        Fx.convert
  FX-004 Rounds half-even                                        Fx.round
Refuses (proven):
  FX-005 Rejects an unknown currency                             Fx.lookup
Claimed, not proven:
  FX-006 Same currency is identity (unbound since #84)
Won't do (decided):
  FX-010 Converting crypto
Unspecified (code no scenario reaches):
  Fx.fee (src/main/kotlin/svc/settlement/Fx.kt:22)

A missing scenario means unspecified, not unsupported.
```

## Behaviour

### 1. `@wont`: decided non-goals

A scenario tagged `@wont` states that something is deliberately not done:

```gherkin
  @FX-010 @wont
  Scenario: Converting crypto
    When I convert 1 BTC to USD
```

It needs no test and gets the verdict `wont`, which never blocks. If a test binds it,
the bound tests must pass like any scenario's; a `@wont` scenario whose test fails is
`failing`. The catalog shows it as a decision, never as a fact about the code.

A scenario that refuses something (an error, a rejection) is an ordinary scenario,
judged the same way. Tagged `@refuses`, the catalog lists it under "Refuses" rather
than "Does"; Gauntlet doesn't read meaning from step text.

### 2. The catalog lives in the baseline

`gauntlet baseline` records, under `properties.gauntlet.scenarios` in
`.gauntlet/baseline.sarif`, one entry per scenario:

- `id`, `file`, `line`, the scenario's text hash (not the text: the file is the
  source of it);
- `verdict` (spec 0012's, plus `wont`);
- `tests`: bound test ids;
- `reaches`: functions with a mutant a bound test killed, as `path` and enclosing
  symbol (ADR 0004's `gauntlet/symbol/v1`), so a move doesn't drop the edge;
- `since`: the commit at which this verdict was first recorded, and its pull request
  when the merge commit names one.

It also records **unspecified code**: functions with at least one mutant that no
scenario's bound test kills, and the commit and date of the mutation run that
produced the map.

`since` comes from comparing with the baseline being replaced: an unchanged verdict
keeps its `since`. There's no separate history store; older catalogs are in git.

### 3. The map needs a full mutation run

On a pull request, mutation covers only changed lines (spec 0011), which says nothing
about the rest of the code. `gauntlet baseline --map` runs the policy's mutation check
`on all` to fill `reaches` and unspecified code. It's slow, so it's separate:

- `gauntlet baseline` without `--map` updates verdicts and tests, and keeps the
  previous map, still dated with its own run;
- `gauntlet connect github` adds a scheduled `baseline --map` job, weekly by
  default, that opens a pull request with the new baseline like any `.gauntlet/`
  change;
- the catalog always prints the map's date, and marks an edge `stale` when its
  function changed after that date.

### 4. A proven scenario can't quietly stop being proven

`scenarios ratchet` (in `gates`) compares each scenario's verdict at head with the
baseline. A scenario `proven` at base that isn't `proven` at head blocks, even when
the scenarios check is `advise`: losing a behaviour is a stronger claim than a failed
test. The report names it as a **lost behaviour**.

Recording a lower verdict in the baseline is a lowering: `gauntlet baseline` refuses
it without `--allow-lower`, and the commit changes `.gauntlet/` and needs an owner, as
for every baseline.

### 5. Reading it

- `gauntlet explain behaviour`: the catalog as text, grouped as in the example. The
  catalog is the baseline's, joined with the scenario files at the same commit for
  their text. A scenario in the files but not the baseline is listed as "not yet
  recorded".
- `--json`: the same, as the report's schema, for tools.
- `--about <id>`: one scenario, its tests, and the functions it reaches, each a
  `path:line`.
- `--about <function or path>`: the scenarios that reach it, or "unspecified".
- The MCP `explain` tool takes `behaviour` and the same `about`, so an agent reads
  the catalog in one call.

Every listing ends with the line "A missing scenario means unspecified, not
unsupported." An LLM reading the catalog must not take silence as a no.

### 6. Agents read it before changing behaviour

`gauntlet connect claude-code` adds to the `AGENTS.md` block: before changing what
code does, run `explain behaviour --about` on the functions you'll touch; keep proven
scenarios proven; ask before changing code a scenario reaches in a way it doesn't
describe; never edit scenario files (they're protected anyway).

The MCP `check` tool's summary names lost behaviours and the scenarios a change
reaches, with their text, so the agent sees the intent where it acts.

## Not covered

- Generating scenarios from code, tickets or the unspecified list. Proposing
  scenarios for unspecified code is a likely next step for `gauntlet author`, under
  ADR 0009 (the agent proposes, a person accepts).
- A committed `BEHAVIOUR.md`. A generated file in the tree goes stale and invites
  edits; `explain behaviour` is the view.
- Reading meaning from step text. `@refuses` and `@wont` are the only meanings the
  catalog uses.

## Tests

- Baseline: verdicts, tests and `reaches` round-trip through `baseline.sarif`; an
  unchanged verdict keeps its `since`; a moved function keeps its edge through the
  symbol key; a lower verdict needs `--allow-lower`.
- Map: `baseline` without `--map` keeps the old map and its date; an edge to a
  function changed since is `stale`.
- Ratchet: proven at base, `unchallenged` or `failing` at head blocks as a lost
  behaviour under `advise`; `unbound` to `proven` passes.
- `@wont`: no test needed; a bound failing test is `failing`.
- Explain: snapshot of the text and JSON for the Kotlin fixture; `--about` by id, by
  function and by path; a scenario not yet in the baseline; the closing line is
  always there.
- Connect: the `AGENTS.md` block names `explain behaviour --about`.

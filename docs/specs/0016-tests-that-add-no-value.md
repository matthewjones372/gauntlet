# Spec 0016: tests that add no value

Status: stage 1 implemented (`gauntlet prune tests` with the signals that need no mutation
run, for every pack); stages 2 to 4 proposed. Uses spec 0011's mutant helper and spec
0013's map of what each test exercises; shares the killer recording of spec 0012 §6.

## Problem

A suite grows faster than it's pruned, and agents grow it fastest. Some of what it
holds checks nothing:

- **Tests that test nothing.** No assertion, an assertion that can't fail
  (`assertTrue(true)`, `expect(x).toBe(x)`), or assertions only on a mock's own
  return value. The pack detectors already forbid these, but only in a diff: a new
  test with no assertions, or a tautology, is a `weakened-assertions` forbid. The
  ones already on trunk are never found.
- **Tests already covered.** A test whose every check another test already makes:
  copied tests, a parameterised case repeated by hand, an example test that a
  broader one fully contains. They cost build time on every check and have to be
  kept up to date, and they make `executed-tests` and `assertions-per-test` look
  better than the suite is.

Gauntlet makes removing them impossible without an override: any test that ran at
base and doesn't now is a `deleted-tests` forbid, and both ratchets count it. That's
right for deleting a test to get past a check, which is the oldest trick there is.
It's wrong for deleting a test that couldn't fail, or whose every check another
test still makes. The difference can be measured: after the removal, does the
suite still catch every bug it caught before?

## Behaviour

### 1. What counts as no value

A test **tests nothing** when, at base:

- it has no assertions, or only ones that can't fail (the packs' existing
  `tautology` detectors, run over the whole test tree instead of the diff), or
- it executes no main code (spec 0013's map records nothing for it), or
- mutation testing reaches main code through it, yet it kills none of the
  mutants it covers.

A test is **already covered** when:

- every mutant it kills is killed by another test that stays, or
- its source is the same as another test's in the same file and the same class,
  module or `describe`, once its name, comments and layout are set aside. Literals
  count, and so do the parameters in its annotations or decorators: two tests that
  check different examples aren't duplicates.

Mutant kills per test come from the mutation tools' killer reports: Pitest's
`killingTests` with the full mutation matrix, and Stryker's and Stryker4s's
`killedBy`. These are recorded in the baseline, as in spec 0012 §6. A pack whose
tool doesn't report killers (mutmut, cargo-mutants, Gremlins) offers only the
signals that need none. Gauntlet never guesses a killer.

### 2. `gauntlet prune tests` lists them

`gauntlet prune tests` lists the candidates from the last baseline. For each one it
gives the evidence ("kills 0 of the 14 mutants it reaches"; "the 6 mutants it kills
are all killed by `FxTest.rounds half-even`"; "same as `BasketTest.empty basket`")
and the time it takes. A set of tests that cover for each other is listed as a set,
with the smallest subset to keep. It's a list: it never deletes, and it never affects
a decision.

### 3. A removal is proven, not trusted

A change whose test files only lose tests (whole files, or cases from files that
stay) and that edits no main code is a **test pruning**. Gauntlet runs mutation on
the main code that the removed tests reached at base (from the map), once with the
base's tests and once with the head's. The pruning holds when:

- every mutant the base's tests killed is still killed, and
- line coverage of that code doesn't fall.

When it holds, the removed tests are flagged instead of forbidden, and the base
values of `executed-tests` and `assertions-per-test` are lowered by what was removed,
as they already are for a test removed with its code. When it doesn't hold, it's
still a `deleted-tests` forbid, naming each mutant that no longer dies ("`Fx.round`:
the conditional boundary on line 22 now survives").

Comparing two mutation runs needs no killer report, so this works for every pack
with a mutation tool. Clojure has none, so its removals stay forbidden.

Main code must be untouched so that "the same bugs" means the same mutants. Removing
tests together with the code they test is spec 0017.

### 4. Opt-in per suite, and some tests never qualify

`suites { unit "src/test/**" prunable }` turns it on per suite. A test never
qualifies if it's in a holdout, bound to a scenario (spec 0012), or counted by the
`property tests` ratchet, however its mutants score. Such tests check things that
mutants don't model: unseen inputs, stated intent, generated cases.

### 5. Still a person's decision

A test pruning is flagged, and a deleted protected test already nominates review
(ADR 0021), so it never auto-approves. The report lists each removed test with the
evidence from §1 and the mutation comparison from §3. When a check fails, the agent's
summary never suggests deleting tests to pass it: `prune tests` is something the owner
asks for, not a way out of a check.

## Stages, one pull request each

1. Run the tautology and no-assertion detectors over the whole test tree, plus the
   duplicate fingerprint, and `gauntlet prune tests` with those signals.
2. Record killers in the baseline (Pitest, then Stryker and Stryker4s), and the
   mutation signals from §1.
3. The proven removal from §3, and the ratchet adjustment.
4. `prunable` suites and the exclusions from §4.

## Not covered

- Tests that are slow but valuable: that's budgets and spec 0013's selection.
- Flaky tests: ADR 0017.
- Merging near-duplicate tests into one parameterised test. Each removal is judged
  as above, but writing the merged test is the agent's job.
- Value that mutants can't measure: concurrency, performance, and tests that pin
  down a public API's shape. That's why a pruning is reviewed, not automatic.

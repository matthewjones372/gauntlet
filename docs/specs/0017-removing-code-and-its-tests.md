# Spec 0017: removing code, and the tests only it needed

Status: proposed; stage 2's `code removed` review condition implemented (defined in `docs/policy.md`, "Review conditions"), while its per-test explanation waits for stage 1's method-level map; stage 3 implemented (project-wide ratchets judged against the code that's left; see "Removing a feature" in `docs/policy.md`); stage 4 implemented for every pack: TypeScript (Knip), Go (`deadcode`), Python (vulture), Rust (rustc's dead-code lints), Scala (scalac's `-Wunused`), Kotlin (detekt's unused rules; unused public code is §5's) and Clojure (clj-kondo's unused linters); stage 5 implemented as `gauntlet prune code` (see "What could go" in `docs/policy.md`): the baseline's dead-code findings, and main source no test ran (the test map, so TypeScript and the JVM) that nothing in the project names, by declaration for TypeScript and Kotlin with the packs' tree-sitter grammars and by file for Java. Builds on spec 0013 (the map of what each test exercises).

## Problem

Code that adds no value should go, and its tests with it. Gauntlet makes that hard
and never suggests it:

- **Only whole files can go.** A test deleted together with the source file it's named
  after (`FxTest.kt` with `Fx.kt`) is flagged instead of forbidden, and doesn't count
  against the `executed-tests` ratchet ("Removing a feature" in `docs/policy.md`).
  Most removals don't look like that: one function out of a file that stays, and its
  test cases out of a test file that stays; a test named for the behaviour, not the
  file (`CheckoutFlowTest` for `Basket.kt`); a feature spread over several files.
  Each of these is a `deleted-tests` forbid, so the owner has to override a change
  that only made the code smaller.
- **A name is weak evidence.** Matching names says nothing about what the deleted test
  actually checked. `FxTest.kt` can test `Rates.kt` as well, and deleting both files
  takes the only tests of `Rates.kt` with them.
- **Nothing finds code that adds no value.** Agents add code readily and rarely remove
  any: an unused helper, a branch no caller can reach, a flag nobody sets. The
  project's tools can find much of it (Knip, vulture, `deadcode`, scalac's `-Wunused`,
  clj-kondo), but Gauntlet doesn't run them, and code with no caller still counts
  towards coverage and mutation.

Deleting code and its tests is also the cheapest way to make a failing check pass. So
a removal has to be proven, not just named, and it still goes to a person.

## Behaviour

### 1. A test goes with its code when the map says it only tested that code

Spec 0013's map records, per test class, the files it executed. For this it also
records the methods: the JVM pack has them from Pitest's per-test coverage, and other
packs from their coverage tools where those report per-test lines.

A test that ran at base and no longer runs (a deleted file, or a test case removed
from a file that stays) is **removed with its code** when:

- it executed at least one method at base that the change removes, and
- every method it executed at base that still exists at head is still executed by a
  test that still runs.

That's to say the only code it was the sole test of is code the change removes. It's
flagged, not forbidden, and left out of the `executed-tests` ratchet, as today's
named-file case is. A removed test that was the last test of a method that stays is
still a `deleted-tests` forbid, however it's named.

Without a map, or for a test the map has never seen, today's name match is the
fallback.

### 2. Still a person's decision

A removal is flagged, so it never auto-approves: a deleted protected test already
nominates review (ADR 0021). For each removed test, the report names the removed code
it covered and says why it qualified ("`FxTest.fee rounds up` only tested `Fx.fee`,
which this change removes"). A new review condition, `code removed`, holds when the
change removes main code with no test removed, so an owner can choose how such a
change is treated, for example `auto when code removed and no zone touched and all
gates pass`.

### 3. Ratchets see the code that's left

Coverage and mutation on changed lines aren't affected: a removed line isn't a changed
line. A project-wide coverage or mutation ratchet is judged against the base's value
for the code that still exists at head. Code that's gone doesn't hold the bar up, and
removing well-tested code isn't a regression. Where the baseline has no per-file
values to recompute from, the report says the drop comes from removed code, and
`gauntlet baseline --update --allow-lower` takes the usual owner route (spec 0015 §2).

### 4. A `dead-code` check, ratcheted

Each pack's `dead-code` check runs the ecosystem's tool into Gauntlet's output
directory and reports what it finds as findings (`dead-code/<kind>`: unused export,
unused private, unreachable), with file and line:

| Pack | Tool |
| --- | --- |
| TypeScript | Knip |
| Python | vulture |
| Go | `deadcode` (golang.org/x/tools) |
| Rust | rustc's `dead_code` lint |
| Scala | scalac's `-Wunused` (Scala 2 and 3) |
| Kotlin, Java | detekt's unused-code rules, and the map (§5) for unused public code |
| Clojure | clj-kondo's unused-binding, unused-private-var, unused-namespace, unused-referred-var and unused-import |

With `dead-code ratchet`, today's findings are recorded in the baseline and
grandfathered, and a change that adds one fails, naming it. They're matched by
fingerprint, as lint and compiler warnings are (spec 0010).

### 5. `gauntlet prune` lists what could go

`gauntlet prune` lists candidates for removal, with why for each: `dead-code`
findings, and public methods that no test exercised and nothing in the project calls
(from the map and the pack's tree-sitter grammar). It's a list: it never deletes, and
it never affects a decision. An agent asked to act on it makes an ordinary change,
judged by §1 to §3. `/gauntlet-setup` mentions it once the map is recorded.

## Stages, one pull request each

1. Method-level map for the JVM pack, and §1's rule in `deleted-tests`, falling back
   to names.
2. The report's explanation and the `code removed` review condition.
3. Project-wide ratchets judged against the code that's left.
4. The `dead-code` check: TypeScript and Go first, then the rest.
5. `gauntlet prune`.

## Not covered

- Removing a test whose code stays: still forbidden here. Spec 0016 covers tests
  that add no value, proven by mutation.
- Code reached only by reflection, dependency injection, serialisation or an outside
  caller (a public library API, an HTTP route nobody tests): tools miss these, which
  is why `prune` lists and never deletes.
- Production telemetry (code that never runs in production): it's outside the
  repository.
- Deciding whether a feature is worth keeping: that's the owner's call. Gauntlet only
  checks that removing it took nothing else with it.

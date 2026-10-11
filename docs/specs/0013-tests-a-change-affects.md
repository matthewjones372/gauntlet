# Spec 0013: run the tests a change affects

Status: proposed.

## Problem

A check runs every test in every build the change touches. On tweet-street that's
lark-bank's whole suite, mostly specs that start clusters of nodes on Postgres: about
five minutes for any change to lark-bank, however small. Most changes touch one read
model or one endpoint, and most of those tests can't be affected by them.

Gauntlet can already run a subset of a suite (`TestSubset`, used to rerun failures and
spot flaky tests), so packs can run what's chosen. Two things stop it choosing today:

- **Integrity counts tests.** `deleted-tests` forbids a test that ran at base and no
  longer runs, and `executed-tests` ratchets how many ran. A test Gauntlet chose not to
  run would look deleted.
- **Choosing must be Gauntlet's.** PLAN lists task selection as a way round the
  executed-tests ratchet: if the project's build decides which tests run, an agent can
  hide tests behind it.

## Behaviour

### 1. A map of what each test exercises, recorded on trunk

`gauntlet baseline` records, for each test class, the source files it executed, in
the baseline next to `testIds`. The JVM pack takes it from Pitest's coverage step
(which runs each test and records what it covers) or Kover's per-test data; other
packs from their coverage tools where they can, and record nothing where they can't.

### 2. A check runs the tests that exercise what changed

With a map, a suite runs the test classes whose recorded files include a changed main
file, plus every test file the change adds or edits. Without one, or for a build whose
map is missing, it runs everything, as today.

Everything runs when the change:

- touches build configuration, test setup or fixtures (anything protected but tests);
- adds a main file the map has never seen, or a dependency;
- is recorded as a baseline, or runs on trunk.

### 3. Integrity knows what was left out

The report lists the tests it didn't select. `deleted-tests` and the `executed-tests`
ratchet compare against the selected tests, not the base's whole suite: a test left
out by selection isn't missing. A test the change deletes is still caught, since its
file is in the diff.

### 4. Opt-in, and visible

`suites { unit "src/test/**" affected }` turns it on per suite. The report says how many
tests ran out of how many, and why the rest didn't.

## Not covered

- Selecting by line or method rather than file.
- Predictive selection (Meta's, Google's TAP): learning which tests tend to fail.
- Making slow tests cheaper (a shared cluster for specs): the project's work, not
  Gauntlet's.

# Spec 0013: run the tests a change affects

Status: implemented for the JVM pack and the TypeScript pack on Vitest and Jest; Bun's test runner and the other packs record no map yet, so their affected suites run every test.

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

The TypeScript pack's "test class" is a test file. It runs each test file the
suite ran on its own with the runner's coverage (Vitest or Jest), and maps it to
itself and every file that run loaded. That's a run per test file, once per
baseline: dearer than one run, but it sees setup files, dynamic imports and
path aliases as they really load, which a static import graph would have to
guess at. What coverage can't see is another process: a test file that starts
processes or workers, imports a computed path, or reaches a test-side helper
that does (or a relative import Gauntlet can't resolve) maps to every file any
test loaded, as does a test file whose own run failed. A global setup runs
outside every test file's process, so a runner configuration with one records
no map.

Bun's test runner records no map. Integrity has to tell a test that selection
left out from one that was deleted, which needs each test id to name its test
file; Vitest's (`<file>.<name>`) and Jest's (`<file> > <name>`) do, but Bun's
JUnit report names a test by its `describe` blocks alone (`money.adds`, or
`.adds` at the top level). ADR 0027 puts the file in Bun's ids
(`test/money.test.ts.money.adds`) and matches older baselines' ids to them, so
recording a map for Bun is what's left.

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

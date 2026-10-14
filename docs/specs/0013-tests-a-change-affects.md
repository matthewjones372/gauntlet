# Spec 0013: run the tests a change affects

Status: implemented for the JVM pack and the TypeScript pack on Vitest, Jest and Bun's test runner; the other packs record no map yet, so their affected suites run every test.

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
suite ran on its own with the runner's coverage (Vitest, Jest or bun), and maps it to
itself and every file that run loaded. That's a run per test file, once per
baseline: dearer than one run, but it sees setup files, dynamic imports and
path aliases as they really load, which a static import graph would have to
guess at. What coverage can't see is another process: a test file that could
run this project's code in one, or that imports a computed path, or that
reaches a test-side helper that does either (or a relative import Gauntlet
can't resolve) maps to every file any test loaded, as does a test file whose
own run failed. A global setup runs outside every test file's process, so a
runner configuration with one records no map.

Which processes count is read from each test-side file's text (a test file and
the helpers and fixtures it imports, transitively; main code is what coverage
sees). A worker (`worker_threads`, `new Worker`) always counts. A process
doesn't when it is a known external tool named by a literal: the first element
of `Bun.spawn`/`Bun.spawnSync`'s array (or its `cmd`), the first argument of
`child_process`'s `spawn`, `spawnSync`, `execFile` or `execFileSync` or
execa's `execa`, or the first word of a command line (`exec`, `execSync`,
`execaCommand`, or a `` $`...` `` template from Bun or execa) that has no
pipes, lists, substitutions or redirects, and, for a real shell, nothing
interpolated. The external tools are tools of their own, such as `git`, `tar`,
`true`, `curl`, `jq`, `java`, `sbt`, `mvn`, `gradle`, `go`, `cargo`. Anything
else counts: a runtime or launcher (`bun`, `node`, `npx`, `tsx`, `python`,
`env`, `xargs`, `make`), a shell (`sh`, `bash`), a path (a script or source
in the repository), a command that isn't a literal, `fork` or `execaNode`, a
spawn function used other than by calling it, `child_process` reached other
than by a named import, and a file that starts any process while it sets
`PATH` (a tool could be a stand-in found there) or passes `shell:`. A shell
counts even running a script that is a test fixture rather than project
source: what a script runs is in a language Gauntlet doesn't read, and test
scripts do start the project (a hook command calls `gauntlet`, a workflow step
calls `bun`). The check is per file: one spawn that counts anywhere in a helper
counts for every test that imports it. Since it reads text, a fixture string
in a test that looks like a spawn or a computed import counts too, which only
runs that test more often.

Its limits, each of which a test can only reach on purpose: an external tool
that calls back into the project (a git hook or alias, a build file a test
writes, a `PATH` set in one file for a spawn in another, or a `PATH` the test
process already had that puts a project command first), and main code that
starts the project in another process, which the test map takes as what the
test exercises.

Integrity has to tell a test that selection left out from one that was
deleted, which needs each test id to name its test file: Vitest's
(`<file>.<name>`) and Jest's (`<file> > <name>`) do, and ADR 0027 puts the
file in Bun's (`test/money.test.ts.money.adds`). Bun runs each test file by
its path (`./test/money.test.ts`), since a bare argument is a filter that runs
every file whose path contains it. Bun has no global setup: a `bunfig.toml`
`[test] preload` runs in each test file's own process, so its coverage sees
what the preload loads, and every test file maps to it; a preload that starts
processes or loads code coverage can't follow records no map. Bun's coverage
leaves out files named like tests, so the test-side files a test file imports
are added to its map from its imports. A `bunfig.toml` `coverageDir`, or a
`coverageReporter` without `lcov`, wins over the command line and leaves no
coverage where Gauntlet reads it, so it records no map; a coverage threshold
fails a run whose tests all passed, so a run counts when its own JUnit report
has no failures. Changing `bunfig.toml` runs every test, like any runner
configuration.

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

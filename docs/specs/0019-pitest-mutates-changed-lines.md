# Spec 0019: Pitest mutates only the changed lines

Status: implemented on branch `pitest-changed-lines`. Builds on spec 0011.

## Problem

With `mutation ... on changed`, the JVM pack hands Pitest the changed classes and
core keeps only the mutants on the changed lines afterwards (spec 0011 §1). Pitest
still generates and runs every mutant in those classes. Spec 0011 cut that down by
naming every untouched Kotlin method in `excludedMethods`, which is coarse (a name is
skipped in every class or none), says nothing for Java, and leaves the rest of a
touched method mutated. The run also starts the root `pitest` task, so every module
with Pitest applied computes coverage and looks for mutants, touched or not. On
petshop a large change takes 16 to 20 minutes in CI.

## Behaviour

### 1. A Pitest filter keeps the changed lines

The JVM pack ships a Pitest mutation interceptor, `gauntlet.ChangedLines`, a
`MutationInterceptorFactory` of type `FILTER` providing the feature
`gauntletlines`, off by default. Its one parameter, `file`, names a file of lines,
one `<package path>/<source file>:<line>` per line (`svc/domain/Money.kt:12`): the
package the source declares and the file's name, which is what Pitest knows of each
mutant. The filter drops every mutant whose class's package and source file and
line aren't listed. A mutant with no source file is dropped.

With `on changed`, the mutation gate writes the class and the file of changed
lines next to the check's output directory, and the init script adds the class's
directory to the `pitest` configuration and turns the feature on with
`+gauntletlines(file[...])`. Pitest then generates, covers and runs only the
mutants on the changed lines. Core's filter by line stays, so a build where the
feature can't load scores exactly as before.

`on all`, a baseline, and the mutation run that confirms removed tests (spec 0016)
mutate whole classes, as before: they don't turn the feature on.

### 2. Generated code is still skipped by name

Spec 0011 §4 stands: data classes' `componentN`, `copy`, `equals`, `hashCode` and
`toString`, and property accessors with no body, sit on the line that declares
them, so a changed declaration line would otherwise bring them back. Those names
stay in `excludedMethods`, unless the change touches a function or accessor
written with that name. Untouched methods are no longer listed: the filter
covers them, for Java too. With a changed Java file nothing is skipped by name,
as before.

### 3. Only the modules the change touches

The gate runs `:<module>:pitest` for each module with a changed main source,
named from the path before `src/main/` (`app/src/main/...` is `:app:pitest`,
`libs/core/src/main/...` is `:libs:core:pitest`, `src/main/...` is `:pitest`).
When Gradle can't find one of those tasks (the module doesn't apply Pitest, or
its project path doesn't follow its directory) the gate runs the root `pitest`
task instead, as before.

## Not covered

- Pitest's coverage run still runs each touched module's whole test suite once.
  Narrowing it to the tests that reach the changed lines (spec 0013's map) is
  later work.
- The other packs' mutation tools: Stryker, mutmut and cargo-mutants each take
  their own line or function filter; this spec is the JVM pack's.

## Tests

- The gate writes `svc/domain/Money.kt:<line>` for a changed line of a file
  declaring `package svc.domain`, turns the feature on only with `on changed`,
  runs `:app:pitest` for `app/src/main/...`, and falls back to `pitest` when
  Gradle says the task isn't there (`packs/jvm/test/pitest-changed-lines.test.ts`).
- End to end on `examples/fixtures/kotlin-service` with real Gradle and Pitest
  (`packs/jvm/test/changed-lines.e2e.ts`): a change to one line of a Kotlin
  function, and to one line of a Java class, leaves only that line's mutants in
  Pitest's report.

## Measured

The fixture, the gate alone, before (main) and after, two runs each:

| Change | Mutants before | Mutants after | Score and survivors |
|---|---|---|---|
| one line in each of two one-line Kotlin functions | 5 | 5 | same |
| line 7 of the five-line `Money.plus` | 2 | 1 | same |
| line 6 of a 20-line Java class with no tests | 17 | 1 | same |

Wall time on a project this small is Gradle's start and compile (8 to 28
seconds either way); the saving grows with the mutants dropped, each of which
otherwise runs the tests that cover it.

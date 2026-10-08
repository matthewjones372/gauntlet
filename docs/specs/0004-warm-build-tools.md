# Spec 0004: one warm Gradle or sbt per check

Status: implemented on branch `warm-build-tools`.

## Problem

The JVM and Scala end-to-end jobs take 14 to 18 and about 11 minutes in CI.
Almost none of that is the tests: every gate starts Gradle with `--no-daemon`
or sbt with `-batch`, so each one pays for a cold JVM and a fresh load of the
build (10 to 30 seconds), times five gates, times every scenario and selftest
fixture.

## What changes

One build-tool process per check, shared by that check's gates and ended when
the check ends (ADR 0020).

- **Gradle.** Gates run with `--daemon`. The daemon's JVM arguments are the
  build's own `org.gradle.jvmargs` (from `gradle.properties`, restored from
  base) plus `-Dgauntlet.check=<the check's directory>`. Gradle reuses a
  daemon only when its JVM arguments match, so the check's gates share one
  daemon and nothing else (an earlier check, the user's IDE) can use it.
  `--no-watch-fs` keeps no file-system state between builds; `--no-build-cache`
  and `--no-configuration-cache` stay. A two-minute idle timeout ends a daemon
  a crashed check left behind.
- **sbt.** Gates use the thin client (`sbt --client`), which starts one sbt
  server for the checkout (each check has its own worktree, so its own
  server). Every call starts with `session clear-all; reload`, so a `set` from
  one gate (report directories, `coverage`) never carries into the next.
  `SBT_OPTS` carries the same `-Dgauntlet.check=` marker. ANSI escapes the
  client prints are stripped before output is read.
- **sbt's build definition, cached.** Before any gate, sbt compiles
  `project/` (plugins, `build.properties`, build code). `project/**` is runner
  configuration restored from base, so its compiled form depends only on base
  content and the JDK. It's built once per key (those files plus `java
  -version`) in a clean directory containing only them, stored under
  `~/.cache/gauntlet/sbt-build-definition/` (or `$GAUNTLET_CACHE_DIR`), and
  copied into each checkout before its first sbt call. Nothing is copied back
  from a checkout that ran the change's code.
- **Ending them.** A pack may define `stop`, which the gate runner calls once
  after the check's tiers: the JVM pack ends its daemon, the Scala pack asks
  its server to shut down. Both then end any process still carrying the
  check's marker.

## What doesn't change

Tier order, fresh output directories per gate, the init script, the `set`
commands, the evidence read and every decision. Gates of one check already
shared a worktree and its build directory; they now also share a JVM. Nothing
is shared across checks.

## Measured

`packs/jvm/test/e2e.test.ts` on an M-series Mac, same machine, same fixture:
400.7 s before, 73.3 s after. An earlier Scala comparison (594.5 s against 652.9 s) is void: the second run
overlapped the JVM run, which used two to three cores. Measured cleanly, one
sbt start costs about 14 CPU seconds before any work, and a check made five;
compiling the build definition costs about 5 more. The Scala numbers with the
server and the cache are in the pull request.

## Protected test

The sbt half is on its own branch (`sbt-client`, stacked on this one):
`packs/scala/test/gates.test.ts` pins the old argv ("every gate runs sbt in
batch mode without colours or a server"), so it needs an owner to apply
`docs/specs/patches/0004-sbt-client-test.patch` there. This branch changes
Gradle and the pack `stop` hook only.

## Tests

- Unit: the daemon's JVM arguments come from the build's `gradle.properties`
  (continuation lines included) or Gradle's default, plus the marker; the
  gate runner calls each pack's `stop` once, after the gates.
- End to end: the JVM and Scala suites pass unchanged, and no daemon or server
  carrying a check's marker is left running after them.

# 0020. One warm Gradle daemon or sbt server per check, never shared across checks

Status: accepted (spec 0004)

## Context
ADR 0007 and the Scala pack started a fresh Gradle (`--no-daemon`) or sbt (`-batch`) for every gate, so no state from an earlier build could vouch for the code being judged. That costs a cold JVM and a build load per gate and made the JVM and Scala end-to-end jobs take 11 to 18 minutes. The real boundary is the check, not the gate: a check's gates already share one worktree and its build directory, and nothing a check does may reach another check.

## Decision
- A check's gates share one build-tool process: a Gradle daemon whose JVM arguments carry `-Dgauntlet.check=<check directory>` (so Gradle never matches it to any other build), or the sbt server the thin client starts in the check's own worktree.
- Each sbt call begins with `session clear-all; reload`, so one gate's `set` commands never reach the next. Gradle builds keep `--no-build-cache`, `--no-configuration-cache` and add `--no-watch-fs`.
- sbt's compiled build definition (`project/`, restored from base) is cached between checks, keyed by those files and the JDK, built in a clean directory holding only them and never copied back from a checkout.
- Packs gain an optional `stop` hook, called once after the check's gates, that ends the process. A marker match (`pkill -f`) and a Gradle idle timeout clean up after a crash.

## Consequences
- A build script in the change can influence later gates of the same check through the shared JVM, as it already could through the shared build directory. It can't reach another check.
- `pkill` is needed on the machine (it is on macOS and Linux; Windows is out of scope).
- The JVM e2e file went from 400.7 s to 73.3 s locally. An earlier Scala comparison that showed no gain was void (it overlapped another heavy run); a single sbt start costs about 14 CPU seconds, and a check made five.

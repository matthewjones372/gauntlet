# Spec 0010: compiler warnings, ratcheted

Status: accepted.

## Problem
Making compiler warnings errors (`-Werror`, `allWarningsAsErrors`) is right for a new project and impossible to switch on in an existing one: hundreds of old warnings break the build on day one. So existing projects never get stricter, and an agent's change can add warnings that nobody sees among the old ones.

## Behaviour
1. A pack's `warnings` check reports the compiler's warnings as findings (`compiler/warning`, or `compiler/warning/<category>` for javac's lint categories), with file and line. With `warnings ratchet`, today's warnings are recorded in the baseline and grandfathered, and a change that adds one fails, naming it. Warnings are matched by fingerprint, as lint findings are, so a moved warning isn't new.
2. The warnings are read from the build check's own compile in the same check. An incremental compile only warns about what it recompiles, and a second compile of unchanged code warns about nothing, so the warnings are read once, from the build. A check whose policy has no build check, or whose build results came from CI (ADR 0024), compiles for the warnings check itself.
3. The JVM pack runs Gradle at warning level for the build (quiet output hides warnings) and reads kotlinc's and javac's. The Scala pack reads scalac's, Scala 2 and Scala 3 formats, from sbt. Each compiler's run reads only its own format, so one warning is never counted twice.
4. A build that doesn't compile is an error for the warnings check, not a pass.

## Not covered
- TypeScript, Rust and Go warnings: tsc and Go have errors, not warnings; rustc's warnings are left to clippy with `-D warnings` in the lint check.
- Switching on `-Werror` once the count reaches zero: the wizard suggests it; the build file is the project's.

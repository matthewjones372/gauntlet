# 0007. Drive JVM tooling through a Gradle init script

Status: accepted (revised in M8)

## Context
Pitest, Kover and detekt need configuring, and their reports must land somewhere Gauntlet controls. Build files are protected and belong to the project. An agent may try to weaken whatever plugin configuration they contain.

## Decision
- The JVM pack ships a Groovy init script inside the binary and passes it with `--init-script` on every Gradle run. It never edits the project's build files.
- The script configures only the plugins the project already applies (`dev.detekt`, `org.jetbrains.kotlinx.kover`, `info.solidsoft.pitest`) and the core `Test` task. It redirects every report into the output directory Gauntlet created for the check, forces tests to rerun, has Pitest write XML for exactly the classes in scope, and hands detekt a baseline generated from Gauntlet's legacy set.
- Gradle runs with `--no-daemon --no-build-cache --no-configuration-cache` in the judged checkout, so nothing is reused from earlier builds.
- A tool that isn't applied is reported with a specific reason ("add the info.solidsoft.pitest Gradle plugin"). That makes the gate errored or not executed, which is missing evidence, never a pass.
- Thresholds, ratchets and verdicts come from the Gauntlet policy, not from plugin configuration. Plugin configuration lives in protected build files that are materialised from base (ADR 0003), so an agent can't change it either.
- `arch` rules are checked from Kotlin imports with tree-sitter rather than ArchUnit. That needs no test-classpath injection and works without compiling.

## Consequences
- Projects adopt Gauntlet without editing their builds, provided they already apply the tools they want gated. `gauntlet init` (M11) will suggest the plugin lines.
- Injecting plugins a project doesn't apply was dropped. It needed plugin resolution inside the init script and broke too easily across Kotlin and Gradle versions.
- Import-based arch rules see dependencies through imports only. Fully qualified references without an import are not caught.
- A fresh Gradle process per gate is slow (around 10 to 20 seconds each). Sharing one Gradle run across gates is a later optimisation.

## Amendment: coverage without a plugin

Most Gradle projects apply no coverage plugin, so `gauntlet init` couldn't propose a coverage gate for them. Injecting the Kover plugin stays dropped (above). Instead, the init script defines a `gauntletCoverage` task in every JVM module that brings its own tool only as plain dependencies or Gradle built-ins, never by resolving a plugin:

- **The project's Kover**, when it applies the plugin: the task runs `koverXmlReport`, as before.
- **Kotlin without Kover:** Kover's JVM agent (`org.jetbrains.kotlinx:kover-jvm-agent`, pinned) is resolved as a detached configuration and attached to every `Test` task with `-javaagent`; `kover-cli` at the same version then writes the same XML report the plugin would.
- **Java:** Gradle's built-in `jacoco` plugin, which needs no resolution, with its XML report in the output directory. JaCoCo is used for Java only; it reports Kotlin poorly.

Coverage is now proposed for every Gradle project. Lint (detekt) and mutation (Pitest) still need their plugins, and `init` still says which lines to add.

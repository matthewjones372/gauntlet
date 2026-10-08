# 0022. Several builds in one repository

Status: accepted

## Context
Gauntlet looked for one build at the repository's root and ran every check there. A repository such as tweet-street holds four builds in folders of their own (three Gradle, one sbt) and nothing at the root, so `gauntlet setup` found no project. One of the Gradle builds also includes another (`includeBuild("events")`), whose tests its own `test` task never runs.

## Decision
- The policy names each build's folder after its pack: `use jvm in "lark-bank", scala in "bank-checks"`. The IR gains an optional `builds` list (omitted when every pack builds at the root, so existing policies keep their hashes).
- A check runs once per build of each pack that implements it, in that build's folder, with its own output directories under `build-<folder>/`. The pack sees the build as the whole repository: its files, the diff and a scoped check's files are given with paths from its folder, and each file belongs to the deepest build that holds it.
- Gauntlet turns the results back into paths from the root (SARIF locations, per-file metrics) and merges the builds into one result per check, so the baseline, ratchets, review rules and reports are unchanged. A metric takes the worst build's value, so a floor holds for every build. A build's error is the check's error.
- A check `on changed` runs only in the builds the change touches. Suites and unscoped checks run in every build, since one build can depend on another (`includeBuild`).
- Runner configuration is protected under each build's folder.
- `gauntlet setup`, finding no build at the root, looks up to three folders down. A folder inside another build of the same pack is part of it unless the pack says it's a build of its own (Gradle: it has a settings file).
- A Gradle build without a wrapper of its own uses the nearest one above it, never outside the checkout.

## Consequences
- Holdouts with files still run at the root.
- Test ids aren't prefixed with their build, so two builds with a test of the same id count as one in the deleted-test check.
- The GitHub workflow sets up every build's tools; the JDK version still comes from `--java`.

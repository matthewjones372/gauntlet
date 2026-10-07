# 0012. Gauntlet produces its own evidence, and a silent green fails

Status: proposed

## Context
An agent can plant a passing JUnit XML file, filter tests down to nothing, or exclude a task, and many tools will report green. A gate that didn't run looks the same as a gate that passed unless you check.

## Decision
- Gauntlet creates a fresh output directory per check, passes it to the tool, and reads output only from there and only after the process it started exits. Files that existed before in the workspace are never read.
- External scanners are imported by running their command through Gauntlet (`{sarif}` placeholder), not by reading files.
- Every gate must produce proof: command, exit code, the hash of the report it produced, and an executed count where one applies. Missing proof means `not-executed`, which is missing evidence. An executed test count below the baseline fails the gate.
- Mutation caches are used only in shadow mode, or when the cache key covers the lockfile, the toolchain and all protected files.
- **Determinism:** the decision and the canonical evidence are pure functions of the IR, the SHAs and tool outputs, with sorted output and no time data. Timing goes in a separate `run` section.

## Consequences
- The proof can be checked after the fact, and it is what Sigstore attestation will sign later.
- Some tools need wrapping so they write to the directory Gauntlet chooses. Packs own that.

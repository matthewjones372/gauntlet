# 0016. Onboarding: pack defaults for existing projects, strict templates for new ones

Status: accepted (implemented in M11)

## Context
An existing project adopting Gauntlet needs a first policy it can trust. A new project can start with the bar set high. A gate whose tool isn't set up fails as missing evidence, so a first policy that names gates the project can't run would block every change from day one. The authoring agent (M12) drafts richer policies, but `init` has to work without a model.

## Decision
- **`gauntlet init --template`.** Each pack can `detect` its kind of project and `onboard` it: from the file list and its own manifests and build files, it proposes protect groups, suites and the gates whose tools are already set up. The core merges the proposals into policy text, in shadow mode, and compiles the draft before writing it. If a draft doesn't compile, that's Gauntlet's bug. Gates left out come back as setup hints with the exact line to add (for the JVM pack, the plugin lines from ADR 0007). Zones and arch rules are left as commented examples, because only people know which code is sensitive. Without a configured model, `init` uses the template and says so; an existing policy is never replaced without `--force`.
- **Proposals stay conservative.** Metric gates are ratchets `on changed` with no thresholds, so adoption never fails on old code. Tests, test fixtures, build and runner config, and `.github/workflows/` are protected.
- **`gauntlet new <template>`.** Templates live in `packages/templates` and are embedded into generated modules (`bun run generate`), so they ship inside the binary; binary files (the Gradle wrapper jar) are stored as base64. Paths may contain `__package__` and text `{{name}}`, `{{package}}` and `{{owner}}`, all validated before anything is written. `new` refuses a non-empty directory and runs `git init`.
- **`kotlin-service` is strict and must pass its own policy.** The project starts in enforce mode, with 90% coverage and an 80% mutation floor on changed code, layering rules (`domain` and `app` never import `infra`), a functional core (no `throw`, `var`, mutable collections, `!!`, `runCatching` or floating-point money), and property tests from the start. An end-to-end test generates it, records a baseline with no grandfathered findings and every file above the bars, and checks that a small tested change gets `auto` while mutable state and layering violations block.

## Consequences
- Adding a language means adding `detect` and `onboard` to its pack; `init` needs no change.
- Pitest can't kill mutants in Kotlin `inline` functions (the inlined copies run inside callers), so the template avoids them in code it mutates.
- Templates for other packs can follow the same layout.

## Amendment: strict drafts by default

`gauntlet init` drafted only ratchets, with zones and arch rules as commented examples, so a first policy guarded little. Since a draft starts in shadow mode and never blocks, the default is now strict:

- **Zones from folder names.** Folders named for money (`payments`, `billing`, `ledger`, `settlement`...), security (`auth`, `crypto`, `secrets`...) and schema migrations become zones, each the shallowest matching folder, with the packs' matching rules (`*.no-floating-money`). Without policy owners, a zone that would reach protected files is left out, so the draft still compiles.
- **Arch from layers.** A `domain` (or `core`, `model`) folder with outer layers beside it (`infra`, `api`, `web`, `adapters`...) gives `module domain must not depend on ...`, and the `arch` gate when a pack implements it.
- **Floors for new code.** Coverage and mutation ratchets gain floors on changed lines: 80% coverage, 60% mutation.

Inference reads folder names only, so the same files always give the same draft. `--lenient` keeps the earlier draft. Reading the code for what folder names miss is left to the coding agent, which can only propose policy text for a person to apply.

## Amendment: three steps, and the rules agreed with the agent

Getting started is three steps: install, `gauntlet setup` (the strict draft plus `connect claude-code`), and `/gauntlet-setup` in Claude Code followed by `gauntlet apply`.

- `/gauntlet-setup` is a Claude Code command that `connect claude-code` installs. The agent reads the code and the draft and goes through the decisions with the person one at a time (owners, each zone, layers, coverage floors, missing tools, when to block), recommending and explaining each. It validates the result with Gauntlet's `validate` tool and writes it to `gauntlet.proposal.gx`. It never writes `.gauntlet/`: its deny rules forbid that, and the command tells it not to (ADR 0009).
- `gauntlet apply` is run by the person. It validates the proposal against the repository, prints what changes with every loosening marked (found by comparing IR, as for the authoring agent), writes the policy, refreshes Claude Code's deny rules, commits the policy and the Claude Code files, records the baseline and commits it. Without a proposal it applies the current policy as it is. An invalid proposal changes and commits nothing. Running it again changes nothing.

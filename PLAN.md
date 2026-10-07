# Gauntlet v1 plan

Status: revision 2, approved 2026-10-07. Later decisions: protected tests stay strict (edited protected tests always run at base); `updated snapshots` is a forbid by default; order is the core (M9 to M14) first, then the Go and Rust packs, then the rest. Q-R1 and Q-R2 answered yes; every other open question in section 16 takes its proposal (Q-P1 reserved group names, Q-A1 advisory inside `gates`, Q-O1 top-level `owners`, Q-I1 `import <name> { command ... }` with `caution`, Q-G1 no turning off defaults, Q-H1 `--holdout name=<dir>`, Q-B1 `updated` is grandfathered, Q-N1 repo directory renamed to `gauntlet`). This revision applies the requirements update that renamed Harness to Gauntlet. Revision 1 was approved earlier the same day and M1 had started; section 18 lists what the already-written code has to change.

Answers carried over from revision 1:
- Q1: globs use `**`, and a trailing `/` also means everything under it.
- Q2: `use` lists packs only, and `kotlin.*` rules come from the jvm pack.
- Q3: commas and line breaks are both accepted as separators.
- MCP uses Effect's `McpServer` (ADR 0008).
- The model provider is pluggable (ADR 0010).

Spike (requirement 13): it has already run and passed. Langium, Effect 4 (`effect/cli`, `effect/ai`), `@effect/ai-anthropic`, MCP and web-tree-sitter all work inside `bun build --compile` binaries on macOS arm64, macOS x64 and Linux x64. Langium did not fail, so there is no need to fall back to hand-written Chevrotain. Details are in `spike/RESULTS.md`.

## 1. What Gauntlet is

Gauntlet is a verification integrity layer for code written by AI agents. Sonar, CodeScene and Codacy judge code quality. CodeRabbit, cubic, Greptile and MergeShield give LLM opinions on diffs. None of them check that the verification itself wasn't weakened. None of them run evidence such as mutation testing or holdout suites as merge gates. Their risk scores also aren't reproducible.

Gauntlet runs the evidence, protects the checks, ratchets how strong the verification is, and gives a deterministic review tier (`auto < skim < review < owner`) with a cited reason for every part of it. It reports and suggests reviewers. Merging stays with GitHub rulesets, required reviewers and merge queues.

Gauntlet never defines behaviour. Behaviour comes from the project's own suites. Gauntlet makes sure those suites ran, weren't weakened, and are at least as strong as on the base branch.

**Design test for every feature:** can the agent delete or weaken this check and still pass? The answer must be no. `gauntlet selftest` turns this test into something that runs (section 12).

### Names and files

| Thing | Name |
|---|---|
| CLI | `gauntlet` |
| Policy | `.gauntlet/policy.gx` |
| Baseline | `.gauntlet/baseline.sarif` |
| Project tamper fixtures | `.gauntlet/selftest/` |
| Built-in tamper fixtures | `fixtures/tamper/` (embedded in the binary) |
| Environment variables | `GAUNTLET_*` |
| Packages | `@gauntlet/*` |

All of `.gauntlet/` is implicitly protected and is always loaded from the base ref in CI.

## 2. Invariants

Each invariant has a test suite (`test/invariants/`) that tries to break it.

1. **Policy comes from the base.** In CI, `.gauntlet/**`, protected groups, test setup and runner config are materialised from the base SHA. Head copies are only diffed against them (ADR 0003).
2. **Gauntlet produces its own evidence.** It never reads result files already in the workspace. Each check gets a fresh output directory that Gauntlet creates. Output is accepted only from that directory and only from the process Gauntlet started (ADR 0012).
3. **A silent green fails.** Every gate must prove it ran: an executed test count, a report file Gauntlet produced (and its hash), the command and the exit code. Without that proof, the gate counts as missing evidence. A missing report or an executed count below baseline fails the gate.
4. **Same inputs, same decision, byte for byte.** The decision and the canonical evidence depend only on the policy IR, the base and head SHAs and the tool outputs. They contain no timestamps or durations and use a fixed ordering. Timing data goes into a separate `gauntlet-run.json` that nothing else reads.
5. **Most cautious wins.** Every matching rule nominates a tier, and the decision is the maximum. Rules can't loosen each other (ADR 0005).
6. **Probabilistic signals only raise.** This covers LLM reviews, imported LLM findings and trajectory signals. None of them can nominate below the current tier or act as the only gate (ADR 0011).
7. **Agent identity and history never loosen anything.** Agent, model and session ids are recorded but never read by the decision.
8. **Missing evidence is risk.** Anything unsupported, not executed, crashed, timed out, skipped by fail-fast or parse-only in v1 nominates at least `review`.
9. **The baseline only ratchets up.** Lowering needs `--allow-lower`, and any change under `.gauntlet/` nominates `owner`.
10. **No bypass by comment.** Gauntlet never treats PR comments as commands. The only override is `gauntlet override`. It is recorded, and on GitHub it needs a named owner's approval (ADR 0014).
11. **Holdouts never reach the agent.** They run only in CI. Output sent to an agent is cut down to the test name and a generic message. Locally they show as "holdout pending".
12. **No thrown exceptions in core.** Every failure is a `Data.TaggedError`. Process exits happen only in `packages/cli`.

## 3. Scope

**v1 implements:**
- the DSL compiling to a Policy IR, with its hash
- SARIF evidence and baseline
- integrity checks and proof of execution
- base-ref policy loading and materialisation
- gate orchestration
- diff facts and most-cautious-wins review
- modes, `report shadow`, overrides and `report_blocked`
- detekt baseline import and generic SARIF import
- `selftest` with the built-in fixtures, and `explain --coverage`
- language packs: `jvm` (Kotlin and Java, Gradle and Maven), `typescript` (including frontend JavaScript), `python`, `go`, `scala` (sbt), `rust`, `clojure`, `dotnet` (C#), `ruby` and `php`, each with its suites, mutation, coverage, lint and integrity detectors (section 21)
- functional-programming rules in each pack, usable per zone and ratcheted like other findings, and a `property tests` integrity ratchet
- `connect github` options a to d, and `connect claude-code` with hooks
- `init`, `new kotlin-service` and the authoring agent
- MCP
- the compiled binary

**Parsed and validated, not executed in v1:** holdouts, perf budgets, stacks and `llm review`. Each is reported as "not executed" and nominates `review` (invariant 8). As a result, any policy that uses one of them can't reach `auto` or `skim` in v1. That is intended, and the validator says so with an info diagnostic.

**Designed now, built later** (section 17): stacks, perf, org-level policy inheritance, GitLab and Bitbucket, outcome tracking, Sigstore attestation, and hook adapters for Codex, Cursor and Copilot.

## 4. Repository layout

```
packages/
  dsl/        Langium grammar, Validator, compiler to Policy IR, golden tests
  ir/         Policy IR schema, canonical JSON, IR hash (no Langium dependency)
  sarif/      SARIF 2.1.0 schema subset, converters, gauntlet/ctx/v1 fingerprints, baseline matching
  core/       PolicySource, Git, ProcessRunner, Workspace, DiffFacts, GateRunner, Integrity,
              Baseline, ReviewPolicy, Overrides, Coverage (explain --coverage), Selftest, Report, ShadowLog
  author/     authoring agent
  connect/    claude-code and github generators
  templates/  kotlin-service template
  cli/        effect/cli commands
  mcp/        MCP server (effect/ai McpServer)
packs/
  jvm/        Gradle, JUnit, Pitest, Kover, ArchUnit, detekt import, Kotlin integrity detectors
fixtures/
  tamper/     built-in tamper fixtures (embedded in the binary)
examples/
  policies/   sample .gx files
  fixtures/kotlin-service/
docs/adr/
spike/        throwaway
```

`ir` is a separate package so that core, packs and mcp depend on the IR and never on Langium.

## 5. Effect service graph

All services are `Context.Service` classes with `Layer`s. Tests swap in fake layers. No module mocking.

| Service | Responsibility | Live | Test |
|---|---|---|---|
| `Git` | show, diff with renames, merge-base, rev-parse, ls-tree, worktrees, notes | via `ProcessRunner` | in-memory + temp-repo helper |
| `ProcessRunner` | run with cwd, env, timeout; stream output; exit code | `effect/process` | scripted by argv |
| `Compiler` | `.gx` text to `PolicyIR` + source map, or diagnostics | Langium, built once | same (pure) |
| `PolicySource` | load IR from working copy or ref; drift | `Git` + `Compiler` | fixed IR |
| `PackRegistry` | installed packs; detection; catalog of gates, rules, integrity detectors, importers, runner-config globs | static list (ADR 0006) | fake packs |
| `Workspace` | judged checkout: worktree at head, materialisation from base, fresh output dirs | `Git` + `FileSystem` | temp dir |
| `GateRunner` | tiers in order, fail fast, proof of execution | packs + `ProcessRunner` | fake packs |
| `Integrity` | generic integrity checks; dispatch language detectors to packs | pure + packs | n/a |
| `Baseline` | read `baseline.sarif` from a ref, match, `baselineState`, ratchet, update, imports | `Git` + `FileSystem` | in-memory |
| `DiffFacts` | facts from git + IR | pure over `Git` | n/a |
| `ReviewPolicy` | `(ir, facts, evidence, comparison) -> Decision` | pure | n/a |
| `Overrides` | record and verify overrides for a head SHA | git notes + GitHub approvals | in-memory |
| `Coverage` | map every path to the zones, gates and protections that cover it | pure over IR + `Git` | n/a |
| `Selftest` | apply tamper fixtures in scratch worktrees and require each to be caught | `Workspace` + check pipeline | fake pipeline |
| `Reporter` | report JSON, markdown, SARIF | `FileSystem` | capture |
| `ShadowLog` | shadow records | git notes `refs/notes/gauntlet` | in-memory |
| `LanguageModel` | `effect/ai` model for the authoring agent | provider from config (ADR 0010) | scripted |
| `Acceptor` | human accept, edit or reject per block | terminal prompt | scripted |

## 6. Policy IR

The DSL compiles to a canonical Policy IR, an Effect Schema. It is the only policy representation used outside `packages/dsl` (ADR 0002).

- The IR holds meaning only. Source locations live in a separate source map (IR node path to file, line, column, source text). Reasons cite DSL lines through the source map.
- Canonical JSON means sorted object keys, a fixed array order (declared order where it matters, such as gate tiers; sorted elsewhere), shortest-form numbers and no whitespace. The IR hash is `sha256` of the canonical JSON. Edits to comments or formatting don't change it.
- Every report carries `irHash`, `baseSha` and `headSha`. `gauntlet explain --ir` prints the canonical IR.
- The IR includes `irVersion: 1`.

```ts
PolicyIR = {
  irVersion: 1, name, mode: "shadow" | "enforce", packs: string[], owners: string[],
  protect: { group: string, globs: string[] }[],         // implicit group "gauntlet": .gauntlet/**
  zones: { name, globs, owners, rules }[],
  arch: { module, mustNotDependOn: string[] }[],
  suites: { name, kind: "suite" | "holdout", location?: string, ciOnly: boolean }[],
  integrity: { ratchet: Ratchet[], forbid: Forbid[], flag: Flag[] },   // defaults merged in
  budgets: Budget[], stack?: Stack,                                     // parse-only in v1
  gates: { name, advisory: boolean, checks: Check[] }[],
  remediation: { gate, fix }[],
  imports: { name, command, trust: "evidence" | "caution" }[],
  predicates: { name, conditions: Condition[] }[],       // conditions may reference earlier predicates by name
  review: { tier: Tier, conditions: Condition[] }[],
}
```

## 7. DSL (surface syntax)

The revised example is below. Lines marked with a Q are proposals waiting for an answer (section 16).

```
gauntlet "trade-reporting"
use jvm
mode shadow
owners @platform                                       // Q-O1

protect {
  tests    "src/test/**", "src/acceptance/**"
  config   "*.gradle.kts", "gradle/**", ".github/workflows/**"
  fixtures "src/test/resources/golden/**"
}

zone money {
  paths "src/**/settlement/**", "src/**/fx/**"
  owner @payments
  rule kotlin.no-floating-money
}

arch { module domain must not depend on infra }

suites {
  unit       "src/test/**"
  acceptance "src/acceptance/**"
  holdout    "trade-holdout" ci only
}

integrity {
  ratchet executed tests, assertions per test
  forbid  new skips, new suppressions, test refs in main, exit in tests
  flag    equality overrides, catch-all near changed code, env branching
}

import semgrep { command "semgrep scan --sarif --output {sarif}" }     // Q-I1

gates {
  fast      { build, lint, arch ratchet }
  verify    { unit, mutation ratchet on changed, coverage >= 90% on changed in zone money }
  behaviour { acceptance, trade-holdout }
  advisory  { llm review x3 }                          // Q-A1
}

on fail mutation { fix "Add assertions that kill the surviving mutants listed in the report. Do not delete or weaken tests." }

predicate small = diff < 150 lines and no zone touched

review {
  owner  when zone touched                             // Q-R1: tier names as verbs
  review when protected changed
  review when dependency added
  auto   when small and all gates pass
}
```

Changes by block:
- **Header:** `gauntlet "<name>"`.
- **`protect { <group> <globs> }`:** replaces the flat list. A flat `protect "a", "b"` is still accepted as group `default`. Group behaviour is in section 9 (Q-P1).
- **`integrity`:** new, with a fixed vocabulary (section 10). Defaults are always on, and the block can only add or tighten (Q-G1).
- **`holdout "<name>" ci only`:** replaces `hidden "<x>" from env VAR`. Parse-only in v1.
- **`advisory { llm review x<N> }`:** an advisory tier. It is caution-only, never the sole gate, and parse-only in v1.
- **`on fail <gate> { fix "<text>" }`:** remediation text, included in the report, the Stop hook output and MCP results.
- **`predicate <name> = <cond> (and <cond>)*`:** a named condition. Predicates can use earlier predicates. Cycles and unknown names are errors.
- **Review rules nominate tiers:** the decision is the maximum nomination. `auto` and `skim` apply only when nothing stricter matches. If no rule matches, the tier is `review` (Q-R2). `raise when` is removed because a relative raise has no meaning under nomination. `evidence missing` already nominates `review` implicitly.
- **Policy and baseline changes** nominate `owner` implicitly.

**Validator additions** (on top of revision 1's checks for names, units, references and did-you-mean, with location, expected and fix on every diagnostic):
- **Conflicts:**
  - a check that is both required and advisory
  - a protected glob overlapping a zone that has no owner
  - duplicate predicates
  - an `auto` rule that can never win because a stricter rule always matches under the same conditions
  - a gates block that is advisory only
  - `on fail` for a gate that doesn't exist
  - a holdout referenced outside `ci only`
- **Glob overlap:** checked on literal prefixes, and against the real file list when PolicySource provides one.
- **Integrity phrases** that no used pack implements are an error.
- **Parse-only constructs** get an info diagnostic saying they nominate `review` in v1.
- **Removed syntax** (`harness`, `hidden ... from env`, `raise when`, `require when`) gets a targeted migration message.

## 8. Commands

| Command | Purpose |
|---|---|
| `gauntlet validate [file]` | compile and validate; print diagnostics |
| `gauntlet check [--policy-ref <sha>]` | run gates and integrity; produce the decision and report |
| `gauntlet explain [block] [--ir] [--coverage]` | explain the policy. `--ir` prints canonical IR. `--coverage` maps every source path to the zones, gates and protections that apply, and lists paths nothing protects. |
| `gauntlet baseline [--update] [--allow-lower] [--import detekt <file>]` | record or ratchet the baseline |
| `gauntlet selftest` | run the policy against built-in and project tamper fixtures; fail if any isn't caught |
| `gauntlet override --reason <text> --approver @x` | record an override for the current head |
| `gauntlet report shadow` | summarise the shadow period |
| `gauntlet init`, `new kotlin-service`, `author init/review/explain` | onboarding and authoring |
| `gauntlet connect github`, `connect claude-code` | integrations |
| `gauntlet mcp` | start the MCP server (stdio) |

Exit codes: `0` done (in enforce mode, nothing blocks); `1` the change is blocked in enforce mode, or `validate` found errors; `2` Gauntlet couldn't do its job (bad arguments, an invalid policy in `check`, a missing base ref, a git failure). Shadow mode never exits 1. `check` judges a commit (default `HEAD`), so uncommitted changes aren't checked, and writes its four report files to `.git/gauntlet/report` unless `--out` says otherwise. Commands recorded in proofs use `{checkout}` and `{out}` in place of temporary paths so identical runs stay byte-identical.

## 9. Policy source, materialisation and tamper model

The threat model is unchanged: the coding agent can edit anything in its branch. It can't edit the base branch, CI config on base or CI secrets.

**Materialised from the base SHA before any gate runs:**
- all of `.gauntlet/`
- every `protect` group
- the runner config the pack declares (JVM: Gradle test configuration, `settings.gradle.kts`, `gradle/`, `junit-platform.properties`, test resources)

Suites run in a fresh process.

**Protect group behaviour (proposal Q-P1):**

| Group | Head additions | Modifications | Deletions |
|---|---|---|---|
| `tests` | run, and counted in ratchets | base copy runs; nominates `review` | base copy runs; the `deleted tests` forbid fires |
| `config`, `fixtures`, other names | ignored for the run; nominates `review` | base copy used; nominates `review` | base copy used; nominates `review` |
| `gauntlet` (implicit) | ignored; nominates `owner` | ignored; nominates `owner` | ignored; nominates `owner` |

If base config can't build the head (for example, the PR legitimately adds a dependency), the gate is `not-executed` with reason "protected config changed". That is missing evidence, so it is never a silent pass.

**Mutation caches** (Pitest history and similar) are used only in shadow mode, or when the cache key covers the lockfile, the toolchain version and the hashes of all protected files. Any other cache is ignored.

**Attacks and defences:**

| Attack | Defence |
|---|---|
| Plant a passing JUnit XML or SARIF | invariant 2 |
| Make tests not run (filter, excluded task, empty suite) | invariant 3 and the `executed tests` ratchet |
| Delete or skip tests, weaken assertions, hardcode the expected value | integrity forbids and ratchets |
| Add `@Suppress` or `detekt:disable` | `new suppressions` forbid and ratchet |
| Special-case tests in main code | `test refs in main` forbid and `env branching` flag |
| `exitProcess(0)` in a test | `exit in tests` forbid |
| Edit test setup or runner config | materialised from base |
| Edit policy, baseline or project self-tests | loaded from base; nominates `owner` |
| Reuse a poisoned mutation cache | cache-key rule above |
| Learn the holdouts | CI only, redacted output (invariant 11) |
| Ask the bot by comment, or claim to be a trusted agent | invariants 10 and 7 |
| Use an LLM reviewer's approval as a pass | invariant 6 |
| Get the authoring agent to loosen policy | ADR 0009 |
| Write to protected paths during the session | Claude Code PreToolUse deny rules (section 14), and in any case judged from base |

## 10. Integrity checks

These are the core differentiator (ADR 0013). Generic checks live in core. Language detectors live in packs (JVM in v1, built on web-tree-sitter with the tree-sitter-kotlin grammar compiled to WASM).

| Check | Kind | Core | JVM pack |
|---|---|---|---|
| executed tests | ratchet | count from converted JUnit | task selection |
| assertions per test | ratchet | comparison of the total | assertion calls in test functions, totalled (adding tests never lowers it; per-test weakening and new tests with no assertions are `weakened assertions` forbids) |
| skipped or disabled tests | ratchet | JUnit skipped count | `@Disabled`, `@Ignore`, `assumeTrue(false)` |
| suppressions and inline disables | ratchet | comparison | `@Suppress`, `@SuppressWarnings`, `detekt:disable`, `noinspection`, `ktlint-disable` |
| quarantined flaky tests | ratchet | comparison | `@Tag("flaky")`, `@Tag("quarantine")` |
| deleted tests | forbid | test ids in base missing from head | test id extraction |
| weakened or tautological assertions | forbid | n/a | `assertTrue(true)`, `assertEquals(x, x)`, an assertion removed or replaced by a weaker one, an expected value hardcoded to the actual output |
| new skips | forbid | ratchet delta | source detection |
| new suppressions | forbid | ratchet delta | source detection |
| test refs in main | forbid | main code referencing test paths | test identifiers used in main code, test profile checks |
| exit in tests | forbid | n/a | `exitProcess`, `System.exit`, `Runtime.halt` in test scope |
| equality overrides | flag | n/a | new `equals`/`hashCode` |
| catch-all near changed code | flag | proximity to changed lines | `catch (e: Exception/Throwable)`, `runCatching` |
| env branching | flag | n/a | `System.getenv`/`getProperty` in a condition |
| mocks of the class under test | flag | n/a | `mockk<Foo>()`/`spyk` inside `FooTest` |
| test special-case comments | flag | comment scan on changed lines | comment extraction |

All forbids, ratchets and flags are on by default. A forbid fails the synthetic `integrity` check, which runs in the first tier. A flag nominates `review`. A check that no used pack implements is reported as not executed. The tree-sitter-kotlin WASM build is the first task of the JVM milestone (risk R1). If it fails, the fallback is line-based detectors for v1, which the plan would have to state as weaker evidence.

## 11. Evidence: SARIF 2.1.0 (ADR 0004)

- **One SARIF run per tool.** JUnit, Pitest and Kover output is converted. Test counts and proof of execution (command, exit code, report hash, executed count, output directory) go in `invocations[0]` and `properties.gauntlet`.
- **Fingerprint `gauntlet/ctx/v1`** is stored in `partialFingerprints`. It is `sha256(ruleId, normalised window, enclosing symbol)`. The window is the result's lines plus two lines either side, with whitespace collapsed (comments stripped when the pack supplies a normaliser). The enclosing symbol comes from the pack. If there is none, the key is `gauntlet/ctx/v1/nosym`. The path is part of the match key rather than the hash, so baseline findings follow renamed files.
- **`baselineState`:**
  - `unchanged`: exact match.
  - `updated`: same rule and path, and the same enclosing symbol or offending line, but a different window. Grandfathered and listed (Q-B1).
  - `new`: no match. Fails the gate.
  - `absent`: a baseline result that no longer appears.
- **Per-file count fallback:** for tools without stable locations. If a (rule, file) count rises, every result for that rule in that file is reported as `new`.
- **detekt baseline import** creates a legacy grandfathered set keyed by detekt's own signature. ESLint and Qodana come later.
- **Generic SARIF import:** external scanners are declared in the policy and run by Gauntlet, so invariant 2 holds. Their results go through the same matching. Imports marked `caution` (any LLM reviewer) can only raise the tier.
- **Ratcheted metrics** (mutation, coverage, and all integrity ratchets) are stored in `baseline.sarif` under `runs[].properties.gauntlet.metrics`, per file where available.
- **Mutation feedback to agents** is a short list of surviving mutants by file and line, not the raw report.

- **Evidence report.** Every `check` writes four files:
  - `gauntlet-report.json`: canonical JSON with the policy (IR hash, origin, base and head SHA, drift), the agent (recorded only), facts, checks with proof of execution, ratchet deltas, integrity findings, new violations, imports, what was not executed, remediation for failed gates, and the decision with a citation for every nomination.
  - `gauntlet-report.md`: the same as a PR comment, with blocking reasons first and long lists cut with a count.
  - `gauntlet-evidence.sarif`: every check's SARIF run.
  - `gauntlet-run.json`: timestamps and durations. Timing appears only here, so the other three files are byte-identical for the same inputs.

- **Baseline and modes.**
  - `gauntlet baseline` runs on the trunk tip only: HEAD must equal `--trunk`, which defaults to `origin/HEAD`, then `main`, then `master`. It runs every gate over the whole project without fail-fast, and records gate metrics, integrity ratchet values, fingerprinted findings and the test ids that ran.
  - An existing baseline is never overwritten without `--update`. `--update` takes improvements and drops fixed findings. If anything would get worse, nothing is written, the regressions are listed and the exit code is 1, unless `--allow-lower` is passed. Either way, the commit changes `.gauntlet/` and needs an owner.
  - `--import-detekt <file>` grandfathers a detekt baseline into a new baseline; adding it to an existing one needs `--allow-lower`.
  - Every `check` appends a record as a git note under `refs/notes/gauntlet` (`--no-record` skips it). `gauntlet report shadow [--since]` summarises those records: runs, how many would have blocked, the tier distribution, the most frequent reasons by policy line or rule, and the evidence most often missing. Shadow mode always exits 0.

## 12. Selftest

`gauntlet selftest [--base <ref>] [--only <names>]` makes the design test executable. For each fixture it:
1. commits the fixture's change on top of the base in a scratch worktree (the user's branches never move);
2. judges that commit exactly as CI would (`check` with the policy from the base);
3. requires the expected result.

A control run on an empty change comes first. If the policy blocks an empty change, the selftest fails before any fixture counts, and the control also gives the reference test counts. The selftest exits 1 if anything gets through.

Built-in fixtures, with what counts as caught:

| Fixture | Supplied by | Caught when |
|---|---|---|
| deleted test | pack | a `deleted tests` forbid |
| weakened assertion | pack | a `weakened assertions` forbid |
| added skip | pack | a `new skips` forbid |
| added suppression | pack | a `new suppressions` forbid |
| hardcoded expected value | pack (when a test asserts a literal from a function call) | the change is blocked: a test, mutation or ratchet fails |
| test id in main | pack | a `test refs in main` forbid |
| edited test setup | pack (runner config that runs no tests) | a protected-change nomination, with every test still running |
| lowered threshold | core | judged by the base policy, with an owner |
| edited baseline | core | an owner |
| fake result file | core (passing JUnit files where tools usually write) | the real tests counted, the planted files ignored |

Built-in fixtures are code in each pack rather than files in `fixtures/tamper/`, because they are built from the project's own tests and sources. A fixture with nothing to apply to (no tests yet, no baseline) is listed as not applicable.

Project fixtures are patches in `.gauntlet/selftest/*.patch`. Headers before the first `diff --git` line say what they test: `Description: ...` and `Expect: blocked` (the default), `Expect: tier >= review|owner` or `Expect: finding <check>`. A patch that no longer applies fails the selftest. The `connect github` workflow runs the selftest whenever `.gauntlet/` changes in a PR.

## 13. GitHub enforcement (`connect github`, ADR 0015)

`connect github` generates layered enforcement:

a. **Org or enterprise:** a workflow in a separate policy repo, required through a ruleset, pinned by SHA, with `pull_request` and `merge_group` triggers.

b. **Single repo:** a `pull_request_target` workflow in two jobs.
   - Job 1 is trusted. It checks out the base SHA and loads the policy, holdouts and baseline.
   - Job 2 runs the PR's code with no secrets and read-only permissions, then hands its results back as an artifact. Job 1 never runs PR code.

   The generated README states the known `pull_request_target` risks: secret exposure if PR code ever runs in the trusted job, cache poisoning and artifact trust. It also lists how each is handled.

c. **CODEOWNERS** for `.gauntlet/`, protected paths and zone owners, as a backstop.

d. **A PR check** that posts the tier and the report as a comment and a check run, and suggests reviewers.

Merging stays with GitHub. Gauntlet never merges and never approves.

## 14. Agent integration

- **MCP tools:**
  - `validate`, `check`, `explain`, `get_grammar`, `get_examples`, `author_draft` (proposals only)
  - `report_blocked` (new): the legitimate exit for "this can't be done without changing protected tests or policy". It records the reason, ends the attempt and nominates `review`. Research shows an explicit abort option sharply reduces cheating.
- **`connect claude-code`** generates:
  - a Stop hook that runs `gauntlet check` and blocks completion on failure with actionable reasons and `on fail` text. It respects `stop_hook_active` so that it can't loop.
  - PreToolUse deny rules for writes to protected paths, generated from the policy IR
  - the MCP config
  - a short section for CLAUDE.md and AGENTS.md
  - a recommendation to use managed hooks (`allowManagedHooksOnly`) for teams
- **Hook adapters for Codex, Cursor and Copilot:** the hook generator works from a neutral description (event, matcher, command, deny globs). Only the Claude Code renderer ships in v1.

## 15. Authoring agent

Mostly as in revision 1: it proposes and the human approves per block, loosenings need separate confirmation, and it is isolated from coding agents (ADR 0009). Changes:
- **Proposals must be backed by evidence.** Every proposal carries a `citation`: detected sensitive code, an unprotected test directory, an escape during the shadow period, a selftest gap, or a path with no coverage. Proposals without a valid citation are dropped before the human sees them, and the drop is logged.
- **New read-only tools:** `selftest` (dry run) and `explain --coverage`.
- Environment variables are `GAUNTLET_AUTHOR_*`.
- **As built (M12):** proposals are whole blocks (`protect`, `zone`, `arch`, `suites`, `integrity`, `import`, `gates`, `on fail`, `predicate`, `review`); `use`, `mode` and `owners` stay people's decisions and can't be proposed. Citations are checked against facts Gauntlet gathers itself, and must be addressed by the proposal: quoted code must be on the cited line and the file must end up in a zone or under new rules; an unprotected test file must end up protected as tests; an uncovered file must end up covered; a selftest gap must close in the dry run; a shadow reason must appear verbatim in the history. A sixth kind, `configured-tool` (a quoted line from a build or manifest file), backs gates changes such as adding mutation when Pitest is applied. Proposals that don't compile go back to the model with the diagnostics, up to three repair rounds. Dropped proposals are listed with the reason before the person sees the rest.

## 16. Open questions

Revision 1 left these as proposals and they still stand:
- Q5: suite names are free.
- Q6: coverage is measured on changed lines.
- Q7: mutation is compared per class against the baseline.
- Q10 to Q12: stack tier names, arch modules, git notes for shadow history.
- Q15: the default model.
- Q16: the real-Gradle e2e suite is opt-in locally and runs on every PR in CI.
- Q17: a generic pack for dogfooding.

Revision 1's Q4, Q8 and Q9 are replaced by the questions below.

**Syntax (need an answer):**
- **Q-R1. Review verbs.** Under nomination semantics, should the verbs be the tier names (`owner`, `review`, `skim`, `auto`)? I propose yes. `require` and `raise` would be removed, each with a migration error.
- **Q-R2. Default tier when no rule matches.** I propose `review` because it fails safe. The alternative is `skim`.
- **Q-P1. Protect groups.** Should `tests`, `config` and `fixtures` be reserved names with the behaviour in the section 9 table, or should behaviour be stated explicitly, for example `tests "src/test/**" allow additions`?
- **Q-A1. Advisory placement.** Should `advisory { ... }` be a tier inside `gates`, as shown, or a top-level block? I propose inside `gates`, with `advisory` reserved as a tier name.
- **Q-O1. Policy owners.** I propose a top-level `owners @platform` line. It names who counts as `owner` for `.gauntlet/` changes and who can approve overrides, and `connect github` mirrors it into CODEOWNERS.
- **Q-I1. Import syntax.** Should it be `import <name> { command "... {sarif}" }`, with `caution` marking LLM sources? Gauntlet runs the command and reads only `{sarif}`.
- **Q-G1. Integrity defaults.** Can a policy turn off a default forbid? I propose no in v1: the block can only add or tighten.
- **Q-H1. Holdout source.** Holdouts are parse-only in v1, but the syntax names a holdout without saying where it comes from. I propose that CI supplies it (`--holdout trade-holdout=<dir>`, checked out by the trusted job) and the syntax stays as you wrote it.

**Not syntax:**
- **Q-B1. `updated` results.** Should an `updated` result be grandfathered (my proposal) or treated as new ("touch it, own it")?
- **Q-N1. Repo directory.** Should I rename `~/IdeaProjects/harness` to `~/IdeaProjects/gauntlet`?

## 17. Designed now, built later

- **Stacks.** Read GitHub's native stack metadata first (from the PR event and the base-branch chain), then Graphite's `refs/branch-metadata` and ghstack's trailers, with a fallback that follows the base chain. Gate each layer on its own diff, and run acceptance and perf on the top of the stack. The v1 IR already holds the stack block, so this adds an executor, not new syntax.
- **Perf:** an isolated process measured with an external clock. Budgets are in the IR already.
- **Org-level policy inheritance:** the IR gains an `extends` reference to a pinned policy repo SHA. Merging uses most-cautious-wins, so a child can only tighten.
- **GitLab and Bitbucket:** connectors behind the same layered model. Core already has no GitHub dependency outside `connect` and `Overrides`.
- **Outcome tracking:** session to PR, 30-day survival, escaped defects per tier. This builds on the agent ids already recorded in reports.
- **Sigstore attestation** of the evidence report and IR hash.
- **Codex, Cursor and Copilot hook adapters** (section 14).
- **LLM review execution** (`advisory`): N independent reviews with no shared context, structured findings, and agreement recorded. Findings agreed by at least two reviews nominate one step up. Separate credentials (ADR 0009).

## 18. Code already written (M1, untested) and what changes

Everything written so far is in `packages/dsl`, and no tests have run. Nothing will be touched until this revision is approved.

| File | Change | Why |
|---|---|---|
| `grammar/harness.langium` | rename to `gauntlet.langium`; header `gauntlet`; add `protect {}` groups, `integrity`, `holdout ... ci only`, advisory tier, `on fail`, `predicate`, `owners`, `import`; tier-name verbs; remove `hidden ... from env` and `raise` | section 7 |
| `langium-config.json`, `generated/` | rename the project, use the `.gx` extension, regenerate | rename |
| `model.ts` | move to `packages/ir` as `PolicyIR` without spans; spans go to a source map; add canonical JSON and hash | IR boundary, determinism |
| `build.ts` | becomes `compile.ts`, which emits IR and a source map; handles the new blocks, predicate resolution, nominations and integrity defaults | sections 6 and 7 |
| new `conflicts.ts` | conflict checks | section 7 |
| `vocabulary.ts` | integrity phrases, tier verbs, group names | new blocks |
| `catalog.ts` | packs declare integrity detectors, importers and runner-config globs | "not implemented by any pack" errors |
| `parse.ts` | messages and keyword list for the new grammar; migration hints | error quality |
| `span.ts`, `diagnostic.ts`, `suggest.ts` | keep; default file `.gauntlet/policy.gx` | unaffected |
| `package.json` names | `@harness/*` to `@gauntlet/*` | rename |

`spike/` is unaffected.

## 19. Milestones

Each milestone ends with a summary and a stop for review. Each includes tests that try to weaken its own checks.

| # | Milestone | Done when |
|---|---|---|
| M1 | **dsl + ir**: grammar, compiler, canonical IR, hash, validator with conflicts | Golden IR per example. At least 40 golden error cases. Formatting-only edits keep the hash. |
| M2 | **policy source + workspace**: base-ref loading, protect groups, materialisation, fresh output dirs | Temp-repo tests. A planted result file is never read. |
| M3 | **sarif + baseline**: schema, converters, ctx/v1, baselineState, count fallback, detekt and generic import | Line shifts survived. Renames followed. Count fallback works. |
| M4 | **diff facts + integrity core + review policy**: nominations, predicates, implicit rules, `report_blocked` handling | Property tests: no rule undercuts another nomination, review and owner rules never lower the tier, caution steps up at most once, rule order is irrelevant. Every nomination cites a source. |
| M5 | **report + determinism** | Golden reports. Two identical runs give byte-identical output. |
| M6 | **cli**: validate, check, explain (incl. `--ir`, `--coverage`), override; the gate runner and the pack gate interface | CLI tests and exit codes, end to end against a script pack in temp repos. |
| M7 | **modes + baseline command + report shadow** | Lowering refused. Shadow exits 0 and records. |
| M8 | **jvm pack** (Kotlin on Gradle): tree-sitter-kotlin WASM, init script, fresh-process suites, detekt, Pitest, Kover, import-based arch, Kotlin integrity detectors and rules | Real-Gradle e2e scenarios pass. |
| M8b | **typescript pack** (done): tsc; vitest, jest or bun test; Biome or eslint; StrykerJS; lcov; TS integrity detectors and rules. `.gauntlet/policy.gx` for this repo in shadow mode | Real e2e on a TS fixture. Gauntlet checks its own PRs. |
| M8e | **python pack** (done): uv, poetry or pip; mypy or pyright; pytest; ruff; mutmut; coverage.py; Python detectors and rules | Real e2e on a Python fixture. |
| M8c | **go pack** (done): `go test -json` (never cached, `-count=1`), gremlins, `-coverprofile` with `-coverpkg=./...`, golangci-lint v2 SARIF with a per-check cache, import-based arch, `go.*` zone rules (no floating money, no panic, no ignored errors, no package-level vars), Go detectors (testify, quick and rapid; fuzz tests count as property tests; a TestMain that never calls m.Run() is forbidden), tamper fixtures, onboarding, flaky reruns with `-shuffle`, `connect github` sets up Go and the pinned tools | Real e2e on a Go fixture. |
| M8f | **rust pack** (done): cargo-nextest with Gauntlet's own config (JUnit into the output directory, no retries), clippy JSON converted to SARIF, cargo-mutants in a target directory of its own, cargo-llvm-cov lcov, `use`-based arch, `rust.*` zone rules (no floating money, unwrap, panic, unsafe, `static mut`), detectors for tests in tests/ and `#[cfg(test)]` modules (`#[ignore]`, `cfg!(test)` and `#[cfg(not(test))]` in main code, proptest and quickcheck), tamper fixtures, onboarding, flaky reruns varying parallelism, `connect github` with pinned Rust actions | Real e2e on a Rust fixture. |
| M8d | **scala pack** (done): every gate one sbt invocation with reports pointed at the output directory by `set` commands (JUnit, scoverage Cobertura), scalafix `--check` converted to SARIF, Stryker4s with Gauntlet's overrides appended to stryker4s.conf for the run, import-based arch, `scala.*` zone rules (no floating money, var, throw, null, mutable collections, unsafe runs), detectors for ScalaTest, munit, munit-cats-effect, ZIO Test and weaver (skips, `.flaky`/`@@ flaky`, `@nowarn`), tamper fixtures, onboarding from project/*.sbt, flaky reruns by suite with parallelism varied, `connect github` with pinned setup-sbt | Real e2e: full ScalaTest service plus one small project per other framework. |
| M8g | **clojure pack** (done): deps.edn or Leiningen; a built-in s-expression reader instead of tree-sitter (ADR 0018); kaocha with its JUnit plugin and cloverage brought by Gauntlet for each run (an `-Sdeps` alias, or `lein update-in`); clj-kondo JSON converted to SARIF; `ns :require` arch; `clojure.*` zone rules (no floating money, throw, mutable state, unsafe reads, println); detectors for deftest and defspec (`^:kaocha/skip`, clj-kondo ignores, `with-redefs` of the namespace under test); tamper fixtures; `mutation` reported not executed; `connect github` with pinned setup-clojure | Real e2e: a deps.edn service through every gate, and a Leiningen project. |
| M8h | **dotnet pack** (C#): `dotnet test` (trx to JUnit), Stryker.NET, coverlet lcov, Roslyn analyzers SARIF | Real e2e on a .NET fixture. |
| M8i | **ruby pack**: RSpec or Minitest JUnit, mutant, SimpleCov lcov, RuboCop | Real e2e on a Ruby fixture. |
| M8j | **php pack**: PHPUnit JUnit, Infection, PHPUnit coverage, PHPStan or Psalm | Real e2e on a PHP fixture. |
| M8k | **jvm: Java and Maven**: Java detectors and rules (tree-sitter-java), Maven support (Surefire JUnit, PIT, JaCoCo, SpotBugs or Checkstyle SARIF) | Real e2e on Java Gradle and Maven fixtures. |
| M8l | **frontend**: Playwright and Cypress acceptance suites; the `updated snapshots` integrity check; Vue and Svelte single-file components. UI additions (decided 2026-10-07): a new test whose only assertion is a snapshot is flagged as weak; axe results (Playwright or jest-axe) imported as SARIF and ratcheted; Playwright screenshot baselines are protected fixtures; bundle size and Lighthouse as budgets once budgets execute; detectors for `waitFor` with arbitrary timeouts, `sleep`, `data-testid` branching in main code and silenced `act()` warnings; a `react` rules namespace (no state mutation, no `useEffect` for derived state, no `any` props) | Real e2e on a React fixture. |
| M9 | **selftest** with built-in fixtures | Every built-in fixture is caught on the fixture repo. Removing a protection makes the selftest fail. |
| M10 | **connect** (done): github a to d, claude-code hooks. The trusted job recomputes everything that needs no execution (`judgeWithEvidence`); only gate outcomes come from the evidence job, and a check it doesn't report counts as not executed. `gauntlet github-status` turns the report, reviews on the head commit and honoured overrides into the `gauntlet` check (ADR 0015) | Snapshot tests. The Stop hook respects `stop_hook_active`. Deny rules match the IR. |
| M11 | **init + new** (done): packs `detect` and `onboard` a repository; `init --template` drafts a shadow-mode policy from the gates whose tools are set up and lists what to add for the rest; `new kotlin-service` creates a strict, enforce-mode project from embedded templates (ADR 0016). Also fixed: a metric ratchet `on changed` compared the changed files' total with the project-wide baseline; it now compares per file | Snapshots. A generated project passes in enforce mode. |
| M12 | **author** (done): `author init`, `author review`, `author explain`, and `init` uses the agent when it can run. Read-only tools (files, search, coverage, catalog, shadow history, selftest dry run, validate, git log); proposals are whole blocks with checked citations; a deterministic loosening detector; per-block acceptance with a typed confirmation for loosenings; providers per ADR 0010 | Fake LanguageModel: the loop converges, loosening is flagged, nothing is written without acceptance, uncited proposals are dropped. |
| M13 | **mcp** incl. `report_blocked` (done): `gauntlet mcp` serves `validate`, `check`, `explain`, `get_grammar`, `get_examples`, `author_draft` and `report_blocked` over stdio. `check`, the Stop hook and `check --working-tree` judge the working tree (uncommitted and new files) as a dangling commit built with a temporary index; the M10 hook only judged HEAD, so it missed uncommitted work. `report_blocked` (also `gauntlet report blocked`) is recorded for the exact tree it was made on: while it matches, checks nominate review with the reason and the Stop hook lets the agent finish; any edit makes it stale | In-memory client tests per tool. |
| M14 | **binary + CI + dogfood** (done): `bun run build` compiles darwin-arm64, darwin-x64 and linux-x64 with `checksums.txt` (reproducible builds); `scripts/smoke.ts` drives a binary through doctor, new, validate, explain, init, both hooks and the MCP server, passing on all three (x64 macOS under Rosetta, Linux in Docker), and a unit test builds and smokes the host binary on every run. `gauntlet doctor` checks the build and machine. CI: typecheck and tests, real-tool e2e, build plus per-platform smoke; tags publish a release after the same smoke tests. `connect github --from-source` builds the judge from the base commit, and this repository uses it. This repository's policy is enforced with a recorded baseline; failing tests are now named in reports and agent feedback | Three-target smoke test. This repo's policy (shadow since M8b) switches to enforce. |
| M15 | **flaky tests** (done, ADR 0017) (after the core, before the Go and Rust packs): new and changed tests run several times, shuffled and with fresh seeds, and any disagreement is a forbid (`new flaky test`); a failed test is rerun alone, and passing on rerun classifies it flaky, which still blocks `auto` and nominates review; newly added retry configuration (Gradle test-retry, pytest-rerunfailures, `jest.retryTimes`, vitest `retry`) is a forbid; test outcomes go into the shadow notes and `gauntlet report flaky` lists tests that both passed and failed on identical code; pack detectors flag sleeps, wall-clock time, unseeded randomness and real network calls in new tests. Syntax (confirmed 2026-10-07): `quarantine { "svc.FxTest.rounding" until 2026-11-01 owner @payments }`, an owner-approved, expiring exception; repeat runs fixed at 3 | A flaky fixture test is caught on its first appearance; a deterministic one never is. Retry config added in a PR is forbidden. |
| M16 | **faster checks without weaker evidence**: content-keyed caches built only from the base commit (dependency downloads, build outputs, Gradle and cargo artifacts), keyed by lockfiles and source hashes so a change can never seed them; independent gates in a tier run in parallel; incremental mutation that reuses results for files whose hash and covering tests are unchanged since the baseline, and is ignored unless its key covers the protected files (scenario 23); per-gate timings in the report | A cache seeded by the change is ignored; identical decisions with and without caches; a measured speed-up on each fixture. |
| M17 | **performance budgets executed**: `budget` blocks run their command in the judged checkout, read metrics it writes into the output directory (p50 to p999, mean, max, error rate, throughput), compare with thresholds and with the baseline using repeated runs and a noise tolerance, and gate in the `perf` tier; `budget changed` stays an owner-reviewed protected change. Built-in readers for JMH (`-rf json`) and Gatling (stats JSON), plus a documented Gauntlet metrics JSON that any custom load tool can write; each pack protects its benchmark and simulation sources (`src/jmh/**`, Gatling simulations, `benches/`, `*_bench_test.go`, and the like) so a change can't weaken the benchmark it is measured by | A regression beyond tolerance fails; noise within tolerance doesn't; a budget edit in the change is judged by the base; JMH, Gatling and custom-JSON results are read the same way; an edited benchmark source needs review. |
| A1 (after v1) | **connect codex**: Codex hooks rendered from the neutral hook description, AGENTS.md block, MCP config, deny rules where Codex supports them. v1 ships Claude Code only (decided 2026-10-07) | Snapshot tests; the stop hook blocks a failing change in a scripted Codex session. |
| A2 (after v1) | **connect cursor**, **connect copilot**, **connect gemini**: the same adapter shape for each agent's hook and MCP formats | Snapshot tests per agent. |
| A3 (after v1) | **native Windows**: a `bun-windows-x64` target with its own smoke job; Gradle through `gradlew.bat`, no `sh` or `rm` in core (imports, snapshots), paths normalised to `/` at every boundary with git and the tools, hook commands that run in PowerShell. Until then the README points Windows users to WSL 2 | The e2e suites pass on `windows-latest`; the binary passes the smoke test there. |

## 20. End-to-end scenarios (fixture repo, real Gradle)

1. A clean change gets `auto`.
2. A change to a protected path gets `review`.
3. A zone change gets `owner`.
4. A weakened test is caught.
5. A policy edit in the PR is judged by the base policy and gets `owner`.
6. A baseline edit is ignored for judging and gets `owner`.
7. A ratcheted metric dropping below the baseline fails.
8. A pre-existing violation is grandfathered, and a new one of the same rule fails.
9. A grandfathered violation survives an unrelated line shift.
10. Shadow mode exits 0 and records what would have blocked.
11. A fake result file in the workspace is ignored.
12. A suite filtered to run nothing fails as a silent green.
13. An executed test count below the baseline fails.
14. Every built-in tamper fixture is caught.
15. The same inputs give a byte-identical decision and evidence.
16. An imported LLM finding can raise the tier but never lower it.
17. An override without a qualifying approval is recorded but not honoured.
18. A detekt baseline import grandfathers its entries.
19. A renamed file keeps its grandfathered violations.
20. A new `System.getenv` branch is flagged and gets `review`.
21. `report_blocked` ends the attempt and gets `review`.
22. A holdout locally shows as "holdout pending" and nominates `review`.
23. A mutation cache whose key doesn't cover the protected files is ignored in enforce mode.

Authoring agent test (fake model): proposals without evidence are dropped.

## 21. Language packs

Every pack follows the JVM pack's shape (ADR 0006, ADR 0013): the project's own build tool runs the suites and tools, every report lands in Gauntlet's output directory, and a vendored tree-sitter grammar (WASM, embedded in the binary) powers integrity detectors, fingerprint symbols and pack rules.

| Pack | Suites | Mutation | Coverage | Lint | Grammar |
|---|---|---|---|---|---|
| `jvm` (Kotlin, Gradle) | Gradle test tasks, JUnit XML | Pitest | Kover | detekt | tree-sitter-kotlin |
| `typescript` | vitest, jest, bun test (JUnit reporters) | StrykerJS | istanbul/c8, bun lcov | eslint or Biome (SARIF) | tree-sitter-typescript |
| `go` | `go test -json` | gremlins | `-coverprofile` | golangci-lint (SARIF) | tree-sitter-go |
| `scala` (sbt) | sbt test, JUnit XML | Stryker4s | scoverage | scalafix | tree-sitter-scala |
| `python` | pytest `--junitxml` (unittest through pytest) | mutmut | coverage.py `coverage lcov` | ruff `--output-format sarif` | tree-sitter-python |
| `rust` | cargo nextest (JUnit) | cargo-mutants | cargo-llvm-cov | clippy (SARIF) | tree-sitter-rust |
| `clojure` | kaocha (JUnit XML) | none mature: not executed | cloverage | clj-kondo | built-in reader (ADR 0018) |
| `dotnet` | `dotnet test` (trx) | Stryker.NET | coverlet | Roslyn analyzers (SARIF) | tree-sitter-c-sharp |
| `ruby` | RSpec, Minitest (JUnit) | mutant | SimpleCov | RuboCop | tree-sitter-ruby |
| `php` | PHPUnit (JUnit) | Infection | PHPUnit | PHPStan, Psalm | tree-sitter-php |

**Frontend.** The `typescript` pack already covers JavaScript, JSX and TSX, and React component tests are ordinary vitest or jest tests. M8l adds Playwright and Cypress as acceptance suites, Vue and Svelte single-file components, and a new integrity check, `updated snapshots` (a forbid by default): regenerating `__snapshots__`, inline snapshots or visual baselines is how a UI test gets "fixed" without fixing the UI, so it needs a human. Bundle size is a perf budget (parse-only in v1).

**Test framework profiles.** Gauntlet never picks a test framework: it runs the build's own test task. Frameworks matter only to the integrity detectors (what counts as a test, an assertion, a skip, a property test). A pack detects the framework from the build's dependencies and loads a profile. The Scala pack ships profiles for ZIO Test (`test(...)`, `assertTrue`, `@@ TestAspect.ignore`, `check(Gen...)`), munit and munit-cats-effect, weaver (`expect`, `pureTest`) and ScalaTest. The Python pack ships profiles for pytest and unittest, with Hypothesis counting towards the property-test ratchet. A framework with no profile leaves its detector checks not executed, which is missing evidence, never a silent pass.

**Functional-programming rules.** Each pack offers FP rules a zone can name, for example the JVM pack's `kotlin.no-var`, `kotlin.no-mutable-collections`, `kotlin.no-throw`, `kotlin.no-null-assertion` and `kotlin.no-run-catching`. They are deterministic syntax checks, grandfathered and ratcheted like any lint finding, and the `new suppressions` forbid stops an agent from suppressing them. The `property tests` ratchet (on by default) counts property-based tests, so they can't be swapped for example tests.

**Dogfooding.** Gauntlet is TypeScript, so the TypeScript pack is what lets Gauntlet judge its own pull requests (this replaces Q17's generic pack). The repo's policy starts in shadow mode as soon as that pack lands. A bug in Gauntlet could pass its own check, so the packs' own tests remain the real guard; the dogfood run adds evidence, not trust.

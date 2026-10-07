<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/gauntlet-logo/gauntlet-lockup-dark.svg">
  <img src="assets/gauntlet-logo/gauntlet-lockup-light.svg" width="280" alt="gauntlet">
</picture>

**Trust AI-written code. Verify the verifier.**

The agent can write the code. It can't redefine what "done" means.

## Get started in 3 steps

**1. Install**

```bash
curl -fsSL https://raw.githubusercontent.com/matthewjones372/gauntlet/main/install.sh | sh
```

**2. Set up your project.** In its folder, on your main branch:

```bash
gauntlet setup
```

**3. Agree the rules with Claude.** Open Claude Code in the same folder and type
`/gauntlet-setup`. It looks through your code, explains what it recommends and
asks you about each decision. When you're done, run the command it gives you:

```bash
gauntlet apply
```

That's it. Claude Code now checks its own work before it says a task is done,
and it can't weaken your tests or the rules to get there. Nothing is blocked
until you say so: Gauntlet starts by only reporting.

> Release candidate (v0.1.0-rc.2). Works end to end; expect rough edges.

## Why Gauntlet

AI coding agents are getting very good at changing code. But a typical agent
can also:

1. change the implementation,
2. change the tests,
3. change the test configuration,
4. run the tests,
5. see whether they pass.

So the agent isn't only writing the solution. It can also change the machinery
that decides whether the solution is correct. If the goal is "make the tests
pass", deleting a test, weakening an assertion, adding a skip, changing the test
runner or making the test exit early can be much easier than fixing the bug.

This is a version of an old problem in AI research: **reward hacking**. An agent
optimised against a proxy for what we want can learn to exploit the proxy
instead. In coding, the tests and the CI result are that proxy, and research on
agentic systems describes modifying tests and interfering with evaluation as
this kind of reward hacking.

So the interesting question isn't "can an agent make the tests pass?" It's:

> Can an agent make the tests pass **without being able to weaken the evidence
> used to judge it**?

That's what Gauntlet is for.

## What Gauntlet does

Gauntlet is a verification integrity layer for AI-assisted development. It sits
between a code change and the decision to trust it. Instead of only asking
"did the tests pass?", it asks:

```text
          ┌──────────────────────────────────┐
          │           Code change            │
          └────────────────┬─────────────────┘
                           │
          ┌────────────────▼─────────────────┐
          │           Verification           │
          │                                  │
          │  • Did the checks actually run?  │
          │  • Can we trust the results?     │
          │  • Were tests weakened?          │
          │  • Did coverage drop?            │
          │  • Did mutation strength drop?   │
          │  • Did the architecture slip?    │
          └────────────────┬─────────────────┘
                           │
          ┌────────────────▼─────────────────┐
          │         Review decision          │
          │                                  │
          │   auto / skim / review / owner   │
          └──────────────────────────────────┘
```

Gauntlet doesn't decide whether your code is correct. Your own tests, linters,
architecture rules and other checks still define that. Gauntlet makes sure
those checks stay trustworthy.

### The central invariant

Everything in Gauntlet follows from one question:

> Can the agent weaken this check and still pass?

If the answer is yes, the check isn't strong enough. That leads to these rules:

- **The policy comes from the base branch,** so an agent can't loosen the rules
  and then pass under the weaker ones.
- **Protected tests and test configuration come from the base,** so editing
  them doesn't change the evidence the change is judged by.
- **Gauntlet only trusts evidence it produced:** it creates fresh output
  directories and reads results only from the processes it started.
- **A silent green is a failure.** A suite that runs zero tests, or missing
  evidence, is never a pass.
- **Verification only gets stronger.** Coverage, mutation strength and other
  metrics can't quietly drop.
- **Integrity checks look for weakened verification:** skipped or deleted
  tests, weakened assertions, new suppressions, test-only code paths and added
  retries.
- **Flaky tests are failures,** not something to retry until it happens to pass.
- **Probabilistic signals can raise suspicion, never lower it.** Nothing a model
  says can make a change look safer.

Gauntlet doesn't make agents trustworthy by trusting them more. It makes the
evidence harder to manipulate.

### Why not just CI?

CI answers "did these commands return success?" Gauntlet asks "should we
believe the success?" Take a change where an agent writes:

```diff
- assertEquals(expected, actual)
+ assertTrue(true)
```

The test passes, CI is green, and the agent reports success, but the evidence
has been weakened. The same goes for:

```diff
+ @Disabled
  class PaymentTest { ... }
```

or a test runner changed so the suite never runs, a retry added so a flaky test
eventually goes green, or an old result file left in the workspace and mistaken
for this run's. None of these are failures of the test framework. They're
failures of the verification boundary, and that boundary is what Gauntlet
guards.

## How it works

Gauntlet reads one file, `.gauntlet/policy.gx`: the **policy**. Every change,
whether Claude or a person wrote it, is checked against it, and gets a result:

| Result | What it means |
| --- | --- |
| `auto` | Every check passed and the change is small. Safe to merge. |
| `skim` | A quick look is enough. |
| `review` | Someone should review it properly. |
| `owner` | It touches something sensitive, so its owner must review it. |

The policy is made of a few simple ideas:

- **Owners** are the people who approve sensitive changes and edits to the
  policy, written as GitHub names such as `@your-username` or `@your-org/team`.
- **Protected files** are your tests, test setup and build configuration. When
  a change edits them, Gauntlet runs your original versions instead, so
  weakening a test can't make a change pass, and the edit is flagged.
- **Zones** are the parts of your code that need extra care, such as payments,
  login or database migrations. A change inside a zone needs its owner's
  review, and a zone can switch on stricter rules, like "no floating-point
  money" or "no thrown exceptions".
- **Layer rules** say which parts of the code may not use which, for example
  "the domain never imports the web layer".
- **Checks** are what every change must pass: the build, your tests, lint,
  layer rules, test coverage and mutation testing (whether your tests would
  notice a bug). Fast checks run first; slower ones only run if those pass.
- **Ratchets and floors** keep quality from slipping. A ratchet means a number
  can't get worse than it is today, for example a file's coverage. A floor sets
  a minimum for new and changed code, for example "80% of new lines tested".
- **The baseline** records where your project stands when you start. Existing
  lint warnings are accepted; only new ones fail, so old code never blocks you.
- **Shadow mode** only reports what Gauntlet would do. When the reports look
  right (`gauntlet report shadow`), change `mode shadow` to `mode enforce` and
  failing changes are blocked.

On top of the policy, Gauntlet always looks for the usual ways to fake a pass:
skipped, deleted or weakened tests, new lint suppressions, test-only code paths
in the main code, tests that exit early, added retries, and flaky tests (new and
changed tests run several times; one that only sometimes passes fails the
change, unless an owner quarantines it until a set date). It only trusts results
from its own runs, and a test suite that runs nothing counts as a failure.

A complete policy looks like this:

```
gauntlet "go-service"
use go
mode enforce
owners @platform

protect {
  tests "**/*_test.go"
}

zone money {
  paths "settlement/**"
  owner @payments
  rule go.no-floating-money, go.no-panic
}

arch { module domain must not depend on infra }

suites { unit "**/*_test.go" }

gates {
  fast   { build, lint ratchet, arch }
  verify { unit, coverage ratchet >= 80% on changed, mutation ratchet on changed }
}

predicate small = diff < 150 lines and no zone touched

review {
  owner  when zone touched
  review when protected changed
  auto   when small and all gates pass
}
```

`gauntlet explain` describes your policy in plain English, `gauntlet validate`
checks it, and `gauntlet selftest` tries known cheats against your code to prove
the policy catches each one.

### What happens to a change

Without Gauntlet:

```text
agent writes code → tests pass → CI green → merge
```

With Gauntlet:

```text
agent writes code
      ↓
the policy is taken from the base branch
      ↓
protected tests and configuration are restored from the base
      ↓
checks run in fresh evidence directories
      ↓
Gauntlet confirms the evidence is genuine
      ↓
integrity checks look for weakened verification
      ↓
tests, coverage, mutation and architecture are evaluated
      ↓
the review level is decided
      ↓
GitHub checks the required approval exists (with `gauntlet connect github`)
```

The result isn't another AI reviewer saying "LGTM". It's a deterministic
decision backed by evidence: the same change always gets the same answer.

### The research behind it

Gauntlet draws on a few converging ideas:

- **Reward hacking.** Systems can optimise a measurable proxy while missing the
  real objective, and agents can go further and manipulate the environment that
  produces the score. For coding agents the proxy is usually "the tests pass",
  and if the agent can change the tests, their configuration or the evidence,
  the proxy itself is attackable.
- **Verification is a moving target.** A verifier that holds against today's
  agent may be exploitable by tomorrow's. The generator and the verifier need to
  evolve together, so Gauntlet treats verification strength as something to test
  and ratchet: `gauntlet selftest` tries known cheats against your own policy.
- **Software testing research.** Gauntlet builds on established techniques
  rather than replacing them: mutation testing, coverage, architecture rules,
  static analysis, flaky-test detection, baseline ratchets and adversarial
  testing (hidden holdout tests are planned). What's new is putting them behind
  an integrity boundary designed for an agent that can edit the repository.

## More

- **When your code changes:** if a change adds something that looks sensitive
  but isn't in a zone (say, a new `billing/` folder), Gauntlet's report says so.
  Run `/gauntlet-setup` again any time to review the policy against the code as
  it is now; `gauntlet apply` shows exactly what would change.
- **Check a branch yourself:** `gauntlet check` (add `--working-tree` for
  uncommitted changes).
- **Check pull requests on GitHub:** `gauntlet connect github`, then commit the
  workflow it writes.
- **Missing tools:** `gauntlet doctor` lists what your project needs.
- **Windows:** use [WSL 2](https://learn.microsoft.com/windows/wsl/install). Run
  `wsl --install` in PowerShell once, then follow the steps above in the
  **Ubuntu** app, with your project inside Ubuntu (not under `/mnt/c/`).
- **Installing by hand:** download `gauntlet-darwin-arm64` (Apple silicon Mac),
  `gauntlet-darwin-x64` (Intel Mac) or `gauntlet-linux-x64` (Linux, WSL) from
  the [releases page](https://github.com/matthewjones372/gauntlet/releases),
  check it against `checksums.txt`, make it executable and put it on your
  `PATH` as `gauntlet`.

## Supported languages

| Language | Build tool | Tests | Lint | Coverage | Mutation |
| --- | --- | --- | --- | --- | --- |
| Kotlin, Java | Gradle | JUnit | detekt | Kover | PIT |
| TypeScript, JavaScript | Bun, npm, pnpm, yarn | Bun test, Vitest, Jest | ESLint or Biome | the test runner's own | Stryker |
| Python | uv, Poetry, pip | pytest | Ruff (and mypy if configured) | coverage.py | mutmut |
| Go | go | go test | golangci-lint | go cover | gremlins |
| Rust | Cargo | cargo-nextest | clippy | cargo-llvm-cov | cargo-mutants |
| Scala | sbt | ScalaTest, munit, ZIO Test, weaver | scalafix | scoverage | Stryker4s |
| Clojure | Clojure CLI, Leiningen | clojure.test (run by kaocha) | clj-kondo | cloverage | none yet |

`gauntlet init` only turns on the checks your project is set up for, and tells
you what to add for the rest.

## While the repository is private

The install command only works once the repository is public. Until then,
download with the [GitHub CLI](https://cli.github.com), which uses your GitHub
login, then install the file by hand (above):

```bash
gh release download v0.1.0-rc.2 --repo matthewjones372/gauntlet --pattern gauntlet-darwin-arm64
```

The workflow from `gauntlet connect github` downloads the binary the same way, so
until the repository is public, pass `--download-url` with a copy of the Linux
binary you host yourself.

## Development

Gauntlet is written in TypeScript on [Bun](https://bun.sh) and
[Effect](https://effect.website).

```bash
bun install
```

```bash
bun run typecheck && bun test
```

The end-to-end tests run real projects from `examples/fixtures` with their real
tools. They're off by default locally:

```bash
GAUNTLET_E2E=1 bun test packs
```

Build the release binaries into `dist/`:

```bash
bun run build
```

This repository is checked by its own policy (`.gauntlet/policy.gx`). Design
decisions are in [docs/adr/](docs/adr/), and the roadmap is in
[PLAN.md](PLAN.md).

To release, set the version in `packages/cli/src/version.ts` and push a
matching tag such as `v0.1.0`. The release workflow builds, tests and publishes
the binaries. A tag with a suffix, such as `v0.1.0-rc.2`, becomes a prerelease.

## License

[Apache-2.0](LICENSE)

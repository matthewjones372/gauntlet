<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/gauntlet-logo/gauntlet-lockup-dark.svg">
  <img src="assets/gauntlet-logo/gauntlet-lockup-light.svg" width="280" alt="gauntlet">
</picture>

# Trust AI-written code. Verify the verifier.

[![Release](https://img.shields.io/github/v/release/matthewjones372/gauntlet?include_prereleases&sort=semver)](https://github.com/matthewjones372/gauntlet/releases)
[![CI](https://github.com/matthewjones372/gauntlet/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/matthewjones372/gauntlet/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/matthewjones372/gauntlet)](LICENSE)

An AI coding agent working in your repository doesn't only change the code
you're about to judge. It can change the tests, the test configuration, the
coverage settings and the report files too: everything that decides whether
the code is correct.

CI can tell you the tests passed. It can't tell you whether the agent changed
the tests first. Gauntlet is built for that gap.

## The problem

This is real output from the Kotlin example in this repository. The change
gets currency conversion wrong by a factor of ten, and replaces the one
assertion that would have caught it.

```diff
 // src/main/kotlin/svc/settlement/Fx.kt
-    fun convert(amount: Money): Money = Money(amount.minor * rateBasisPoints / 10_000, target)
+    fun convert(amount: Money): Money = Money(amount.minor * rateBasisPoints / 1_000, target)

 // src/test/kotlin/svc/settlement/FxTest.kt
     @Test
     fun converts() {
-        assertEquals(Money(110, "USD"), Fx(11_000, "USD").convert(Money(100, "EUR")))
+        assertTrue(true)
     }
```

```text
Agent changes the implementation.
Agent changes the test.
CI passes.
The code is still wrong.
```

Every test passes, because the one test that could fail now asserts `true`.
€1.00 now converts to $11.00 instead of $1.10, and nothing in the pipeline
says so.

Here's what Gauntlet told the agent when it tried to finish:

```text
Gauntlet would block this change:
- unit failed: 1 of 4 tests failed
- assertTrue(true) can't fail. (src/test/kotlin/svc/settlement/FxTest.kt:11)
Failing in unit:
  - svc.settlement.FxTest.converts(): org.opentest4j.AssertionFailedError:
    expected: <Money(minor=110, currency=USD)> but was: <Money(minor=1100, currency=USD)>
```

The test file is protected, so Gauntlet put the original back before running
anything. The original test ran and failed on the real bug. The edit itself
was reported too: an assertion that can't fail replaced one that could.

## The boundary

Gauntlet treats the checks that judge a change as something the change isn't
allowed to touch. Every check in it is designed against one question:

> Can the agent delete or weaken this check and still pass?

The answer has to be no.

**The agent can write the code. It cannot redefine what "done" means.**

## Why CI isn't enough

| Tool | What it tells you |
| --- | --- |
| CI | Did the configured checks pass? |
| Tests | Did the tests pass? |
| Coverage | Was the code exercised? |
| Mutation testing | Are the tests strong enough? |
| AI review | Does the change look reasonable? |
| Gauntlet | Can I trust the verification itself? |

Every row above assumes the checks are the ones you meant to run. With an
agent in the loop, that's the assumption that breaks. The thing being
evaluated can edit the evaluation.

Gauntlet isn't trying to replace those tools. It runs most of them. Its job is
narrower: stop the agent being evaluated from changing the machinery used to
evaluate it.

This isn't a made-up edge case. Research on coding agents has found them
modifying tests, over-mocking and gaming their reward signals, all ways of
producing a passing result that means less than it looks. None of it
evaluates Gauntlet, but it's the problem Gauntlet is built for.
[References](#research), and what each study found in
[docs/research.md](docs/research.md).

## How it works

- **The checks come from the base branch.** Fixtures, test setup and runner
  configuration are put back to their base versions before anything runs, so
  editing them can't change the result. A protected test the change edits (a
  changed requirement changes its tests) runs as edited and always needs
  review; `--protect-only` restores tests too.
- **Gauntlet produces its own evidence.** Checks run in a fresh worktree, and
  Gauntlet reads only what the processes it started wrote. A planted report is
  ignored, and a check that can't prove it ran never counts as a pass.
- **Weakening is detected.** Deleted, skipped and weakened tests, new
  suppressions and similar edits are found in the diff.
- **Strength can't quietly drop.** Coverage, mutation score and test counts
  ratchet against a baseline.
- **Decisions are deterministic.** Same inputs, same decision. No model
  involved.

On GitHub, the job that runs the pull request's code gets no secrets, and a
separate job that never runs it makes the decision.

## Holdouts

A test the agent can read is a target. It can make that test pass without
making the code right: return the value the test expects, special-case its
input, or edit it. Protecting the test stops the editing. It doesn't stop the
overfitting.

A holdout is a behavioural check the agent never sees. Passing it means the
code works on cases it wasn't shown. That's a different kind of evidence from
a test sitting next to the code in the agent's own working copy.

Today a policy can name holdout files, which you write. Gauntlet leaves them
out of every checkout it runs checks in, blocks Claude Code's file tools from
them, and runs them only in CI, from the base branch. A change that passes the
visible tests but fails a holdout fails as a **holdout gap**. The files still
live in the repository, so they're hidden from the agent, not secret; a source
outside the repository is planned. Details are in
[the policy docs](docs/policy.md#holdouts).

## Try it

In your project, on its main branch:

```bash
curl -fsSL https://raw.githubusercontent.com/matthewjones372/gauntlet/main/install.sh | sh
gauntlet setup
```

Then open Claude Code there, type `/gauntlet-setup`, answer its questions and
run the `gauntlet apply` it gives you. Claude Code now runs Gauntlet before it
says a task is done. It starts in shadow mode, which reports and blocks
nothing until you switch it on.

### What setup looks like

An example session in a Kotlin payments service (`/gauntlet-setup` in Claude
Code, shortened):

```text
> /gauntlet-setup

● Here's what you already have: you build with Gradle and test with JUnit 5.
  Kover already requires 80% line coverage, detekt runs with your config, and
  CI runs the tests on every pull request. There's no mutation testing.

  Decision 1 of 6 · Owner
  Who approves sensitive changes and edits to the policy?
  > @maria

  ✅ Owner: @maria.

  Decision 2 of 6 · Zones
  A zone is code where a change needs @maria's review. I found:
    • src/main/kotlin/payments/   money: Transfer, Ledger, FxRate
    • src/main/kotlin/auth/       tokens and permissions
  For payments I recommend also banning floating-point money (Double, Float).
  > Yes, both zones, and the money rule

  ✅ Zones: payments (no floating-point money) and auth.

  Decision 3 of 6 · Layers
  domain/ never imports web/ today. Keep it that way?
  > Yes

  Decision 4 of 6 · Tests and coverage
  Kover already requires 80%, so I recommend 80% for new and changed code.
  > 80%

  Decision 5 of 6 · Mutation testing
  Mutation testing makes small deliberate bugs in your code and runs your
  tests against each one; a bug no test catches is a test that doesn't really
  check anything. It runs your tests once per bug, so it's the slowest check.
  I recommend it only on changed lines in payments, or leaving it out.
  > Changed lines in payments

  Decision 6 of 6 · When to block
  Start in shadow mode (reports, blocks nothing), or block failing changes now?
  > Shadow mode

  This will be applied:
    • owner @maria
    • zones payments (no floating-point money) and auth, both need @maria
    • domain must not depend on web
    • 80% coverage on changed code; mutation 60% on changed code in payments
    • shadow mode
  Apply it now?
  > Apply it now

● Applied on the branch gauntlet/setup: the policy, a baseline of today's
  coverage and findings, and Claude Code's hooks. Everything passes. Open a
  pull request for it: gh pr create --fill
```

From then on Claude Code runs Gauntlet before it says a task is done, and
every pull request gets a `gauntlet` check with a plain-English summary. A
change that touches `payments` says so in colour, lists what needs a look,
and waits for @maria to tick **Approve this change** in the report.

Just want the GitHub check, no agent setup?

```bash
gauntlet init
gauntlet connect github --protect-only
```

Commit `.gauntlet` and `.github`, require the `gauntlet` check in your branch
ruleset, and open a pull request that replaces an assertion with
`assertTrue(true)`. It fails.

Starting a new project? `gauntlet new kotlin-service my-service --owner @you`
creates a Kotlin service with a strict policy already in enforce mode
([next steps](docs/getting-started.md#a-new-project)). For any
other language, create the project with your usual tool, commit it, then run
`gauntlet setup`. In a new or an existing project, setup offers to install the
tools its checks need (a linter, coverage, mutation testing), and if part of
the project uses a language or build tool Gauntlet doesn't support yet, it says
so and how to ask for it or add it.

Kotlin and Java (Gradle), TypeScript and JavaScript, Python, Go, Rust, Scala
and Clojure are supported. On Windows, use WSL 2. Step by step:
[Getting started](docs/getting-started.md).

## Is it tested?

`gauntlet selftest` applies ten kinds of tampering to a copy of your own
project (a deleted test, a weakened assertion, a planted result file, a
lowered threshold and so on) and checks the policy catches each one.

The [tamper corpus](docs/evidence.md#the-tamper-corpus) measures the detectors
in public: 56 committed cases across the seven language packs. All 35
tamperings are detected. 7 of the 21 cases that should stay silent don't: a
test renamed with its body unchanged reads as a deleted test. That's reported
as it is.

Gauntlet is built under its own policy. Its Stop hook blocked the agent that
was writing it more than once.

## Status

Release candidate (v0.1.0-rc.20). Claude Code is the only agent integration so
far; Codex, Cursor, Copilot and Gemini are planned. .NET, Ruby, PHP, Maven and
native Windows aren't done yet. The roadmap is
[PLAN.md](PLAN.md).

## Documentation

- [Getting started](docs/getting-started.md): Claude Code, the GitHub-only path, who it's for
- [The policy](docs/policy.md): writing `.gauntlet/policy.gx`, zones, ratchets, holdouts, review levels
- [Claude Code and GitHub](docs/integrations.md): hooks, MCP, the two-job workflow
- [Evidence and testing the verifier](docs/evidence.md): report files, selftest, the tamper corpus
- [Supported languages](docs/languages.md)
- [FAQ](docs/faq.md)
- [Development](docs/development.md): architecture, building, adding a language pack
- [Design decisions](docs/adr/) and [specs](docs/specs/)

## Research

These papers motivate the problem. None of them evaluates Gauntlet. What each
one found is summarised in [docs/research.md](docs/research.md).

1. Morampudi, A., Irrinki, U., Grandhi, R., Pagadala, V. and Maddula, M.
   *A survey of reward hacking in agentic large language model systems.*
   Discover Artificial Intelligence 6 (2026).
   [doi:10.1007/s44163-026-01980-z](https://doi.org/10.1007/s44163-026-01980-z)
2. Wang, B., Zhang, C., Liu, D. et al. *The Verification Horizon: No Silver
   Bullet for Coding Agent Rewards.* 2026.
   [arXiv:2606.26300](https://arxiv.org/abs/2606.26300)
3. Hora, A. and Robbes, R. *Are Coding Agents Generating Over-Mocked Tests? An
   Empirical Study.* MSR 2026.
   [arXiv:2602.00409](https://arxiv.org/abs/2602.00409)
4. Alami, D. *Specification gaming in LLM-generated code: detecting cognitive
   camouflage by adversarial execution.* 2026, preprint (not peer reviewed).
   [SSRN 6512960](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6512960)
5. Deshpande, D., Kannappan, A. and Qian, R. *Benchmarking Reward Hack Detection
   in Code Environments via Contrastive Analysis.* ICML 2026.
   [arXiv:2601.20103](https://arxiv.org/abs/2601.20103)

## License

[Apache-2.0](LICENSE)

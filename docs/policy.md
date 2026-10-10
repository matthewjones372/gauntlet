# The policy

What `.gauntlet/policy.gx` says and how Gauntlet decides. Back to the [README](../README.md).

`gauntlet setup` writes the first version of `.gauntlet/policy.gx`, inferred
from your layout, and `/gauntlet-setup` refines it with you. A complete example:

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

The pieces:

- **Owners** approve sensitive changes and edits to the policy (`@user` or
  `@org/team`).
- **Protected paths** are restored from the base before anything runs.
- **Zones** mark code that needs its owner's review and can switch on stricter
  rules, such as no floating-point money.
- **Layer rules** (`arch`) say which modules may not import which.
- **Gates** are the checks, in tiers: fast checks run first, and later tiers
  only run if they pass. A **ratchet** can't get worse than the baseline; a
  **floor** (`>= 80% on changed`) applies to new and changed lines, so old code
  never blocks a change.
- **Shadow mode** only reports. Switch to `mode enforce` when
  `gauntlet report shadow` looks right.

## Several builds in one repository

When the builds sit in folders of their own, name each folder after its pack
([ADR 0022](adr/0022-several-builds.md)):

```
use jvm in "lark-bank", "lark-bank/events", "bank-access", scala in "bank-checks"
```

`gauntlet setup` writes this line when the repository's root has no build but
its folders do, including a Gradle build included in another (a folder with
its own `settings.gradle.kts`).

- Every check runs in each build, in that build's folder, and the results come
  back as one check: `unit` is every build's tests.
- A check `on changed` runs only in the builds the change touches.
- A floor holds for every build: the build with the lowest value decides.
- Paths in the policy (protected paths, zones, suites) are from the
  repository's root. A suite's location is also read from each build's folder,
  so `unit "**/src/test/**"` covers every build.
- Each build's runner configuration (Gradle's `gradle/**`, sbt's `project/**`)
  is protected in its own folder.

## Mutation testing

Mutation testing makes small deliberate bugs in your code (turning a `>` into
`>=`, say) and runs your tests against each one. A bug that no test catches
shows a test that runs the code but doesn't really check it, which coverage
alone can't tell you.

It runs your tests once for every bug it makes, so it's by far the slowest
check: minutes where your tests take seconds, and far longer across a whole
project. Keep it quick by running it only on the lines a change touches, and
only in the zones that matter:

```
verify { unit, mutation >= 60% on changed in zone money }
```

`gauntlet setup` explains this before it adds mutation testing, setup skips
the whole-project run, and a check whose mutation step takes over three
minutes says so and how to speed it up.

## Stacked pull requests

A change of 400 lines or more that spans several parts of the repository
(packages, builds, top-level folders) gets a suggestion in the report to
review it as stacked pull requests: one per part with its tests, each on top
of the one before, lowest layer first by the policy's `arch` rules, with
Gauntlet's own settings in a pull request of their own. Parts under 30 lines
join the next one. The agent offers to split the change and only does it if
you agree. Ticking the box on the top pull request of a stack approves every
pull request under it whose commit it contains, and its report warns of that
above the box; merge the stack bottom first with merge commits, as a squash
gives the pull requests above new commits to approve again, and delete each
branch as it merges (`gh pr merge --merge --delete-branch`): otherwise GitHub
merges the next pull request into the branch below instead of the default
branch. Set the size with:

```
split when diff > 600 lines
```

## Performance budgets

A budget runs a benchmark and holds its results to limits ([spec 0006](specs/0006-perf-budgets.md)):

```
budget api {
  command "k6 run --summary-export {json} perf/api.js"
  p95 < 200ms
  errors < 0.1%
  regression < 10% vs baseline
}

gates {
  verify { unit }
  perf   { budget api }
}
```

The command runs in the judged checkout and writes its results to `{json}`:
Gauntlet's own JSON (`{"p99": 48, "errors": 0.02, "throughput": 1200}`, times
in milliseconds), `hyperfine --export-json {json}`, `k6 run --summary-export
{json}`, a Proofload run document (each step a series), Gatling's
`js/stats.json` (each request a series), JMH's `-rf json`, `go test -bench`
(text or `-json`), criterion's `estimates.json`, pytest-benchmark's
`--benchmark-json`, Locust's `--csv` stats, vegeta's JSON report or `oha
--json`, copied to `{json}`. A load test whose
generator fell behind its schedule (Proofload's `behind`) is not executed: its
numbers describe the generator, not the service. Limits use the policy's units (`ms`, `s`, `%`, `rps`).
`max(p99) < 100ms` takes the worst of the per-endpoint or per-command
results. `vs baseline` compares with what `gauntlet baseline` measured:
`p99 < 10% vs baseline` lets p99 grow by less than 10%, and `regression`
holds every time (and throughput) to that. Benchmarks are noisy, so record the
baseline on the same kind of machine that runs the checks, and give the limit
some room.

## Holdouts

A holdout is a set of tests the agent never sees. Name its files with `paths`:

```
suites {
  unit    "**/*_test.go"
  holdout "acceptance" paths "**/*_holdout_test.go" ci only
}
gates {
  verify    { unit }
  behaviour { acceptance }
}
```

Holdout files are taken out of every checkout Gauntlet builds, and
`gauntlet connect claude-code` stops the agent reading or editing them. They
run only in the GitHub evidence job (`check --holdouts`, which
`connect github` adds), from the base commit; everywhere else they show as
"holdout pending". A change that passes the visible tests but fails a holdout
fails the check as a **holdout gap**, counted on its own line in the summary,
and the report names only the failing tests. Holdouts live in the repository,
so they're hidden from the agent, not secret from people with read access.
Only Claude Code's file tools are denied: an agent running a shell command
could still read them. There's no generator; you write the holdouts. See
[ADR 0019](adr/0019-holdout-paths.md).

`gauntlet explain` describes a policy in plain English and `gauntlet validate`
checks it. The DSL compiles to a canonical, hashed policy IR, so two policies
that mean the same thing have the same hash.

## Removing a feature

Deleting a test is forbidden: it's the oldest way to make a check pass. But removing a feature removes its tests too. When a change deletes a test file together with the source file it's named after (`FxTest.kt` with `Fx.kt`, `fx.test.ts` with `fx.ts`, `fx_test.go` with `fx.go`, `test_fx.py` with `fx.py`), it's flagged instead: the change needs a person's review, not a fix. Those tests don't count against the executed-tests ratchet either. A test deleted while its code stays is still forbidden.

## Review levels

| Level | What it means |
| --- | --- |
| `auto` | Every check passed and the change is small. Safe to merge. |
| `skim` | A quick look is enough. |
| `review` | Someone should review it properly. |
| `owner` | It touches something sensitive, so its owner must review it. |

Missing evidence, a failing gate, a regression or an integrity finding each
nominate `review` (and block in enforce mode); any change to `.gauntlet/`
nominates `owner`. If no rule matches, the level is `review`.

## Everything it protects

| Implemented today | How |
| --- | --- |
| **The policy** | In CI the policy, baseline and protected paths come from the base commit. A change to `.gauntlet/` is judged by the old policy and needs an owner. |
| **Tests, fixtures, test setup and runner configuration** | Protected paths and each language's runner config are restored from the base before anything runs. Editing them can't change the result; the edit is flagged. |
| **The evidence** | Each check gets a fresh output directory. Gauntlet reads only what the processes it started wrote there, so a planted result file is ignored. |
| **Proof of execution** | Every gate records its command, exit code, report hash and, for suites, the executed test count. Missing proof is "not executed", which is missing evidence, never a pass. A suite that runs zero tests fails. |
| **Verification strength** | A baseline records coverage, mutation score, executed tests, assertions and lint findings. These ratchet: they can't drop. Existing lint findings are grandfathered; new ones fail. |
| **Test integrity** | Integrity checks find deleted, skipped and weakened tests, new suppressions, test-only branches in main code, `exit` in tests, added retries, and more, with language-aware detectors per pack. |
| **Flakiness** | Failures are rerun alone; new and changed tests run several times. A test that only sometimes passes fails the change unless an owner quarantines it until a date. |
| **Sensitive code** | Zones mark code such as payments or auth; a change there needs the zone owner's review and can switch on stricter rules. Layer rules keep modules from importing what they mustn't. |
| **Bypasses** | Overrides are explicit, recorded as git notes and honoured on GitHub only with a named owner's approval of that exact commit. Pull request comments are never read as commands. |

Two rules keep the decision honest:

- **Most cautious wins.** Every matching review rule nominates a level, and the
  strictest nomination is the result. Nothing can lower another rule's
  nomination.
- **Probabilistic signals are caution-only.** Imported findings marked
  `caution` (for example from an LLM reviewer) can raise the review level by at
  most one step and never lower it.

| Parsed and validated, not yet executed | Status |
| --- | --- |
| Holdout suites without `paths` | Reported as pending, which counts as missing evidence |
| `llm review` checks | Reported as not executed |

# Spec 0020: a mutation budget, and mutation that doesn't hold the verdict

Status: implemented on branch `mutation-budget`. Builds on spec 0011.

## Problem

Spec 0011 left "a cap on mutants per change" out. Mutation runs inside its tier,
after the tests, one gate after another, so a big change waits for every mutant
before anything is decided. On petshop a large change takes 16 to 20 minutes in CI,
nearly all of it mutation, and a policy that only `advise`s on survivors makes the
verdict wait for findings that never block. Nothing says beforehand that a change
is too big to mutate in reasonable time, and the CI log shows no time per gate, so
it isn't obvious where the minutes went. The split suggestion for big changes looks
at changed lines (400 by default) and knows nothing about mutation.

## Behaviour

### 1. A budget in mutants

A mutation gate scoped to the change can take a budget:

```
verify { unit, mutation advise on changed max 150 mutants }
verify { unit, mutation >= 60% on changed max 300 mutants }
```

`max <n> mutants` comes after the scope and before `in zone`. It needs `on
changed` (a whole-project run has nothing to cap per change), a whole number from
1, and the unit `mutants`. Only the mutation gate takes it. The IR keeps it as
`max` on the gate check, absent otherwise, so policies without it keep their hashes.

### 2. The estimate

Before the gate runs, Gauntlet estimates how many mutants the change brings. For
every file in the gate's scope that is a source file a mutation tool mutates (by
extension: Kotlin, Java, Scala, TypeScript, JavaScript, Python, Go, Rust, Clojure)
and isn't a test, documentation or Gauntlet's or CI's settings, it counts the
changed lines that look executable: not blank, not only a comment, not only
brackets, and not an `import`, `package` or `use` line. Each such line counts as
**two** mutants. That is rough on purpose: an operator set gives one to three
mutants on a line with logic, and none on a declaration. It errs high, so a budget
holds even for dense code. The estimate needs no build and no tool run.

The estimate is the same function wherever it is used (the gate, the split
suggestion), so they always agree.

### 3. Over budget, a blocking gate isn't run

With a threshold or a ratchet (not `advise`), an estimate over the budget means
the gate is **not executed**, with the reason

> about 412 mutants on the changed lines, over the policy's budget of 150: split
> the change (see the suggested split)

A gate that isn't executed is missing evidence, so the change is nominated for
review as any not-executed gate is (ADR 0012). It is never a pass.

### 4. Over budget, `advise` samples

Under `advise` the gate runs on a sample. The changed executable lines are
shuffled with a generator seeded by the head commit (the seed the stability
reruns use), and the first `floor(max / 2)` lines are kept. The gate runs with its
scope narrowed to the files holding those lines, and with only those lines as the
changed lines. So core's filter counts only mutants on sampled lines, and a pack
that narrows its tool to the changed lines (spec 0019) runs only those. The same
head commit always picks the same lines; a new commit may pick others.

The gate's reason says what was sampled:

> sampled 140 of about 412 mutants (lines chosen by the head commit); 3 survive,
> reported without blocking

where 140 is the mutants the tool reported on the sampled lines and 412 the
estimate for the whole change.

### 5. Over budget, the split is a finding

Whenever a mutation gate's estimate is over its budget, enforce or advise, the gate
adds one advisory finding (rule `mutation/over-budget`, check `mutation`, no file)
that names a split:

> About 412 mutants on the changed lines, over the policy's budget of 150. Split
> the change into pull requests of up to 150 each: 1. packages/core (about 120
> mutants); 2. packages/cli (about 140 mutants); 3. packs/jvm/src/Gate.kt (about 152
> mutants, over the budget on its own).

The report's stack suggestion uses the same grouping: when a mutation budget is
exceeded it is shown whatever the change's size in lines, and each step says its
estimated mutants. Parts are the ones the 400-line suggestion uses (packages,
builds, top-level folders), in the same review order. A part over the budget with
more than one file is broken into its files. Consecutive parts are then joined
while the step stays within the budget. Gauntlet's own settings stay a step of
their own. A step that is still over the budget on its own (one big file) says so.
A split of one step (all of it in one file) isn't shown as a stack; the finding
still says the file is over.

### 6. `advise` mutation in a job of its own

In the single-repository workflow, a policy whose mutation gates all `advise` gets
a `mutation` job beside `evidence`, started at the same time. It runs the same
checkout, toolchain and setup as `evidence`, then

```
gauntlet check --policy-ref "$BASE" --head "$HEAD" --out gauntlet-mutation --no-record --advised-mutation only
```

and keeps `gauntlet-mutation` as an artifact. `evidence` runs with
`--advised-mutation skip`: its mutation gate is recorded as not executed, advisory,
"runs in its own job", which blocks nothing. So `status` posts the verdict as soon
as the tests are done.

A `mutation-report` job, after `mutation` and holding no pull request code, reads
the artifact's report and posts a separate check run, `gauntlet mutation`, with
conclusion `neutral`, the gate's reason as its title, and each located advisory
mutation finding as a warning annotation (at most GitHub's 50). The report comes
from a job that ran the pull request's code, so it is used for annotations and
nothing else: it never feeds the verdict.

`--advised-mutation only` runs only the `advise` mutation gates and nothing else in
the tiers; `skip` records them as not executed and runs the rest. A policy with a
blocking mutation gate keeps it in `evidence`: the verdict needs it. So does a
policy with a `scenarios` check, which reads which tests killed which mutants. The
organisation workflow keeps everything in one job (it has no token to post a
second check).

### 7. Time per gate

`gauntlet check` prints the time each gate took after the report, whether or not
the output is a terminal:

```
Time per gate: build 12s, unit 1m 05s, coverage 3s, mutation 14m 02s; total 15m 30s
```

The report files stay free of timings, so two runs on the same commit still write
the same bytes (invariant 4); the times are in the run record (`gauntlet-run.json`)
as before. `github-status` reads the evidence job's run record next to its report
and ends the pull request's comment with the same timings in a collapsed section,
so the comment shows the evidence job's times, not its own.

### 8. Loosening

A blocking mutation gate over its budget isn't run, so adding a budget to one, or
lowering it, is a loosening (`looseningsBetween`) that needs its own confirmation,
as a weaker threshold does. A budget on an `advise` gate blocks nothing either way.

## Not covered

- A budget in time (`within 5m`). The time a run takes isn't known until it has
  run, and stopping a tool part way loses every result it hadn't written. A mutant
  budget is what can be decided before the run.
- Estimates from the tool itself (a Pitest dry run or a per-pack operator count).
  The per-line estimate is cheap and errs high; a pack can refine it later.
- Sampling mutants rather than lines: the tools don't name mutants before they run.

## Tests

- The grammar and compiler: `max 150 mutants` compiles to `max: 150`; without it
  the IR has no `max`; it is rejected on a gate other than mutation, without `on
  changed`, with another unit, and with a fraction.
- The estimate counts executable changed lines twice, skips blanks, comments,
  brackets, imports, tests and documentation, and only counts the gate's scope.
- Enforce over budget: not executed with the reason, a `mutation/over-budget`
  finding naming the split, review nominated; within budget it runs as before.
- Advise over budget: the gate's context holds only the sampled lines and their
  files, the reason says "sampled N of about M", and the same head picks the same
  lines while another head can pick others.
- The stack suggestion appears for a small change over its mutation budget, packs
  parts under the budget, breaks an oversized part into files, and says when a
  single file is over on its own.
- The workflow: a policy with only `advise` mutation gets the `mutation` and
  `mutation-report` jobs and `--advised-mutation skip` on `evidence`; a blocking
  mutation gate, protect-only and org mode don't. Golden workflows updated.
- `--advised-mutation only` and `skip` run and record the right checks.
- Timings: the CLI line and the comment's section from a run record; the report
  files are unchanged, so the golden reports are unchanged.
- A new or lower budget on a blocking gate is a loosening; on `advise` it isn't.

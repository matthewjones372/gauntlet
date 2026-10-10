# Spec 0007: performance tests the wizard writes, and budgets that run when they matter

Status: proposed. Builds on spec 0006 (performance budgets).

## Problem
Spec 0006 lets a policy hold a benchmark's results to limits, but almost nobody has a benchmark to hold. Projects rarely know which code is performance-critical, rarely have a load test for it, and an agent's change can make a hot path ten times slower with every test still green. When a project does have load tests, running them on every check would make every check slow, which is the reverse of what people will put up with.

## Behaviour

### 1. Gauntlet reads the tools people use
A budget's command writes its results to `{json}` or a file it names. Gauntlet reads, besides its own JSON, hyperfine and k6 (spec 0006):

| Tool | Kind | What Gauntlet reads |
| --- | --- | --- |
| JMH | benchmark (JVM) | `-rf json`: each benchmark is a series; score and its unit become times, throughput mode becomes `throughput` |
| Gatling | load test (JVM) | the run's `js/stats.json`: per request percentiles, errors and requests a second |
| Proofload | load test (JVM) | its machine-readable result export; its exit code too: 0 met, 1 missed a goal, 2 the generator fell behind, 3 refused, 4 unusable |
| criterion | benchmark (Rust) | `target/criterion/*/new/estimates.json` |
| `go test -bench` | benchmark (Go) | `-json` output, `ns/op` per benchmark |
| pytest-benchmark | benchmark (Python) | `--benchmark-json` |
| mitata, tinybench | benchmark (TypeScript) | their JSON output |
| Locust | load test | `--csv` stats |
| vegeta, oha | load test | their JSON reports |

A run whose load generator fell behind (Proofload's exit 2; any tool that reports it) is **not executed**, never passed or failed: its numbers describe the tool, not the service.

### 2. Budgets run when their code changes
```
budget transfers {
  command "./gradlew :load:gatlingRun --simulation TransfersSimulation"
  reads "load/build/reports/gatling/*/js/stats.json"
  p99 < 200ms
  errors < 0.1%
  when zone payments touched
}
```
- `when zone <name> touched` (or `when "<glob>" touched`) runs the budget only for a change that touches that code, locally and in CI. A change elsewhere passes it with "the change doesn't touch payments".
- `reads "<path>"` names a tool's own output when it can't write to `{json}`; a `*` matches one folder or file name, and of several matches the last by name is read (timestamped report folders sort by time). The format is recognised from the file.
- A failing budget runs once more before it counts: a laptop under load misses a limit by chance, and an agent would chase a slowdown that isn't there. Both runs are in the proof.

### 3. The agent is told enough to fix a slowdown
When a budget fails, the agent's summary names the budget, the step or endpoint, the measured value, the limit, the baseline value when there is one, and the report file. The Stop hook already keeps the agent from finishing; the policy is protected, so the only way to pass is to make the code fast again or report blocked.

### 4. The wizard finds the critical code and writes the tests
A new decision in `/gauntlet-setup`, "Performance-critical code", after zones:
- The agent reads the code for request handlers, hot loops over large data, serialisation, pricing and matching, and database access, and proposes up to three places, each with why and what it would measure.
- For each one I accept, it proposes a test and writes it once I agree: a benchmark for a function, a load test for an endpoint.

| Language | Benchmark | Load test (first choice, then the alternative) |
| --- | --- | --- |
| Kotlin, Java | JMH | Gatling, then Proofload |
| Scala | sbt-jmh | Gatling, then Proofload (its Scala API or ZIO Test) |
| Clojure | criterium | Gatling, then Proofload (its command line with a YAML plan) |
| TypeScript | mitata or tinybench | k6, then autocannon |
| Python | pytest-benchmark | Locust, then k6 |
| Go | `go test -bench` | k6, then vegeta |
| Rust | criterion | oha, then k6 |

  Proofload is offered on JVM projects only, as the second choice.
- It adds a budget for each test, scoped with `when zone ... touched`, limits from one measured run with room (twice the measured p99 unless I say otherwise), and explains that `vs baseline` limits need a baseline recorded on the CI machine.
- It warns plainly that load tests take minutes and only run when their code changes.

### 5. New critical code gets a suggestion
When a change adds something that looks performance-critical (a new endpoint, a new consumer, a loop over a collection read from a database) and no budget covers it, the agent's summary suggests one: "This adds `POST /transfers`. Want a Gatling test with a p99 budget?" A suggestion only: it never writes a test or changes the policy unasked, and it never affects the decision.

## Stages, one pull request each
1. Readers: Proofload and Gatling, then JMH, then the rest.
2. `when ... touched` and `reads`, and the rerun of a failing budget.
3. The agent's failure summary.
4. The wizard's decision.
5. The suggestion for new critical code.

## Not covered
- Running a service for a load test to hit: the budget's command does that (a Gradle task, docker compose, the test framework).
- Comparing with the base commit measured in the same run; `vs baseline` compares with the recorded baseline (spec 0006).

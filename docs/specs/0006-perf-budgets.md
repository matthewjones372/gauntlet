# Spec 0006: performance budgets

Status: accepted

## Problem
The policy language had `budget` blocks (`p99 < 50ms`, `regression < 5% vs baseline`) since the first release, but Gauntlet reported them as not executed. A change that made a service slower passed every gate.

## Behaviour
1. A budget's `command` runs in the judged checkout, after the earlier tiers, with `{json}` replaced by a fresh file in the check's own output directory (also in `GAUNTLET_OUT`). Only that file is read, as for imports' `{sarif}` (ADR 0012).
2. The file may be:
   - Gauntlet's own JSON: metric names as the policy writes them (`p50`, `p90`, `p95`, `p99`, `p999`, `mean`, `max`, `min`, `errors`, `throughput`), times in milliseconds, errors in percent, throughput in requests a second, and optionally `series` (per endpoint or command) with the same names.
   - hyperfine's `--export-json`: each command is a series; seconds become milliseconds; `median` is `p50`.
   - k6's `--summary-export`: `http_req_duration` gives the times, `http_req_failed` the errors and `http_reqs.rate` the throughput.
3. A limit is in the policy's units (`ms`, `s`, `m`, `%`, `rps`). An aggregate (`max(p99)`) is taken over the series, falling back to the whole run's value.
4. `vs baseline` compares with the value `gauntlet baseline` recorded (`budget/<name>/<metric>`): the threshold is how much worse, in percent, the value may get. `regression` applies it to every measured time and to throughput. With no recorded value the check is not executed (missing evidence), never passed.
5. A command that can't start errors; one that exits non-zero fails; one that writes nothing is not executed.
6. The baseline records every measured value, so a later re-recording that would make one worse needs `--allow-lower`, like any metric.
7. `compile` warns when a budget's command never mentions `{json}`.

## Not covered
- Gauntlet runs the command once; repeating and warming up are the benchmark's job (hyperfine and k6 do both).
- "vs baseline" compares with the recorded baseline, not with the base commit measured in the same run, so the baseline should be recorded on the same kind of machine that runs the checks.

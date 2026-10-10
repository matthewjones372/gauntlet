import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli, POLICY } from "./harness.ts"

// Spec 0007 end to end: a budget whose command runs a load test. Proofload's
// command line writes its run document and exits 1 when a goal missed, 2 when
// its generator fell behind. A run that fell behind is not executed, not a
// failure of the change; one that kept its schedule is held to the budget.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const BUDGET = `budget checkout {
  command "sh load/run.sh {json}"
  max(p99) < 200ms
}
`
const policy = POLICY.replace("gates {", `${BUDGET}\ngates {`).replace("verify { unit, coverage >= 80% }", "verify { unit, coverage >= 80% }\n  perf   { budget checkout }")
// A stand-in for proofload-cli run: the verdict and p99 come from files the change controls.
const RUN = `p99=$(cat load/p99.txt); verdict=$(cat load/verdict.txt)
echo "{\\"schema\\": \\"proofload/run/1\\", \\"durationUnit\\": \\"nanoseconds\\", \\"verdict\\": \\"$verdict\\", \\"count\\": 100, \\"failed\\": 0, \\"steps\\": [{\\"name\\": \\"place order\\", \\"count\\": 100, \\"failed\\": 0, \\"p50\\": 1000000, \\"p99\\": $p99}]}" > "$1"
[ "$verdict" = behind ] && exit 2
[ "$verdict" = missed ] && exit 1
exit 0
`

const check = async (verdict: string, p99ms: number) => {
  const s = baseRepo()
  repos.push(s.r)
  s.r.git("checkout", "-q", "main")
  s.r.write({ ".gauntlet/policy.gx": policy, "load/run.sh": RUN, "load/verdict.txt": "met\n", "load/p99.txt": "1000000\n" })
  const base = s.r.commit("load test")
  s.r.git("checkout", "-q", "-b", "change")
  s.r.write({ "load/verdict.txt": `${verdict}\n`, "load/p99.txt": `${p99ms * 1_000_000}\n`, "src/main/App.kt": "class App { fun x() = 1 }\n" })
  s.r.commit("change")
  const out = join(s.r.dir, "out")
  await cli(["check", "--repo", s.r.dir, "--base", base, "--out", out, "--no-record"])
  return JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8")).checks.find((c: { check: string }) => c.check === "budget checkout")
}

describe("a load test as a budget", () => {
  test("a run that kept its schedule is held to the budget", async () => {
    expect((await check("met", 150)).status).toBe("passed")
  })

  test("a generator that fell behind (exit 2) makes the run not executed, not a failure", async () => {
    const b = await check("behind", 900)
    expect(b.status).toBe("not-executed")
    expect(b.reason).toBe("the load generator fell behind its schedule, so the numbers describe the generator, not the service")
    expect(b.proof.exitCode).toBe(2)
  })

  test("a missed goal (exit 1) still fails", async () => {
    expect((await check("missed", 250)).status).toBe("failed")
  })
})

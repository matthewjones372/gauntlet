import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli, POLICY } from "./harness.ts"

// Spec 0006 end to end: a budget's command runs in the judged checkout and
// writes to {json}; the check holds it to its limits, and "vs baseline"
// against what the baseline recorded.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const BUDGET = `budget api {
  command "sh perf/run.sh {json}"
  p99 < 50ms
  regression < 10% vs baseline
}
`
const policy = POLICY.replace("gates {", `${BUDGET}\ngates {`).replace("verify { unit, coverage >= 80% }", "verify { unit, coverage >= 80% }\n  perf   { budget api }")
// The "service" answers in whatever perf/latency.txt says; the benchmark reports it.
const RUN = `echo "{\\"p99\\": $(cat perf/latency.txt), \\"errors\\": 0}" > "$1"\n`

const setup = (latency: number) => {
  const s = baseRepo()
  repos.push(s.r)
  s.r.git("checkout", "-q", "main")
  s.r.write({ ".gauntlet/policy.gx": policy, "perf/run.sh": RUN, "perf/latency.txt": `${latency}\n` })
  s.r.commit("perf budget")
  return s.r
}
const check = async (r: TempRepo, base: string) => {
  const out = join(r.dir, "out")
  const res = await cli(["check", "--repo", r.dir, "--base", base, "--out", out, "--no-record"])
  return { res, budget: JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8")).checks.find((c: { check: string }) => c.check === "budget api") }
}

describe("a performance budget", () => {
  test("the baseline records what was measured, and a change within budget passes", async () => {
    const r = setup(40)
    expect((await cli(["baseline", "--repo", r.dir, "--trunk", "main"])).code).toBe(0)
    const b = JSON.parse(readFileSync(join(r.dir, ".gauntlet", "baseline.sarif"), "utf8"))
    expect(b.runs[0].properties.gauntlet.metrics["budget/api/p99"].value).toBe(40)
    const base = r.commit("baseline")
    r.git("checkout", "-q", "-b", "change")
    r.write({ "perf/latency.txt": "42\n" })
    r.commit("a little slower")
    const { budget } = await check(r, base)
    expect(budget.status).toBe("passed")
    expect(budget.proof.command).toEqual(["sh", "-c", "sh perf/run.sh {json}"])
  })

  test("over a limit, or too much worse than the baseline, fails and says by how much", async () => {
    const r = setup(40)
    await cli(["baseline", "--repo", r.dir, "--trunk", "main"])
    const base = r.commit("baseline")
    r.git("checkout", "-q", "-b", "change")
    r.write({ "perf/latency.txt": "48\n" })
    r.commit("20% slower")
    const { res, budget } = await check(r, base)
    expect(budget.status).toBe("failed")
    expect(budget.reason).toBe("p99 got 20% worse than the baseline (40ms to 48ms), over the 10% allowed")
    expect(res.code).toBe(1)
  })

  test("a command that writes nothing is missing evidence, never a pass", async () => {
    const r = setup(40)
    r.write({ "perf/run.sh": "exit 0\n" })
    const base = r.commit("benchmark writes nothing")
    r.git("checkout", "-q", "-b", "change")
    r.write({ "src/main/App.kt": "class App { fun x() = 1 }\n" })
    r.commit("change")
    expect((await check(r, base)).budget).toMatchObject({ status: "not-executed", reason: "the budget's command wrote nothing to {json}" })
  })
})

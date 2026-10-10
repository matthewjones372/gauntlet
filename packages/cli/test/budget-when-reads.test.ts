import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli, POLICY } from "./harness.ts"

// Spec 0007 end to end: a budget runs only for a change that touches its
// code, reads its tool's own report through a `*`, and a failure runs once
// more before it counts.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const gatling = (p99: number) => JSON.stringify({ type: "GROUP", name: "All Requests", stats: { name: "All Requests", numberOfRequests: { total: 10, ok: 10, ko: 0 }, percentiles4: { total: p99 } }, contents: {} })

const check = async (budget: string, files: Record<string, string>, change: Record<string, string>) => {
  const s = baseRepo()
  repos.push(s.r)
  s.r.git("checkout", "-q", "main")
  const policy = POLICY.replace("gates {", `${budget}\ngates {`).replace("verify { unit, coverage >= 80% }", "verify { unit, coverage >= 80% }\n  perf   { budget load }")
  s.r.write({ ".gauntlet/policy.gx": policy, ...files })
  const base = s.r.commit("budget")
  s.r.git("checkout", "-q", "-b", "change")
  s.r.write(change)
  s.r.commit("change")
  const out = join(s.r.dir, "out")
  await cli(["check", "--repo", s.r.dir, "--base", base, "--out", out, "--no-record"])
  return JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8")).checks.find((c: { check: string }) => c.check === "budget load")
}

describe("when a budget runs", () => {
  const budget = `budget load {\n  command "sh load/run.sh {json}"\n  when zone money touched\n  p99 < 200ms\n}`
  // The load test would fail if it ran: only a change in the money zone runs it.
  const files = { "load/run.sh": `echo '{"p99": 999}' > "$1"\n` }

  test("a change outside its zone doesn't run it, and says why", async () => {
    const b = await check(budget, files, { "src/main/App.kt": "class App { fun x() = 1 }\n" })
    expect(b).toMatchObject({ status: "passed", reason: "the change doesn't touch zone money, so this budget didn't run" })
    expect(b.proof).toBeUndefined()
  })

  test("a change in its zone runs it", async () => {
    expect((await check(budget, files, { "src/money/Fx.kt": "class Fx { fun r() = 1 }\n" })).status).toBe("failed")
  })
})

describe("a tool's own report", () => {
  test("is read through a * in its path, the newest folder by name", async () => {
    const b = await check(`budget load {\n  command "sh load/run.sh"\n  reads "load/reports/*/js/stats.json"\n  p99 < 200ms\n}`, {
      // Two runs' folders, as Gatling names them: the later one is read.
      "load/run.sh": `mkdir -p load/reports/sim-20260101/js load/reports/sim-20260102/js\necho '${gatling(900)}' > load/reports/sim-20260101/js/stats.json\necho '${gatling(150)}' > load/reports/sim-20260102/js/stats.json\n`,
    }, { "src/main/App.kt": "class App { fun x() = 1 }\n" })
    expect(b.status).toBe("passed")
    expect(Object.keys(b.proof.reports)).toContain("budget.json")
  })

  test("nothing at the path is not executed, and says where it looked", async () => {
    const b = await check(`budget load {\n  command "true"\n  reads "load/reports/*/js/stats.json"\n  p99 < 200ms\n}`, {}, { "src/main/App.kt": "class App { fun x() = 1 }\n" })
    expect(b).toMatchObject({ status: "not-executed", reason: "nothing was found at load/reports/*/js/stats.json" })
  })
})

describe("a budget that fails once", () => {
  test("runs again, and passes if the second run does, saying the first didn't", async () => {
    // Slow the first time (a busy machine), fine after.
    const run = `if [ -f "$GAUNTLET_OUT/../tried" ]; then echo '{"p99": 120}' > "$1"; else touch "$GAUNTLET_OUT/../tried"; echo '{"p99": 260}' > "$1"; fi\n`
    const b = await check(`budget load {\n  command "sh load/run.sh {json}"\n  p99 < 200ms\n}`, { "load/run.sh": run }, { "src/main/App.kt": "class App { fun x() = 1 }\n" })
    expect(b.status).toBe("passed")
    expect(b.reason).toBe("the first run failed (p99 260ms doesn't meet < 200ms), a second run didn't")
  })
})

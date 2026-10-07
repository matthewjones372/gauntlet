import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { hookCli } from "./agent-harness.ts"
import { baseRepo, cli } from "./harness.ts"

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

describe("a failing suite names its failing tests", () => {
  test("in the JSON report, the markdown and the Stop hook's reason", async () => {
    const { r, base } = baseRepo()
    repos.push(r)
    r.write({ "src/main/behaviour.txt": "broken add\n" })
    r.commit("breaks add")
    const json = JSON.parse((await cli(["check", "--repo", r.dir, "--base", base, "--json", "--no-record", "--out", join(r.dir, ".git", "out-json")])).out)
    expect(json.checks.find((c: { check: string }) => c.check === "unit").failures).toEqual(["svc.AddTest.add: add is broken"])
    const md = (await cli(["check", "--repo", r.dir, "--base", base, "--no-record", "--out", join(r.dir, ".git", "out-md")])).out
    expect(md).toContain("### Failing tests\n\n- unit: `svc.AddTest.add: add is broken`")
    writeFileSync(join(r.dir, "src/main/behaviour.txt"), "broken round\n")
    const stop = JSON.parse((await hookCli(["hook", "stop"], JSON.stringify({ cwd: r.dir }))).out)
    expect(stop.reason).toContain("Failing in unit:\n  - svc.RoundTest.round: round is broken")
  })
})

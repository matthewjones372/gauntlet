import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli, POLICY } from "./harness.ts"

// Mutation testing a whole project took an hour on a real one. When the
// policy mutates only each change's own lines, setup's first baseline
// (gauntlet apply) skips it; every change is still held to the floor, and
// gauntlet baseline still records it.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const setup = (mutation: string) => {
  const s = baseRepo()
  repos.push(s.r)
  s.r.git("checkout", "-q", "main")
  s.r.write({
    ".gauntlet/policy.gx": POLICY.replace("verify { unit, coverage >= 80% }", `verify { unit, coverage >= 80%, ${mutation} }`),
    // The mutation script leaves a mark in the repository (gates run in a separate checkout), so the test can tell whether it ran.
    "scripts/mutation.sh": `touch "${join(s.r.dir, "mutation-ran")}"\necho '{"value": 70}' > "$1/mutation.json"\n`,
  })
  s.r.commit("mutation gate")
  return s.r
}

describe("the baseline and mutation testing", () => {
  test("setup's baseline doesn't mutate the whole project for mutation on changed lines", async () => {
    const r = setup("mutation ratchet >= 60% on changed")
    const res = await cli(["apply", "--repo", r.dir])
    expect(existsSync(join(r.dir, "mutation-ran"))).toBe(false)
    expect(res.out).not.toContain("Not recorded: verify: mutation")
    const b = JSON.parse(readFileSync(join(r.dir, ".gauntlet", "baseline.sarif"), "utf8"))
    expect(b.runs[0].properties.gauntlet.metrics.mutation).toBeUndefined()
  })

  test("gauntlet baseline still records it, and so does setup for a whole-project ratchet", async () => {
    const changed = setup("mutation ratchet >= 60% on changed")
    await cli(["baseline", "--repo", changed.dir, "--trunk", "main"])
    expect(existsSync(join(changed.dir, "mutation-ran"))).toBe(true)
    const whole = setup("mutation ratchet")
    await cli(["apply", "--repo", whole.dir])
    expect(existsSync(join(whole.dir, "mutation-ran"))).toBe(true)
  })

  test("after setup's baseline, a change is still held to the floor", async () => {
    const r = setup("mutation ratchet >= 80% on changed")
    await cli(["apply", "--repo", r.dir])
    const base = r.git("rev-parse", "HEAD").trim()
    r.git("checkout", "-q", "-b", "change")
    r.write({ "src/main/App.kt": "class App { fun x() = 1 }\n" })
    r.commit("change")
    const out = join(r.dir, "out")
    await cli(["check", "--repo", r.dir, "--base", base, "--out", out])
    const mutation = JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8")).checks.find((c: { check: string }) => c.check === "mutation")
    expect(mutation.status).toBe("failed")
    expect(mutation.reason).toContain("mutation 70% doesn't meet >= 80")
  })
})

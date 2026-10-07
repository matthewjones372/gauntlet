import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli, POLICY } from "./harness.ts"

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const RATCHET_POLICY = POLICY.replace("coverage >= 80%", "coverage ratchet >= 80%")
const lintSarif = (lines: number[]) => JSON.stringify({
  version: "2.1.0",
  runs: [{
    tool: { driver: { name: "lint-tool" } },
    results: lines.map((line) => ({
      ruleId: "style/magic",
      message: { text: "magic number" },
      locations: [{ physicalLocation: { artifactLocation: { uri: "src/main/App.kt" }, region: { startLine: line } } }],
    })),
  }],
})

/** A repo on main with the ratchet policy and one grandfathered-to-be lint finding. */
const trunk = () => {
  const s = baseRepo()
  repos.push(s.r)
  s.r.git("checkout", "-q", "main")
  s.r.write({ ".gauntlet/policy.gx": RATCHET_POLICY, "src/main/App.kt": "class App {\n  val x = 42\n}\n", "lint.sarif": lintSarif([2]) })
  const sha = s.r.commit("trunk with a lint finding")
  return { r: s.r, sha }
}
const baselineOf = (r: TempRepo) => JSON.parse(readFileSync(join(r.dir, ".gauntlet/baseline.sarif"), "utf8"))
const baselineCli = (r: TempRepo, ...extra: string[]) => cli(["baseline", "--repo", r.dir, "--trunk", "main", ...extra])

describe("gauntlet baseline", () => {
  test("records metrics, findings and test ids on trunk", async () => {
    const { r, sha } = trunk()
    const res = await baselineCli(r)
    expect(res.code).toBe(0)
    const b = baselineOf(r)
    const meta = b.runs[0].properties.gauntlet
    expect(meta.baseline.commit).toBe(sha)
    expect(meta.metrics.coverage.value).toBe(90)
    expect(meta.metrics["integrity/executed-tests"].value).toBe(2)
    expect(meta.testIds).toEqual(["svc.AddTest.add", "svc.RoundTest.round"])
    expect(b.runs[1].results[0].partialFingerprints["gauntlet/ctx/v1/nosym"]).toMatch(/^[0-9a-f]{64}$/)
  })

  test("refuses to run off trunk, or to overwrite without --update", async () => {
    const { r } = trunk()
    expect((await baselineCli(r)).code).toBe(0)
    expect((await baselineCli(r)).code).toBe(2)
    r.git("checkout", "-q", "-b", "elsewhere")
    r.write({ "src/main/App.kt": "class App\n" })
    r.commit("not trunk")
    const off = await baselineCli(r, "--update")
    expect(off.code).toBe(2)
    expect(off.err).toContain("check out main first")
  })

  test("--update takes improvements and refuses to lower without --allow-lower", async () => {
    const { r } = trunk()
    await baselineCli(r)
    r.write({ "coverage.txt": "95\n" })
    r.commit("better coverage")
    expect((await baselineCli(r, "--update")).code).toBe(0)
    expect(baselineOf(r).runs[0].properties.gauntlet.metrics.coverage.value).toBe(95)

    r.write({ "coverage.txt": "85\n" })
    r.commit("worse coverage")
    const before = readFileSync(join(r.dir, ".gauntlet/baseline.sarif"), "utf8")
    const refused = await baselineCli(r, "--update")
    expect(refused.code).toBe(1)
    expect(refused.err).toContain("- coverage: 95 -> 85")
    expect(readFileSync(join(r.dir, ".gauntlet/baseline.sarif"), "utf8")).toBe(before)

    const lowered = await baselineCli(r, "--update", "--allow-lower")
    expect(lowered.code).toBe(0)
    expect(lowered.err).toContain("Lowering the baseline")
    expect(baselineOf(r).runs[0].properties.gauntlet.metrics.coverage.value).toBe(85)
  })

  test("a new finding of a grandfathered rule fails, a line shift doesn't", async () => {
    const { r } = trunk()
    await baselineCli(r)
    const base = r.commit("commit the baseline")
    r.git("checkout", "-q", "-b", "feature-shift")
    r.write({ "src/main/App.kt": "// header\n\nclass App {\n  val x = 42\n}\n", "lint.sarif": lintSarif([4]) })
    r.commit("shift the finding down")
    const shifted = await cli(["check", "--repo", r.dir, "--policy-ref", base, "--out", join(r.dir, "o1"), "--no-record"])
    expect(JSON.parse(readFileSync(join(r.dir, "o1", "gauntlet-report.json"), "utf8")).checks.find((c: { check: string }) => c.check === "lint").status).toBe("passed")
    expect(shifted.code).toBe(0)

    r.write({ "src/main/App.kt": "// header\n\nclass App {\n  val x = 42\n  val y = 7\n}\n", "lint.sarif": lintSarif([4, 5]) })
    r.commit("add a second magic number")
    const added = await cli(["check", "--repo", r.dir, "--policy-ref", base, "--out", join(r.dir, "o2"), "--no-record"])
    const report = JSON.parse(readFileSync(join(r.dir, "o2", "gauntlet-report.json"), "utf8"))
    expect(added.code).toBe(1)
    expect(report.violations.map((v: { line: number }) => v.line)).toEqual([5])
  })

  test("a coverage drop below the baseline fails a PR", async () => {
    const { r } = trunk()
    await baselineCli(r)
    const base = r.commit("commit the baseline")
    r.git("checkout", "-q", "-b", "feature-drop")
    r.write({ "coverage.txt": "85\n" })
    r.commit("drop coverage")
    const res = await cli(["check", "--repo", r.dir, "--policy-ref", base, "--out", join(r.dir, "o"), "--no-record"])
    expect(res.code).toBe(1)
    expect(JSON.parse(readFileSync(join(r.dir, "o", "gauntlet-report.json"), "utf8")).ratchets).toContainEqual(expect.objectContaining({ metric: "coverage", base: 90, head: 85, regressed: true }))
  })

  test("detekt findings import into a new baseline, but not into an existing one without --allow-lower", async () => {
    const { r } = trunk()
    r.write({ "config/detekt-baseline.xml": `<SmellBaseline><CurrentIssues><ID>MagicNumber:App.kt$App$42</ID></CurrentIssues></SmellBaseline>` })
    r.commit("add detekt baseline")
    expect((await baselineCli(r, "--import-detekt", "config/detekt-baseline.xml")).code).toBe(0)
    expect(baselineOf(r).runs[0].properties.gauntlet.legacy).toEqual([{ tool: "detekt", id: "MagicNumber:App.kt$App$42" }])
    r.commit("commit baseline")
    expect((await baselineCli(r, "--import-detekt", "config/detekt-baseline.xml")).code).toBe(1)
  })
})

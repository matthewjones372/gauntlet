import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli } from "./harness.ts"

// A pull request whose branch started before other changes reached main is
// judged on its own changes: compared from where it left main, as GitHub's
// "Files changed" shows it, with main's current policy. What main gained
// since isn't counted as the branch deleting it.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

describe("a branch that's behind main", () => {
  test("is judged on its own changes, not on what main gained since", async () => {
    const s = baseRepo()
    repos.push(s.r)
    const r = s.r
    // The branch (the harness's "feature") starts here and changes one file.
    r.write({ "src/main/App.kt": "class App { fun x() = 1 }\n" })
    r.commit("feature")
    // Meanwhile main gains a file and a test.
    r.git("checkout", "-q", "main")
    r.write({ "src/main/Report.kt": "class Report\n", "src/test/ReportTest.txt": "report\n" })
    const mainTip = r.commit("main moves on")
    r.git("checkout", "-q", "feature")
    const out = join(r.dir, "out")
    await cli(["check", "--repo", r.dir, "--policy-ref", mainTip, "--head", "HEAD", "--out", out, "--no-record"])
    const report = JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8"))
    expect(report.facts.files.map((f: { path: string; status: string }) => `${f.status} ${f.path}`)).toEqual(["modified src/main/App.kt"])
    expect(report.integrity.findings.filter((f: { check: string }) => f.check === "deleted-tests")).toEqual([])
    expect(report.policy.baseSha).toBe(s.base)
  })
})

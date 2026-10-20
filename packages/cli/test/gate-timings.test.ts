import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli } from "./harness.ts"

// Spec 0020 §7: the check says where its time went, in a CI log too, and the
// pull request's comment ends with the evidence job's times. The report files
// stay free of them, so two runs on the same commit still write the same bytes.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const change = async () => {
  const s = baseRepo()
  repos.push(s.r)
  s.r.write({ "src/main/App.kt": "class App { fun x() = 2 }\n" })
  s.r.commit("touch app")
  return s
}

describe("time per gate", () => {
  test("check prints each gate's time, without a terminal, and keeps it out of the report", async () => {
    const { r, base } = await change()
    const res = await cli(["check", "--repo", r.dir, "--base", base, "--out", join(r.dir, "evidence"), "--no-record"])
    expect(res.err).toMatch(/^Time per gate: build \d+m?s?.*, lint .*; total .+$/m)
    expect(readFileSync(join(r.dir, "evidence", "gauntlet-report.md"), "utf8")).not.toContain("Time per gate")
    expect(Object.keys(JSON.parse(readFileSync(join(r.dir, "evidence", "gauntlet-run.json"), "utf8")).durationsMs)).toContain("build")
  })

  test("github-status ends the comment with the evidence job's times, not its own", async () => {
    const { r, base } = await change()
    await cli(["check", "--repo", r.dir, "--base", base, "--out", join(r.dir, "evidence"), "--no-record"])
    writeFileSync(join(r.dir, "evidence", "gauntlet-run.json"), JSON.stringify({ startedAt: "", finishedAt: "", durationsMs: { build: 12_000, unit: 65_000, total: 80_000 } }))
    writeFileSync(join(r.dir, "reviews.json"), "[]")
    await cli(["github-status", "--repo", r.dir, "--policy-ref", base, "--head", "HEAD", "--evidence", "evidence/gauntlet-report.json", "--reviews", "reviews.json", "--out", "trusted"])
    const md = readFileSync(join(r.dir, "trusted", "gauntlet-report.md"), "utf8")
    expect(md).toEndWith("<details><summary>Time per gate</summary>\n\n| Check | Time |\n|---|---|\n| build | 12s |\n| unit | 1m 05s |\n| total | 1m 20s |\n\n</details>\n")
  })

  test("without the evidence job's run record the comment has no times", async () => {
    const { r, base } = await change()
    await cli(["check", "--repo", r.dir, "--base", base, "--out", join(r.dir, "evidence"), "--no-record"])
    writeFileSync(join(r.dir, "evidence", "gauntlet-run.json"), "not json")
    writeFileSync(join(r.dir, "reviews.json"), "[]")
    await cli(["github-status", "--repo", r.dir, "--policy-ref", base, "--head", "HEAD", "--evidence", "evidence/gauntlet-report.json", "--reviews", "reviews.json", "--out", "trusted"])
    expect(readFileSync(join(r.dir, "trusted", "gauntlet-report.md"), "utf8")).not.toContain("Time per gate")
  })
})

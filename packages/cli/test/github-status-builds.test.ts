import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { cli } from "./harness.ts"

// The trusted github-status job recomputes integrity from the evidence. With
// several builds only the touched ones run their tests, so it must compare
// the executed-tests count with those builds' baseline tests, as check does,
// and work out which builds those are from the diff, not from the evidence.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const TEST_SH = `#!/bin/sh
out="$1"
cases=""
for f in src/test/*Test.txt; do
  name=$(basename "$f" .txt)
  word=$(cat "$f")
  if grep -q "broken $word" src/main/behaviour.txt; then
    cases="$cases<testcase classname=\\"svc.$name\\" name=\\"$word\\" file=\\"$f\\"><failure message=\\"$word is broken\\"/></testcase>"
  else
    cases="$cases<testcase classname=\\"svc.$name\\" name=\\"$word\\" file=\\"$f\\"/>"
  fi
done
echo "<testsuite name=\\"unit\\">$cases</testsuite>" > "$out/TEST-unit.xml"
`
const build = (test: string, coverage: number) => ({
  "scripts/build.sh": "exit 0\n",
  "scripts/test.sh": TEST_SH,
  "scripts/coverage.sh": `echo "{\\"value\\": $(cat coverage.txt)}" > "$1/coverage.json"\n`,
  "coverage.txt": `${coverage}\n`,
  "src/main/behaviour.txt": "all good\n",
  "src/main/App.kt": "class App\n",
  [`src/test/${test}Test.txt`]: `${test.toLowerCase()}\n`,
})
const prefixed = (dir: string, files: Record<string, string>) => Object.fromEntries(Object.entries(files).map(([p, c]) => [`${dir}/${p}`, c]))

const POLICY = `gauntlet "street"
use jvm in "bank", "checks"
mode enforce
owners @owner
protect {
  tests  "**/src/test/**"
  config "*/scripts/**"
}
suites { unit "src/test/**" }
gates {
  fast   { build }
  verify { unit, coverage >= 80% on changed }
}
review { auto when all gates pass }
`

const setup = (coverage = { bank: 90, checks: 90 }) => {
  const r = new TempRepo()
  repos.push(r)
  r.write({ ".gauntlet/policy.gx": POLICY, "README.md": "street\n", ...prefixed("bank", build("Transfer", coverage.bank)), ...prefixed("checks", build("Screen", coverage.checks)) })
  const base = r.commit("base")
  r.git("checkout", "-q", "-b", "change")
  return { r, base }
}
const check = async (r: TempRepo, base: string) => {
  const out = join(r.dir, "out")
  const res = await cli(["check", "--repo", r.dir, "--base", base, "--out", out, "--no-record"])
  const report = JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8"))
  const run = JSON.parse(readFileSync(join(out, "gauntlet-run.json"), "utf8"))
  const of = (name: string) => report.checks.find((c: { check: string }) => c.check === name)
  return { res, report, run, of }
}


/** A baseline on trunk, then a change to the bank build only; its evidence, as the untrusted job would upload it. */
const bankOnly = async () => {
  const { r } = setup()
  r.git("checkout", "-q", "main")
  await cli(["baseline", "--repo", r.dir, "--trunk", "main"])
  const base = r.commit("baseline")
  r.git("checkout", "-q", "-b", "bank-only")
  r.write({ "bank/src/main/App.kt": "class App { fun x() = 1 }\n" })
  r.commit("change the bank")
  await cli(["check", "--repo", r.dir, "--base", base, "--out", join(r.dir, "evidence"), "--no-record"])
  return { r, base, evidence: JSON.parse(readFileSync(join(r.dir, "evidence", "gauntlet-report.json"), "utf8")) }
}

const trusted = async (r: TempRepo, base: string, evidence: unknown) => {
  writeFileSync(join(r.dir, "evidence.json"), JSON.stringify(evidence))
  writeFileSync(join(r.dir, "reviews.json"), "[]")
  await cli(["github-status", "--repo", r.dir, "--policy-ref", base, "--head", "HEAD", "--evidence", "evidence.json", "--reviews", "reviews.json", "--out", "trusted"])
  return JSON.parse(readFileSync(join(r.dir, "trusted", "gauntlet-report.json"), "utf8"))
}

const executedFindings = (report: { integrity: { findings: { check: string }[] } }) =>
  report.integrity.findings.filter((f) => f.check === "executed-tests")

describe("github-status with several builds", () => {
  test("an untouched build's tests don't count against the executed-tests ratchet", async () => {
    const { r, base, evidence } = await bankOnly()
    expect(executedFindings(evidence)).toEqual([])
    expect(executedFindings(await trusted(r, base, evidence))).toEqual([])
  }, 60000)

  test("a touched build whose tests the evidence says didn't run still drops the count", async () => {
    const { r, base, evidence } = await bankOnly()
    const forged = { ...evidence, checks: evidence.checks.map((c: { check: string; tests?: object }) =>
      c.check === "unit" ? { ...c, tests: { executed: 0, passed: 0, failed: 0, errored: 0, skipped: 0 } } : c) }
    expect(executedFindings(await trusted(r, base, forged)).length).toBeGreaterThan(0)
  }, 60000)
})

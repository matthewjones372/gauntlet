import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { cli } from "./harness.ts"

// ADR 0022: with several builds only the builds a change touches are built
// and tested. A change that touches none of them (a workflow, deploy
// settings) runs no tests, so the checks that count tests have nothing to
// count: that is not missing evidence, and it doesn't ask for review.

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

describe("a change outside every build", () => {
  test("doesn't report the checks that count tests as not executed", async () => {
    const { r, base } = setup()
    r.write({ "deploy/values.txt": "replicas: 3\n" })
    r.commit("deploy settings")
    const { report } = await check(r, base)
    expect(report.integrity.notExecuted).not.toContain("executed-tests")
    expect(report.integrity.notExecuted).not.toContain("skipped-tests")
    expect(JSON.stringify(report.decision)).not.toContain("was not executed")
  })

  test("a change inside a build still counts its tests", async () => {
    const { r, base } = setup()
    r.write({ "bank/src/main/App.kt": "class App { fun x() = 1 }\n" })
    r.commit("change the bank")
    const { of } = await check(r, base)
    expect(of("unit").tests.executed).toBe(1)
  })
})

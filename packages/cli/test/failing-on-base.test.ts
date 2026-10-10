import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { scriptPack } from "../../core/test/script-pack.ts"
import { cli } from "./harness.ts"

// A test already failing before the change isn't the change's fault: failures
// run again with the change's files as the base has them, and those that fail
// there too ask a person to look without blocking. A test the change breaks
// still blocks.

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
  const res = await cli(["check", "--repo", r.dir, "--base", base, "--out", out, "--no-record"], [{ ...scriptPack, reruns: true }])
  const report = JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8"))
  const run = JSON.parse(readFileSync(join(out, "gauntlet-run.json"), "utf8"))
  const of = (name: string) => report.checks.find((c: { check: string }) => c.check === name)
  return { res, report, run, of }
}

describe("a test that fails on the base too", () => {
  test("is named as already failing, and doesn't block", async () => {
    const { r } = setup()
    r.write({ "checks/src/main/behaviour.txt": "broken screen\n" })
    const base = r.commit("screening already broken on main")
    r.write({ "checks/src/main/App.kt": "class App { fun y() = 2 }\n" })
    r.commit("an unrelated change in checks")
    const { res, report, of } = await check(r, base)
    expect(of("unit").status).toBe("failed")
    expect(of("unit").failedBefore).toBe(true)
    expect(of("unit").failures).toEqual(["svc.ScreenTest.screen: screen is broken (fails on the base too)"])
    expect(of("unit").reason).toContain("it fails on the base too, so this change didn't cause it")
    expect(report.decision.blocking).toBe(false)
    expect(report.decision.tier).toBe("review")
    expect(res.code).toBe(0)
  })

  test("a test the change breaks still blocks", async () => {
    const { r, base } = setup()
    r.write({ "checks/src/main/behaviour.txt": "broken screen\n" })
    r.commit("break screening")
    const { res, report, of } = await check(r, base)
    expect(of("unit").status).toBe("failed")
    expect(of("unit").failedBefore).toBeUndefined()
    expect(of("unit").failures).toEqual(["svc.ScreenTest.screen: screen is broken"])
    expect(report.decision.blocking).toBe(true)
    expect(res.code).not.toBe(0)
  })
})

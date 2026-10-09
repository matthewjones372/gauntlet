import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { scriptPack } from "../../core/test/script-pack.ts"
import { cli } from "./harness.ts"

// ADR 0022: a repository with several builds, each in its own folder. Every
// check runs in each build, in that folder; scoped checks only in the builds
// the change touches; and the results come back as one check per gate.

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

describe("several builds in one repository", () => {
  test("tests run in every build; a scoped check only in the build the change touches", async () => {
    const { r, base } = setup()
    r.write({ "bank/src/main/App.kt": "class App { fun x() = 1 }\n" })
    r.commit("change the bank")
    const { res, of } = await check(r, base)
    expect(of("unit").status).toBe("passed")
    expect(of("unit").tests.executed).toBe(2)
    expect(of("unit").proof.command.join(" ")).toContain("[bank]")
    expect(of("unit").proof.command.join(" ")).toContain("[checks]")
    expect(of("coverage").status).toBe("passed")
    expect(of("coverage").proof.command).toContain("[bank]")
    expect(of("coverage").proof.command).not.toContain("[checks]")
    expect(res.code).toBe(0)
  })

  test("a failing test in one build fails the suite and names that build's test file", async () => {
    const { r, base } = setup()
    r.write({ "checks/src/main/behaviour.txt": "broken screen\n" })
    r.commit("break screening")
    const { of, report } = await check(r, base)
    expect(of("unit").status).toBe("failed")
    expect(of("unit").failures).toEqual(["svc.ScreenTest.screen: screen is broken"])
    expect(JSON.stringify(report)).not.toContain("{out}")
  })

  test("a floor holds for every build the change touches: the worst one decides", async () => {
    const { r, base } = setup({ bank: 90, checks: 50 })
    r.write({ "bank/src/main/App.kt": "class App { fun x() = 1 }\n", "checks/src/main/App.kt": "class App { fun y() = 2 }\n" })
    r.commit("change both")
    const { of } = await check(r, base)
    expect(of("coverage").status).toBe("failed")
    expect(of("coverage").reason).toContain("coverage 50% doesn't meet >= 80")
  })

  test("a change outside every build has nothing for a scoped check to measure", async () => {
    const { r, base } = setup({ bank: 90, checks: 50 })
    // A file outside every build that isn't documentation (a docs-only change runs nothing at all, ADR 0023).
    r.write({ "deploy/values.txt": "replicas: 3\n" })
    r.commit("deploy settings")
    const { of } = await check(r, base)
    expect(of("coverage").status).toBe("passed")
    expect(of("coverage").reason).toBe("the change touches none of the builds")
  })

  test("each build's runner configuration is protected under its folder", async () => {
    const { r, base } = setup()
    r.write({ "checks/scripts/build.sh": "exit 0 # tweak\n" })
    r.commit("tweak a build script")
    const { report } = await check(r, base)
    expect(report.facts.protectedTouched.map((p: { path: string; action: string }) => `${p.action} ${p.path}`)).toEqual(["restored checks/scripts/build.sh"])
  })

  test("a failing test runs again alone in its own build before it counts", async () => {
    const { r, base } = setup()
    r.write({ "checks/src/main/behaviour.txt": "broken screen\n" })
    r.commit("break screening")
    const out = join(r.dir, "out")
    await cli(["check", "--repo", r.dir, "--base", base, "--out", out, "--no-record"], [{ ...scriptPack, reruns: true }])
    const unit = JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8")).checks.find((c: { check: string }) => c.check === "unit")
    expect(unit.status).toBe("failed")
    expect(unit.failures).toEqual(["svc.ScreenTest.screen: screen is broken"])
  })
})

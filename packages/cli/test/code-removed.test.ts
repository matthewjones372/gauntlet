import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { cli } from "./harness.ts"

// Spec 0017 §2: `auto when code removed and ...` lets a change that only
// deletes main code merge on its own, end to end through `gauntlet check`.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const TEST_SH = `#!/bin/sh
out="$1"
cases=""
for f in src/test/*Test.txt; do
  [ -e "$f" ] || continue
  name=$(basename "$f" .txt)
  word=$(cat "$f")
  cases="$cases<testcase classname=\\"svc.$name\\" name=\\"$word\\"/>"
done
echo "<testsuite name=\\"unit\\">$cases</testsuite>" > "$out/TEST-unit.xml"
`

const POLICY = `gauntlet "svc"
use jvm
mode enforce
owners @platform
protect {
  tests  "src/test/**"
  config "scripts/**"
}
zone money { paths "src/money/**" owner @payments }
suites { unit "src/test/**" }
gates {
  fast   { build }
  verify { unit }
}
review {
  owner  when zone touched
  auto   when code removed and no zone touched and all gates pass
}
`

const setup = () => {
  const r = new TempRepo()
  repos.push(r)
  r.write({
    ".gauntlet/policy.gx": POLICY,
    "scripts/build.sh": "exit 0\n",
    "scripts/test.sh": TEST_SH,
    "src/main/App.kt": "class App {\n  fun run() = 1\n  fun legacy() = 2\n}\n",
    "src/main/Legacy.kt": "object Legacy\n",
    "src/test/AddTest.txt": "add\n",
  })
  const base = r.commit("base")
  r.git("checkout", "-q", "-b", "change")
  return { r, base }
}

const check = async (r: TempRepo, base: string) => {
  const out = join(r.dir, "out")
  const res = await cli(["check", "--repo", r.dir, "--base", base, "--out", out, "--no-record"])
  const report = JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8"))
  const md = readFileSync(join(out, "gauntlet-report.md"), "utf8")
  return { res, report, md }
}

describe("auto when code removed", () => {
  test("a change that deletes a file and a function of main code merges on its own", async () => {
    const { r, base } = setup()
    r.remove("src/main/Legacy.kt")
    r.write({ "src/main/App.kt": "class App {\n  fun run() = 1\n}\n" })
    r.commit("remove legacy code")
    const { report, md } = await check(r, base)
    expect(report.facts.codeRemoved).toBe(true)
    expect(report.decision.tier).toBe("auto")
    expect(md).toContain("only removing code and no tests (the review condition `code removed`)")
  })

  test("a change that also edits main code doesn't", async () => {
    const { r, base } = setup()
    r.remove("src/main/Legacy.kt")
    r.write({ "src/main/App.kt": "class App {\n  fun run() = 3\n}\n" })
    r.commit("remove and change")
    const { report } = await check(r, base)
    expect(report.facts.codeRemoved).toBeUndefined()
    expect(report.decision.tier).toBe("review")
  })
})

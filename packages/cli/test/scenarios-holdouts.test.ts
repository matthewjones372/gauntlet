import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { scriptPack } from "../../core/test/script-pack.ts"
import { cli } from "./harness.ts"

// Spec 0012 §7: a holdout test can bind a scenario. Where holdouts don't run
// (everywhere but the evidence job), a scenario only a holdout names is
// passing, marked holdout, and the holdout check itself is the missing evidence.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const POLICY = `gauntlet "fx"
use jvm
mode enforce
owners @platform
suites {
  unit "src/test/**"
  holdout "acceptance" paths "holdout/**" ci only
}
scenarios "specs/*.feature"
gates {
  verify    { unit }
  behaviour { scenarios }
}
`

const TEST_SH = `out="$1"
cases=""
for f in src/test/*Test.txt; do
  cases="$cases<testcase classname=\\"svc.$(basename "$f" .txt)\\" name=\\"$(cat "$f")\\"/>"
done
echo "<testsuite name=\\"unit\\">$cases</testsuite>" > "$out/TEST-unit.xml"
`

describe("scenarios bound by holdouts", () => {
  test("a scenario only a pending holdout names is passing, marked holdout; one nothing names is unbound", async () => {
    const r = new TempRepo()
    repos.push(r)
    r.write({
      ".gauntlet/policy.gx": POLICY,
      "specs/fx.feature": "Feature: FX\n  @FX-001\n  Scenario: converts\n    Then it converts\n  @FX-002\n  Scenario: identity\n    Then EUR is EUR\n  @FX-003\n  Scenario: rounds\n    Then it rounds\n",
      "scripts/test.sh": TEST_SH,
      "src/test/FxTest.txt": "FX-001 converts",
      "holdout/FxHoldout.txt": "FX-002 identity\n",
      "src/main/behaviour.txt": "ok\n",
    })
    const base = r.commit("base")
    r.write({ "src/main/behaviour.txt": "changed\n" })
    r.commit("change")
    const out = join(r.dir, ".git", "report")
    await cli(["check", "--repo", r.dir, "--base", base, "--out", out, "--no-record"], [scriptPack])
    const report = JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8"))
    const verdicts = report.scenarios.scenarios.map((s: { id: string; verdict: string; holdout?: boolean }) => `${s.id} ${s.verdict}${s.holdout ? " holdout" : ""}`)
    expect(verdicts).toEqual(["FX-003 unbound", "FX-001 passing", "FX-002 passing holdout"])
    const fx2 = report.scenarios.scenarios.find((s: { id: string }) => s.id === "FX-002")
    expect(fx2.tests).toEqual([{ id: "holdout acceptance", status: "not-run", holdout: true }])
    // Shown by id only: no path to the holdout's file.
    expect(readFileSync(join(out, "gauntlet-report.md"), "utf8")).toContain("- Test: `holdout acceptance` (holdout, pending: it runs only in the evidence job)")
  })
})

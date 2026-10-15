import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli, POLICY } from "./harness.ts"

// Spec 0012 §1 and §2, through the CLI: scenario files are checked by
// `gauntlet validate`, judged as the base has them, and a change to one
// nominates review; deleting a scenario is a `deleted-tests` forbid.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const FX = `Feature: Currency conversion

  @FX-003
  Scenario: Converting EUR to USD
    Given a rate of 1.10 USD per EUR
    When I convert €1.00
    Then I get $1.10

  @FX-004
  Scenario: Rounds half-even
    Given 0.125
    Then I get 0.12
`

const WITH_SCENARIOS = POLICY.replace(`suites { unit "src/test/**" }`, `suites { unit "src/test/**" }\nscenarios "specs/**/*.feature"`)

/** The harness's repository with scenarios; its build fails when it sees a scenario file the change edited. */
const scenarioRepo = () => {
  const s = baseRepo()
  repos.push(s.r)
  s.r.git("checkout", "-q", "main")
  s.r.write({
    ".gauntlet/policy.gx": WITH_SCENARIOS,
    "specs/fx.feature": FX,
    "scripts/build.sh": "if grep -q EDITED specs/fx.feature; then exit 1; fi\nexit 0\n",
  })
  const base = s.r.commit("scenarios")
  s.r.git("checkout", "-q", "-B", "feature", base)
  return { r: s.r, base }
}
const report = (dir: string) => JSON.parse(readFileSync(join(dir, "gauntlet-report.json"), "utf8"))

describe("gauntlet validate with scenarios", () => {
  test("valid scenario files: the policy is valid, with its scenarios counted", async () => {
    const { r } = scenarioRepo()
    const res = await cli(["validate", "--repo", r.dir])
    expect(res.code).toBe(0)
    expect(res.out).toContain("is valid (IR ")
    expect(res.out).toContain("with 2 scenarios.")
  })

  test("a scenario without an id, or an id used twice, makes validate fail, at the scenario's line", async () => {
    const { r } = scenarioRepo()
    r.write({ "specs/more.feature": "Feature: More\n\n  @FX-003\n  Scenario: Same id again\n    Given x\n\n  Scenario: No id\n    Given y\n" })
    const res = await cli(["validate", "--repo", r.dir])
    expect(res.code).toBe(1)
    expect(res.out).toContain("specs/more.feature:4:3  error[duplicate-scenario-id]")
    expect(res.out).toContain("specs/more.feature:7:3  error[scenario-without-id]")
    expect(res.out).toContain(".gauntlet/policy.gx is valid, but its scenario files aren't.")
    const json = JSON.parse((await cli(["validate", "--repo", r.dir, "--json"])).out)
    expect(json.valid).toBe(false)
    expect(json.diagnostics.filter((d: { severity: string }) => d.severity === "error").map((d: { code: string }) => d.code).sort()).toEqual(["duplicate-scenario-id", "scenario-without-id"])
  })
})

describe("gauntlet check with scenario files", () => {
  test("an edited scenario is judged as the base has it, shown as such, and nominates review", async () => {
    const { r, base } = scenarioRepo()
    r.write({ "specs/fx.feature": FX.replace("Then I get $1.10", "Then I get $1.10 EDITED") })
    r.commit("edit a scenario")
    const out = join(r.dir, ".git", "report")
    const res = await cli(["check", "--repo", r.dir, "--base", base, "--out", out, "--no-record"])
    const rep = report(out)
    // The build reads the scenario file: it passes only on the base's version.
    expect(rep.checks.find((c: { check: string }) => c.check === "build").status).toBe("passed")
    expect(rep.facts.protectedTouched).toEqual([{ path: "specs/fx.feature", group: "scenarios", kind: "scenarios", change: "modified", action: "restored" }])
    expect(rep.decision.nominations.some((n: { rule: string; tier: string }) => n.rule === "protected-changed" && n.tier === "review")).toBe(true)
    expect(res.out).toContain("### Ran as the base has them")
    expect(res.out).toContain("`specs/fx.feature` (scenarios)")
  })

  test("deleting a scenario is a deleted-tests forbid; moving it to another file isn't", async () => {
    const { r, base } = scenarioRepo()
    r.write({ "specs/fx.feature": FX.slice(0, FX.indexOf("  @FX-004")) })
    r.commit("delete FX-004")
    const out = join(r.dir, ".git", "report")
    const res = await cli(["check", "--repo", r.dir, "--base", base, "--out", out, "--no-record"])
    const forbids = report(out).integrity.findings.filter((f: { kind: string }) => f.kind === "forbid")
    expect(forbids).toEqual([{
      check: "deleted-tests", kind: "forbid", detector: "core", path: "specs/fx.feature", line: 10,
      message: "Scenario @FX-004 ('Rounds half-even') was deleted. Scenarios state what a person meant; only they can remove one.",
    }])
    expect(res.code).toBe(1)

    r.write({ "specs/rounding.feature": `Feature: Rounding\n\n${FX.slice(FX.indexOf("  @FX-004"))}` })
    r.commit("move FX-004 to a file of its own")
    const moved = join(r.dir, ".git", "moved")
    await cli(["check", "--repo", r.dir, "--base", base, "--out", moved, "--no-record"])
    expect(report(moved).integrity.findings.filter((f: { check: string }) => f.check === "deleted-tests")).toEqual([])
  })
})

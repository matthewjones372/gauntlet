import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { jvmPack } from "@gauntlet/pack-jvm"
import { convertJUnit, skippedOf } from "@gauntlet/sarif"
import { Effect } from "effect"
import { agentSummary, type GateImpl, type Mutant, mutationGateRun, type Pack, ProcessRunner, renderAgentSummary, type SuiteImpl } from "../../core/src/index.ts"
import { quietDetector } from "../../core/test/script-pack.ts"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { cli } from "./harness.ts"

// Spec 0012 §3-§6 end to end, the README's FX change in miniature: the suite
// is a script writing JUnit XML, the mutation gate reads mutants a script
// writes (as Pitest's full matrix would name them), and the JVM pack reads the
// Kotlin test source. A correct change proves FX-003 and lists the untested
// Fx.fee as changed code with no scenario; `assertTrue(true)` makes FX-003
// vacuous and blocks.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const sh = (dir: string, script: string, out: string) =>
  Effect.gen(function*() {
    const r = yield* Effect.exit((yield* ProcessRunner).run({ command: "sh", args: [script, out], cwd: dir, timeout: "30 seconds" }))
    return r._tag === "Success" ? r.value.exitCode : -1
  })

const suite: SuiteImpl = (s, ctx) =>
  Effect.gen(function*() {
    const exitCode = yield* sh(ctx.dir, "scripts/test.sh", ctx.outputDir)
    const files = (yield* ctx.collect).filter((f) => f.path.endsWith(".xml"))
    const report = yield* Effect.orDie(convertJUnit(s.name, files))
    return { command: ["sh", "scripts/test.sh"], exitCode, runs: [report.run], tests: { counts: report.counts, ids: report.tests.map((t) => t.id), ...skippedOf(report.tests) } }
  })

/** Mutants as \`scripts/mutation.sh\` writes them, scored by the shared helper. */
const mutation: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const exitCode = yield* sh(ctx.dir, "scripts/mutation.sh", ctx.outputDir)
    const file = (yield* ctx.collect).find((f) => f.path === "mutants.json")
    const mutants = file ? (JSON.parse(file.content) as Mutant[]) : []
    // As the JVM pack does: killers only when asked for them (spec 0016), which the scenarios check does.
    const shown = ctx.recordKillMap ? mutants : mutants.map(({ killedBy: _k, coveredBy: _c, ...m }) => m)
    return { command: ["sh", "scripts/mutation.sh"], exitCode, ...mutationGateRun("pitest", shown, ctx) }
  })

const pack: Pack = {
  spec: jvmPack.spec,
  runnerConfig: [],
  manifests: [],
  detectors: [quietDetector],
  gates: { build: (_c, ctx) => sh(ctx.dir, "scripts/build.sh", ctx.outputDir).pipe(Effect.map((exitCode) => ({ command: ["sh", "scripts/build.sh"], exitCode, runs: [] }))), mutation },
  runSuite: suite,
  ...(jvmPack.surveyTests ? { surveyTests: jvmPack.surveyTests } : {}),
}

const policy = (check: string) => `gauntlet "fx"
use jvm
mode enforce
owners @platform
protect { tests "src/test/**" }
suites { unit "src/test/**" }
scenarios "specs/**/*.feature"
gates {
  verify    { build, unit, mutation advise on changed }
  behaviour { ${check} }
}
review { auto when all gates pass }
`

const FEATURE = `Feature: Currency conversion

  @FX-003
  Scenario: Converting EUR to USD
    Given a rate of 1.10 USD per EUR
    When I convert €1.00
    Then I get $1.10
`

// One JUnit test per line of src/test/tests.txt, as "<class>|<name>".
const TEST_SH = `out="$1"
cases=""
while IFS='|' read -r cls name; do
  [ -n "$cls" ] && cases="$cases<testcase classname=\\"$cls\\" name=\\"$name\\"/>"
done < src/test/tests.txt
echo "<testsuite name=\\"unit\\">$cases</testsuite>" > "$out/TEST-unit.xml"
`

const FX_TEST = (assertion: string) => `package svc.settlement

class FxTest {
    @Test
    fun \`FX-003 converts\`() {
        ${assertion}
    }
}
`

const T = "svc.settlement.FxTest.FX-003 converts"
const KILLED = { path: "src/main/kotlin/svc/settlement/Fx.kt", line: 3, killed: true, message: "killed", method: "Fx.convert", description: "replaced Long division with multiplication", killedBy: [T], coveredBy: [T] }
const SURVIVED_FEE = { path: "src/main/kotlin/svc/settlement/Fx.kt", line: 4, killed: false, message: "No test kills a mutant in Fx", method: "Fx.fee", description: "replaced return value with 0", killedBy: [], coveredBy: [] }

const repo = (check = "scenarios", feature = FEATURE) => {
  const r = new TempRepo()
  repos.push(r)
  r.write({
    ".gauntlet/policy.gx": policy(check),
    "specs/fx.feature": feature,
    "scripts/build.sh": "exit 0\n",
    "scripts/test.sh": TEST_SH,
    "scripts/mutation.sh": `cp mutants.json "$1/mutants.json"\n`,
    "mutants.json": "[]\n",
    "src/main/kotlin/svc/settlement/Fx.kt": "class Fx {\n  fun convert(a: Long) = a * 11_000 / 10_000\n}\n",
    "src/test/tests.txt": `svc.settlement.FxTest|FX-003 converts\n`,
    "src/test/kotlin/svc/settlement/FxTest.kt": FX_TEST(`assertEquals(110, Fx().convert(100))`),
  })
  const base = r.commit("base")
  r.git("checkout", "-q", "-b", "feature")
  return { r, base }
}

const check = async (r: TempRepo, base: string) => {
  const out = join(r.dir, ".git", `report-${Math.random().toString(36).slice(2)}`)
  const res = await cli(["check", "--repo", r.dir, "--base", base, "--out", out, "--no-record"], [pack])
  return { res, report: JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8")) }
}

const CHANGE = "class Fx {\n  fun convert(a: Long) = a * 11_000 / 10_000\n  fun convert2(a: Long) = a * 11_000 / 10_000\n  fun fee(a: Long) = a / 100\n}\n"

describe("the scenarios check", () => {
  test("a correct change proves FX-003, and lists the untested Fx.fee as changed code with no scenario", async () => {
    const { r, base } = repo()
    r.write({ "src/main/kotlin/svc/settlement/Fx.kt": CHANGE, "mutants.json": JSON.stringify([KILLED, SURVIVED_FEE]) })
    r.commit("convert2 and a fee")
    const { res, report } = await check(r, base)
    const scenarios = report.checks.find((c: { check: string }) => c.check === "scenarios")
    expect(scenarios.status).toBe("passed")
    expect(scenarios.reason).toBe("1 scenario: 1 proven; changed code with no scenario: 1 function")
    expect(report.scenarios.scenarios.map((s: { id: string; verdict: string }) => `${s.id} ${s.verdict}`)).toEqual(["FX-003 proven"])
    expect(report.scenarios.scenarios[0].tests).toEqual([{ id: T, status: "passed", path: "src/test/kotlin/svc/settlement/FxTest.kt", line: 4, assertions: 1 }])
    expect(report.scenarios.noScenario).toEqual([{ function: "Fx.fee", path: "src/main/kotlin/svc/settlement/Fx.kt", line: 4, mutants: 1 }])
    expect(report.advice.map((a: { ruleId: string }) => a.ruleId)).toContain("scenarios/no-scenario")
    expect(report.decision.blocking).toBe(false)
    expect(res.code).toBe(0)
  })

  test("assertTrue(true) makes FX-003 vacuous, and the change is blocked", async () => {
    const { r, base } = repo()
    r.write({
      "src/main/kotlin/svc/settlement/Fx.kt": CHANGE.replace("/ 10_000\n  fun convert2", "/ 1_000\n  fun convert2"),
      "src/test/kotlin/svc/settlement/FxTest.kt": FX_TEST("assertTrue(true)"),
      "mutants.json": JSON.stringify([{ ...KILLED, killed: false, killedBy: [] }]),
    })
    r.commit("divide by 1_000, assertTrue(true)")
    const { res, report } = await check(r, base)
    expect(report.scenarios.scenarios.map((s: { id: string; verdict: string }) => `${s.id} ${s.verdict}`)).toEqual(["FX-003 vacuous"])
    expect(report.scenarios.scenarios[0].tests[0].vacuous).toBe("its only assertion can't fail")
    const scenarios = report.checks.find((c: { check: string }) => c.check === "scenarios")
    expect(scenarios.status).toBe("failed")
    expect(report.decision.blocking).toBe(true)
    expect(res.code).toBe(1)
    // The agent is told what the person meant, with the scenario's steps.
    const told = renderAgentSummary(agentSummary(report, "out"))
    expect(told).toContain("@FX-003 Converting EUR to USD (specs/fx.feature:4) is vacuous: its tests can't fail: they assert nothing that could. Given a rate of 1.10 USD per EUR; When I convert €1.00; Then I get $1.10")
    expect(told).toContain("scenario files are protected, so don't edit them")
  })

  test("the trusted job takes the verdicts with the check's outcome from the evidence job", async () => {
    const { r, base } = repo()
    r.write({ "src/main/kotlin/svc/settlement/Fx.kt": CHANGE, "mutants.json": JSON.stringify([KILLED, SURVIVED_FEE]) })
    r.commit("change")
    await cli(["check", "--repo", r.dir, "--policy-ref", base, "--out", join(r.dir, "evidence"), "--no-record"], [pack])
    r.write({ "reviews.json": "[]" })
    await cli(["github-status", "--repo", r.dir, "--policy-ref", base, "--head", "HEAD", "--evidence", "evidence/gauntlet-report.json", "--reviews", "reviews.json", "--out", "trusted"], [pack])
    const trusted = JSON.parse(readFileSync(join(r.dir, "trusted", "gauntlet-report.json"), "utf8"))
    expect(trusted.checks.find((c: { check: string }) => c.check === "scenarios").status).toBe("passed")
    expect(trusted.scenarios.scenarios.map((s: { id: string; verdict: string }) => `${s.id} ${s.verdict}`)).toEqual(["FX-003 proven"])
  })

  test("an unbound scenario blocks under scenarios, and is only reported under scenarios advise", async () => {
    const extra = `${FEATURE}\n  @FX-006\n  Scenario: Same currency is identity\n    Given EUR to EUR\n    Then nothing changes\n`
    for (const [gate, blocked] of [["scenarios", true], ["scenarios advise", false]] as const) {
      const { r, base } = repo(gate, extra)
      r.write({ "src/main/kotlin/svc/settlement/Fx.kt": CHANGE, "mutants.json": JSON.stringify([KILLED]) })
      r.commit("change")
      const { report } = await check(r, base)
      expect(report.scenarios.scenarios.map((s: { id: string; verdict: string }) => `${s.id} ${s.verdict}`)).toEqual(["FX-006 unbound", "FX-003 proven"])
      expect(report.decision.blocking).toBe(blocked)
      if (!blocked) expect(report.advice.map((a: { message: string }) => a.message)).toContain("Scenario @FX-006 (Same currency is identity) is unbound.")
    }
  })
})

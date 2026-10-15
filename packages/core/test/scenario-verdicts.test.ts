import { describe, expect, test } from "bun:test"
import { parseScenarioFile } from "@gauntlet/dsl"
import { judgeScenarios, type Mutant, type ScenarioEvidence, scenarioAdvice, type SurveyedTest } from "../src/index.ts"

// Spec 0012 §3-§6: one fixture per row of the verdict table, first match wins,
// and changed code no scenario's test catches.

const FEATURE = `Feature: FX
  @FX-003
  Scenario: Converting EUR to USD
    Given a rate of 1.10 USD per EUR
    When I convert €1.00
    Then I get $1.10
`
const scenarios = parseScenarioFile("specs/fx.feature", FEATURE).scenarios
const T = "svc.FxTest.FX-003 converts()"

const surveyed = (name: string, assertions: number, tautologies = 0): ScenarioEvidence["surveyed"][number] => ({
  path: "src/test/kotlin/svc/FxTest.kt",
  test: { name, line: 9, assertions, tautologies, property: false, calls: [], scope: "FxTest", body: "x" } satisfies SurveyedTest,
  helpers: new Set(),
})

const mutant = (over: Partial<Mutant> = {}): Mutant => ({ path: "src/main/Fx.kt", line: 7, killed: true, message: "", method: "Fx.convert", description: "replaced Long division with multiplication", ...over })

const base: ScenarioEvidence = {
  scenarios,
  ran: [{ id: T, status: "passed" }],
  known: [],
  leftOut: [],
  surveyed: [surveyed("FX-003 converts", 4)],
  mutation: { state: "ran", mutants: [mutant({ killedBy: [T], coveredBy: [T], killMessage: "expected Money(110, USD) but was Money(1100, USD)\n\tat FxTest" })] },
  changedLines: new Map([["src/main/Fx.kt", new Set([7])], ["src/main/Fee.kt", new Set([3])]]),
}
const verdict = (over: Partial<ScenarioEvidence>) => judgeScenarios({ ...base, ...over }).scenarios[0]!.verdict

describe("scenario verdicts", () => {
  test("unbound: no test names the id", () => {
    expect(verdict({ ran: [{ id: "svc.FxTest.converts_FX003", status: "passed" }], surveyed: [] })).toBe("unbound")
  })

  test("not-run: a bound test exists (in the base, or in the source) but didn't execute", () => {
    expect(verdict({ ran: [], known: [T], surveyed: [] })).toBe("not-run")
    expect(verdict({ ran: [] })).toBe("not-run")
    expect(verdict({ ran: [{ id: T, status: "skipped" }] })).toBe("not-run")
  })

  test("a bound test affected selection left out didn't need to run: unaffected", () => {
    expect(verdict({ ran: [], known: [T], leftOut: [T], surveyed: [] })).toBe("unaffected")
  })

  test("failing: a bound test failed", () => {
    expect(verdict({ ran: [{ id: T, status: "failed" }, { id: "svc.FxTest.FX-003 again()", status: "passed" }] })).toBe("failing")
  })

  test("vacuous: every bound test that ran can't fail", () => {
    expect(verdict({ surveyed: [surveyed("FX-003 converts", 1, 1)] })).toBe("vacuous")
    expect(verdict({ surveyed: [surveyed("FX-003 converts", 0)] })).toBe("vacuous")
    // One test that can fail is enough.
    expect(verdict({ ran: [{ id: T, status: "passed" }, { id: "svc.FxTest.FX-003 rounds()", status: "passed" }], surveyed: [surveyed("FX-003 converts", 0), surveyed("FX-003 rounds", 2)] })).toBe("proven")
  })

  test("unchallenged: a bound test reaches a changed line's mutant and no bound test kills one", () => {
    const judged = judgeScenarios({ ...base, mutation: { state: "ran", mutants: [mutant({ killed: false, killedBy: [], coveredBy: [T] })] } })
    expect(judged.scenarios[0]!.verdict).toBe("unchallenged")
    expect(scenarioAdvice(judged, false).map((a) => a.message)).toContain("Scenario @FX-003 (Converting EUR to USD): its tests reach 1 mutant on the changed lines and kill none.")
  })

  test("proven: a bound test kills a mutant on a changed line, with the tool's words and the test's message", () => {
    const s = judgeScenarios(base).scenarios[0]!
    expect(s.verdict).toBe("proven")
    expect(s.killed).toEqual([{ path: "src/main/Fx.kt", line: 7, method: "Fx.convert", description: "replaced Long division with multiplication", killedBy: T, message: "expected Money(110, USD) but was Money(1100, USD)" }])
    expect(s.tests).toEqual([{ id: T, status: "passed", path: "src/test/kotlin/svc/FxTest.kt", line: 9, assertions: 4 }])
    expect(s.text).toEqual(["Given a rate of 1.10 USD per EUR", "When I convert €1.00", "Then I get $1.10"])
  })

  test("unaffected: proven, but no bound test reached a changed line", () => {
    expect(verdict({ mutation: { state: "ran", mutants: [mutant({ line: 30, killedBy: [T], coveredBy: [T] })] } })).toBe("unaffected")
  })

  test("passing: without a mutation gate, or a tool that names no killers", () => {
    expect(verdict({ mutation: { state: "not-in-policy" } })).toBe("passing")
    expect(verdict({ mutation: { state: "not-run" } })).toBe("passing")
    const notReported = judgeScenarios({ ...base, mutation: { state: "ran", mutants: [mutant()] } })
    expect(notReported.scenarios[0]!.verdict).toBe("passing")
    expect(notReported.scenarios[0]!.killers).toBe("not-reported")
    // Gauntlet never infers a killer, and never claims code has no scenario without them.
    expect(notReported.noScenario).toEqual([])
  })

  test("one test can bind two scenarios", () => {
    const two = parseScenarioFile("specs/fx.feature", `${FEATURE}  @FX-004\n  Scenario: Rounds\n    Given x\n`).scenarios
    const judged = judgeScenarios({ ...base, scenarios: two, ran: [{ id: "svc.FxTest.FX-003 and FX-004()", status: "passed" }], surveyed: [] })
    expect(judged.scenarios.map((s) => `${s.id} ${s.tests.map((t) => t.id).join(",")}`)).toEqual(["FX-003 svc.FxTest.FX-003 and FX-004()", "FX-004 svc.FxTest.FX-003 and FX-004()"])
  })
})

describe("changed code with no scenario", () => {
  test("a changed function none of whose changed-line mutants a scenario's test kills, per function", () => {
    const judged = judgeScenarios({
      ...base,
      mutation: {
        state: "ran",
        mutants: [
          mutant({ killedBy: [T], coveredBy: [T] }),
          mutant({ path: "src/main/Fee.kt", line: 3, method: "Fx.fee", killedBy: ["svc.FeeTest.rounds up()"], coveredBy: ["svc.FeeTest.rounds up()"] }),
          mutant({ path: "src/main/Fee.kt", line: 3, method: "Fx.fee", killed: false, killedBy: [], coveredBy: [] }),
          // Not on a changed line: never claimed.
          mutant({ path: "src/main/Fee.kt", line: 40, method: "Fx.other", killed: false, killedBy: [], coveredBy: [] }),
        ],
      },
    })
    expect(judged.noScenario).toEqual([{ function: "Fx.fee", path: "src/main/Fee.kt", line: 3, mutants: 2 }])
    expect(scenarioAdvice(judged, false).map((a) => `${a.ruleId} ${a.path}:${a.line}`)).toEqual(["scenarios/no-scenario src/main/Fee.kt:3"])
  })

  test("under advise, the verdicts that would block are findings too", () => {
    const judged = judgeScenarios({ ...base, ran: [], surveyed: [] })
    expect(scenarioAdvice(judged, true)).toEqual([{ check: "scenarios", ruleId: "scenarios/verdict", message: "Scenario @FX-003 (Converting EUR to USD) is unbound.", path: "specs/fx.feature", line: 3 }])
    expect(scenarioAdvice(judged, false)).toEqual([])
  })
})

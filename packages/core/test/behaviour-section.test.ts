import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { parseScenarioFile } from "@gauntlet/dsl"
import { irHash } from "@gauntlet/ir"
import {
  agentSummary, buildReport, decide, judgeScenarios, type Mutant, renderAgentSummary, renderMarkdown, type ScenarioEvidence, type ScenarioJudgement, type SurveyedTest,
} from "../src/index.ts"
import { cleanEvidence, compiled, noFacts } from "./fixtures.ts"
import { expectGolden } from "./golden-file.ts"

// Spec 0012 "In the pull request": the `### Behaviour` section for the FX
// example, links for every path (scenario files at the base commit), a
// diagram that stays readable, and a report that stays under GitHub's limit.

const BASE = "b".repeat(40)
const HEAD = "c".repeat(40)
const OPTS = { repoUrl: "https://github.com/acme/fx", pullRequest: 12 }

const FEATURE = `Feature: Currency conversion

  @FX-003
  Scenario: Converting EUR to USD
    Given a rate of 1.10 USD per EUR
    When I convert €1.00
    Then I get $1.10

  @FX-004
  Scenario: Rounds half-even
    Given an amount of 0.125
    Then I get 0.12

  @FX-005
  Scenario: Rejects unknown currency
    When I convert to XYZ
    Then it fails

  @FX-006
  Scenario: Same currency is identity
    When I convert EUR to EUR
    Then nothing changes

  @FX-007
  Scenario: Quotes are cached
    Given a quote
    Then it is reused
`

const t = (name: string) => `svc.settlement.FxTest.${name}`
const FX = "src/main/kotlin/svc/settlement/Fx.kt"
const surveyed = (name: string, line: number, assertions: number): ScenarioEvidence["surveyed"][number] => ({
  path: "src/test/kotlin/svc/settlement/FxTest.kt",
  test: { name, line, assertions, tautologies: 0, property: false, calls: [], scope: "FxTest", body: name } satisfies SurveyedTest,
  helpers: new Set(),
})
const m = (line: number, method: string, description: string, killedBy: string[], coveredBy: string[], killMessage?: string): Mutant =>
  ({ path: FX, line, killed: killedBy.length > 0, message: "", method, description, killedBy, coveredBy, ...(killMessage ? { killMessage } : {}) })

const fxEvidence = (): ScenarioEvidence => ({
  scenarios: parseScenarioFile("specs/fx.feature", FEATURE).scenarios,
  ran: ["FX-003 converts", "FX-004 rounds", "FX-005 rejects", "FX-007 caches"].map((n) => ({ id: t(n), status: "passed" as const })),
  known: [],
  leftOut: [],
  surveyed: [surveyed("FX-003 converts", 9, 4), surveyed("FX-004 rounds", 15, 2), surveyed("FX-005 rejects", 20, 1)],
  mutation: {
    state: "ran",
    mutants: [
      m(7, "Fx.convert", "Replaced long division with multiplication", [t("FX-003 converts")], [t("FX-003 converts")], "expected Money(110, USD) but was Money(1100, USD)\n  at FxTest.kt:12"),
      m(7, "Fx.convert", "Replaced long multiplication with division", [t("FX-003 converts")], [t("FX-003 converts")]),
      m(8, "Fx.convert", "negated conditional", [t("FX-003 converts")], [t("FX-003 converts")]),
      m(10, "Fx.round", "removed call to setScale", [t("FX-004 rounds")], [t("FX-004 rounds")]),
      m(11, "Fx.round", "replaced HALF_EVEN with HALF_UP", [t("FX-004 rounds")], [t("FX-004 rounds")]),
      m(14, "Fx.lookup", "negated conditional", [], [t("FX-005 rejects")]),
      m(22, "Fx.fee", "replaced return value with 0", [], []),
      m(40, "Fx.cache", "removed call", [t("FX-007 caches")], [t("FX-007 caches")]),
    ],
  },
  changedLines: new Map([[FX, new Set([7, 8, 10, 11, 14, 22])]]),
})

const reportFor = (judgement: ScenarioJudgement, files = [{ path: FX, status: "modified" as const, added: 6, removed: 2 }]) => {
  const policy = compiled(`gauntlet "fx"\nuse jvm\nmode enforce\nowners @p\nsuites { unit "src/test/**" }\nscenarios "specs/**/*.feature"\ngates {\n  verify { unit, mutation advise on changed }\n  behaviour { scenarios }\n}\n`)
  const facts = noFacts({ base: BASE, head: HEAD, files, linesChanged: 8 })
  const checks = [
    { tier: "verify", check: "unit", pointer: "/gates/0/checks/1", advisory: false, status: "passed" as const },
    { tier: "behaviour", check: "scenarios", pointer: "/gates/1/checks/0", advisory: false, status: "failed" as const, reason: "x", scenarios: judgement },
  ]
  const evidence = cleanEvidence({ checks })
  return buildReport({
    gauntletVersion: "0.1.0",
    policy: { ...policy, irHash: irHash(policy.ir), origin: "base", firstAdoption: false, drift: [], notes: [] },
    facts, checks, ratchets: [], integrity: evidence.integrity, violations: [], imports: [],
    decision: decide({ ...policy, facts, evidence, mode: "enforce" }),
  })
}

const section = (md: string) => md.slice(md.indexOf("### Behaviour"), md.indexOf("### Checks"))

describe("the Behaviour section", () => {
  test("the FX example: count, table, details and diagram, after Why and before Checks", () => {
    const md = renderMarkdown(reportFor(judgeScenarios(fxEvidence())), OPTS)
    expect(md.indexOf("### Why")).toBeLessThan(md.indexOf("### Behaviour"))
    expect(md.indexOf("### Behaviour")).toBeLessThan(md.indexOf("### Checks"))
    expectGolden(join(import.meta.dir, "golden", "behaviour-fx.md"), section(md))
    expect(section(md)).toContain("2 of 5 scenarios proven · 1 unbound · 1 unchallenged · 1 unaffected · changed code with no scenario: 1 function")
    expect(section(md)).toContain("| ⚠️ | **FX-005** Rejects unknown currency | `FxTest.FX-005 rejects` | ✔ 1 assertion | kills 0 of 1 |")
    expect(section(md)).toContain("| ✅ | **FX-003** Converting EUR to USD | `FxTest.FX-003 converts` | ✔ 4 assertions | kills 3 of 3 |")
  })

  test("every path is a link, and scenario files link to the base commit", () => {
    const s = section(renderMarkdown(reportFor(judgeScenarios(fxEvidence())), OPTS))
    expect(s).toContain(`[\`specs/fx.feature:4\`](https://github.com/acme/fx/blob/${BASE}/specs/fx.feature#L4), unchanged`)
    expect(s).toContain("[`src/main/kotlin/svc/settlement/Fx.kt:7`](https://github.com/acme/fx/pull/12/files#diff-")
    expect(s).toContain(`[\`src/test/kotlin/svc/settlement/FxTest.kt:9\`](https://github.com/acme/fx/blob/${HEAD}/src/test/kotlin/svc/settlement/FxTest.kt#L9), unchanged since base`)
    // A path in backticks that isn't a link's text would be a bare path.
    const bare = [...s.matchAll(/(?<!\[)`((?:src|specs)\/[^`]*)`/g)].map((x) => x[1])
    expect(bare).toEqual([])
  })

  test("a scenario file the pull request changes is shown as the base has it, and says so", () => {
    const report = reportFor(judgeScenarios(fxEvidence()), [{ path: FX, status: "modified", added: 6, removed: 2 }, { path: "specs/fx.feature", status: "modified", added: 1, removed: 1 }])
    const s = section(renderMarkdown(report, OPTS))
    expect(s).toContain("as the base has it: this pull request changes the file, and the base's version is the one judged (the head's is in [`specs/fx.feature`](https://github.com/acme/fx/pull/12/files#diff-")
  })

  test("the diagram's edges are evidence only: solid for killed, dotted for reached", () => {
    const s = section(renderMarkdown(reportFor(judgeScenarios(fxEvidence())), OPTS))
    const chart = s.slice(s.indexOf("```mermaid"), s.indexOf("```", s.indexOf("```mermaid") + 3))
    expect(chart).toContain('["FX-005 Rejects unknown currency"]:::warn')
    expect(chart).toMatch(/S\d -\.-> F\d/)
    expect(chart).toMatch(/S\d --> F\d/)
    expect(chart).toContain("Fx.fee: no scenario")
    expect(s).toContain("- **FX-006** → no test names it")
    expect(s).toContain("- **No scenario** → [`src/main/kotlin/svc/settlement/Fx.kt:22`]")
  })

  test("the diagram stays under 30 nodes, with +N more, and a big report stays under GitHub's comment limit", () => {
    const many = Array.from({ length: 400 }, (_, i) => `  @FX-${1000 + i}\n  Scenario: Scenario number ${i} with a fairly long name to fill the table\n    Given step one of ${i}\n    When step two\n    Then step three\n`).join("\n")
    const judgement = judgeScenarios({ ...fxEvidence(), scenarios: parseScenarioFile("specs/many.feature", `Feature: Many\n\n${many}`).scenarios, ran: [], surveyed: [] })
    const md = renderMarkdown(reportFor(judgement), OPTS)
    const s = section(md)
    const chart = s.slice(s.indexOf("```mermaid"), s.indexOf("```", s.indexOf("```mermaid") + 3))
    expect(chart.split("\n").filter((l) => /^\s+\w+\["/.test(l)).length).toBeLessThanOrEqual(31)
    expect(chart).toContain("more in gauntlet-report.json")
    expect(s).toContain("| … | 360 more in gauntlet-report.json | | | |")
    expect(md.length).toBeLessThan(65_536)
  })

  test("a holdout test is shown by id only; a scenario bound only by holdouts is passing, marked holdout", () => {
    const e = fxEvidence()
    const judgement = judgeScenarios({ ...e, ran: [...e.ran, { id: "holdout.FxHoldout.FX-006 identity", status: "passed", holdout: true }] })
    const fx6 = judgement.scenarios.find((s) => s.id === "FX-006")!
    expect(fx6.verdict).toBe("passing")
    expect(fx6.holdout).toBe(true)
    const s = section(renderMarkdown(reportFor(judgement), OPTS))
    expect(s).toContain("- Test: `holdout.FxHoldout.FX-006 identity` (holdout, passed)")
    expect(s).toContain("| ✅ | **FX-006** Same currency is identity | `holdout.FxHoldout.FX-006 identity` | ✔ holdout | holdout: not mutated |")
  })

  test("without mutation, the count says none can be proven, and the agent hears each scenario that blocks", () => {
    const judgement = judgeScenarios({ ...fxEvidence(), mutation: { state: "not-in-policy" } })
    const report = reportFor(judgement)
    expect(section(renderMarkdown(report, OPTS))).toContain("0 of 5 scenarios proven · 1 unbound · 4 passing · mutation wasn't run, so none can be proven")
    expect(renderAgentSummary(agentSummary(report, "out"))).toContain("- @FX-006 Same currency is identity (specs/fx.feature:20) is unbound: no test names its id. When I convert EUR to EUR; Then nothing changes")
  })
})

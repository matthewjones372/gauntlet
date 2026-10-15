import { describe, expect, test } from "bun:test"
import { namesScenario, parseScenarioFile, readScenarios } from "../src/index.ts"

// Spec 0012 §1: the Gherkin subset scenario files are written in, read by
// Gauntlet's own parser, and §3: a test binds a scenario by naming its id.

const FX = `# Scenarios for the FX conversion.
@money
Feature: Currency conversion
  Prices are quoted in the buyer's currency.

  Background:
    Given the rates are loaded

  @FX-003 @smoke
  Scenario: Converting EUR to USD
    Given a rate of 1.10 USD per EUR
    When I convert €1.00
    Then I get $1.10
    And nothing is rounded

  @FX-004
  Scenario Outline: Rounds half-even
    Given an amount of <amount>
    When I round it
    Then I get <rounded>

    Examples:
      | amount | rounded |
      | 0.125  | 0.12    |
      | 0.135  | 0.14    |

  @FX-005
  Scenario: Rejects unknown currency
    Given these rates:
      | from | to  | rate |
      | EUR  | USD | 1.10 |
    When I convert to "XYZ"
    Then it fails with
      """
      unknown currency XYZ
      """
`

describe("the Gherkin subset", () => {
  test("reads scenarios with their ids, steps, background and tags", () => {
    const r = parseScenarioFile("specs/fx.feature", FX)
    expect(r.diagnostics).toEqual([])
    expect(r.scenarios.map((s) => [s.id, s.name, s.line, s.outline])).toEqual([
      ["FX-003", "Converting EUR to USD", 10, false],
      ["FX-004", "Rounds half-even", 17, true],
      ["FX-005", "Rejects unknown currency", 28, false],
    ])
    const fx3 = r.scenarios[0]!
    expect(fx3.feature).toBe("Currency conversion")
    expect(fx3.tags).toEqual(["@FX-003", "@smoke"])
    expect(fx3.background.map((s) => `${s.keyword} ${s.text}`)).toEqual(["Given the rates are loaded"])
    expect(fx3.steps.map((s) => `${s.keyword} ${s.text}`)).toEqual([
      "Given a rate of 1.10 USD per EUR", "When I convert €1.00", "Then I get $1.10", "And nothing is rounded",
    ])
    expect(fx3.steps.map((s) => s.line)).toEqual([11, 12, 13, 14])
  })

  test("an outline is one scenario, its examples kept as written", () => {
    const outline = parseScenarioFile("specs/fx.feature", FX).scenarios[1]!
    expect(outline.steps.map((s) => s.text)).toEqual(["an amount of <amount>", "I round it", "I get <rounded>"])
    expect(outline.examples).toEqual([["| amount | rounded |", "| 0.125  | 0.12    |", "| 0.135  | 0.14    |"]])
  })

  test("data tables and doc strings stay with their step", () => {
    const fx5 = parseScenarioFile("specs/fx.feature", FX).scenarios[2]!
    expect(fx5.steps[0]!.argument).toEqual(["| from | to  | rate |", "| EUR  | USD | 1.10 |"])
    expect(fx5.steps[2]!.argument).toEqual(['"""', "unknown currency XYZ", '"""'])
  })

  test("Example, Scenario Template and Scenarios are read as their synonyms", () => {
    const text = `Feature: f\n  @A-1\n  Example: one\n    Given x\n  @A-2\n  Scenario Template: two <n>\n    Given <n>\n    Scenarios:\n      | n |\n      | 1 |\n`
    const r = parseScenarioFile("a.feature", text)
    expect(r.diagnostics).toEqual([])
    expect(r.scenarios.map((s) => [s.id, s.outline, s.examples?.length ?? 0])).toEqual([["A-1", false, 0], ["A-2", true, 1]])
  })

  test("a scenario without an id is an error at its line, and is left out", () => {
    const r = parseScenarioFile("specs/a.feature", `Feature: f\n\n  @smoke\n  Scenario: no id here\n    Given x\n`)
    expect(r.scenarios).toEqual([])
    expect(r.diagnostics.map((d) => [d.code, d.file, d.span.line, d.span.column])).toEqual([["scenario-without-id", "specs/a.feature", 4, 3]])
  })

  test("two ids on one scenario, or an id on the feature, are errors", () => {
    expect(parseScenarioFile("a.feature", `Feature: f\n  @A-1 @A-2\n  Scenario: s\n    Given x\n`).diagnostics.map((d) => [d.code, d.span.line, d.span.column]))
      .toEqual([["scenario-with-two-ids", 2, 8]])
    expect(parseScenarioFile("a.feature", `@A-1\nFeature: f\n  @A-2\n  Scenario: s\n    Given x\n`).diagnostics.map((d) => [d.code, d.span.line]))
      .toEqual([["feature-with-id", 1]])
  })

  test("Gherkin outside the subset is an error, not silently skipped", () => {
    const codes = (text: string) => parseScenarioFile("a.feature", text).diagnostics.map((d) => d.code)
    expect(codes(`Feature: f\n  Rule: r\n  @A-1\n  Scenario: s\n    Given x\n`)).toEqual(["unsupported-gherkin"])
    expect(codes(`Feature: f\n  @A-1\n  Scenario: s\n    Given x\n    whatever this is\n`)).toEqual(["unexpected-gherkin"])
    expect(codes(`Feature: f\nGiven x\n`)).toEqual(["step-outside-scenario"])
    expect(codes(`Feature: f\n  @A-1\n  Scenario: s\n    Given x\n    Examples:\n`)).toEqual(["examples-outside-outline"])
    expect(codes(`@A-1\nScenario: s\n  Given x\n`)).toEqual(["scenario-outside-feature"])
    expect(codes(`Feature: f\n  @A-1\n  Scenario: s\n    Given x\n      """\n      never closed\n`)).toEqual(["unclosed-doc-string"])
  })

  test("an id used twice across files is an error at the second, naming the first", () => {
    const r = readScenarios([
      { path: "specs/b.feature", text: `Feature: b\n  @FX-003\n  Scenario: again\n    Given y\n` },
      { path: "specs/a.feature", text: `Feature: a\n  @FX-003\n  Scenario: first\n    Given x\n  @FX-004\n  Scenario: other\n    Given z\n` },
    ])
    expect(r.scenarios.map((s) => `${s.id} ${s.file}`)).toEqual(["FX-003 specs/a.feature", "FX-004 specs/a.feature"])
    expect(r.diagnostics.map((d) => [d.code, d.file, d.span.line])).toEqual([["duplicate-scenario-id", "specs/b.feature", 3]])
    expect(r.diagnostics[0]!.message).toBe("@FX-003 is also the id of 'first' at specs/a.feature:3.")
    expect(r.diagnostics[0]!.fix).toContain("@FX-005")
  })
})

describe("binding a test to a scenario by name", () => {
  test("the id binds as a word in the name the runner reports", () => {
    expect(namesScenario("svc.FxTest.FX-003 converts at the quoted rate()", "FX-003")).toBe(true)
    expect(namesScenario("FxTest > [FX-003] converts", "FX-003")).toBe(true)
    expect(namesScenario("svc.FxTest.[engine:junit-jupiter]/[method:FX-003 converts()]", "FX-003")).toBe(true)
  })

  test("not as part of a longer word or number", () => {
    expect(namesScenario("svc.FxTest.converts_FX003", "FX-003")).toBe(false)
    expect(namesScenario("svc.FxTest.FX-0031 converts", "FX-003")).toBe(false)
    expect(namesScenario("svc.FxTest.FX-003-2 converts", "FX-003")).toBe(false)
    expect(namesScenario("svc.FxTest.AFX-003 converts", "FX-003")).toBe(false)
    expect(namesScenario("svc.FxTest.converts_FX-003", "FX-003")).toBe(false)
  })

  test("one test can name two scenarios", () => {
    const name = "svc.FxTest.FX-003 and FX-004 together"
    expect(["FX-003", "FX-004", "FX-005"].filter((id) => namesScenario(name, id))).toEqual(["FX-003", "FX-004"])
  })
})

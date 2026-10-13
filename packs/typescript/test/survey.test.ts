import { describe, expect, test } from "bun:test"
import { pruneCandidates } from "@gauntlet/core"
import { typescriptSurveyor } from "../src/detectors.ts"

// Spec 0016: how the TypeScript pack reads a test file for `gauntlet prune tests`.

const FILE = `import { describe, expect, test } from "vitest"
import fc from "fast-check"

const expectRate = (from: string, to: string, rate: number) => expect(convert(from, to)).toBe(rate)

describe("convert", () => {
  test("runs without checking", () => {
    convert("GBP", "USD")
  })

  test("can't fail", () => {
    expect(true).toBeTruthy()
    expect(rate).toBe(rate)
  })

  test("GBP to USD", () => {
    expect(convert("GBP", "USD")).toBe(1.25)
  })

  // Same as above under another title.
  test("pounds to dollars", () => {
    expect(convert("GBP", "USD"))
      .toBe(1.25)
  })

  test("via a helper", () => {
    expectRate("GBP", "EUR", 1.17)
  })

  test("round trips", () => {
    fc.assert(fc.property(fc.integer(), (n) => convert("GBP", "GBP", n) === n))
  })
})

describe("legacy", () => {
  test("GBP to USD", () => {
    expect(convert("GBP", "USD")).toBe(1.25)
  })
})
`

describe("typescriptSurveyor", () => {
  test("reads test files, and source files the policy counts as tests", () => {
    expect(typescriptSurveyor.reads("src/fx.test.ts", false)).toBe(true)
    expect(typescriptSurveyor.reads("test/helpers.ts", true)).toBe(true)
    expect(typescriptSurveyor.reads("src/fx.ts", false)).toBe(false)
    expect(typescriptSurveyor.reads("test/data.json", true)).toBe(false)
  })

  test("counts assertions, tautologies, helpers, property tests and describe scopes", () => {
    const s = typescriptSurveyor.survey("src/fx.test.ts", FILE)
    const by = Object.fromEntries(s.tests.map((t) => [`${t.scope}|${t.name}`, t]))
    expect(by['"convert"|runs without checking']!.assertions).toBe(0)
    expect(by[`"convert"|can't fail`]!.tautologies).toBe(2)
    expect(by['"convert"|via a helper']!.calls).toContain("expectRate")
    expect(by['"legacy"|GBP to USD']).toBeDefined()
    expect(s.tests.find((t) => t.name === "round trips")?.property).toBe(true)
    expect(s.assertingHelpers).toEqual(["expectRate"])
  })

  test("lists what tests nothing and what repeats another in the same describe", () => {
    const r = pruneCandidates([{ path: "src/fx.test.ts", survey: typescriptSurveyor.survey("src/fx.test.ts", FILE) }])
    expect(r.testsNothing.map((c) => c.name)).toEqual(["runs without checking", "can't fail"])
    expect(r.duplicates).toEqual([{ path: "src/fx.test.ts", tests: [{ name: "GBP to USD", line: 16 }, { name: "pounds to dollars", line: 21 }] }])
  })
})

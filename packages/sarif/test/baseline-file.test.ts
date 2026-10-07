import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { type Baseline, decodeBaseline, emptyBaseline, encodeBaseline, fingerprint, type Metric, type Result, updateBaseline } from "../src/index.ts"

const pct = (value: number): Metric => ({ value, unit: "%", higherIsBetter: true })
const file = "class A {\n  val d: Double = 1.0\n  val e: Double = 2.0\n}"
const at = (line: number): Result =>
  fingerprint([{
    ruleId: "money/float",
    message: { text: "float" },
    locations: [{ physicalLocation: { artifactLocation: { uri: "A.kt" }, region: { startLine: line } } }],
  }], () => file.split("\n"))[0]!

const sample: Baseline = {
  ...emptyBaseline("abc123", "f".repeat(64), "0.0.0"),
  metrics: { mutation: pct(80) },
  legacy: [{ tool: "detekt", id: "MagicNumber:A.kt$A$1.0" }],
  results: { detekt: [at(2)] },
}

describe("baseline.sarif", () => {
  test("round-trips", () => {
    expect(Effect.runSync(decodeBaseline(encodeBaseline(sample))) as Baseline).toEqual(sample)
  })

  test("encodes byte-for-byte the same regardless of input order", () => {
    const shuffled: Baseline = { ...sample, results: { detekt: [at(3), at(2)] } }
    const ordered: Baseline = { ...sample, results: { detekt: [at(2), at(3)] } }
    expect(encodeBaseline(shuffled)).toBe(encodeBaseline(ordered))
    expect(encodeBaseline(sample).endsWith("\n")).toBe(true)
  })

  test("is valid SARIF 2.1.0 with the gauntlet run first", () => {
    const log = JSON.parse(encodeBaseline(sample))
    expect(log.version).toBe("2.1.0")
    expect(log.runs[0].tool.driver.name).toBe("gauntlet")
    expect(log.runs[1].results[0].baselineState).toBeUndefined()
  })

  test("a file without the gauntlet run is BaselineInvalid", () => {
    const exit = Effect.runSyncExit(decodeBaseline(`{"version":"2.1.0","runs":[]}`))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("updateBaseline", () => {
  const request = { commit: "def456", irHash: "e".repeat(64), gauntletVersion: "0.0.1", testIds: ["a.B.c"] }

  test("fixed findings leave and better metrics are taken", () => {
    const out = updateBaseline(sample, { ...request, metrics: { mutation: pct(85) }, results: { detekt: [] }, allowLower: false })
    expect(out.lowers).toBe(false)
    expect(out.fixed).toHaveLength(1)
    expect(out.baseline.results.detekt).toEqual([])
    expect(out.baseline.metrics.mutation?.value).toBe(85)
    expect(out.baseline.commit).toBe("def456")
  })

  test("new findings and worse metrics are refused without allowLower", () => {
    const out = updateBaseline(sample, { ...request, metrics: { mutation: pct(70) }, results: { detekt: [at(2), at(3)] }, allowLower: false })
    expect(out.lowers).toBe(true)
    expect(out.newlyGrandfathered).toHaveLength(1)
    expect(out.baseline.results.detekt).toHaveLength(1)
    expect(out.baseline.metrics.mutation?.value).toBe(80)
  })

  test("allowLower applies them and still reports them", () => {
    const out = updateBaseline(sample, { ...request, metrics: { mutation: pct(70) }, results: { detekt: [at(2), at(3)] }, allowLower: true })
    expect(out.lowers).toBe(true)
    expect(out.baseline.results.detekt).toHaveLength(2)
    expect(out.baseline.metrics.mutation?.value).toBe(70)
  })

  test("a tool not recorded this time keeps its grandfathered findings", () => {
    const out = updateBaseline(sample, { ...request, metrics: {}, results: {}, allowLower: false })
    expect(out.baseline.results.detekt).toHaveLength(1)
    expect(out.baseline.legacy).toEqual(sample.legacy)
  })
})

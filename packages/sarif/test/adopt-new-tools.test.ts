import { describe, expect, test } from "bun:test"
import { type Baseline, emptyBaseline, fingerprint, type Result, updateBaseline } from "../src/index.ts"

// A policy that gains a gate starts that gate from the project's existing
// findings; a gate the baseline already had still can't gain new ones quietly.

const file = "class A {\n  val d: Double = 1.0\n  val e: Double = 2.0\n}"
const at = (line: number, rule = "money/float"): Result =>
  fingerprint([{ ruleId: rule, message: { text: "x" }, locations: [{ physicalLocation: { artifactLocation: { uri: "A.kt" }, region: { startLine: line } } }] }], () => file.split("\n"))[0]!
const old: Baseline = { ...emptyBaseline("abc", "f".repeat(64), "0.0.0"), results: { detekt: [at(2)] } }
const request = { commit: "def", irHash: "e".repeat(64), gauntletVersion: "0.0.1", testIds: [], metrics: {}, allowLower: false }

describe("adopting new gates", () => {
  test("a tool the old baseline never recorded starts from its findings, without lowering", () => {
    const out = updateBaseline(old, { ...request, results: { detekt: [at(2)], biome: [at(3, "style/x")] }, adoptNewTools: true })
    expect(out.lowers).toBe(false)
    expect(out.baseline.results.biome).toHaveLength(1)
  })

  test("a new finding from a tool already recorded still counts as lowering", () => {
    const out = updateBaseline(old, { ...request, results: { detekt: [at(2), at(3)] }, adoptNewTools: true })
    expect(out.lowers).toBe(true)
    expect(out.newlyGrandfathered).toHaveLength(1)
  })

  test("without the option, a new tool's findings lower the baseline as before", () => {
    expect(updateBaseline(old, { ...request, results: { detekt: [at(2)], biome: [at(3, "style/x")] } }).lowers).toBe(true)
  })
})

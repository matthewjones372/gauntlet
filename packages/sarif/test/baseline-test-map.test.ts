import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { type Baseline, decodeBaseline, emptyBaseline, encodeBaseline, updateBaseline } from "../src/index.ts"

// The map of what each test class executed, recorded on trunk next to testIds (spec 0013).

const withMap: Baseline = {
  ...emptyBaseline("abc123", "f".repeat(64), "0.0.0"),
  testIds: ["svc.MoneyTest.adds"],
  testMap: { "svc.MoneyTest": ["src/test/kotlin/svc/MoneyTest.kt", "src/main/kotlin/svc/Money.kt"], "svc.FxTest": ["src/main/kotlin/svc/Money.kt"] },
}

describe("the baseline's test map", () => {
  test("round-trips, each class's files in order", () => {
    const back = Effect.runSync(decodeBaseline(encodeBaseline(withMap)))
    expect(back.testMap).toEqual({ "svc.FxTest": ["src/main/kotlin/svc/Money.kt"], "svc.MoneyTest": ["src/main/kotlin/svc/Money.kt", "src/test/kotlin/svc/MoneyTest.kt"] })
  })

  test("names each file once", () => {
    const meta = JSON.parse(encodeBaseline(withMap)).runs[0].properties.gauntlet
    expect(meta.testMap.files).toEqual(["src/main/kotlin/svc/Money.kt", "src/test/kotlin/svc/MoneyTest.kt"])
    expect(meta.testMap.tests).toEqual({ "svc.FxTest": [0], "svc.MoneyTest": [0, 1] })
  })

  test("a baseline without one encodes as before and reads back without one", () => {
    const plain = emptyBaseline("abc123", "f".repeat(64), "0.0.0")
    expect(encodeBaseline(plain)).not.toContain("testMap")
    expect("testMap" in Effect.runSync(decodeBaseline(encodeBaseline(plain)))).toBe(false)
  })

  test("an update keeps only the map recorded with it: an older one describes another commit", () => {
    const request = { commit: "def456", irHash: "f".repeat(64), gauntletVersion: "0.0.0", metrics: {}, results: {}, testIds: [], allowLower: false }
    expect("testMap" in updateBaseline(withMap, request).baseline).toBe(false)
    expect(updateBaseline(withMap, { ...request, testMap: { "svc.A": ["a.kt"] } }).baseline.testMap).toEqual({ "svc.A": ["a.kt"] })
  })
})

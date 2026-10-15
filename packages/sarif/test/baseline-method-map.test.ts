import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { type Baseline, decodeBaseline, emptyBaseline, encodeBaseline, mergeMethodMaps, methodKey, methodOf, renameMethodMap, updateBaseline } from "../src/index.ts"

// The test map's methods (spec 0017 §1): per test, the methods it executed,
// recorded on trunk so a test removed with its code can be told apart.

const FX = "src/main/kotlin/svc/Fx.kt"
const MONEY = "src/main/kotlin/svc/Money.kt"

const withMethods: Baseline = {
  ...emptyBaseline("abc123", "f".repeat(64), "0.0.0"),
  testIds: ["svc.FxTest.rounds"],
  methodMap: { "svc.FxTest.rounds": [methodKey(MONEY, "Money.plus"), methodKey(FX, "Fx.fee")], "svc.MoneyTest.adds": [methodKey(MONEY, "Money.plus")] },
}

describe("a method's key", () => {
  test("names its file and its name, and reads back", () => {
    expect(methodKey(FX, "Fx.fee")).toBe("src/main/kotlin/svc/Fx.kt#Fx.fee")
    expect(methodOf("src/main/kotlin/svc/Fx.kt#Fx.fee")).toEqual({ path: FX, name: "Fx.fee" })
    expect(methodOf("no-name")).toEqual({ path: "no-name", name: "" })
  })
})

describe("the baseline's method map", () => {
  test("round-trips, each test's methods in order", () => {
    const back = Effect.runSync(decodeBaseline(encodeBaseline(withMethods)))
    expect(back.methodMap).toEqual({ "svc.FxTest.rounds": [`${FX}#Fx.fee`, `${MONEY}#Money.plus`], "svc.MoneyTest.adds": [`${MONEY}#Money.plus`] })
  })

  test("names each method once, and tests' methods by index", () => {
    const meta = JSON.parse(encodeBaseline(withMethods)).runs[0].properties.gauntlet
    expect(meta.methodMap.methods).toEqual([`${FX}#Fx.fee`, `${MONEY}#Money.plus`])
    expect(meta.methodMap.tests).toEqual({ "svc.FxTest.rounds": [0, 1], "svc.MoneyTest.adds": [1] })
  })

  test("a baseline recorded before it reads back without one", () => {
    const old = encodeBaseline(emptyBaseline("abc123", "f".repeat(64), "0.0.0"))
    expect(old).not.toContain("methodMap")
    expect("methodMap" in Effect.runSync(decodeBaseline(old))).toBe(false)
  })

  test("an update keeps only the methods recorded with it", () => {
    const request = { commit: "def456", irHash: "f".repeat(64), gauntletVersion: "0.0.0", metrics: {}, results: {}, testIds: [], allowLower: false }
    expect("methodMap" in updateBaseline(withMethods, request).baseline).toBe(false)
    expect(updateBaseline(withMethods, { ...request, methodMap: { "svc.A": ["a.kt#A.b"] } }).baseline.methodMap).toEqual({ "svc.A": ["a.kt#A.b"] })
  })
})

describe("merging and renaming method maps", () => {
  test("a test in several maps ran every method any of them records", () => {
    expect(mergeMethodMaps([{ "svc.B": ["b#B.x"], "svc.A": ["a#A.y"] }, { "svc.A": ["a#A.x", "a#A.y"] }])).toEqual({ "svc.A": ["a#A.x", "a#A.y"], "svc.B": ["b#B.x"] })
  })

  test("a build's paths and test names take its folder", () => {
    const map = { "svc.A": ["src/A.kt#A.x"] }
    expect(renameMethodMap(map, { path: (p) => `app/${p}`, test: (t) => `app:${t}` })).toEqual({ "app:svc.A": ["app/src/A.kt#A.x"] })
    expect(renameMethodMap(map, {})).toEqual(map)
  })
})

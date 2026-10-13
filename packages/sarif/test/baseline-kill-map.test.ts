import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { type Baseline, decodeBaseline, emptyBaseline, encodeBaseline, type KillMap, mergeKillMaps, renameKillMap, updateBaseline } from "../src/index.ts"

// Which tests killed which mutants, recorded on trunk (spec 0016).

const map: KillMap = {
  mutants: [{ path: "src/main/kotlin/svc/Fx.kt", line: 3 }, { path: "src/main/kotlin/svc/Fx.kt", line: 7 }],
  tests: { "svc.FxTest.rounds": { killed: [0, 1], reached: 2 }, "svc.FxTest.runs": { killed: [], reached: 1 } },
}
const withMap: Baseline = { ...emptyBaseline("abc123", "f".repeat(64), "0.0.0"), killMap: map }

describe("the baseline's kill map", () => {
  test("round-trips", () => {
    expect(Effect.runSync(decodeBaseline(encodeBaseline(withMap))).killMap).toEqual(map)
  })

  test("a baseline without one encodes as before and reads back without one", () => {
    const plain = emptyBaseline("abc123", "f".repeat(64), "0.0.0")
    expect(encodeBaseline(plain)).not.toContain("killMap")
    expect("killMap" in Effect.runSync(decodeBaseline(encodeBaseline(plain)))).toBe(false)
  })

  test("an update keeps only the map recorded with it", () => {
    const request = { commit: "def456", irHash: "f".repeat(64), gauntletVersion: "0.0.0", metrics: {}, results: {}, testIds: [], allowLower: false }
    expect("killMap" in updateBaseline(withMap, request).baseline).toBe(false)
    const fresh: KillMap = { mutants: [{ path: "a.kt", line: 1 }], tests: { "svc.A": { killed: [0], reached: 1 } } }
    expect(updateBaseline(withMap, { ...request, killMap: fresh }).baseline.killMap).toEqual(fresh)
  })
})

describe("mergeKillMaps", () => {
  test("keeps each map's mutants apart and adds up a test that's in both", () => {
    const other: KillMap = { mutants: [{ path: "src/main/kotlin/svc/Fx.kt", line: 3 }], tests: { "svc.FxTest.rounds": { killed: [0], reached: 1 }, "svc.B": { killed: [0], reached: 1 } } }
    expect(mergeKillMaps([map, other])).toEqual({
      mutants: [...map.mutants, ...other.mutants],
      tests: { "svc.FxTest.rounds": { killed: [0, 1, 2], reached: 3 }, "svc.FxTest.runs": { killed: [], reached: 1 }, "svc.B": { killed: [2], reached: 1 } },
    })
    expect(mergeKillMaps([])).toEqual({ mutants: [], tests: {} })
  })
})

describe("renameKillMap", () => {
  test("rewrites paths and test names, either or both", () => {
    const both = renameKillMap(map, { path: (p) => `bank/${p}`, test: (t) => `bank:${t}` })
    expect(both.mutants[0]).toEqual({ path: "bank/src/main/kotlin/svc/Fx.kt", line: 3 })
    expect(Object.keys(both.tests)).toEqual(["bank:svc.FxTest.rounds", "bank:svc.FxTest.runs"])
    expect(renameKillMap(map, {})).toEqual(map)
  })
})

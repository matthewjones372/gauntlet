import { describe, expect, test } from "bun:test"
import { calls, go, pack, ran, suite } from "./affected-runner.ts"

// Recording a baseline asks an affected suite's pack for its map of what each
// test class executes (spec 0013), named as the baseline names tests.

describe("recording the test map", () => {
  test("a baseline asks the pack for its map", async () => {
    const o = await go(pack(suite((s) => ({ ...ran(["svc.FxTest.converts"]), ...(s ? {} : { testMap: { "svc.FxTest": ["src/main/kotlin/svc/Fx.kt"] } }) }))), { recording: true })
    expect(calls[0]!.ctx.recordTestMap).toBe(true)
    expect(calls[0]!.subset).toBeUndefined()
    expect(o.testMap).toEqual({ "svc.FxTest": ["src/main/kotlin/svc/Fx.kt"] })
  })

  test("a check doesn't ask for one", async () => {
    const o = await go(pack(suite(() => ran(["svc.FxTest.converts"]))))
    expect(calls[0]!.ctx.recordTestMap).toBeUndefined()
    expect(o.testMap).toBeUndefined()
  })

  test("with build folders, the map's classes and paths are named from the repository's root", async () => {
    const o = await go(pack(suite(() => ({ ...ran(["svc.FxTest.converts"]), testMap: { "svc.FxTest": ["src/main/kotlin/svc/Fx.kt"] } }))), { recording: true, use: `use jvm in "bank"`, changed: "bank/src/main/kotlin/svc/Fx.kt" })
    expect(o.testMap).toEqual({ "bank:svc.FxTest": ["bank/src/main/kotlin/svc/Fx.kt"] })
  })

  test("why a build recorded no map is kept, named with its build", async () => {
    const o = await go(pack(suite(() => ({ ...ran(["svc.FxTest.converts"]), testMapMissing: "test classes ran at the same time" }))), { recording: true, use: `use jvm in "bank"`, changed: "bank/src/main/kotlin/svc/Fx.kt" })
    expect(o.testMap).toBeUndefined()
    expect(o.testMapMissing).toEqual(["bank: test classes ran at the same time"])
    const single = await go(pack(suite(() => ({ ...ran(["svc.FxTest.converts"]), testMapMissing: "the listener couldn't read JaCoCo's data" }))), { recording: true })
    expect(single.testMapMissing).toEqual(["the listener couldn't read JaCoCo's data"])
  })
})

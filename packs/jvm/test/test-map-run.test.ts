import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { runSuite } from "../src/gates.ts"
import { LISTENER_CLASS } from "../src/testmap-listener.ts"
import { execFile } from "./exec-file.ts"
import { gradle } from "./fake-gradle.ts"

// Recording the JVM test map (spec 0013): a baseline runs the suite once more
// to map what each test class executes.

const unit = { name: "unit", location: "src/test/**" }

describe("recording the JVM test map", () => {
  test("a baseline runs the suite again with the listener and JaCoCo, apart from the suite's reports, and maps each class", async () => {
    const g = gradle()
    const r = await g.run(runSuite(unit, { ...g.ctx, recordTestMap: true }))
    expect(r.tests?.ids).toEqual(["svc.FxTest.converts", "svc.MoneyTest.adds"])
    expect(r.testMap).toEqual({
      "svc.FxTest": ["src/main/kotlin/svc/Fx.kt", "src/test/kotlin/svc/FxTest.kt"],
      "svc.MoneyTest": ["src/main/kotlin/svc/Money.kt", "src/test/kotlin/svc/MoneyTest.kt"],
    })
    const mapping = g.calls[1]!
    expect(mapping.args.slice(-1)).toEqual(["test"])
    expect(mapping.env?.GAUNTLET_OUT).toBe(`${g.out}-testmap`)
    expect(mapping.env?.GAUNTLET_TEST_MAP_INCLUDES).toBe("svc.*")
    const listener = mapping.env!.GAUNTLET_TEST_MAP!
    expect(readFileSync(join(listener, "META-INF/services/org.junit.platform.launcher.TestExecutionListener"), "utf8").trim()).toBe(LISTENER_CLASS)
    expect(existsSync(join(listener, "gauntlet/TestMapListener.class"))).toBe(true)
    // The suite's own proof stays its own run's.
    expect(readdirSync(g.out, { recursive: true }).some((p) => String(p).includes("testmap"))).toBe(false)
  })

  test("no map when classes ran at once, the listener failed, or a test class that ran has no data", async () => {
    for (const g of [gradle(undefined, { overlap: "a and b" }), gradle(undefined, { failed: "no JaCoCo" }), gradle({ "svc.FxTest": execFile([{ name: "svc/Fx", probes: [true] }]) })]) {
      const r = await g.run(runSuite(unit, { ...g.ctx, recordTestMap: true }))
      expect(r.tests?.ids).toHaveLength(2)
      expect(r.testMap).toBeUndefined()
    }
  })

  test("without a map, it says why", async () => {
    const cases: Array<[ReturnType<typeof gradle>, string]> = [
      [gradle(undefined, { overlap: "svc.FxTest and svc.MoneyTest" }), "test classes ran at the same time (svc.FxTest and svc.MoneyTest)"],
      [gradle(undefined, { failed: "javax.management.InstanceNotFoundException: org.jacoco:type=Runtime" }), "the listener couldn't read JaCoCo's data (javax.management.InstanceNotFoundException: org.jacoco:type=Runtime)"],
      [gradle({ "svc.FxTest": execFile([{ name: "svc/Fx", probes: [true] }]) }), "1 test the suite ran has no data, such as svc.MoneyTest.adds"],
      [gradle({ "svc.FxTest": new Uint8Array([1, 2, 3]), "svc.MoneyTest": execFile([{ name: "svc/Money", probes: [true] }]) }), "JaCoCo's data couldn't be read"],
    ]
    for (const [g, why] of cases) {
      const r = await g.run(runSuite(unit, { ...g.ctx, recordTestMap: true }))
      expect(r.testMap).toBeUndefined()
      expect(r.testMapMissing).toContain(why)
    }
  })
})

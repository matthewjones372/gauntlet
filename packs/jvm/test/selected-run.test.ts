import { describe, expect, test } from "bun:test"
import { runSuite } from "../src/gates.ts"
import { gradle } from "./fake-gradle.ts"

// A check of an affected JVM suite (spec 0013) runs the selected test classes.

const unit = { name: "unit", location: "src/test/**" }

describe("a selected JVM run", () => {
  test("a check runs the selected classes and new test files, in the usual order, measuring coverage when asked", async () => {
    const g = gradle()
    await g.run(runSuite(unit, { ...g.ctx, withCoverage: true }, { files: ["src/test/kotlin/svc/NewTest.kt"], ids: [], seed: 7, classes: ["svc.FxTest"], affected: true }))
    const call = g.calls[0]!
    expect(call.args.slice(-6)).toEqual(["test", "--tests", "svc.FxTest", "--tests", "svc.NewTest", "gauntletCoverage"])
    expect(call.env?.GAUNTLET_SELECTED).toBe("1")
    expect(call.env?.GAUNTLET_JUNIT_SEED).toBeUndefined()
    expect(g.calls).toHaveLength(1)
  })
})

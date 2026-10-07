import { describe, expect, test } from "bun:test"
import { fakeGate } from "../../../packages/core/test/fake-gate.ts"
import { runSuite, testClasses } from "../src/gates.ts"

describe("JVM reruns", () => {
  test("test ids and files become test classes", () => {
    expect(testClasses({ files: ["src/test/kotlin/svc/FxTest.kt", "app/src/test/java/a/BTest.java"], ids: ["svc.MoneyTest.adds", "svc.Outer$Inner.x"], seed: 1 })).toEqual(["a.BTest", "svc.FxTest", "svc.MoneyTest", "svc.Outer"])
  })

  test("Gradle reruns the classes, and the init script gets the seed for JUnit's random order", async () => {
    const g = fakeGate({ gradlew: "#!/bin/sh\n" })
    await g.run(runSuite({ name: "unit", location: "src/test/**" }, g.ctx, { files: [], ids: ["svc.MoneyTest.adds"], seed: 5 }))
    const call = g.calls.at(-1)!
    expect(call.args.slice(-3)).toEqual(["test", "--tests", "svc.MoneyTest"])
    expect(call.env?.GAUNTLET_JUNIT_SEED).toBe("5")
    expect((await g.run(runSuite({ name: "unit", location: "src/test/**" }, g.ctx, { files: ["README.md"], ids: [], seed: 5 }))).error).toBe("no test classes to run again")
  })
})

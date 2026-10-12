import { describe, expect, test } from "bun:test"
import type { Selection } from "../src/index.ts"
import { calls, go, pack, ran, suite } from "./affected-runner.ts"

// An affected suite in a check (spec 0013): the selected test classes and new
// test files run as a subset of the suite's own run.

const some: Selection = { kind: "some", classes: ["svc.FxTest"], files: ["src/test/kotlin/svc/NewTest.kt"], deselected: ["svc.ClusterSpec", "svc.MoneyTest"] }
const selections = (dir: string, s: Selection) => ({ selections: new Map([["unit", new Map([[dir, s]])]]) })

describe("an affected suite in a check", () => {
  test("runs the selected classes and new test files as the suite's own run", async () => {
    await go(pack(suite(() => ran(["svc.FxTest.converts", "svc.NewTest.works"]))), { input: selections(".", some) })
    expect(calls[0]!.subset).toEqual({ files: ["src/test/kotlin/svc/NewTest.kt"], ids: [], seed: 0, classes: ["svc.FxTest"], affected: true })
  })

  test("runs everything when its selection says so", async () => {
    await go(pack(suite(() => ran(["svc.FxTest.converts"]))), { input: selections(".", { kind: "all", reason: "the change touches build.gradle.kts, the build's configuration" }) })
    expect(calls[0]!.subset).toBeUndefined()
  })

  test("a baseline ignores selections: it runs everything and records the map", async () => {
    await go(pack(suite(() => ran(["svc.FxTest.converts"]))), { recording: true, input: selections(".", some) })
    expect(calls[0]!.subset).toBeUndefined()
    expect(calls[0]!.ctx.recordTestMap).toBe(true)
  })

  test("with build folders, a subset's files are named from the build's folder", async () => {
    await go(pack(suite(() => ran(["svc.FxTest.converts"]))), {
      use: `use jvm in "bank"`,
      changed: "bank/src/main/kotlin/svc/Fx.kt",
      input: selections("bank", { ...some, files: ["bank/src/test/kotlin/svc/NewTest.kt"], deselected: ["bank:svc.MoneyTest"] }),
    })
    expect(calls[0]!.subset).toMatchObject({ files: ["src/test/kotlin/svc/NewTest.kt"], classes: ["svc.FxTest"], affected: true })
  })
})

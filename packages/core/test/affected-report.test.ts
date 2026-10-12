import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { emptyBaseline } from "@gauntlet/sarif"
import { Schema } from "effect"
import { renderMarkdown, Report, type Selection } from "../src/index.ts"
import { go, pack, ran, suite } from "./affected-runner.ts"

// The report of an affected suite (spec 0013) says how many tests ran of how
// many, why the rest didn't (or why all did), and which classes were left out.

const selections = (dir: string, s: Selection) => ({ selections: new Map([["unit", new Map([[dir, s]])]]) })
const some: Selection = { kind: "some", classes: ["svc.FxTest"], files: ["src/test/kotlin/svc/NewTest.kt"], deselected: ["svc.ClusterSpec", "svc.MoneyTest"] }

describe("an affected suite's record", () => {
  test("how many ran of how many: the base's tests of the classes left out make up the rest", async () => {
    const baseline = { ...emptyBaseline("m", "h", "0"), testIds: ["svc.FxTest.converts", "svc.MoneyTest.adds", "svc.MoneyTest.subtracts", "svc.ClusterSpec.starts"] }
    const o = await go(pack(suite(() => ran(["svc.FxTest.converts", "svc.NewTest.works"]))), { input: selections(".", some), baseline })
    expect(o.checks[0]).toMatchObject({
      status: "passed",
      selection: { ran: 2, of: 5, why: ["ran 1 test class that executed what the change touches, and 1 new test file; 2 test classes didn't need to run"], deselected: ["svc.ClusterSpec", "svc.MoneyTest"] },
    })
  })

  test("why every test ran", async () => {
    const o = await go(pack(suite(() => ran(["svc.FxTest.converts"]))), { input: selections(".", { kind: "all", reason: "the change touches build.gradle.kts, the build's configuration" }) })
    expect(o.checks[0]).toMatchObject({ selection: { ran: 1, of: 1, why: ["every test ran: the change touches build.gradle.kts, the build's configuration"] } })
  })

  test("only new test files, or nothing left out", async () => {
    const onlyNew: Selection = { kind: "some", classes: [], files: ["src/test/kotlin/svc/NewTest.kt"], deselected: ["svc.FxTest"] }
    expect((await go(pack(suite(() => ran(["svc.NewTest.works"]))), { input: selections(".", onlyNew) })).checks[0]!.selection?.why)
      .toEqual(["ran 1 new test file; 1 test class didn't need to run"])
    const everyClass: Selection = { kind: "some", classes: ["svc.FxTest", "svc.MoneyTest"], files: [], deselected: [] }
    expect((await go(pack(suite(() => ran(["svc.FxTest.converts"]))), { input: selections(".", everyClass) })).checks[0]!.selection?.why)
      .toEqual(["ran 2 test classes that executed what the change touches; none could be left out"])
  })

  test("with build folders, each build's reason names its folder", async () => {
    const o = await go(pack(suite(() => ran(["svc.FxTest.converts"]))), {
      use: `use jvm in "bank"`,
      changed: "bank/src/main/kotlin/svc/Fx.kt",
      input: selections("bank", { ...some, files: ["bank/src/test/kotlin/svc/NewTest.kt"], deselected: ["bank:svc.MoneyTest"] }),
    })
    expect(o.checks[0]!.selection?.why).toEqual(["bank: ran 1 test class that executed what the change touches, and 1 new test file; 1 test class didn't need to run"])
  })
})

describe("the report of an affected suite", () => {
  test("says how many tests ran of how many, and why", () => {
    const golden = JSON.parse(readFileSync(join(import.meta.dir, "golden", "clean-auto.report.json"), "utf8")) as Report
    const suiteAt = golden.checks.findIndex((c) => c.tests !== undefined)
    const checks = golden.checks.map((c, i) => (i === suiteAt ? { ...c, selection: { ran: 2, of: 5, why: ["ran 1 test class that executed what the change touches; 2 test classes didn't need to run"], deselected: ["svc.MoneyTest"] } } : c))
    const report = { ...golden, checks }
    expect(Schema.decodeUnknownSync(Report)(report).checks[suiteAt]!.selection?.of).toBe(5)
    expect(renderMarkdown(report)).toContain("2 of 5 tests (ran 1 test class that executed what the change touches; 2 test classes didn't need to run)")
  })
})

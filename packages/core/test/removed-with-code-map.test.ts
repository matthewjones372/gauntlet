import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { methodKey } from "@gauntlet/sarif"
import { Effect, Layer, Option } from "effect"
import { jvm } from "../../dsl/test/fixtures/catalog.ts"
import { describeRemoval, type GateRun, type IntegrityInput, judgeRemovedTests, mergeBuildRuns, methodMapOf, type Mutant, mutationGateRun, type Pack, type PreparedWorkspace, ProcessRunnerLive, runFromBuild, runGates, runIntegrity, stillDeclared, testPathMatcher } from "../src/index.ts"
import { compiled, noFacts } from "./fixtures.ts"

// Spec 0017 §1: a test goes with its code when the map of the methods each
// test executed at base says it only tested code the change removes. Without
// the map, or for a test it doesn't name, a test file named after a deleted
// source file is the fallback.

const FX = "src/main/kotlin/svc/Fx.kt"
const MONEY = "src/main/kotlin/svc/Money.kt"
const fee = methodKey(FX, "Fx.fee")
const convert = methodKey(FX, "Fx.convert")
const plus = methodKey(MONEY, "Money.plus")

describe("whether a method is still there at head", () => {
  test("its name as a word in the file's text", () => {
    expect(stillDeclared("fun fee(x: Int) = x", "Fx.fee")).toBe(true)
    expect(stillDeclared("fun feeRounded(x: Int) = x", "Fx.fee")).toBe(false)
    expect(stillDeclared("val \\$fee = 1", "Fx.$fee")).toBe(true)
  })

  test("a file that's gone has nothing", () => {
    expect(stillDeclared(undefined, "Fx.fee")).toBe(false)
  })

  test("a constructor stays while its class does, and an accessor while its property does", () => {
    expect(stillDeclared("class Fx(val rate: Int)", "Fx.<init>")).toBe(true)
    expect(stillDeclared("class Money", "Fx.<init>")).toBe(false)
    expect(stillDeclared("", "<clinit>")).toBe(true)
    expect(stillDeclared("class Fx(val rate: Int)", "Fx.getRate")).toBe(true)
    expect(stillDeclared("class Fx(var open: Boolean)", "Fx.isOpen")).toBe(true)
    expect(stillDeclared("class Fx", "Fx.getRate")).toBe(false)
  })

  test("a name it can't read is kept, so doubt never lets a test go", () => {
    expect(stillDeclared("class Fx", "Fx.rounds up")).toBe(true)
    expect(stillDeclared("class Fx", "Fx.")).toBe(true)
  })
})

describe("judging the tests that no longer run", () => {
  const map = {
    "svc.FxTest.feeRoundsUp": [fee],
    "svc.FxTest.converts": [convert, plus],
    "svc.FxTest.feeAndPlus": [fee, plus],
    "svc.MoneyTest.adds": [plus],
  }
  const removing = (...keys: string[]) => (key: string) => keys.includes(key)

  test("a test that only ran removed code went with it", () => {
    expect(judgeRemovedTests(["svc.FxTest.feeRoundsUp"], map, removing(fee)).get("svc.FxTest.feeRoundsUp")).toEqual({ kind: "with-its-code", removed: ["Fx.fee"], kept: [] })
  })

  test("so did one whose other code tests that stay still run", () => {
    expect(judgeRemovedTests(["svc.FxTest.feeAndPlus"], map, removing(fee)).get("svc.FxTest.feeAndPlus")).toEqual({ kind: "with-its-code", removed: ["Fx.fee"], kept: ["Money.plus"] })
  })

  test("the last test of code that stays didn't, however much else it ran is removed", () => {
    const v = judgeRemovedTests(["svc.FxTest.converts", "svc.FxTest.feeAndPlus", "svc.MoneyTest.adds"], map, removing(fee))
    expect(v.get("svc.FxTest.converts")).toEqual({ kind: "last-test", sole: ["Fx.convert", "Money.plus"] })
    expect(v.get("svc.FxTest.feeAndPlus")).toEqual({ kind: "last-test", sole: ["Money.plus"] })
  })

  test("a test whose code the change doesn't remove didn't", () => {
    expect(judgeRemovedTests(["svc.MoneyTest.adds"], map, removing(fee)).get("svc.MoneyTest.adds")).toEqual({ kind: "nothing-removed" })
  })

  test("a test is found under the name its runner gave it, and one the map doesn't name has no verdict", () => {
    const v = judgeRemovedTests(["svc.FxTest.feeRoundsUp()", "svc.OtherTest.runs"], map, removing(fee))
    expect(v.get("svc.FxTest.feeRoundsUp()")?.kind).toBe("with-its-code")
    expect(v.has("svc.OtherTest.runs")).toBe(false)
  })

  test("the report says why each qualified or didn't", () => {
    expect(describeRemoval("svc.FxTest.feeRoundsUp", { kind: "with-its-code", removed: ["Fx.fee"], kept: [] })).toBe("Test svc.FxTest.feeRoundsUp no longer runs: it only tested Fx.fee, which this change removes. Check the feature was meant to go.")
    expect(describeRemoval("svc.FxTest.feeAndPlus", { kind: "with-its-code", removed: ["Fx.fee"], kept: ["Money.plus"] })).toContain("it tested Fx.fee, which this change removes, and tests that still run cover the rest of what it ran (Money.plus)")
    expect(describeRemoval("svc.FxTest.converts", { kind: "last-test", sole: ["Fx.convert"] })).toBe("Test svc.FxTest.converts ran at base and no longer runs: it was the last test of Fx.convert, which stays.")
    expect(describeRemoval("svc.FxTest.converts", { kind: "last-test", sole: ["Fx.a", "Fx.b", "Fx.c", "Fx.d", "Fx.e", "Fx.f"] })).toContain("Fx.a, Fx.b, Fx.c, Fx.d, Fx.e and 1 more, which stay.")
    expect(describeRemoval("svc.MoneyTest.adds", { kind: "nothing-removed" })).toBe("Test svc.MoneyTest.adds ran at base and no longer runs, and this change removes none of the code it ran.")
  })
})

// Integrity, as a check runs it.
const { ir } = compiled(`gauntlet "svc"
use jvm
owners @platform
protect { tests "src/test/**" }
suites { unit "src/test/**" }
integrity { ratchet executed tests }
gates { verify { unit } }
`)
const FX_SOURCE = "class Fx {\n  fun convert(x: Int) = x\n}\n"
const input = (over: Partial<IntegrityInput> = {}, head: Record<string, string> = { [FX]: FX_SOURCE, [MONEY]: "class Money { fun plus() = 1 }" }): IntegrityInput => ({
  ir,
  facts: noFacts({ files: [{ path: FX, status: "modified", added: 0, removed: 3 }] }),
  readBase: () => Effect.succeed(Option.none()),
  readHead: (p) => Effect.succeed(Option.fromNullishOr(head[p])),
  isTestPath: testPathMatcher(ir),
  baselineMetrics: { "integrity/executed-tests": { value: 3, unit: "count", higherIsBetter: true } },
  headFiles: [],
  dir: "/nonexistent",
  baseTestIds: ["svc.FxTest.feeRoundsUp", "svc.FxTest.converts", "svc.MoneyTest.adds"],
  headTests: { counts: { executed: 2, passed: 2, failed: 0, errored: 0, skipped: 0 }, ids: ["svc.FxTest.converts", "svc.MoneyTest.adds"] },
  methodMap: { "svc.FxTest.feeRoundsUp": [fee], "svc.FxTest.converts": [convert, plus], "svc.MoneyTest.adds": [plus] },
  ...over,
})
const run = (i: IntegrityInput) => Effect.runSync(runIntegrity(i, []).pipe(Effect.provide(BunServices.layer)))
const deletedTests = (r: ReturnType<typeof run>) => r.findings.filter((f) => f.check === "deleted-tests" || f.check === "executed-tests").map((f) => `${f.kind} ${f.check}${f.path ? ` ${f.path}` : ""}: ${f.message}`)
const deleted = (path: string) => ({ path, status: "deleted" as const, added: 0, removed: 9 })

describe("tests removed with their code, by the map", () => {
  test("a test case removed from a file that stays, with the method it alone tested, is flagged and left out of the ratchet", () => {
    expect(deletedTests(run(input()))).toEqual([
      "flag deleted-tests: Test svc.FxTest.feeRoundsUp no longer runs: it only tested Fx.fee, which this change removes. Check the feature was meant to go.",
    ])
  })

  test("the last test of a method that stays is still forbidden, and counts against the ratchet", () => {
    const r = run(input({}, { [FX]: "class Fx {\n  fun fee() = 1\n  fun convert(x: Int) = x\n}\n", [MONEY]: "class Money { fun plus() = 1 }" }))
    expect(deletedTests(r)).toEqual([
      "forbid deleted-tests: Test svc.FxTest.feeRoundsUp ran at base and no longer runs: it was the last test of Fx.fee, which stays.",
      "ratchet executed-tests: executed tests went from 3 to 2; it may not get worse than the baseline.",
    ])
  })

  test("a test file deleted with its source file, whose tests were the last of code that stays, is forbidden whatever its name", () => {
    const r = run(input({
      facts: noFacts({ files: [deleted("src/test/kotlin/svc/FxTest.kt"), deleted(FX)] }),
      baseTestIds: ["svc.FxTest.feeRoundsUp", "svc.FxTest.converts", "svc.MoneyTest.adds"],
      headTests: { counts: { executed: 1, passed: 1, failed: 0, errored: 0, skipped: 0 }, ids: ["svc.MoneyTest.adds"] },
      methodMap: { "svc.FxTest.feeRoundsUp": [fee], "svc.FxTest.converts": [convert, plus], "svc.MoneyTest.adds": [methodKey(MONEY, "Money.minus")] },
    }))
    const found = deletedTests(r)
    expect(found).toContain("forbid deleted-tests src/test/kotlin/svc/FxTest.kt: Test file src/test/kotlin/svc/FxTest.kt was deleted. Test svc.FxTest.converts ran at base and no longer runs: it was the last test of Money.plus, which stays.")
    expect(found.filter((f) => f.startsWith("flag"))).toEqual([
      "flag deleted-tests: Test svc.FxTest.feeRoundsUp no longer runs: it only tested Fx.fee, which this change removes. Check the feature was meant to go.",
    ])
  })

  test("a test file whose every test went with its code is flagged, named for none of it", () => {
    const r = run(input({
      facts: noFacts({ files: [deleted("src/test/kotlin/svc/CheckoutFlowTest.kt"), deleted(FX)] }),
      baseTestIds: ["svc.CheckoutFlowTest.charges", "svc.MoneyTest.adds"],
      headTests: { counts: { executed: 1, passed: 1, failed: 0, errored: 0, skipped: 0 }, ids: ["svc.MoneyTest.adds"] },
      methodMap: { "svc.CheckoutFlowTest.charges": [fee, convert, plus], "svc.MoneyTest.adds": [plus] },
      baselineMetrics: { "integrity/executed-tests": { value: 2, unit: "count", higherIsBetter: true } },
    }))
    expect(deletedTests(r)).toEqual([
      "flag deleted-tests: Test svc.CheckoutFlowTest.charges no longer runs: it tested Fx.convert, Fx.fee, which this change removes, and tests that still run cover the rest of what it ran (Money.plus). Check the feature was meant to go.",
      "flag deleted-tests src/test/kotlin/svc/CheckoutFlowTest.kt: Test file src/test/kotlin/svc/CheckoutFlowTest.kt was removed along with the code its tests covered (Fx.convert, Fx.fee), and tests that still run cover the rest of what they ran. Check the feature was meant to go.",
    ])
  })

  test("a test the map doesn't name falls back to names", () => {
    const r = run(input({
      facts: noFacts({ files: [deleted("src/test/kotlin/svc/FxTest.kt"), deleted(FX)] }),
      baseTestIds: ["svc.FxTest.rounds", "svc.MoneyTest.adds"],
      headTests: { counts: { executed: 1, passed: 1, failed: 0, errored: 0, skipped: 0 }, ids: ["svc.MoneyTest.adds"] },
      baselineMetrics: { "integrity/executed-tests": { value: 2, unit: "count", higherIsBetter: true } },
    }))
    expect(deletedTests(r)).toEqual([
      "flag deleted-tests: Test svc.FxTest.rounds no longer runs: its test file was removed along with the code it tested.",
      `flag deleted-tests src/test/kotlin/svc/FxTest.kt: Test file src/test/kotlin/svc/FxTest.kt was removed along with ${FX}, the code it tested. Check the feature was meant to go.`,
    ])
  })

  test("without a map, as from a baseline recorded before it, names decide", () => {
    const { methodMap: _, ...noMap } = input()
    expect(deletedTests(run(noMap))).toEqual([
      "forbid deleted-tests: Test svc.FxTest.feeRoundsUp ran at base and no longer runs.",
      "ratchet executed-tests: executed tests went from 3 to 2; it may not get worse than the baseline.",
    ])
  })

  test("a renamed file is read at its new path", () => {
    const r = run(input({ facts: noFacts({ files: [{ path: "src/main/kotlin/svc/Rates.kt", oldPath: FX, status: "renamed", added: 0, removed: 0 }] }) }, { "src/main/kotlin/svc/Rates.kt": "class Fx { fun fee() = 1 }", [MONEY]: "class Money { fun plus() = 1 }" }))
    expect(deletedTests(r)[0]).toBe("forbid deleted-tests: Test svc.FxTest.feeRoundsUp ran at base and no longer runs: it was the last test of Fx.fee, which stays.")
  })

  test("no test that no longer runs, nothing to judge", () => {
    expect(deletedTests(run(input({ baseTestIds: ["svc.MoneyTest.adds"], baselineMetrics: {} })))).toEqual([])
  })
})

describe("the methods each test ran, from a mutation tool", () => {
  const m = (line: number, method: string | undefined, coveredBy: string[] | undefined, killedBy: string[] = []): Mutant => ({
    path: FX, line, killed: killedBy.length > 0, message: "a mutant",
    ...(method !== undefined ? { method } : {}), ...(coveredBy !== undefined ? { coveredBy, killedBy } : {}),
  })

  test("every test that reached a mutant ran its method, killers included", () => {
    expect(methodMapOf([m(3, "Fx.fee", ["svc.FxTest.rounds"], ["svc.FxTest.halves"]), m(7, "Fx.convert", ["svc.FxTest.rounds"]), m(9, "Fx.fee", [])])).toEqual({
      "svc.FxTest.halves": [fee],
      "svc.FxTest.rounds": [convert, fee],
    })
  })

  test("nothing when the tool names no method, no tests that reached it, or no file", () => {
    expect(methodMapOf([m(3, undefined, ["svc.A"])])).toBeUndefined()
    expect(methodMapOf([m(3, "Fx.fee", undefined)])).toBeUndefined()
    expect(methodMapOf([{ ...m(3, "Fx.fee", ["svc.A"]), path: undefined }])).toBeUndefined()
  })

  const mutants = [m(3, "Fx.fee", ["svc.FxTest.rounds"], ["svc.FxTest.rounds"])]
  const workspace: PreparedWorkspace = {
    dir: "/checkout", base: "b", head: "h", materialised: [],
    outputDir: (check) => Effect.succeed(`/out/${check}`),
    collect: () => Effect.succeed([{ path: "mutations.xml", content: "<mutations/>" }]),
  }
  const pitest: Pack = {
    spec: jvm, runnerConfig: [], manifests: [], detectors: [],
    gates: { mutation: (_check, ctx) => Effect.succeed({ command: ["pitest"], exitCode: 0, ...mutationGateRun("pitest", mutants, ctx) }) },
  }
  const record = (use = "use jvm", changed = FX) =>
    Effect.runPromise(runGates({
      ir: compiled(`gauntlet "x"\n${use}\nowners @p\ngates { verify { mutation >= 10% } }\n`).ir,
      facts: noFacts({ files: [{ path: changed, status: "modified", added: 1, removed: 0 }] }),
      workspace, packs: [pitest], baseline: Option.none(), renames: new Map(), files: [], recording: true,
    }).pipe(Effect.provide(Layer.mergeAll(ProcessRunnerLive.pipe(Layer.provide(BunServices.layer)), BunServices.layer))))

  test("a mutation gate hands them on through the gate runner", async () => {
    expect((await record()).methodMap).toEqual({ "svc.FxTest.rounds": [fee] })
  })

  test("with build folders, paths and tests are named from the repository's root", async () => {
    expect((await record(`use jvm in "bank"`, `bank/${FX}`)).methodMap).toEqual({ "bank:svc.FxTest.rounds": [`bank/${fee}`] })
  })

  test("several builds' maps are merged, and a build without one adds nothing", () => {
    const one = (methodMap?: GateRun["methodMap"]): GateRun => ({ command: ["pitest"], exitCode: 0, runs: [], ...(methodMap ? { methodMap } : {}) })
    expect(runFromBuild(one({ "svc.A": [fee] }), "bank").methodMap).toEqual({ "svc.A": [`bank/${fee}`] })
    expect(mergeBuildRuns([{ dir: "a", run: one({ "a:svc.A": [fee] }) }, { dir: "b", run: one({ "b:svc.B": [plus] }) }]).methodMap).toEqual({ "a:svc.A": [fee], "b:svc.B": [plus] })
    expect(mergeBuildRuns([{ dir: "a", run: one() }]).methodMap).toBeUndefined()
  })
})

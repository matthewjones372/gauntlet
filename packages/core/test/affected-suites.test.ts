import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { type Baseline, emptyBaseline } from "@gauntlet/sarif"
import { Effect, Layer, Option, Schema } from "effect"
import { jvm } from "../../dsl/test/fixtures/catalog.ts"
import { type GateContext, type GateRun, type Pack, type PreparedWorkspace, ProcessRunnerLive, renderMarkdown, Report, runGates, type Selection, type SuiteImpl, type TestSubset } from "../src/index.ts"
import { compiled, noFacts } from "./fixtures.ts"

// An affected suite (spec 0013): a check runs the selected test classes as a
// subset of the suite's own run, and a baseline asks the pack for its map.

const workspace: PreparedWorkspace = {
  dir: "/checkout",
  base: "b",
  head: "h",
  materialised: [],
  outputDir: (check) => Effect.succeed(`/out/${check}`),
  collect: () => Effect.succeed([{ path: "TEST-unit.xml", content: "<testsuite/>" }]),
}
const counts = (executed: number) => ({ executed, passed: executed, failed: 0, errored: 0, skipped: 0 })

const calls: Array<{ ctx: GateContext; subset?: TestSubset }> = []
const suite = (out: (subset?: TestSubset) => GateRun): SuiteImpl => (_s, ctx, subset) =>
  Effect.sync(() => {
    calls.push({ ctx, ...(subset ? { subset } : {}) })
    return out(subset)
  })
const pack = (runSuite: SuiteImpl): Pack => ({ spec: jvm, runnerConfig: [], manifests: [], detectors: [], gates: {}, runSuite, reruns: true, testMaps: true })

const policy = (use = "use jvm") => compiled(`gauntlet "x"
${use}
owners @p
suites {
  unit "**/src/test/**" affected
}
gates { verify { unit } }
`).ir

const go = (p: Pack, over: { selections?: ReadonlyMap<string, ReadonlyMap<string, Selection>>; recording?: boolean; baseline?: Baseline; use?: string; changed?: string } = {}) => {
  calls.length = 0
  return Effect.runPromise(
    runGates({
      ir: policy(over.use),
      facts: noFacts({ files: [{ path: over.changed ?? "src/main/kotlin/svc/Fx.kt", status: "modified", added: 1, removed: 0 }] }),
      workspace,
      packs: [p],
      baseline: over.baseline ? Option.some(over.baseline) : Option.none(),
      renames: new Map(),
      files: [],
      ...(over.recording ? { recording: true } : {}),
      ...(over.selections ? { selections: over.selections } : {}),
    }).pipe(Effect.provide(Layer.mergeAll(ProcessRunnerLive.pipe(Layer.provide(BunServices.layer)), BunServices.layer))),
  )
}

const some: Selection = { kind: "some", classes: ["svc.FxTest"], files: ["src/test/kotlin/svc/NewTest.kt"], deselected: ["svc.ClusterSpec", "svc.MoneyTest"] }
const ran = (ids: string[]): GateRun => ({ command: ["gradle"], exitCode: 0, runs: [], tests: { counts: counts(ids.length), ids } })

describe("an affected suite in a check", () => {
  test("runs the selected classes and new test files as the suite's own run, and says what it left out", async () => {
    const baseline = { ...emptyBaseline("m", "h", "0"), testIds: ["svc.FxTest.converts", "svc.MoneyTest.adds", "svc.MoneyTest.subtracts", "svc.ClusterSpec.starts"] }
    const o = await go(pack(suite(() => ran(["svc.FxTest.converts", "svc.NewTest.works"]))), { selections: new Map([["unit", new Map([[".", some]])]]), baseline })
    expect(calls[0]!.subset).toEqual({ files: ["src/test/kotlin/svc/NewTest.kt"], ids: [], seed: 0, classes: ["svc.FxTest"], affected: true })
    expect(o.checks[0]).toMatchObject({
      status: "passed",
      selection: { ran: 2, of: 5, why: ["ran 1 test class that executed what the change touches, and 1 new test file; 2 test classes didn't need to run"], deselected: ["svc.ClusterSpec", "svc.MoneyTest"] },
    })
    expect(o.deselected).toEqual(["svc.ClusterSpec", "svc.MoneyTest"])
  })

  test("runs everything when its selection says so, and says why", async () => {
    const o = await go(pack(suite(() => ran(["svc.FxTest.converts"]))), { selections: new Map([["unit", new Map([[".", { kind: "all", reason: "the change touches build.gradle.kts, the build's configuration" } as Selection]])]]) })
    expect(calls[0]!.subset).toBeUndefined()
    expect(o.checks[0]).toMatchObject({ selection: { ran: 1, of: 1, why: ["every test ran: the change touches build.gradle.kts, the build's configuration"] } })
    expect(o.deselected).toBeUndefined()
  })

  test("a baseline asks the pack for its map", async () => {
    const o = await go(pack(suite((s) => ({ ...ran(["svc.FxTest.converts"]), ...(s ? {} : { testMap: { "svc.FxTest": ["src/main/kotlin/svc/Fx.kt"] } }) }))), { recording: true, selections: new Map([["unit", new Map([[".", some]])]]) })
    expect(calls[0]!.ctx.recordTestMap).toBe(true)
    expect(calls[0]!.subset).toBeUndefined()
    expect(o.testMap).toEqual({ "svc.FxTest": ["src/main/kotlin/svc/Fx.kt"] })
  })

  test("with build folders, the map's classes and paths are named from the repository's root, and a subset's files from the build's", async () => {
    const o = await go(pack(suite(() => ({ ...ran(["svc.FxTest.converts"]), testMap: { "svc.FxTest": ["src/main/kotlin/svc/Fx.kt"] } }))), { recording: true, use: `use jvm in "bank"`, changed: "bank/src/main/kotlin/svc/Fx.kt" })
    expect(o.testMap).toEqual({ "bank:svc.FxTest": ["bank/src/main/kotlin/svc/Fx.kt"] })
    const selections = new Map([["unit", new Map([["bank", { ...some, files: ["bank/src/test/kotlin/svc/NewTest.kt"], deselected: ["bank:svc.MoneyTest"] } as Selection]])]])
    const checked = await go(pack(suite(() => ran(["svc.FxTest.converts"]))), { use: `use jvm in "bank"`, changed: "bank/src/main/kotlin/svc/Fx.kt", selections })
    expect(calls[0]!.subset).toMatchObject({ files: ["src/test/kotlin/svc/NewTest.kt"], classes: ["svc.FxTest"], affected: true })
    expect(checked.checks[0]!.selection?.why).toEqual(["bank: ran 1 test class that executed what the change touches, and 1 new test file; 1 test class didn't need to run"])
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

describe("how a selection reads", () => {
  test("only new test files, or nothing left out", async () => {
    const onlyNew: Selection = { kind: "some", classes: [], files: ["src/test/kotlin/svc/NewTest.kt"], deselected: ["svc.FxTest"] }
    expect((await go(pack(suite(() => ran(["svc.NewTest.works"]))), { selections: new Map([["unit", new Map([[".", onlyNew]])]]) })).checks[0]!.selection?.why)
      .toEqual(["ran 1 new test file; 1 test class didn't need to run"])
    const everyClass: Selection = { kind: "some", classes: ["svc.FxTest", "svc.MoneyTest"], files: [], deselected: [] }
    expect((await go(pack(suite(() => ran(["svc.FxTest.converts"]))), { selections: new Map([["unit", new Map([[".", everyClass]])]]) })).checks[0]!.selection?.why)
      .toEqual(["ran 2 test classes that executed what the change touches; none could be left out"])
  })
})

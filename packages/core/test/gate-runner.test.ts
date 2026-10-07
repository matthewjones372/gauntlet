import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { emptyBaseline, fingerprint, type Result, type Run } from "@gauntlet/sarif"
import { Effect, Layer, Option } from "effect"
import { jvm } from "../../dsl/test/fixtures/catalog.ts"
import { type GateImpl, type GateRun, type Pack, type PreparedWorkspace, ProcessRunnerLive, runGates, type SuiteImpl } from "../src/index.ts"
import { compiled, noFacts } from "./fixtures.ts"

// An in-memory workspace: each check's "output directory" is a map entry,
// and the fake gates "write" reports by returning them from `files`.
const fakeWorkspace = (files: Record<string, Record<string, string>>): PreparedWorkspace => ({
  dir: "/checkout",
  base: "b",
  head: "h",
  materialised: [],
  outputDir: (check) => Effect.succeed(`/out/${check}`),
  collect: (check) => {
    const name = Object.keys(files).find((k) => check.endsWith(`-${k}`))
    return Effect.succeed(name ? Object.entries(files[name]!).map(([path, content]) => ({ path, content })) : [])
  },
})

const run = (over: Partial<GateRun> = {}): GateRun => ({ command: ["tool"], exitCode: 0, runs: [], ...over })
const finding = (line: number): Result => ({ ruleId: "style/x", message: { text: "x" }, locations: [{ physicalLocation: { artifactLocation: { uri: "src/A.kt" }, region: { startLine: line } } }] })
const sarifRun = (results: Result[]): Run => ({ tool: { driver: { name: "lint-tool" } }, results })
const fileLines = ["class A {", "  val a = 1", "  val b = 2", "}"]

const pack = (gates: Record<string, GateImpl>, runSuite?: SuiteImpl): Pack => ({
  spec: jvm, runnerConfig: [], manifests: [], detectors: [], gates, ...(runSuite ? { runSuite } : {}),
})

const policy = (gates: string) => compiled(`gauntlet "x"
use jvm
owners @p
suites {
  unit "src/test/**"
  holdout "secret" ci only
}
gates { ${gates} }
`)

const go = (gates: string, p: Pack, files: Record<string, Record<string, string>> = {}, baseline = Option.none<ReturnType<typeof emptyBaseline>>()) =>
  Effect.runPromise(
    runGates({ ir: policy(gates).ir, facts: noFacts({ files: [{ path: "src/A.kt", status: "modified", added: 1, removed: 0 }] }), workspace: fakeWorkspace(files), packs: [p], baseline, renames: new Map(), files: [] })
      .pipe(Effect.provide(Layer.mergeAll(ProcessRunnerLive.pipe(Layer.provide(BunServices.layer)), BunServices.layer))),
  )

const statuses = (o: Awaited<ReturnType<typeof go>>) => o.checks.map((c) => `${c.check}:${c.status}${c.reason ? ` (${c.reason})` : ""}`)
const counts = (executed: number, failed = 0) => ({ executed, passed: executed - failed, failed, errored: 0, skipped: 0 })

describe("runGates", () => {
  test("tiers run in order and a failure stops the later tiers", async () => {
    const o = await go("fast { build } verify { unit }", pack({ build: () => Effect.succeed(run({ exitCode: 1 })) }, () => Effect.succeed(run())))
    expect(statuses(o)).toEqual(["build:failed (exited with 1)", "unit:not-executed (tier 'fast' failed, so later tiers didn't run)"])
  })

  test("a suite that ran no tests fails as a silent green", async () => {
    const o = await go("verify { unit }", pack({}, () => Effect.succeed(run({ tests: { counts: counts(0), ids: [] } }))), { unit: { "TEST-x.xml": "<testsuite/>" } })
    expect(statuses(o)).toEqual(["unit:failed (no tests ran (a silent green fails))"])
  })

  test("a suite that wrote no report fails, whatever it claims", async () => {
    const o = await go("verify { unit }", pack({}, () => Effect.succeed(run({ tests: { counts: counts(5), ids: [] } }))))
    expect(statuses(o)).toEqual(["unit:failed (no test report was produced (a silent green fails))"])
  })

  test("a passing suite records its proof and counts", async () => {
    const o = await go("verify { unit }", pack({}, () => Effect.succeed(run({ tests: { counts: counts(3), ids: ["a", "b", "c"] } }))), { unit: { "TEST-x.xml": "<testsuite/>" } })
    expect(statuses(o)).toEqual(["unit:passed"])
    expect(o.checks[0]?.proof?.reports["TEST-x.xml"]).toMatch(/^[0-9a-f]{64}$/)
    expect(o.checks[0]?.proof?.executed).toBe(3)
    expect(o.tests?.ids).toEqual(["a", "b", "c"])
  })

  test("a tool that couldn't run is errored, not passed", async () => {
    const o = await go("fast { build }", pack({ build: () => Effect.succeed(run({ error: "gradle not found" })) }))
    expect(statuses(o)).toEqual(["build:errored (gradle not found)"])
  })

  test("a gate no pack implements, and parse-only checks, are not executed", async () => {
    const o = await go("fast { build } behaviour { secret }", pack({}))
    expect(statuses(o)).toEqual([
      "build:not-executed (no used pack implements the 'build' gate)",
      "secret:not-executed (holdout pending: holdouts run only in CI and are not executed in v1)",
    ])
  })

  test("a ratcheted violations gate fails only on findings not in the baseline", async () => {
    const base = fingerprint([finding(2)], () => fileLines)
    const head = fingerprint([finding(2), finding(3)], () => fileLines)
    const baseline = Option.some({ ...emptyBaseline("c", "h", "0"), results: { "lint-tool": base } })
    const lint = pack({ lint: () => Effect.succeed(run({ runs: [sarifRun(head)] })) })
    const o = await go("fast { lint ratchet }", lint, { lint: { "lint.sarif": "{}" } }, baseline)
    expect(statuses(o)).toEqual(["lint:failed (1 new finding not in the baseline)"])
    expect(o.newViolations.map((v) => v.line)).toEqual([3])
    const grandfathered = pack({ lint: () => Effect.succeed(run({ runs: [sarifRun(base)] })) })
    expect(statuses(await go("fast { lint ratchet }", grandfathered, { lint: { "lint.sarif": "{}" } }, baseline))).toEqual(["lint:passed"])
  })

  test("a violations gate with no report fails", async () => {
    expect(statuses(await go("fast { lint }", pack({ lint: () => Effect.succeed(run()) })))).toEqual(["lint:failed (no report was produced (a silent green fails))"])
  })

  test("metric gates check thresholds and ratchets against the baseline", async () => {
    const coverage = (value: number) => pack({ coverage: () => Effect.succeed(run({ metrics: { coverage: { value, unit: "%", higherIsBetter: true } } })) })
    const files = { coverage: { "coverage.xml": "<report/>" } }
    expect(statuses(await go("verify { coverage >= 80% }", coverage(85), files))).toEqual(["coverage:passed"])
    expect(statuses(await go("verify { coverage >= 80% }", coverage(70), files))).toEqual(["coverage:failed (coverage 70% doesn't meet >= 80%)"])
    const baseline = Option.some({ ...emptyBaseline("c", "h", "0"), metrics: { coverage: { value: 90, unit: "%" as const, higherIsBetter: true } } })
    const o = await go("verify { coverage ratchet }", coverage(85), files, baseline)
    expect(statuses(o)).toEqual(["coverage:failed (coverage fell from 90 to 85)"])
    expect(o.regressions).toEqual([{ metric: "coverage", base: 90, head: 85 }])
    expect(statuses(await go("verify { coverage >= 80% }", coverage(85)))).toEqual(["coverage:not-executed (no coverage value was reported)"])
  })
})

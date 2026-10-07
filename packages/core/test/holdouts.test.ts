import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import type { Result, Run } from "@gauntlet/sarif"
import { Effect, Layer, Option } from "effect"
import { jvm } from "../../dsl/test/fixtures/catalog.ts"
import { type GateRun, holdoutDir, holdoutsOf, type Pack, planMaterialisation, type PreparedWorkspace, ProcessRunnerLive, type Report, runGates, type SuiteImpl, verdictLines } from "../src/index.ts"
import { compiled, noFacts } from "./fixtures.ts"

// ADR 0019, spec 0003: holdouts name their files, are left out of every
// ordinary run, and run only with `check --holdouts`.

const policy = (holdout: string) => compiled(`gauntlet "x"
use jvm
owners @p
protect { tests "src/test/**" }
suites {
  unit "src/test/**"
  ${holdout}
}
gates { verify { unit } behaviour { acceptance } }
`).ir

const WITH_PATHS = policy(`holdout "acceptance" paths "src/test/holdout/**" ci only`)

describe("holdout files", () => {
  test("holdoutsOf lists only holdouts that name their files", () => {
    expect(holdoutsOf(WITH_PATHS)).toEqual([{ name: "acceptance", globs: ["src/test/holdout/**"] }])
    expect(holdoutsOf(policy(`holdout "acceptance" ci only`))).toEqual([])
  })

  test("any head change under a holdout path is left out, before protected tests are considered", () => {
    const plan = planMaterialisation([
      { status: "modified", path: "src/test/holdout/AcceptanceTest.kt" },
      { status: "added", path: "src/test/holdout/NewTest.kt" },
      { status: "modified", path: "src/test/UnitTest.kt" },
      { status: "renamed", oldPath: "src/test/holdout/OldTest.kt", path: "src/test/Moved.kt" },
    ], WITH_PATHS.protect, [], holdoutsOf(WITH_PATHS))
    // The moved copy outside the holdout is a new test file: it runs, as any new test does.
    expect(plan.map((m) => `${m.path} ${m.group} ${m.action}`)).toEqual([
      "src/test/UnitTest.kt tests restored",
      "src/test/holdout/AcceptanceTest.kt holdout acceptance removed",
      "src/test/holdout/NewTest.kt holdout acceptance removed",
      "src/test/holdout/OldTest.kt holdout acceptance removed",
    ])
  })

  test("the runner's directory is the holdout globs' common literal prefix", () => {
    expect(holdoutDir(["src/test/holdout/**"])).toBe("src/test/holdout")
    expect(holdoutDir(["internal/a/*_holdout_test.go", "internal/b/x_test.go"])).toBe("internal")
    expect(holdoutDir(["**/*_holdout_test.go"])).toBe("")
  })
})

// An in-memory workspace that records which holdout globs were put in place.
const workspace = (put: string[][], holdoutFiles: string[] = ["src/test/holdout/AcceptanceTest.kt"]): PreparedWorkspace => ({
  dir: "/checkout",
  base: "b",
  head: "h",
  materialised: [],
  outputDir: (check) => Effect.succeed(`/out/${check}`),
  collect: () => Effect.succeed([{ path: "TEST-x.xml", content: "<testsuite/>" }]),
  withHoldout: (globs, use) => {
    put.push([...globs])
    return use(holdoutFiles)
  },
})
const counts = (executed: number, failed = 0) => ({ executed, passed: executed - failed, failed, errored: 0, skipped: 0 })
const failure = (id: string): Result => ({ ruleId: "test/failed", message: { text: `${id}: expected 300 but was 220 (secret detail)` }, locations: [{ logicalLocations: [{ fullyQualifiedName: id }] }] })
const testRun = (results: Result[]): Run => ({ tool: { driver: { name: "junit" } }, results })

const go = (suite: SuiteImpl, opts: { holdouts?: boolean; put?: string[][]; files?: string[]; ir?: typeof WITH_PATHS } = {}) => {
  const pack: Pack = { spec: jvm, runnerConfig: [], manifests: [], detectors: [], gates: {}, runSuite: suite }
  return Effect.runPromise(
    runGates({ ir: opts.ir ?? WITH_PATHS, facts: noFacts(), workspace: workspace(opts.put ?? [], opts.files), packs: [pack], baseline: Option.none(), renames: new Map(), files: [], ...(opts.holdouts ? { holdouts: true } : {}) })
      .pipe(Effect.provide(Layer.mergeAll(ProcessRunnerLive.pipe(Layer.provide(BunServices.layer)), BunServices.layer))),
  )
}
const byName = (o: Awaited<ReturnType<typeof go>>, name: string) => o.checks.find((c) => c.check === name)!

describe("running holdouts", () => {
  const visibleOk: GateRun = { command: ["test"], exitCode: 0, runs: [testRun([])], tests: { counts: counts(2), ids: ["a", "b"] } }

  test("without --holdouts the holdout is pending and nothing is put in place", async () => {
    const put: string[][] = []
    const o = await go(() => Effect.succeed(visibleOk), { put })
    expect(byName(o, "acceptance")).toMatchObject({ status: "not-executed" })
    expect(byName(o, "acceptance").reason).toContain("holdout pending")
    expect(put).toEqual([])
  })

  test("a holdout without paths stays pending even with --holdouts", async () => {
    const o = await go(() => Effect.succeed(visibleOk), { holdouts: true, ir: policy(`holdout "acceptance" ci only`) })
    expect(byName(o, "acceptance").reason).toContain("holdout pending")
  })

  test("a failing holdout after a passing visible suite is a holdout gap, naming only the test", async () => {
    const put: string[][] = []
    const suite: SuiteImpl = (s) =>
      Effect.succeed(s.name === "acceptance"
        ? { command: ["test"], exitCode: 1, runs: [testRun([failure("AcceptanceTest.convertsAnyRate")])], tests: { counts: counts(3, 1), ids: ["a", "b", "AcceptanceTest.convertsAnyRate"] } }
        : visibleOk)
    const o = await go(suite, { holdouts: true, put })
    expect(put).toEqual([["src/test/holdout/**"]])
    const c = byName(o, "acceptance")
    expect(c).toMatchObject({ status: "failed", holdoutGap: true, failures: ["AcceptanceTest.convertsAnyRate"] })
    expect(c.reason).toStartWith("holdout gap")
    expect(JSON.stringify(o)).not.toContain("secret detail")
    // Holdout tests never join the visible test record.
    expect(o.tests?.ids).toEqual(["a", "b"])
  })

  test("a passing holdout passes", async () => {
    const o = await go(() => Effect.succeed(visibleOk), { holdouts: true })
    expect(byName(o, "acceptance")).toMatchObject({ status: "passed" })
  })

  test("a holdout with no files at base, or that runs no tests, fails", async () => {
    expect(byName(await go(() => Effect.succeed(visibleOk), { holdouts: true, files: [] }), "acceptance")).toMatchObject({ status: "failed" })
    const empty = await go((s) => Effect.succeed(s.name === "acceptance" ? { ...visibleOk, tests: { counts: counts(0), ids: [] } } : visibleOk), { holdouts: true })
    expect(byName(empty, "acceptance").reason).toContain("silent green")
  })
})

describe("the GitHub summary", () => {
  test("a holdout gap is counted apart from ordinary failures", () => {
    const report = {
      integrity: { findings: [] },
      checks: [
        { tier: "verify", check: "unit", status: "passed", advisory: false },
        { tier: "verify", check: "lint", status: "failed", advisory: false },
        { tier: "behaviour", check: "acceptance", status: "failed", advisory: false, holdoutGap: true },
      ],
    } as unknown as Report
    expect(verdictLines(report)).toEqual(["Integrity: no forbidden changes.", "Gates: 1 passed, 1 failed (lint), 1 holdout gap (acceptance)."])
  })
})

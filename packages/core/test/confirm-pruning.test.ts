import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { type Baseline, emptyBaseline, type KillMap } from "@gauntlet/sarif"
import { Effect, Layer, Option, Schema } from "effect"
import { jvm } from "../../dsl/test/fixtures/catalog.ts"
import { confirmPruning, type GateContext, type GateRun, type IntegrityInput, type Pack, type PreparedWorkspace, ProcessRunnerLive, pruningRun, ReportCheck, runGates, runIntegrity, testPathMatcher } from "../src/index.ts"
import { compiled, noFacts } from "./fixtures.ts"

// Spec 0016 §3, second half: for a change that only removes tests, the policy's
// mutation gate fails at once when the kill map shows lost kills, or mutates the
// files the removed tests protected. When they score as at base, integrity
// turns the deleted-tests forbid into a flag: reviewed, not forbidden.

const FX = "src/main/kotlin/svc/Fx.kt"
const MONEY = "src/main/kotlin/svc/Money.kt"
const MAP: KillMap = {
  mutants: [{ path: FX, line: 3 }, { path: FX, line: 7 }, { path: FX, line: 9 }, { path: MONEY, line: 2 }],
  tests: {
    "svc.FxTest.converts": { killed: [0, 1], reached: 3 },
    "svc.FxTest.rounds": { killed: [1], reached: 1 },
    "svc.FxTest.halves": { killed: [2], reached: 1 },
    "svc.MoneyTest.adds": { killed: [3], reached: 1 },
  },
}
const IDS = ["svc.FxTest.converts()", "svc.FxTest.rounds()", "svc.FxTest.halves()", "svc.MoneyTest.adds()"]
const { ir } = compiled(`gauntlet "svc"
use jvm
owners @platform
protect { tests "src/test/**" }
suites { unit "src/test/**" }
gates { verify { unit, mutation ratchet on changed } }
`)
const isTestPath = testPathMatcher(ir)
const modified = (path: string) => ({ path, status: "modified" as const, added: 0, removed: 5 })
const TEST_ONLY = { files: [modified("src/test/kotlin/svc/FxTest.kt")] }

describe("pruningRun", () => {
  const run = (head: string[], facts = TEST_ONLY) => pruningRun({ facts, isTestPath, baseTestIds: IDS, headTestIds: head, killMap: MAP })

  test("a removal the kill map supports is confirmed on the files the removed tests protected", () => {
    expect(run(IDS.filter((i) => i !== "svc.FxTest.rounds()"))).toMatchObject({ kind: "confirm", files: [FX] })
  })

  test("a removal that loses kills is rejected without a run", () => {
    expect(run(IDS.filter((i) => i !== "svc.FxTest.halves()"))?.kind).toBe("rejected")
  })

  test("nothing special for other changes, or when the kill map can't tell", () => {
    expect(run(IDS)).toBeUndefined()
    expect(run(IDS.filter((i) => i !== "svc.FxTest.rounds()"), { files: [modified("src/test/kotlin/svc/FxTest.kt"), modified(FX)] })).toBeUndefined()
    expect(pruningRun({ facts: TEST_ONLY, isTestPath, baseTestIds: IDS, headTestIds: IDS.filter((i) => i !== "svc.FxTest.rounds()"), killMap: undefined })).toBeUndefined()
  })
})

describe("confirmPruning", () => {
  test("confirmed when every protected file scores at least as at base", () => {
    // Fx.kt: 3 mutants, all killed at base.
    expect(confirmPruning([FX], MAP, { [FX]: 100 })).toEqual({ confirmed: true, reason: `the tests that stay still kill every mutant the removed tests killed: ${FX} scores as at base (spec 0016)` })
  })

  test("not when a file scores lower, or has no score", () => {
    expect(confirmPruning([FX], MAP, { [FX]: 66.67 })).toEqual({ confirmed: false, reason: `the removal loses kills: ${FX} (66.67%, 100% at base) scored lower with the tests that stay` })
    expect(confirmPruning([FX, MONEY], MAP, { [FX]: 100 }).reason).toContain(`${MONEY} (no score at head, 100% at base)`)
    expect(confirmPruning([FX], MAP, undefined).confirmed).toBe(false)
  })
})

describe("the mutation gate for a change that only removes tests", () => {
  const workspace: PreparedWorkspace = {
    dir: "/checkout", base: "b", head: "h", materialised: [],
    outputDir: (check) => Effect.succeed(`/out/${check}`),
    collect: () => Effect.succeed([{ path: "report.xml", content: "<x/>" }]),
  }
  const asked: GateContext[] = []
  const pack = (fxScore: number): Pack => ({
    spec: jvm, runnerConfig: [], manifests: [], detectors: [],
    runSuite: () => Effect.succeed({ command: ["gradle"], exitCode: 0, runs: [], tests: { counts: { executed: 3, passed: 3, failed: 0, errored: 0, skipped: 0 }, ids: IDS.filter((i) => i !== "svc.FxTest.rounds()") } }),
    gates: {
      mutation: (_c, ctx) => Effect.sync((): GateRun => {
        asked.push(ctx)
        return { command: ["pitest"], exitCode: 0, runs: [], metrics: { mutation: { value: fxScore, unit: "%", higherIsBetter: true, perFile: { [FX]: fxScore } } } }
      }),
    },
  })
  const baseline: Baseline = { ...emptyBaseline("b", "f".repeat(64), "0.0.0"), testIds: IDS, killMap: MAP, metrics: { mutation: { value: 100, unit: "%", higherIsBetter: true } } }
  const go = (p: Pack, files = TEST_ONLY.files, map: KillMap = MAP) => {
    asked.length = 0
    return Effect.runPromise(runGates({
      ir, facts: noFacts({ files }), workspace, packs: [p], baseline: Option.some({ ...baseline, killMap: map }), renames: new Map(), files: [],
    }).pipe(Effect.provide(Layer.mergeAll(ProcessRunnerLive.pipe(Layer.provide(BunServices.layer)), BunServices.layer))))
  }
  const mutationOf = (o: Awaited<ReturnType<typeof go>>) => o.checks.find((c) => c.check === "mutation")!

  test("mutates the protected files whole, and a run that scores as at base is a confirmed pruning", async () => {
    const m = mutationOf(await go(pack(100)))
    expect(asked[0]!.scope).toEqual([FX])
    expect(asked[0]!.changedLinesOnly).toBeUndefined()
    expect(m.status).toBe("passed")
    expect(m.pruning).toBe("confirmed")
  })

  test("a run that scores lower fails, naming the file", async () => {
    const m = mutationOf(await go(pack(66.67)))
    expect(m.status).toBe("failed")
    expect(m.reason).toContain(`${FX} (66.67%, 100% at base)`)
    expect(m.pruning).toBeUndefined()
  })

  test("a removal the kill map shows losing kills fails without running mutation", async () => {
    const lost = { ...MAP, tests: { ...MAP.tests, "svc.FxTest.converts": { killed: [0], reached: 3 } } }
    const m = mutationOf(await go(pack(100), TEST_ONLY.files, lost))
    expect(asked).toHaveLength(0)
    expect(m.status).toBe("failed")
    expect(m.reason).toContain("loses kills")
  })

  test("a change to main code runs the gate as usual, on the changed lines", async () => {
    const m = mutationOf(await go(pack(100), [modified("src/test/kotlin/svc/FxTest.kt"), modified(FX)]))
    expect(asked[0]!.changedLinesOnly).toBe(true)
    expect(m.pruning).toBeUndefined()
  })
})

describe("integrity after a confirmed pruning", () => {
  const input = (over: Partial<IntegrityInput> = {}): IntegrityInput => ({
    ir: compiled(`gauntlet "svc"
use jvm
owners @platform
protect { tests "src/test/**" }
suites { unit "src/test/**" }
integrity { ratchet executed tests }
gates { verify { unit } }
`).ir,
    facts: noFacts({ files: [{ path: "src/test/kotlin/svc/FxTest.kt", status: "deleted" as const, added: 0, removed: 9 }] }),
    readBase: () => Effect.succeed(Option.none()), readHead: () => Effect.succeed(Option.none()),
    isTestPath, headFiles: [], dir: "/nonexistent",
    baselineMetrics: { "integrity/executed-tests": { value: 4, unit: "count", higherIsBetter: true } },
    baseTestIds: IDS,
    headTests: { counts: { executed: 1, passed: 1, failed: 0, errored: 0, skipped: 0 }, ids: ["svc.MoneyTest.adds()"] },
    ...over,
  })
  const run = (i: IntegrityInput) => Effect.runSync(runIntegrity(i, []).pipe(Effect.provide(BunServices.layer)))
  const kinds = (r: ReturnType<typeof run>) => [...new Set(r.findings.filter((f) => f.check === "deleted-tests" || f.check === "executed-tests").map((f) => `${f.kind} ${f.check}`))].sort()

  test("the removal is flagged for review instead of forbidden, and the executed-tests ratchet allows for it", () => {
    const r = run(input({ pruningConfirmed: true }))
    expect(kinds(r)).toEqual(["flag deleted-tests"])
    expect(r.findings.find((f) => f.check === "deleted-tests")!.message).toContain("The mutation gate confirmed the tests that stay still kill every mutant")
  })

  test("a deleted holdout stays forbidden: nothing confirms a test that never runs where the mutation gate does", () => {
    const withHoldout = compiled(`gauntlet "svc"
use jvm
owners @platform
protect { tests "src/test/**" }
suites {
  unit "src/test/**"
  holdout "acceptance" paths "src/test/**/*HoldoutTest.kt" ci only
}
gates { verify { unit } }
`).ir
    const r = run(input({
      ir: withHoldout, pruningConfirmed: true,
      facts: noFacts({ files: [{ path: "src/test/kotlin/svc/FxTest.kt", status: "deleted" as const, added: 0, removed: 9 }, { path: "src/test/kotlin/svc/FxHoldoutTest.kt", status: "deleted" as const, added: 0, removed: 9 }] }),
    }))
    const removal = r.findings.filter((f) => f.check === "deleted-tests" && f.path !== undefined)
    expect(removal.find((f) => f.path === "src/test/kotlin/svc/FxHoldoutTest.kt")!.kind).toBe("forbid")
    expect(removal.find((f) => f.path === "src/test/kotlin/svc/FxTest.kt")!.kind).toBe("flag")
  })

  test("without the confirmation it stays forbidden, and so it does when main code changed too", () => {
    expect(kinds(run(input()))).toContain("forbid deleted-tests")
    const mixed = noFacts({ files: [{ path: "src/test/kotlin/svc/FxTest.kt", status: "deleted" as const, added: 0, removed: 9 }, modified(FX)] })
    expect(kinds(run(input({ pruningConfirmed: true, facts: mixed })))).toContain("forbid deleted-tests")
  })
})

describe("the evidence report", () => {
  test("carries a confirmed pruning to the trusted job", () => {
    const check = Schema.decodeUnknownSync(ReportCheck)({ tier: "verify", check: "mutation", status: "passed", advisory: false, pruning: "confirmed" })
    expect(check.pruning).toBe("confirmed")
    expect(() => Schema.decodeUnknownSync(ReportCheck)({ tier: "verify", check: "mutation", status: "passed", advisory: false, pruning: "yes" })).toThrow()
  })
})

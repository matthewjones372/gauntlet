import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { emptyBaseline, type Metric, updateBaseline } from "@gauntlet/sarif"
import { Effect, Layer, Option } from "effect"
import { jvm } from "../../dsl/test/fixtures/catalog.ts"
import { explainPolicy, type GateImpl, type GateRun, metricGate, type Pack, type PreparedWorkspace, ProcessRunnerLive, runGates } from "../src/index.ts"
import { compiled, noFacts } from "./fixtures.ts"

// Spec 0009: zone defaults run as each zone's own gates, explain says where a
// zone's checks come from, and each zone's measurement is recorded under its
// own name, so a zone added later starts its ratchet from its own value.

const policy = (body: string) => compiled(`gauntlet "x"
use jvm
owners @p
zone money { paths "src/money/**" owner @pay }
zone billing { paths "src/billing/**" owner @bill }
suites { unit "src/test/**" }
${body}
`)

const workspace: PreparedWorkspace = {
  dir: "/checkout", base: "b", head: "h", materialised: [],
  outputDir: (check) => Effect.succeed(`/out/${check}`),
  collect: (check) => Effect.succeed(check.endsWith("-coverage") ? [{ path: "coverage.xml", content: "<report/>" }] : []),
}

/** A coverage gate that reports each file in its scope at the value given for it, and says which scopes it ran with. */
const coverage = (values: Record<string, number>, scopes: Array<ReadonlyArray<string> | undefined>): GateImpl => (_check, ctx) => {
  scopes.push(ctx.scope)
  const files = (ctx.scope ?? Object.keys(values)).filter((f) => values[f] !== undefined)
  const perFile = Object.fromEntries(files.map((f) => [f, values[f]!]))
  const value = files.length === 0 ? 100 : files.reduce((a, f) => a + values[f]!, 0) / files.length
  const metric: Metric = { value, unit: "%", higherIsBetter: true, perFile }
  return Effect.succeed({ command: ["cover"], exitCode: 0, runs: [], metrics: { coverage: metric } } satisfies GateRun)
}

const pack = (gate: GateImpl): Pack => ({ spec: jvm, runnerConfig: [], manifests: [], detectors: [], gates: { coverage: gate } })

const go = (body: string, gate: GateImpl, options: { recording?: boolean; baseline?: Record<string, Metric> } = {}) =>
  Effect.runPromise(
    runGates({
      ir: policy(body).ir,
      facts: noFacts({ files: [{ path: "src/money/Pay.kt", status: "modified", added: 1, removed: 0 }, { path: "src/other/X.kt", status: "modified", added: 1, removed: 0 }] }),
      workspace, packs: [pack(gate)], renames: new Map(), files: [...Object.keys(VALUES), "src/test/T.kt"],
      baseline: options.baseline ? Option.some({ ...emptyBaseline("b", "h", "v"), metrics: options.baseline }) : Option.none(),
      ...(options.recording ? { recording: true } : {}),
    }).pipe(Effect.provide(Layer.mergeAll(ProcessRunnerLive.pipe(Layer.provide(BunServices.layer)), BunServices.layer))),
  )

const VALUES = { "src/money/Pay.kt": 70, "src/billing/Bill.kt": 95, "src/other/X.kt": 40 }

describe("explain", () => {
  test("names the zone defaults and marks each zone's checks that come from them", () => {
    const { ir } = policy(`zones { coverage >= 90% on changed }\ngates { verify { coverage ratchet, coverage >= 95% on changed in zone money } }`)
    const zones = explainPolicy(ir, "zones")
    expect(zones).toContain("- zone billing: src/billing/**, owned by @bill; checks coverage >= 90% on changed code (zone default)")
    expect(zones).toContain("- zone money: src/money/**, owned by @pay; checks coverage >= 95% on changed code\n")
    expect(zones).toContain("Zone defaults: every zone, including one added later, gets coverage >= 90% on changed code, unless its own gate for that check says otherwise.")
    expect(explainPolicy(ir, "gates")).toContain("coverage >= 90% on changed code in zone billing (zone default)")
  })

  test("a policy without zone defaults explains its zones as before", () => {
    const { ir } = policy(`gates { verify { unit } }`)
    expect(explainPolicy(ir, "zones")).toBe("zones\n- zone billing: src/billing/**, owned by @bill\n- zone money: src/money/**, owned by @pay\n")
  })
})

describe("zone defaults run as each zone's gates", () => {
  test("each zone's copy runs over that zone's changed files only, and the decision reads it like any gate", async () => {
    const scopes: Array<ReadonlyArray<string> | undefined> = []
    const o = await go(`zones { coverage >= 80% on changed }\ngates { verify { coverage } }`, coverage(VALUES, scopes))
    expect(scopes).toContainEqual(["src/money/Pay.kt"])
    expect(scopes).toContainEqual([])
    expect(scopes).toContainEqual(undefined)
    expect(o.checks.map((c) => `${c.check}:${c.status}${c.reason ? ` (${c.reason})` : ""}`).sort()).toEqual([
      "coverage:failed (coverage 70% doesn't meet >= 80%)",
      "coverage:passed",
      "coverage:passed",
    ])
  })
})

describe("each zone's measurement is its own (spec 0009 §3)", () => {
  test("recording keeps the project's value and adds each zone's under the zone's name", async () => {
    const o = await go(`gates { verify { coverage ratchet, coverage ratchet in zone money, coverage ratchet in zone billing } }`, coverage(VALUES, []), { recording: true })
    expect(Object.keys(o.metrics).sort()).toEqual(["coverage", "coverage in zone billing", "coverage in zone money"])
    expect(o.metrics.coverage!.perFile).toEqual(VALUES)
    expect(o.metrics["coverage in zone money"]!.perFile).toEqual({ "src/money/Pay.kt": 70 })
    expect(o.metrics["coverage in zone billing"]!.perFile).toEqual({ "src/billing/Bill.kt": 95 })
    expect(Object.keys(o.metrics).map(metricGate)).toEqual(["coverage", "coverage", "coverage"])
  })

  test("a zone's ratchet starts from the zone's own value", async () => {
    const baseline = {
      coverage: { value: 50, unit: "%", higherIsBetter: true, perFile: { "src/money/Pay.kt": 60 } },
      "coverage in zone money": { value: 75, unit: "%", higherIsBetter: true, perFile: { "src/money/Pay.kt": 75 } },
    } satisfies Record<string, Metric>
    const o = await go(`gates { verify { coverage ratchet in zone money } }`, coverage(VALUES, []), { baseline })
    expect(o.checks.map((c) => [c.status, c.reason])).toEqual([["failed", "coverage in zone money for src/money/Pay.kt fell from 75 to 70"]])
  })

  test("a baseline recorded before the zone had a value holds the zone's files to the project's, as before", async () => {
    const baseline = { coverage: { value: 50, unit: "%", higherIsBetter: true, perFile: { "src/money/Pay.kt": 60 } } } satisfies Record<string, Metric>
    const o = await go(`gates { verify { coverage ratchet in zone money } }`, coverage(VALUES, []), { baseline })
    expect(o.checks.map((c) => c.status)).toEqual(["passed"])
  })

  test("`baseline --update` records a zone the policy gained, without counting it as a lowering", () => {
    const old = { ...emptyBaseline("old", "h1", "v"), metrics: {
      coverage: { value: 60, unit: "%", higherIsBetter: true },
      "coverage in zone money": { value: 70, unit: "%", higherIsBetter: true },
    } } as const
    const recorded = {
      coverage: { value: 60, unit: "%", higherIsBetter: true },
      "coverage in zone money": { value: 70, unit: "%", higherIsBetter: true },
      "coverage in zone billing": { value: 40, unit: "%", higherIsBetter: true },
    } satisfies Record<string, Metric>
    const outcome = updateBaseline(old, { commit: "new", irHash: "h2", gauntletVersion: "v", metrics: recorded, results: {}, testIds: [], allowLower: false })
    expect(outcome.lowers).toBe(false)
    expect(outcome.baseline.metrics["coverage in zone billing"]).toEqual(recorded["coverage in zone billing"])
    expect(outcome.baseline.metrics["coverage in zone money"]!.value).toBe(70)
  })
})

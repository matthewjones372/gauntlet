import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { emptyBaseline, type Metric } from "@gauntlet/sarif"
import { Effect, Layer, Option } from "effect"
import { jvm } from "../../dsl/test/fixtures/catalog.ts"
import type { DiffFacts } from "../src/diff-facts.ts"
import { type GateRun, type Pack, type PreparedWorkspace, ProcessRunnerLive, runGates } from "../src/index.ts"
import { mergeBuildRuns, runFromBuild } from "../src/builds.ts"
import { mutationResult, type Mutant } from "../src/mutants.ts"
import { compiled, noFacts } from "./fixtures.ts"

// Spec 0017 §3: a whole-project coverage or mutation ratchet is judged against
// the base's value for the code still there at head.

const workspace = (files: Record<string, Record<string, string>>): PreparedWorkspace => ({
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

const policy = (gates: string) => compiled(`gauntlet "x"
use jvm
owners @p
suites {
  unit "src/test/**"
}
gates { ${gates} }
`)

const reportsFor = { coverage: { "coverage.xml": "<report/>" }, mutation: { "mutations.xml": "<mutations/>" } }

/** A pack whose coverage or mutation gate reports the given metric. */
const reporting = (name: "coverage" | "mutation", metric: Metric): Pack => ({
  spec: jvm, runnerConfig: [], manifests: [], detectors: [],
  gates: { [name]: () => Effect.succeed({ command: ["tool"], exitCode: 0, runs: [], metrics: { [name]: metric } } satisfies GateRun) },
})

/** A coverage metric as the packs work it out, from [hit, measured] lines per file. */
const coverage = (files: Record<string, [number, number]>, withTotals = true): Metric => {
  const pct = (hit: number, total: number) => Math.round((hit / total) * 10000) / 100
  const all = Object.values(files)
  return {
    value: pct(all.reduce((a, [h]) => a + h, 0), all.reduce((a, [, t]) => a + t, 0)),
    unit: "%",
    higherIsBetter: true,
    perFile: Object.fromEntries(Object.entries(files).map(([f, [h, t]]) => [f, pct(h, t)])),
    ...(withTotals ? { perFileTotal: Object.fromEntries(Object.entries(files).map(([f, [, t]]) => [f, t])) } : {}),
  }
}

const deleting = (...paths: string[]) => paths.map((path) => ({ path, status: "deleted" as const, added: 0, removed: 10 }))

const judge = (gates: string, p: Pack, baseMetrics: Readonly<Record<string, Metric>>, files: DiffFacts["files"], renames = new Map<string, string>()) =>
  Effect.runPromise(
    runGates({
      ir: policy(gates).ir,
      facts: noFacts({ files }),
      workspace: workspace(reportsFor),
      packs: [p],
      baseline: Option.some({ ...emptyBaseline("c", "h", "0"), metrics: baseMetrics }),
      renames,
      files: [],
    }).pipe(Effect.provide(Layer.mergeAll(ProcessRunnerLive.pipe(Layer.provide(BunServices.layer)), BunServices.layer))),
  )

const statuses = (o: Awaited<ReturnType<typeof judge>>) => o.checks.map((c) => `${c.check}:${c.status}${c.reason ? ` (${c.reason})` : ""}`)

// Well.kt is fully covered and Poor.kt half: 75% over 200 lines.
const base = { coverage: coverage({ "src/main/Well.kt": [100, 100], "src/main/Poor.kt": [50, 100] }) }

describe("a whole-project coverage ratchet when the change removes code", () => {
  test("deleting a well-covered file is not a regression", async () => {
    const o = await judge("verify { coverage ratchet }", reporting("coverage", coverage({ "src/main/Poor.kt": [50, 100] })), base, deleting("src/main/Well.kt"))
    expect(statuses(o)).toEqual(["coverage:passed"])
    expect(o.ratchets.find((r) => r.file === undefined)).toMatchObject({ base: 50, head: 50, note: "50 is the base's 75 without the code this change removes (src/main/Well.kt)" })
  })

  test("deleting a poorly covered file passes too", async () => {
    const o = await judge("verify { coverage ratchet }", reporting("coverage", coverage({ "src/main/Well.kt": [100, 100] })), base, deleting("src/main/Poor.kt"))
    expect(statuses(o)).toEqual(["coverage:passed"])
  })

  test("a drop in a file that's left still fails", async () => {
    const o = await judge("verify { coverage ratchet }", reporting("coverage", coverage({ "src/main/Poor.kt": [40, 100] })), base, deleting("src/main/Well.kt"))
    expect(statuses(o)).toEqual([
      "coverage:failed (coverage fell from 50 to 40: 50 is the base's 75 without the code this change removes (src/main/Well.kt); coverage for src/main/Poor.kt fell from 50 to 40)",
    ])
    expect(o.regressions[0]).toMatchObject({ metric: "coverage", base: 50, head: 40 })
  })

  test("a deleted test file isn't removed code", async () => {
    const o = await judge("verify { coverage ratchet }", reporting("coverage", coverage({ "src/main/Poor.kt": [50, 100] })), base, deleting("src/test/WellTest.kt"))
    expect(statuses(o)).toEqual(["coverage:failed (coverage fell from 75 to 50)"])
  })

  test("a renamed file keeps its base value", async () => {
    const was = { coverage: coverage({ "src/main/Old.kt": [9, 10], "src/main/Rest.kt": [90, 90] }) }
    const now = coverage({ "src/main/New.kt": [9, 10], "src/main/Rest.kt": [90, 90] })
    const files = [{ path: "src/main/New.kt", oldPath: "src/main/Old.kt", status: "renamed" as const, added: 0, removed: 0 }]
    const o = await judge("verify { coverage ratchet }", reporting("coverage", now), was, files, new Map([["src/main/Old.kt", "src/main/New.kt"]]))
    expect(statuses(o)).toEqual(["coverage:passed"])
    expect(o.ratchets.find((r) => r.file === "src/main/New.kt")).toMatchObject({ base: 90, head: 90 })
  })

  test("an older baseline without per-file totals is compared as before, and the drop says why it may have happened", async () => {
    const older = { coverage: coverage({ "src/main/Well.kt": [100, 100], "src/main/Poor.kt": [50, 100] }, false) }
    const o = await judge("verify { coverage ratchet }", reporting("coverage", coverage({ "src/main/Poor.kt": [50, 100] }, false)), older, deleting("src/main/Well.kt"))
    expect(o.checks[0]?.status).toBe("failed")
    expect(o.checks[0]?.reason).toStartWith("coverage fell from 75 to 50: this change removes src/main/Well.kt")
    expect(o.checks[0]?.reason).toContain("`gauntlet baseline --update --allow-lower`")
    expect(o.regressions[0]?.note).toContain("the drop may come from the removed code")
  })

  test("`on changed` is judged as before", async () => {
    // Only the changed file's whole-file value is compared; the deletion plays no part.
    const head = coverage({ "src/main/Poor.kt": [40, 100] })
    const files = [...deleting("src/main/Well.kt"), { path: "src/main/Poor.kt", status: "modified" as const, added: 1, removed: 0 }]
    const o = await judge("verify { coverage ratchet on changed }", reporting("coverage", head), base, files)
    expect(statuses(o)).toEqual(["coverage:failed (coverage for src/main/Poor.kt fell from 50 to 40)"])
    expect(o.ratchets.every((r) => r.note === undefined)).toBe(true)
  })
})

describe("a whole-project mutation ratchet when the change removes code", () => {
  const m = (path: string, killed: boolean): Mutant => ({ path, line: 1, killed, message: killed ? "killed" : "survived" })
  // Fx.kt: 9 of 10 killed; Rates.kt: 1 of 10. 50% overall.
  const fx = Array.from({ length: 10 }, (_, i) => m("src/main/Fx.kt", i < 9))
  const rates = Array.from({ length: 10 }, (_, i) => m("src/main/Rates.kt", i < 1))
  const scored = (ms: ReadonlyArray<Mutant>) => mutationResult("pitest", ms, {}).metrics!.mutation!

  test("the score records what each file's value is out of", () => {
    expect(scored([...fx, ...rates])).toMatchObject({ value: 50, perFile: { "src/main/Fx.kt": 90, "src/main/Rates.kt": 10 }, perFileTotal: { "src/main/Fx.kt": 10, "src/main/Rates.kt": 10 } })
  })

  test("deleting a well-tested file is not a regression, and a drop in what's left still fails", async () => {
    const was = { mutation: scored([...fx, ...rates]) }
    const ok = await judge("verify { mutation ratchet }", reporting("mutation", scored(rates)), was, deleting("src/main/Fx.kt"))
    expect(statuses(ok)).toEqual(["mutation:passed"])
    const fewer = scored(rates.map((x) => ({ ...x, killed: false })))
    const worse = await judge("verify { mutation ratchet }", reporting("mutation", fewer), was, deleting("src/main/Fx.kt"))
    expect(worse.checks[0]?.reason).toStartWith("mutation fell from 10 to 0: 10 is the base's 50 without the code this change removes (src/main/Fx.kt)")
  })

  test("a mutant with no file means the score can't be worked out again: the note instead", async () => {
    const was = { mutation: scored([...fx, ...rates, { path: undefined, line: 1, killed: true, message: "killed" }]) }
    const o = await judge("verify { mutation ratchet }", reporting("mutation", scored(rates)), was, deleting("src/main/Fx.kt"))
    expect(o.checks[0]?.reason).toContain("the drop may come from the removed code")
  })
})

describe("several builds", () => {
  test("per-file totals follow each build's paths and merge only when every build has them", () => {
    const run = (metric: Metric, dir: string): GateRun => runFromBuild({ command: ["tool"], exitCode: 0, runs: [], metrics: { coverage: metric } }, dir)
    const a = coverage({ "X.kt": [100, 100] })
    const b = coverage({ "Y.kt": [50, 100] })
    const merged = mergeBuildRuns([{ dir: "a", run: run(a, "a") }, { dir: "b", run: run(b, "b") }]).metrics!.coverage!
    expect(merged).toMatchObject({ value: 50, perFile: { "a/X.kt": 100, "b/Y.kt": 50 }, perFileTotal: { "a/X.kt": 100, "b/Y.kt": 100 } })
    const partly = mergeBuildRuns([{ dir: "a", run: run(a, "a") }, { dir: "b", run: run(coverage({ "Y.kt": [50, 100] }, false), "b") }]).metrics!.coverage!
    expect(partly.perFileTotal).toBeUndefined()
  })
})

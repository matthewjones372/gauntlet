import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Option } from "effect"
import { jvm } from "../../dsl/test/fixtures/catalog.ts"
import { type GateRun, killMapOf, mergeBuildRuns, type Mutant, mutationCandidates, mutationGateRun, type Pack, type PreparedWorkspace, ProcessRunnerLive, renderPruneTests, runFromBuild, runGates } from "../src/index.ts"
import { compiled, noFacts } from "./fixtures.ts"

// Spec 0016 stage 2: which tests kill which mutants, from the tools that
// report it, through a mutation gate into the baseline and `prune tests`.

const FX = "src/main/kotlin/svc/Fx.kt"
const m = (line: number, killedBy: string[] | undefined, coveredBy?: string[]): Mutant => ({
  path: FX, line, killed: (killedBy ?? []).length > 0, message: "a mutant",
  ...(killedBy !== undefined ? { killedBy } : {}), ...(coveredBy !== undefined ? { coveredBy } : {}),
})

describe("killMapOf", () => {
  test("nothing when the tool reports no killers", () => {
    expect(killMapOf([m(1, undefined), m(2, undefined)])).toBeUndefined()
  })

  test("each test's kills by index, and every mutant it reached, killers included", () => {
    expect(killMapOf([m(3, ["svc.FxTest.rounds"], ["svc.FxTest.runs"]), m(7, ["svc.FxTest.rounds", "svc.FxTest.halves"]), m(9, [], ["svc.FxTest.runs"])])).toEqual({
      mutants: [{ path: FX, line: 3 }, { path: FX, line: 7 }, { path: FX, line: 9 }],
      tests: {
        "svc.FxTest.halves": { killed: [1], reached: 1 },
        "svc.FxTest.rounds": { killed: [0, 1], reached: 2 },
        "svc.FxTest.runs": { killed: [], reached: 2 },
      },
    })
  })

  test("a mutant the report can't trace to a file is left out", () => {
    expect(killMapOf([{ ...m(1, ["svc.A"]), path: undefined }, m(2, ["svc.A"])])).toEqual({ mutants: [{ path: FX, line: 2 }], tests: { "svc.A": { killed: [0], reached: 1 } } })
  })
})

const workspace: PreparedWorkspace = {
  dir: "/checkout", base: "b", head: "h", materialised: [],
  outputDir: (check) => Effect.succeed(`/out/${check}`),
  collect: () => Effect.succeed([{ path: "mutations.xml", content: "<mutations/>" }]),
}
const mutants = [m(3, ["svc.FxTest.rounds"], ["svc.FxTest.runs"]), m(7, [], ["svc.FxTest.runs"])]
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

describe("the kill map through the gate runner", () => {
  test("a mutation gate whose tool reports killers hands its kill map on", async () => {
    const out = await record()
    expect(out.killMap).toEqual({ mutants: [{ path: FX, line: 3 }, { path: FX, line: 7 }], tests: { "svc.FxTest.rounds": { killed: [0], reached: 1 }, "svc.FxTest.runs": { killed: [], reached: 2 } } })
  })

  test("with build folders, its paths and tests are named from the repository's root", async () => {
    const out = await record(`use jvm in "bank"`, `bank/${FX}`)
    expect(out.killMap?.mutants[0]).toEqual({ path: `bank/${FX}`, line: 3 })
    expect(Object.keys(out.killMap?.tests ?? {})).toEqual(["bank:svc.FxTest.rounds", "bank:svc.FxTest.runs"])
  })
})

describe("kill maps from several builds", () => {
  const run = (killMap?: GateRun["killMap"]): GateRun => ({ command: ["pitest"], exitCode: 0, runs: [], ...(killMap ? { killMap } : {}) })
  const one = { mutants: [{ path: FX, line: 3 }], tests: { "svc.A": { killed: [0], reached: 1 } } }

  test("a build's paths are named from the repository's root", () => {
    expect(runFromBuild(run(one), "bank").killMap?.mutants).toEqual([{ path: `bank/${FX}`, line: 3 }])
    expect(runFromBuild(run(), "bank").killMap).toBeUndefined()
  })

  test("merging keeps every build's map", () => {
    expect(mergeBuildRuns([{ dir: "a", run: run(one) }, { dir: "b", run: run(one) }]).killMap?.mutants).toHaveLength(2)
    expect(mergeBuildRuns([{ dir: "a", run: run() }]).killMap).toBeUndefined()
  })
})

describe("mutationCandidates", () => {
  const map = {
    mutants: [0, 1, 2, 3].map((line) => ({ path: FX, line })),
    tests: {
      "svc.FxTest.broad": { killed: [0, 1, 2], reached: 4 },
      "svc.FxTest.narrow": { killed: [1], reached: 1 },
      "svc.FxTest.twin": { killed: [1, 2], reached: 2 },
      "svc.FxTest.unique": { killed: [3], reached: 1 },
      "svc.FxTest.idle": { killed: [], reached: 2 },
      "svc.FxTest.untouched": { killed: [], reached: 0 },
    },
  }

  test("lists tests that kill nothing, and tests whose every kill a kept test makes", () => {
    const r = mutationCandidates(map, "c0ffee")
    expect(r.killsNothing).toEqual([{ test: "svc.FxTest.idle", reached: 2 }])
    expect(r.alreadyKilled).toEqual([
      { test: "svc.FxTest.narrow", killed: 1, by: ["svc.FxTest.broad"] },
      { test: "svc.FxTest.twin", killed: 2, by: ["svc.FxTest.broad"] },
    ])
    expect(r.mutants).toBe(4)
    expect(r.tests).toBe(6)
  })

  test("two tests that kill the same mutants: one keeps, so removing the listed ones loses no kill", () => {
    const r = mutationCandidates({ mutants: [{ path: FX, line: 1 }], tests: { "b": { killed: [0], reached: 1 }, "a": { killed: [0], reached: 1 } } }, "c")
    expect(r.alreadyKilled).toEqual([{ test: "b", killed: 1, by: ["a"] }])
  })

  test("a kept test (a property test) is never listed, and its kills count first", () => {
    const keep = (t: string) => t === "svc.FxTest.twin" || t === "svc.FxTest.idle"
    const r = mutationCandidates(map, "c", keep)
    expect(r.killsNothing).toEqual([])
    expect(r.alreadyKilled.map((x) => x.test)).toEqual(["svc.FxTest.narrow"])
    expect(r.alreadyKilled[0]!.by).toEqual(["svc.FxTest.twin"])
  })

  test("the report names what it read and each kind", () => {
    const text = renderPruneTests({ files: 0, tests: 0, testsNothing: [], duplicates: [], mutation: mutationCandidates(map, "c0ffee1234567890") })
    expect(text).toContain("From the mutation results recorded at c0ffee123456: 4 mutants, 6 tests.")
    expect(text).toContain("Tests that kill no mutant (1):\n  svc.FxTest.idle: reaches 2 mutants and kills none.")
    expect(text).toContain("  svc.FxTest.narrow: its mutant is also killed by svc.FxTest.broad.")
    expect(text).toContain("  svc.FxTest.twin: its 2 mutants are also killed by svc.FxTest.broad.")
  })

  test("the report says when every test earns its place, or when there's nothing to read", () => {
    const fine = mutationCandidates({ mutants: [{ path: FX, line: 1 }], tests: { a: { killed: [0], reached: 1 } } }, "c")
    expect(renderPruneTests({ files: 0, tests: 0, testsNothing: [], duplicates: [], mutation: fine })).toContain("Every test kills a mutant no other test kills.")
    expect(renderPruneTests({ files: 0, tests: 0, testsNothing: [], duplicates: [], mutation: { missing: "why" } })).toContain("No mutation results: why.")
  })
})

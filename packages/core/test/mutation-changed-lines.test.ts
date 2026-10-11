import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { emptyBaseline } from "@gauntlet/sarif"
import { Effect, Layer, Option } from "effect"
import { jvm } from "../../dsl/test/fixtures/catalog.ts"
import { type GateContext, type GateRun, type Mutant, mutationGateRun, type Pack, type PreparedWorkspace, ProcessRunnerLive, runGates } from "../src/index.ts"
import { compiled, noFacts } from "./fixtures.ts"

// Spec 0011: with `on changed`, a mutation gate is told to count only the
// changed lines, and its ratchet is "no new survivors" rather than a per-file
// comparison with the baseline's whole-file scores.

const workspace: PreparedWorkspace = {
  dir: "/checkout", base: "b", head: "h", materialised: [],
  outputDir: (check) => Effect.succeed(`/out/${check}`),
  collect: () => Effect.succeed([{ path: "mutations.xml", content: "<mutations/>" }]),
}

const policy = (gates: string) => compiled(`gauntlet "x"\nuse jvm\nowners @p\ngates { ${gates} }\n`).ir

const facts = noFacts({
  files: [{ path: "src/A.kt", status: "modified", added: 2, removed: 0 }],
  addedLines: new Map([["src/A.kt", [{ line: 3, text: "  if (x > 0) pay()" }, { line: 4, text: "  log()" }]]]),
})

const mutants: Mutant[] = [
  { path: "src/A.kt", line: 3, killed: true, message: "killed" },
  { path: "src/A.kt", line: 3, killed: false, message: "No test kills a conditional-boundary mutant" },
  { path: "src/A.kt", line: 20, killed: false, message: "No test kills a mutant far from the change" },
]

/** A JVM pack whose mutation gate scores [mutants] through the shared helper, recording the context it got. */
const pack = (seen: GateContext[]): Pack => ({
  spec: jvm, runnerConfig: [], manifests: [], detectors: [],
  gates: { mutation: (_check, ctx) => Effect.sync((): GateRun => (seen.push(ctx), { command: ["pitest"], exitCode: 0, ...mutationGateRun("pitest", mutants, ctx) })) },
})

const go = (gates: string, seen: GateContext[], baseline = Option.none<ReturnType<typeof emptyBaseline>>()) =>
  Effect.runPromise(
    runGates({ ir: policy(gates), facts, workspace, packs: [pack(seen)], baseline, renames: new Map(), files: ["src/A.kt"] })
      .pipe(Effect.provide(Layer.mergeAll(ProcessRunnerLive.pipe(Layer.provide(BunServices.layer)), BunServices.layer))),
  )

const statuses = (o: Awaited<ReturnType<typeof go>>) => o.checks.map((c) => `${c.check}:${c.status}${c.reason ? ` (${c.reason})` : ""}`)

describe("mutation on changed lines", () => {
  test("a gate on changed is told to count only the changed lines; on all it isn't", async () => {
    const seen: GateContext[] = []
    await go("verify { mutation >= 0% on changed }", seen)
    await go("verify { mutation >= 0% }", seen)
    expect(seen.map((c) => c.changedLinesOnly === true)).toEqual([true, false])
  })

  test("a threshold counts only the mutants on the changed lines", async () => {
    // Line 3 has one killed and one surviving mutant; line 20's survivor is outside the change.
    expect(statuses(await go("verify { mutation >= 50% on changed }", []))).toEqual(["mutation:passed"])
    expect(statuses(await go("verify { mutation >= 60% on changed }", []))).toEqual(["mutation:failed (mutation 50% doesn't meet >= 60%)"])
  })

  test("a ratchet on changed blocks on a new survivor, and names it, without comparing whole-file scores", async () => {
    const baseline = Option.some({
      ...emptyBaseline("c", "h", "0"),
      metrics: { mutation: { value: 40, unit: "%" as const, higherIsBetter: true, perFile: { "src/A.kt": 40 } } },
    })
    const o = await go("verify { mutation ratchet on changed }", [], baseline)
    expect(statuses(o)).toEqual(["mutation:failed (1 mutant on the changed lines survives)"])
    expect(o.regressions).toEqual([])
    expect(o.newViolations).toEqual([{ check: "mutation", ruleId: "mutation/survived", message: "No test kills a conditional-boundary mutant", path: "src/A.kt", line: 3 }])
  })
})

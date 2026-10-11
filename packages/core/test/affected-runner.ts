import { BunServices } from "@effect/platform-bun"
import type { Baseline } from "@gauntlet/sarif"
import { Effect, Layer, Option } from "effect"
import { jvm } from "../../dsl/test/fixtures/catalog.ts"
import { type GateContext, type GateRun, type GateRunnerInput, type Pack, type PreparedWorkspace, ProcessRunnerLive, runGates, type SuiteImpl, type TestSubset } from "../src/index.ts"
import { compiled, noFacts } from "./fixtures.ts"

// The gate runner over an affected suite (spec 0013), with a suite runner that
// records what it was asked to run: the context it got and any subset.

const workspace: PreparedWorkspace = {
  dir: "/checkout",
  base: "b",
  head: "h",
  materialised: [],
  outputDir: (check) => Effect.succeed(`/out/${check}`),
  collect: () => Effect.succeed([{ path: "TEST-unit.xml", content: "<testsuite/>" }]),
}
const counts = (executed: number) => ({ executed, passed: executed, failed: 0, errored: 0, skipped: 0 })

export const calls: Array<{ ctx: GateContext; subset?: TestSubset }> = []

export const suite = (out: (subset?: TestSubset) => GateRun): SuiteImpl => (_s, ctx, subset) =>
  Effect.sync(() => {
    calls.push({ ctx, ...(subset ? { subset } : {}) })
    return out(subset)
  })

export const pack = (runSuite: SuiteImpl): Pack => ({ spec: jvm, runnerConfig: [], manifests: [], detectors: [], gates: {}, runSuite, reruns: true, testMaps: true })

/** A suite run that ran these tests, all passing. */
export const ran = (ids: string[]): GateRun => ({ command: ["gradle"], exitCode: 0, runs: [], tests: { counts: counts(ids.length), ids } })

const policy = (use = "use jvm") => compiled(`gauntlet "x"
${use}
owners @p
suites {
  unit "**/src/test/**" affected
}
gates { verify { unit } }
`).ir

export const go = (p: Pack, over: { recording?: boolean; baseline?: Baseline; use?: string; changed?: string; input?: Partial<GateRunnerInput> } = {}) => {
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
      ...over.input,
    }).pipe(Effect.provide(Layer.mergeAll(ProcessRunnerLive.pipe(Layer.provide(BunServices.layer)), BunServices.layer))),
  )
}

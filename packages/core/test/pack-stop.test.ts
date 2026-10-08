import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Option } from "effect"
import { jvm } from "../../dsl/test/fixtures/catalog.ts"
import { type Pack, type PreparedWorkspace, ProcessRunnerLive, runGates } from "../src/index.ts"
import { compiled, noFacts } from "./fixtures.ts"

// ADR 0020: a pack's `stop` runs once, after the check's gates, with the
// directory every output directory of the check sits in.

const workspace: PreparedWorkspace = {
  dir: "/checkout",
  base: "b",
  head: "h",
  materialised: [],
  outputDir: (check) => Effect.succeed(`/outs/${check}`),
  collect: () => Effect.succeed([]),
}

const go = (gates: string, pack: Pack) =>
  Effect.runPromise(
    runGates({ ir: compiled(`gauntlet "x"\nuse jvm\nowners @p\ngates { ${gates} }\n`).ir, facts: noFacts(), workspace, packs: [pack], baseline: Option.none(), renames: new Map(), files: [] })
      .pipe(Effect.provide(Layer.mergeAll(ProcessRunnerLive.pipe(Layer.provide(BunServices.layer)), BunServices.layer))),
  )

describe("pack stop", () => {
  test("is called once after every gate, with the checkout and the outputs' directory", async () => {
    const events: string[] = []
    const pack: Pack = {
      spec: jvm, runnerConfig: [], manifests: [], detectors: [],
      gates: { build: () => Effect.sync(() => (events.push("build"), { command: ["b"], exitCode: 0, runs: [] })), arch: () => Effect.sync(() => (events.push("arch"), { command: ["a"], exitCode: 0, runs: [] })) },
      stop: (check) => Effect.sync(() => void events.push(`stop ${check.dir} ${check.root}`)),
    }
    await go("fast { build } verify { arch }", pack)
    expect(events).toEqual(["build", "arch", "stop /checkout /outs"])
  })

  test("isn't called when no gate ran", async () => {
    const events: string[] = []
    const pack: Pack = { spec: jvm, runnerConfig: [], manifests: [], detectors: [], gates: {}, stop: () => Effect.sync(() => void events.push("stop")) }
    await go("fast { build }", pack)
    expect(events).toEqual([])
  })
})

import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Option } from "effect"
import { jvm } from "../../dsl/test/fixtures/catalog.ts"
import { buildSlug, type GateRun, type Pack, type PreparedWorkspace, ProcessRunnerLive, runGates } from "../src/index.ts"
import { compiled, noFacts } from "./fixtures.ts"

// ADR 0022: each build writes into its own output directories. A build whose
// directory can't be made errors the check, naming the build; it never passes.

const workspace: PreparedWorkspace = {
  dir: "/checkout",
  base: "b",
  head: "h",
  materialised: [],
  // A build's directories are under build-…/; this workspace can't make them.
  outputDir: (check) => (check.startsWith("build-") ? Effect.fail({ _tag: "OutputDirUnavailable", check, reason: "full" } as never) : Effect.succeed(`/out/${check}`)),
  collect: () => Effect.succeed([]),
}
const pack: Pack = { spec: jvm, runnerConfig: [], manifests: [], detectors: [], gates: { build: () => Effect.succeed({ command: ["tool"], exitCode: 0, runs: [] } satisfies GateRun) } }

describe("a build's output directories", () => {
  test("one that can't be made errors the check and names the build", async () => {
    const o = await Effect.runPromise(
      runGates({ ir: compiled(`gauntlet "x"\nuse jvm in "api"\nowners @p\ngates { fast { build } }\n`).ir, facts: noFacts({ files: [{ path: "api/A.kt", status: "modified", added: 1, removed: 0 }] }), workspace, packs: [pack], baseline: Option.none(), renames: new Map(), files: [] })
        .pipe(Effect.provide(Layer.mergeAll(ProcessRunnerLive.pipe(Layer.provide(BunServices.layer)), BunServices.layer))),
    )
    expect(o.checks.map((c) => `${c.check}:${c.status} (${c.reason})`)).toEqual(["build:errored (api: couldn't create an output directory)"])
  })

  test("folders that look alike get different directories", () => {
    expect(buildSlug("a/b")).not.toBe(buildSlug("a-b"))
    expect(buildSlug(".")).toBe("build-root")
  })
})

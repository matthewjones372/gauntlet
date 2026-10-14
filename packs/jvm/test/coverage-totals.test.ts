import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { type GateContext, ProcessRunner } from "@gauntlet/core"
import { Effect, Layer } from "effect"
import { coverage } from "../src/gates.ts"

// Spec 0017 §3: the coverage gate records what each file's value is out of, so
// the baseline's project value can be worked out again without removed files.
// The CI's Kover report stands in for running Gradle (ADR 0024).

const KOVER = `<report name="r"><package name="svc">`
  + `<sourcefile name="Fx.kt"><line nr="3" mi="0" ci="2"/><line nr="4" mi="3" ci="0"/><line nr="5" mi="0" ci="1"/><line nr="6" mi="0" ci="1"/></sourcefile>`
  + `<sourcefile name="Rates.kt"><line nr="2" mi="1" ci="0"/></sourcefile>`
  + `</package></report>`

const ctx: GateContext = {
  dir: "/checkout",
  outputDir: "/out/1-coverage",
  collect: Effect.succeed([{ path: "build/reports/kover/report.xml", content: KOVER }]),
  ir: { zones: [], arch: [] } as never,
  facts: { addedLines: new Map() } as never,
  files: ["src/main/kotlin/svc/Fx.kt", "src/main/kotlin/svc/Rates.kt"],
  legacy: [],
  fromCi: true,
}

const noProcesses = Layer.succeed(ProcessRunner, { run: () => Effect.die("no process should run") } as never)

describe("JVM coverage from the CI's report", () => {
  test("records each file's value and the lines it's out of", async () => {
    const r = await Effect.runPromise(coverage({ kind: "gate", name: "coverage" } as never, ctx).pipe(Effect.provide(Layer.mergeAll(noProcesses, BunServices.layer))))
    expect(r.metrics?.coverage).toEqual({
      value: 60,
      unit: "%",
      higherIsBetter: true,
      perFile: { "src/main/kotlin/svc/Fx.kt": 75, "src/main/kotlin/svc/Rates.kt": 0 },
      perFileTotal: { "src/main/kotlin/svc/Fx.kt": 4, "src/main/kotlin/svc/Rates.kt": 1 },
    })
  })
})

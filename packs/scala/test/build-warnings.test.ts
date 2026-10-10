import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { type GateContext, ProcessRunner, type RunRequest } from "@gauntlet/core"
import { Effect, Layer } from "effect"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { build, warnings } from "../src/gates.ts"

// The Scala build keeps scalac's warnings from its own compile (spec 0010);
// the warnings check uses them, or compiles itself when no build ran. A
// scripted sbt prints a Scala 3 warning.

const setup = (stdout: (dir: string) => string) => {
  const dir = mkdtempSync(join(tmpdir(), "scala-warn-"))
  for (const [p, t] of Object.entries({ "build.sbt": "scalaVersion := \"3.10.0\"\n", "src/main/scala/calc/Calc.scala": "package calc\n" })) {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), t)
  }
  const out = join(mkdtempSync(join(tmpdir(), "scala-warn-out-")), "0-check")
  mkdirSync(out)
  const ctx: GateContext = {
    dir, outputDir: out,
    collect: Effect.sync(() => readdirSync(out).map((name) => ({ path: name, content: readFileSync(join(out, name), "utf8") }))),
    ir: { zones: [], arch: [] } as never, facts: { addedLines: new Map() } as never, files: ["build.sbt", "src/main/scala/calc/Calc.scala"], legacy: [],
  }
  const calls: RunRequest[] = []
  const layer = Layer.mergeAll(Layer.succeed(ProcessRunner, { run: (r) => Effect.sync(() => (calls.push(r), { exitCode: 0, stdout: stdout(dir), stderr: "" })) }), BunServices.layer)
  const run = <A>(e: Effect.Effect<A, never, unknown>) => Effect.runPromise(e.pipe(Effect.provide(layer)) as Effect.Effect<A, never, never>)
  return { ctx, calls, run }
}
const warned = (dir: string) => [
  `[warn] -- [E198] Unused Symbol Warning: ${dir}/src/main/scala/calc/Calc.scala:5:8 ----`,
  "[warn] 5 |    val unused = 1",
  "[warn]   |        ^^^^^^",
  "[warn]   |        unused local definition",
].join("\n")
const GATE = { kind: "gate", name: "build" } as never

describe("Scala compiler warnings", () => {
  test("the build keeps scalac's warnings from its compile", async () => {
    const s = setup(warned)
    const r = await s.run(build(GATE, s.ctx))
    expect(r.runs.map((x) => [x.tool.driver.name, x.results.map((y) => y.message.text)])).toEqual([["scalac", ["unused local definition"]]])
  })

  test("the warnings check uses the build's, or compiles itself when no build ran", async () => {
    const given = setup(warned)
    await given.run(warnings(GATE, { ...given.ctx, buildWarnings: [] }))
    expect(given.calls).toEqual([])
    const alone = setup(warned)
    const r = await alone.run(warnings(GATE, alone.ctx))
    expect(alone.calls.length).toBeGreaterThan(0)
    expect(r.runs[0]!.results).toHaveLength(1)
  })
})

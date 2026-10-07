import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { type GateContext, ProcessRunner, type RunRequest } from "../src/index.ts"

// A gate context over a temporary checkout, and a process runner that only
// records what it was asked to run, for testing how packs build commands.

export const fakeGate = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "gauntlet-gate-"))
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), t)
  }
  const out = join(mkdtempSync(join(tmpdir(), "gauntlet-out-")), "0-check")
  mkdirSync(out)
  const ctx: GateContext = {
    dir,
    outputDir: out,
    collect: Effect.sync(() => readdirSync(out, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => ({ path: join(e.parentPath, e.name).slice(out.length + 1), content: readFileSync(join(e.parentPath, e.name), "utf8") }))),
    ir: { zones: [], arch: [] } as never,
    facts: { addedLines: new Map() } as never,
    files: Object.keys(files).sort(),
    legacy: [],
  }
  const calls: RunRequest[] = []
  const layer = Layer.mergeAll(Layer.succeed(ProcessRunner, { run: (r) => Effect.sync(() => (calls.push(r), { exitCode: 0, stdout: "", stderr: "" })) }), BunServices.layer)
  const run = <A, E, R>(e: Effect.Effect<A, E, R>) => Effect.runPromise(e.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>)
  return { ctx, calls, run }
}

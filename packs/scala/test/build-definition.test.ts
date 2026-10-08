import { afterEach, describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { type GateContext, ProcessRunner, type RunRequest } from "@gauntlet/core"
import { Effect, Layer } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildDefinitionKey, warmBuildDefinition } from "../src/toolchain.ts"

// ADR 0020: sbt's compiled build definition is built once per key, from the
// base files alone, and copied into each check's checkout.

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  delete process.env.GAUNTLET_CACHE_DIR
})
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

describe("the build definition cache key", () => {
  const plugins = { path: "project/plugins.sbt", text: `addSbtPlugin("org.scoverage" % "sbt-scoverage" % "2.4.4")\n` }
  const props = { path: "project/build.properties", text: "sbt.version=1.13.0\n" }

  test("depends on every file and the JDK, not their order", () => {
    expect(buildDefinitionKey([plugins, props], "jdk 25")).toBe(buildDefinitionKey([props, plugins], "jdk 25"))
    expect(buildDefinitionKey([plugins, props], "jdk 25")).not.toBe(buildDefinitionKey([plugins, props], "jdk 21"))
    expect(buildDefinitionKey([plugins, { ...props, text: "sbt.version=1.12.0\n" }], "jdk 25")).not.toBe(buildDefinitionKey([plugins, props], "jdk 25"))
  })
})

describe("warming the build definition", () => {
  const checkout = (files: Record<string, string>) => {
    const dir = temp("gauntlet-sbt-checkout-")
    for (const [p, t] of Object.entries(files)) {
      mkdirSync(join(dir, p, ".."), { recursive: true })
      writeFileSync(join(dir, p), t)
    }
    const outs = join(temp("gauntlet-sbt-outs-"), "0-build")
    mkdirSync(outs, { recursive: true })
    const ctx: GateContext = { dir, outputDir: outs, collect: Effect.succeed([]), ir: {} as never, facts: {} as never, files: Object.keys(files).sort(), legacy: [] }
    return ctx
  }
  // A fake sbt that "compiles" the build definition by writing project/target.
  const runner = (calls: RunRequest[]) =>
    Layer.mergeAll(Layer.succeed(ProcessRunner, {
      run: (r) => Effect.sync(() => {
        calls.push(r)
        if (r.command === "sbt") {
          mkdirSync(join(r.cwd, "project", "target"), { recursive: true })
          writeFileSync(join(r.cwd, "project", "target", "compiled.txt"), readFileSync(join(r.cwd, "project", "plugins.sbt"), "utf8"))
          // Only base build files are present where it's built.
          writeFileSync(join(r.cwd, "project", "target", "seen.txt"), existsSync(join(r.cwd, "src")) ? "src" : "clean")
        }
        return { exitCode: 0, stdout: "", stderr: "openjdk 25" }
      }),
    }), BunServices.layer)

  test("builds once per key in a clean directory, then copies it into every checkout", async () => {
    process.env.GAUNTLET_CACHE_DIR = temp("gauntlet-cache-")
    const files = { "project/plugins.sbt": "addSbtPlugin(x)\n", "project/build.properties": "sbt.version=1.13.0\n", "src/main/scala/A.scala": "object A" }
    const calls: RunRequest[] = []
    const first = checkout(files)
    await Effect.runPromise(warmBuildDefinition(first).pipe(Effect.provide(runner(calls))))
    const second = checkout(files)
    await Effect.runPromise(warmBuildDefinition(second).pipe(Effect.provide(runner(calls))))
    expect(calls.filter((c) => c.command === "sbt").length).toBe(1)
    for (const c of [first, second]) {
      expect(readFileSync(join(c.dir, "project", "target", "compiled.txt"), "utf8")).toBe("addSbtPlugin(x)\n")
      expect(readFileSync(join(c.dir, "project", "target", "seen.txt"), "utf8")).toBe("clean")
    }
  })

  test("a different build definition gets its own build", async () => {
    process.env.GAUNTLET_CACHE_DIR = temp("gauntlet-cache-")
    const calls: RunRequest[] = []
    await Effect.runPromise(warmBuildDefinition(checkout({ "project/plugins.sbt": "a\n" })).pipe(Effect.provide(runner(calls))))
    await Effect.runPromise(warmBuildDefinition(checkout({ "project/plugins.sbt": "b\n" })).pipe(Effect.provide(runner(calls))))
    expect(calls.filter((c) => c.command === "sbt").length).toBe(2)
  })

  test("a checkout that already has a compiled build definition is left alone", async () => {
    process.env.GAUNTLET_CACHE_DIR = temp("gauntlet-cache-")
    const calls: RunRequest[] = []
    const c = checkout({ "project/plugins.sbt": "a\n", "project/target/mine.txt": "x" })
    await Effect.runPromise(warmBuildDefinition(c).pipe(Effect.provide(runner(calls))))
    expect(calls).toEqual([])
  })
})

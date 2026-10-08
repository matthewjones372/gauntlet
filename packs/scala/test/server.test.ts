import { afterEach, describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { type GateContext, ProcessRunner, type RunRequest } from "@gauntlet/core"
import { Effect, Layer } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stopServer, warmBuildDefinition } from "../src/toolchain.ts"

// ADR 0020: the check's sbt server is ended with the check.

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  delete process.env.GAUNTLET_CACHE_DIR
})
const temp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p))
  dirs.push(d)
  return d
}
const recorder = (calls: RunRequest[], onRun: (r: RunRequest) => void = () => {}) =>
  Layer.mergeAll(Layer.succeed(ProcessRunner, { run: (r) => Effect.sync(() => (calls.push(r), onRun(r), { exitCode: 0, stdout: "", stderr: "openjdk 25" })) }), BunServices.layer)

describe("stopping the check's sbt server", () => {
  test("a running server is asked to shut down, then anything with the check's marker is ended", async () => {
    const dir = temp("gauntlet-sbt-")
    mkdirSync(join(dir, "project", "target"), { recursive: true })
    writeFileSync(join(dir, "project", "target", "active.json"), "{}")
    const calls: RunRequest[] = []
    await Effect.runPromise(stopServer({ dir, root: "/tmp/gauntlet-x/outputs" }).pipe(Effect.provide(recorder(calls))))
    expect(calls.map((c) => [c.command, ...c.args])).toEqual([["sbt", "--client", "shutdown"], ["pkill", "-f", "--", "-Dgauntlet.check=/tmp/gauntlet-x/outputs"]])
  })

  test("with no server running, no client is started just to stop one", async () => {
    const calls: RunRequest[] = []
    await Effect.runPromise(stopServer({ dir: temp("gauntlet-sbt-"), root: "/tmp/r" }).pipe(Effect.provide(recorder(calls))))
    expect(calls.map((c) => c.command)).toEqual(["pkill"])
  })
})

describe("the cached build definition", () => {
  test("a meta-build's own project/project is copied too", async () => {
    process.env.GAUNTLET_CACHE_DIR = temp("gauntlet-cache-")
    const dir = temp("gauntlet-checkout-")
    mkdirSync(join(dir, "project"), { recursive: true })
    writeFileSync(join(dir, "project", "plugins.sbt"), "addSbtPlugin(x)\n")
    const outs = join(temp("gauntlet-outs-"), "0-build")
    mkdirSync(outs, { recursive: true })
    const ctx: GateContext = { dir, outputDir: outs, collect: Effect.succeed([]), ir: {} as never, facts: {} as never, files: ["project/plugins.sbt"], legacy: [] }
    const calls: RunRequest[] = []
    await Effect.runPromise(warmBuildDefinition(ctx).pipe(Effect.provide(recorder(calls, (r) => {
      if (r.command !== "sbt") return
      mkdirSync(join(r.cwd, "project", "target"), { recursive: true })
      mkdirSync(join(r.cwd, "project", "project", "target"), { recursive: true })
      writeFileSync(join(r.cwd, "project", "project", "target", "meta.txt"), "meta")
    }))))
    expect(existsSync(join(dir, "project", "target"))).toBe(true)
    expect(readFileSync(join(dir, "project", "project", "target", "meta.txt"), "utf8")).toBe("meta")
  })
})

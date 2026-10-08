import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { type GateContext, ProcessRunner, type RunRequest } from "@gauntlet/core"
import { Effect, Layer } from "effect"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildJvmArgs, daemonMarker, gradle, stopDaemon } from "../src/gradle.ts"

// ADR 0020: the check's Gradle daemon runs with the build's own JVM arguments
// plus a marker no other build carries.

describe("the check's Gradle daemon", () => {
  test("uses the build's org.gradle.jvmargs, continuation lines included", () => {
    expect(buildJvmArgs("org.gradle.caching=true\norg.gradle.jvmargs=-Xmx2g -Dfile.encoding=UTF-8\n")).toBe("-Xmx2g -Dfile.encoding=UTF-8")
    expect(buildJvmArgs("org.gradle.jvmargs = -Xmx1g \\\n    -XX:+UseParallelGC\n")).toBe("-Xmx1g -XX:+UseParallelGC")
    expect(buildJvmArgs("org.gradle.jvmargs:-Xmx3g")).toBe("-Xmx3g")
  })

  test("falls back to Gradle's default when the build sets none", () => {
    expect(buildJvmArgs(undefined)).toBe("-Xmx512m -XX:MaxMetaspaceSize=384m")
    expect(buildJvmArgs("org.gradle.jvmargs=\n")).toBe("-Xmx512m -XX:MaxMetaspaceSize=384m")
  })

  test("the marker names the check's directory", () => {
    expect(daemonMarker("/tmp/gauntlet-abc/outputs")).toBe("-Dgauntlet.check=/tmp/gauntlet-abc/outputs")
  })
})

describe("running Gradle", () => {
  const recorded: RunRequest[] = []
  const layer = Layer.mergeAll(Layer.succeed(ProcessRunner, { run: (r) => Effect.sync(() => (recorded.push(r), { exitCode: 0, stdout: "", stderr: "" })) }), BunServices.layer)
  const ctx = (dir: string): GateContext => ({ dir, outputDir: join(dir, "outs", "0-build"), collect: Effect.succeed([]), ir: {} as never, facts: {} as never, files: [], legacy: [] })

  test("without a wrapper, it says so and starts nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gauntlet-gradle-"))
    recorded.length = 0
    const r = await Effect.runPromise(gradle(ctx(dir), ["classes"]).pipe(Effect.provide(layer)))
    expect(r.error).toBe("no Gradle wrapper (gradlew) in the repository")
    expect(recorded).toEqual([])
  })

  test("the daemon runs with the build's JVM arguments plus the check's marker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gauntlet-gradle-"))
    mkdirSync(join(dir, "outs"), { recursive: true })
    writeFileSync(join(dir, "gradlew"), "#!/bin/sh\n", { mode: 0o755 })
    writeFileSync(join(dir, "gradle.properties"), "org.gradle.jvmargs=-Xmx2g\n")
    recorded.length = 0
    await Effect.runPromise(gradle(ctx(dir), ["classes"]).pipe(Effect.provide(layer)))
    expect(recorded[0]!.args).toContain(`-Dorg.gradle.jvmargs=-Xmx2g -Dgauntlet.check=${join(dir, "outs")}`)
    expect(recorded[0]!.args).toContain("--daemon")
    expect(recorded[0]!.args).not.toContain("--no-daemon")
  })

  test("stopping ends only the process carrying the check's marker", async () => {
    recorded.length = 0
    await Effect.runPromise(stopDaemon("/tmp/gauntlet-x/outputs").pipe(Effect.provide(layer)))
    expect(recorded.map((r) => [r.command, ...r.args])).toEqual([["pkill", "-f", "--", "-Dgauntlet.check=/tmp/gauntlet-x/outputs"]])
  })
})

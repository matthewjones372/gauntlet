import { BunServices } from "@effect/platform-bun"
import { type GateContext, ProcessRunner, type RunRequest } from "@gauntlet/core"
import { Effect, Layer } from "effect"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { execFile } from "./exec-file.ts"

// A checkout and a fake Gradle for the test map's tests (spec 0013): it writes
// JUnit XML, and each test class's execution data when the map is recorded.

const SOURCES: Record<string, string> = {
  gradlew: "#!/bin/sh\n",
  "src/main/kotlin/svc/Fx.kt": "package svc\n\nclass Fx\n",
  "src/main/kotlin/svc/Money.kt": "package svc\n\nclass Money\n",
  "src/test/kotlin/svc/FxTest.kt": "package svc\n\nclass FxTest\n",
  "src/test/kotlin/svc/MoneyTest.kt": "package svc\n\nclass MoneyTest\n",
}
const JUNIT = `<testsuite name="svc"><testcase classname="svc.FxTest" name="converts"/><testcase classname="svc.MoneyTest" name="adds"/></testsuite>`

/** A checkout, and a Gradle that writes JUnit XML, plus each test class's execution data when mapping. */
export const gradle = (execs: Record<string, Uint8Array> = { "svc.FxTest": execFile([{ name: "svc/Fx", probes: [true] }]), "svc.MoneyTest": execFile([{ name: "svc/Money", probes: [true] }]) }, extra: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "gauntlet-affected-"))
  for (const [p, t] of Object.entries(SOURCES)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), t)
  }
  const out = join(mkdtempSync(join(tmpdir(), "gauntlet-out-")), "0-unit")
  mkdirSync(out)
  const calls: RunRequest[] = []
  const write = (path: string, content: string | Uint8Array) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  const runner = Layer.succeed(ProcessRunner, {
    run: (r) =>
      Effect.sync(() => {
        calls.push(r)
        const target = r.env!.GAUNTLET_OUT!
        write(join(target, "junit/root/test/TEST-svc.xml"), JUNIT)
        if (r.env!.GAUNTLET_TEST_MAP) {
          for (const [cls, bytes] of Object.entries(execs)) write(join(target, `testmap/root/test/${cls}.exec`), bytes)
          for (const [name, content] of Object.entries(extra)) write(join(target, `testmap/root/test/${name}`), content)
        }
        return { exitCode: 0, stdout: "", stderr: "" }
      }),
  })
  const ctx: GateContext = {
    dir,
    outputDir: out,
    collect: Effect.sync(() => readdirSync(out, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => ({ path: join(e.parentPath, e.name).slice(out.length + 1), content: readFileSync(join(e.parentPath, e.name), "utf8") }))),
    ir: { zones: [], arch: [] } as never,
    facts: { addedLines: new Map() } as never,
    files: Object.keys(SOURCES).sort(),
    legacy: [],
  }
  const run = <A, E, R>(e: Effect.Effect<A, E, R>) => Effect.runPromise(e.pipe(Effect.provide(Layer.mergeAll(runner, BunServices.layer))) as Effect.Effect<A, E, never>)
  return { ctx, calls, run, out }
}

import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { type GateContext, ProcessRunner, type RunRequest } from "@gauntlet/core"
import { Effect, Layer } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { runSuite } from "../src/gates.ts"
import { LISTENER_CLASS } from "../src/testmap-listener.ts"
import { execFile } from "./exec-file.ts"

// An affected suite on the JVM (spec 0013): a baseline runs the suite once more
// to map what each test class executes; a check runs the selected classes.

const SOURCES: Record<string, string> = {
  gradlew: "#!/bin/sh\n",
  "src/main/kotlin/svc/Fx.kt": "package svc\n\nclass Fx\n",
  "src/main/kotlin/svc/Money.kt": "package svc\n\nclass Money\n",
  "src/test/kotlin/svc/FxTest.kt": "package svc\n\nclass FxTest\n",
  "src/test/kotlin/svc/MoneyTest.kt": "package svc\n\nclass MoneyTest\n",
}
const JUNIT = `<testsuite name="svc"><testcase classname="svc.FxTest" name="converts"/><testcase classname="svc.MoneyTest" name="adds"/></testsuite>`

/** A checkout, and a Gradle that writes JUnit XML, plus each test class's execution data when mapping. */
const gradle = (execs: Record<string, Uint8Array> = { "svc.FxTest": execFile([{ name: "svc/Fx", probes: [true] }]), "svc.MoneyTest": execFile([{ name: "svc/Money", probes: [true] }]) }, extra: Record<string, string> = {}) => {
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

const unit = { name: "unit", location: "src/test/**" }

describe("an affected JVM suite", () => {
  test("a baseline runs the suite again with the listener and JaCoCo, apart from the suite's reports, and maps each class", async () => {
    const g = gradle()
    const r = await g.run(runSuite(unit, { ...g.ctx, recordTestMap: true }))
    expect(r.tests?.ids).toEqual(["svc.FxTest.converts", "svc.MoneyTest.adds"])
    expect(r.testMap).toEqual({
      "svc.FxTest": ["src/main/kotlin/svc/Fx.kt", "src/test/kotlin/svc/FxTest.kt"],
      "svc.MoneyTest": ["src/main/kotlin/svc/Money.kt", "src/test/kotlin/svc/MoneyTest.kt"],
    })
    const mapping = g.calls[1]!
    expect(mapping.args.slice(-1)).toEqual(["test"])
    expect(mapping.env?.GAUNTLET_OUT).toBe(`${g.out}-testmap`)
    expect(mapping.env?.GAUNTLET_TEST_MAP_INCLUDES).toBe("svc.*")
    const listener = mapping.env!.GAUNTLET_TEST_MAP!
    expect(readFileSync(join(listener, "META-INF/services/org.junit.platform.launcher.TestExecutionListener"), "utf8").trim()).toBe(LISTENER_CLASS)
    expect(existsSync(join(listener, "gauntlet/TestMapListener.class"))).toBe(true)
    // The suite's own proof stays its own run's.
    expect(readdirSync(g.out, { recursive: true }).some((p) => String(p).includes("testmap"))).toBe(false)
  })

  test("no map when classes ran at once, the listener failed, or a test class that ran has no data", async () => {
    for (const g of [gradle(undefined, { overlap: "a and b" }), gradle(undefined, { failed: "no JaCoCo" }), gradle({ "svc.FxTest": execFile([{ name: "svc/Fx", probes: [true] }]) })]) {
      const r = await g.run(runSuite(unit, { ...g.ctx, recordTestMap: true }))
      expect(r.tests?.ids).toHaveLength(2)
      expect(r.testMap).toBeUndefined()
    }
  })

  test("a check runs the selected classes and new test files, in the usual order, measuring coverage when asked", async () => {
    const g = gradle()
    await g.run(runSuite(unit, { ...g.ctx, withCoverage: true }, { files: ["src/test/kotlin/svc/NewTest.kt"], ids: [], seed: 7, classes: ["svc.FxTest"], affected: true }))
    const call = g.calls[0]!
    expect(call.args.slice(-6)).toEqual(["test", "--tests", "svc.FxTest", "--tests", "svc.NewTest", "gauntletCoverage"])
    expect(call.env?.GAUNTLET_SELECTED).toBe("1")
    expect(call.env?.GAUNTLET_JUNIT_SEED).toBeUndefined()
    expect(g.calls).toHaveLength(1)
  })
})

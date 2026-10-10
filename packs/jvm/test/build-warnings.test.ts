import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { ProcessRunner, type RunRequest } from "@gauntlet/core"
import { Effect, Layer } from "effect"
import { fakeGate } from "../../../packages/core/test/fake-gate.ts"
import { build, warnings } from "../src/gates.ts"

// The build compiles at warning level, so kotlinc's and javac's warnings are
// read once, from its own output (spec 0010); the warnings check uses them,
// or compiles itself when no build ran.

const output = (dir: string) => `> Task :compileKotlin\nw: file://${dir}/src/main/kotlin/Fx.kt:3:9 Unchecked cast of 'Any' to 'List<String>'.\n`
const run = <A>(e: Effect.Effect<A, never, never>) => Effect.runPromise(e)
const withGradle = (stdout: (dir: string) => string, calls: RunRequest[]) =>
  Layer.mergeAll(Layer.succeed(ProcessRunner, { run: (r) => Effect.sync(() => (calls.push(r), { exitCode: 0, stdout: stdout(r.cwd), stderr: "" })) }), BunServices.layer)

describe("JVM compiler warnings", () => {
  test("the build runs Gradle at warning level and keeps kotlinc's warnings, each once", async () => {
    const g = fakeGate({ gradlew: "#!/bin/sh\n", "src/main/kotlin/Fx.kt": "class Fx\n" })
    const calls: RunRequest[] = []
    const r = await run(build({ kind: "gate", name: "build" } as never, g.ctx).pipe(Effect.provide(withGradle(output, calls))) as never) as { runs: Array<{ tool: { driver: { name: string } }; results: unknown[] }> }
    expect(calls[0]!.args).toContain("--warn")
    expect(calls[0]!.args).not.toContain("-q")
    expect(r.runs.map((x) => [x.tool.driver.name, x.results.length])).toEqual([["kotlinc", 1], ["javac", 0]])
  })

  test("the warnings check uses the build's warnings without compiling again", async () => {
    const g = fakeGate({ gradlew: "#!/bin/sh\n" })
    const calls: RunRequest[] = []
    const given = [{ tool: { driver: { name: "kotlinc" } }, results: [] }] as never
    const r = await run(warnings({ kind: "gate", name: "warnings" } as never, { ...g.ctx, buildWarnings: given }).pipe(Effect.provide(withGradle(output, calls))) as never) as { command: string[] }
    expect(calls).toEqual([])
    expect(r.command).toEqual(["(the build check's compiler output)"])
  })

  test("with no build in this check, it compiles itself", async () => {
    const g = fakeGate({ gradlew: "#!/bin/sh\n" })
    const calls: RunRequest[] = []
    await run(warnings({ kind: "gate", name: "warnings" } as never, g.ctx).pipe(Effect.provide(withGradle(output, calls))) as never)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args).toContain("classes")
  })
})

import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { ProcessRunner } from "@gauntlet/core"
import { Effect, Layer } from "effect"
import { fakeGate } from "../../../packages/core/test/fake-gate.ts"
import { build, runSuite } from "../src/gates.ts"

// A build that fails says why (CI's sbt "exited with 1" said nothing): sbt's
// own [error] lines, wherever it printed them, without its timing line or the
// caret under the code; and the tail of what it printed when it marked none.

const failing = (stdout: string, stderr: string) =>
  Layer.mergeAll(Layer.succeed(ProcessRunner, { run: () => Effect.succeed({ exitCode: 1, stdout, stderr }) }), BunServices.layer)
const GATE = { kind: "gate", name: "build" } as never

const compile = (stdout: string, stderr = "") => {
  const g = fakeGate({ "build.sbt": "scalaVersion := \"3.10.0\"\n" })
  return Effect.runPromise(build(GATE, g.ctx).pipe(Effect.provide(failing(stdout, stderr))) as never) as Promise<{ exitCode: number; output?: string[] }>
}

describe("a failing sbt build says why", () => {
  test("sbt's error lines from stdout, not the JVM's warnings on stderr", async () => {
    const r = await compile([
      "[info] compiling 2 Scala sources to /w/target/scala-3.10.0/classes ...",
      "[error] -- [E006] Not Found Error: /w/src/main/scala/calc/Calc.scala:3:10 ",
      "[error] 3 |  def f = total",
      "[error]   |          ^^^^^",
      "[error]   |          Not found: total",
      "[error] one error found",
      "[error] (Compile / compileIncremental) Compilation failed",
      "[error] Total time: 3 s, completed 12 Oct 2026, 10:00:00",
    ].join("\n"), "WARNING: A terminally deprecated method in sun.misc.Unsafe has been called\n")
    expect(r.exitCode).toBe(1)
    expect(r.output).toEqual(["-- [E006] Not Found Error: /w/src/main/scala/calc/Calc.scala:3:10", "3 |  def f = total", "|          Not found: total", "one error found", "(Compile / compileIncremental) Compilation failed"])
  })

  test("an sbt that marks no error line: the tail of what it printed", async () => {
    const r = await compile("", "sbt server is already booting. Create a new server? y/n (default y)\njava.io.IOException: Connection refused\n")
    expect(r.output).toEqual(["sbt server is already booting. Create a new server? y/n (default y)", "java.io.IOException: Connection refused"])
  })
})

describe("an sbt that fails silently", () => {
  test("the suite's error says sbt printed nothing, rather than ending at a colon", async () => {
    const g = fakeGate({ "build.sbt": "scalaVersion := \"3.10.0\"\n" })
    const r = await Effect.runPromise(runSuite({ name: "unit", location: "**" }, g.ctx).pipe(Effect.provide(failing("", ""))) as never) as { error?: string }
    expect(r.error).toBe("sbt test failed before any test ran: sbt exited with 1 and printed nothing")
  })
})

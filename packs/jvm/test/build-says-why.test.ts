import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { ProcessRunner } from "@gauntlet/core"
import { Effect, Layer } from "effect"
import { fakeGate } from "../../../packages/core/test/fake-gate.ts"
import { build } from "../src/gates.ts"

// A Gradle build that fails says why: its "What went wrong" block, not the
// advice after it ("Run with --stacktrace") that ends its output.

const STDERR = [
  "e: file:///w/src/main/kotlin/Fx.kt:3:9 Unresolved reference 'total'.",
  "",
  "FAILURE: Build failed with an exception.",
  "",
  "* What went wrong:",
  "Execution failed for task ':compileKotlin'.",
  "> A failure occurred while executing org.jetbrains.kotlin.compilerRunner.GradleCompilerRunnerWithWorkers$GradleKotlinCompilerWorkAction",
  "   > Compilation error. See log for more details",
  "",
  "* Try:",
  "> Run with --stacktrace option to get the stack trace.",
  "> Get more help at https://help.gradle.org.",
  "",
  "BUILD FAILED in 2s",
].join("\n")

describe("a failing Gradle build says why", () => {
  test("its What went wrong block", async () => {
    const g = fakeGate({ gradlew: "#!/bin/sh\n", "src/main/kotlin/Fx.kt": "class Fx\n" })
    const layer = Layer.mergeAll(Layer.succeed(ProcessRunner, { run: () => Effect.succeed({ exitCode: 1, stdout: "", stderr: STDERR }) }), BunServices.layer)
    const r = await Effect.runPromise(build({ kind: "gate", name: "build" } as never, g.ctx).pipe(Effect.provide(layer)) as never) as { exitCode: number; output?: string[] }
    expect(r.exitCode).toBe(1)
    expect(r.output).toEqual([
      "Execution failed for task ':compileKotlin'.",
      "> A failure occurred while executing org.jetbrains.kotlin.compilerRunner.GradleCompilerRunnerWithWorkers$GradleKotlinCompilerWorkAction",
      "> Compilation error. See log for more details",
    ])
  })
})

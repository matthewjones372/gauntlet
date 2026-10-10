import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { ProcessRunner } from "@gauntlet/core"
import { Effect, Layer } from "effect"
import { fakeGate } from "../../../packages/core/test/fake-gate.ts"
import { lint } from "../src/gates.ts"

// detekt not applied to a build is a linter that isn't set up, which a
// repository with several builds can leave out for that build; detekt that
// ran and wrote nothing is a plain error.

const lintWith = (stderr: string) => {
  const g = fakeGate({ gradlew: "#!/bin/sh\n" })
  const layer = Layer.mergeAll(Layer.succeed(ProcessRunner, { run: () => Effect.succeed({ exitCode: 1, stdout: "", stderr }) }), BunServices.layer)
  return Effect.runPromise(lint({ check: "lint" } as never, g.ctx).pipe(Effect.provide(layer)) as Effect.Effect<{ error?: string; notSetUp?: true }>)
}

describe("detekt missing from a build", () => {
  test("not applied: an error marked as not set up", async () => {
    const run = await lintWith("Task 'detekt' not found in root project 'bank'.")
    expect(run.error).toBe("detekt isn't applied; add the dev.detekt Gradle plugin")
    expect(run.notSetUp).toBe(true)
  })

  test("applied but wrote no report: an error, not marked", async () => {
    const run = await lintWith("")
    expect(run.error).toBe("detekt wrote no report")
    expect(run.notSetUp).toBeUndefined()
  })
})

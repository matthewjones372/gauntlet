import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Layer } from "effect"
import { tmpdir } from "node:os"
import { ProcessRunner, ProcessRunnerLive } from "../src/index.ts"

const Runner = ProcessRunnerLive.pipe(Layer.provide(BunServices.layer))
const run = (request: Parameters<ProcessRunner["Service"]["run"]>[0]) =>
  Effect.runPromiseExit(ProcessRunner.use((r) => r.run(request)).pipe(Effect.provide(Runner)))

const tagOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (!Exit.isFailure(exit)) return undefined
  const fail = exit.cause.reasons.find((r) => r._tag === "Fail")
  return fail && "error" in fail ? (fail.error as { _tag: string })._tag : undefined
}

describe("ProcessRunner", () => {
  test("returns exit code, stdout and stderr", async () => {
    const exit = await run({ command: "sh", args: ["-c", "echo out; echo err >&2; exit 3"], cwd: tmpdir() })
    expect(exit).toEqual(Exit.succeed({ exitCode: 3, stdout: "out\n", stderr: "err\n" }))
  })

  test("an isolated environment doesn't leak Gauntlet's variables", async () => {
    process.env.GAUNTLET_TEST_SECRET = "leaked"
    const exit = await run({ command: "/bin/sh", args: ["-c", "echo \"[$GAUNTLET_TEST_SECRET][$ONLY]\""], cwd: tmpdir(), isolatedEnv: true, env: { ONLY: "this" } })
    expect(Exit.isSuccess(exit) && exit.value.stdout).toBe("[][this]\n")
  })

  test("times out with ProcessTimedOut", async () => {
    expect(tagOf(await run({ command: "sleep", args: ["5"], cwd: tmpdir(), timeout: "100 millis" }))).toBe("ProcessTimedOut")
  })

  test("a missing binary is ProcessFailed", async () => {
    expect(tagOf(await run({ command: "definitely-not-a-binary-gauntlet", args: [], cwd: tmpdir() }))).toBe("ProcessFailed")
  })
})

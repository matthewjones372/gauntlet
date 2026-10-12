import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer } from "effect"
import { tmpdir } from "node:os"
import { ProcessRunner, ProcessRunnerLive, toolTimeout, whyNotRun } from "../src/index.ts"

const Runner = ProcessRunnerLive.pipe(Layer.provide(BunServices.layer))
const failure = (request: Parameters<ProcessRunner["Service"]["run"]>[0]) =>
  Effect.runPromise(Effect.exit(ProcessRunner.use((r) => r.run(request))).pipe(Effect.provide(Runner)))

const minutes = (d: Duration.Input) => Duration.toMinutes(Duration.fromInputUnsafe(d))

describe("an explicit limit on how long a tool may run", () => {
  test("a tool's own limit applies unless GAUNTLET_TOOL_TIMEOUT sets one", () => {
    expect(minutes(toolTimeout("10 minutes", {}))).toBe(10)
    expect(minutes(toolTimeout("10 minutes", { GAUNTLET_TOOL_TIMEOUT: "3 minutes" }))).toBe(3)
    // A bare number is minutes, the unit people write in a workflow.
    expect(minutes(toolTimeout("10 minutes", { GAUNTLET_TOOL_TIMEOUT: "5" }))).toBe(5)
    // A value that isn't a duration keeps the tool's own limit rather than no limit.
    expect(minutes(toolTimeout("10 minutes", { GAUNTLET_TOOL_TIMEOUT: "soon" }))).toBe(10)
  })

  test("a tool that hangs is stopped and the reason says it ran out of time", async () => {
    const exit = await failure({ command: "sleep", args: ["5"], cwd: tmpdir(), timeout: "100 millis" })
    expect(exit._tag).toBe("Failure")
    const why = whyNotRun("sbt", exit)
    expect(why).toContain("sbt didn't finish within 100ms")
    expect(why).toContain("GAUNTLET_TOOL_TIMEOUT")
  })

  test("a tool that can't start says so, not that it timed out", async () => {
    const exit = await failure({ command: "definitely-not-a-binary-gauntlet", args: [], cwd: tmpdir() })
    const why = whyNotRun("definitely-not-a-binary-gauntlet", exit)
    expect(why).toStartWith("definitely-not-a-binary-gauntlet couldn't be started")
    expect(why).not.toContain("didn't finish")
  })
})

import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { STOP_SIGNALS, withStopSignals } from "../src/stop-signals.ts"

// A stopped run cleans up after itself: the signal interrupts the command, so
// its finalizers run (the judged checkout is unregistered) before it exits.

describe("withStopSignals", () => {
  for (const signal of STOP_SIGNALS) {
    test(`${signal} interrupts the run and its finalizers run`, async () => {
      let cleaned = false
      let started!: () => void
      const running = new Promise<void>((resolve) => { started = resolve })
      const done = Effect.runPromiseExit(
        Effect.sync(() => started()).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.sync(() => { cleaned = true })),
          withStopSignals,
        ),
      )
      await running
      process.emit(signal)
      const exit = await done
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(cleaned).toBe(true)
      expect(process.listenerCount(signal)).toBe(0)
    })
  }

  test("a run that ends leaves no signal listeners behind", async () => {
    expect(await Effect.runPromise(withStopSignals(Effect.succeed(1)))).toBe(1)
    for (const signal of STOP_SIGNALS) expect(process.listenerCount(signal)).toBe(0)
  })
})

import { Effect } from "effect"

export const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const

/**
 * Ctrl-C, or a hook or agent stopping the run, interrupts it so its finalizers
 * run: the judged checkout is unregistered and its temporary directory removed.
 * A second signal kills it the usual way.
 */
export const withStopSignals = <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.withFiber((fiber) => {
    const stop = () => fiber.interruptUnsafe()
    for (const signal of STOP_SIGNALS) process.once(signal, stop)
    return self.pipe(Effect.ensuring(Effect.sync(() => {
      for (const signal of STOP_SIGNALS) process.removeListener(signal, stop)
    })))
  })

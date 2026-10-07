import { Context, Effect, Layer, Ref } from "effect"

/** Where commands print. Tests capture it; the binary writes to stdout and stderr. */
export class Output extends Context.Service<Output, {
  readonly out: (text: string) => Effect.Effect<void>
  readonly err: (text: string) => Effect.Effect<void>
}>()("@gauntlet/cli/Output") {}

export const OutputLive = Layer.succeed(Output, {
  out: (text) => Effect.sync(() => void process.stdout.write(text.endsWith("\n") ? text : `${text}\n`)),
  err: (text) => Effect.sync(() => void process.stderr.write(text.endsWith("\n") ? text : `${text}\n`)),
})

/**
 * Exit codes:
 *   0  done; in enforce mode, nothing blocks
 *   1  the change is blocked (enforce mode), or the policy is invalid (validate)
 *   2  Gauntlet couldn't do its job: bad arguments, bad policy in `check`, git failure
 */
export class ExitStatus extends Context.Service<ExitStatus, Ref.Ref<number>>()("@gauntlet/cli/ExitStatus") {
  static readonly layer = Layer.effect(ExitStatus, Ref.make(0))
}

export const exitWith = (code: number) => ExitStatus.use((ref) => Ref.update(ref, (c) => Math.max(c, code)))

/** Standard input, for hooks that receive JSON from the coding agent. Defaults to the process's stdin; tests supply text. */
export const Stdin = Context.Reference<{ readonly text: Effect.Effect<string> }>("@gauntlet/cli/Stdin", {
  defaultValue: () => ({ text: Effect.promise(() => Bun.stdin.text()) }),
})
export const stdinText = (text: string) => Layer.succeed(Stdin, { text: Effect.succeed(text) })

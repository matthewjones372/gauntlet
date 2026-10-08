import { Context, Effect, Layer, Option, Ref } from "effect"
import { createInterface } from "node:readline/promises"

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

/** Asks on a terminal, or answers none when either stream isn't one (CI, a pipe, a hook). */
export const terminalQuestion = (input: NodeJS.ReadableStream & { readonly isTTY?: boolean }, output: NodeJS.WritableStream & { readonly isTTY?: boolean }) =>
  (text: string): Effect.Effect<Option.Option<string>> =>
    input.isTTY === true && output.isTTY === true
      ? Effect.promise(async () => {
        const rl = createInterface({ input, output })
        try {
          return Option.some((await rl.question(text)).trim())
        } finally {
          rl.close()
        }
      })
      : Effect.succeed(Option.none())

/** A question for the person at the terminal: none when nobody is there to answer (no TTY). Tests supply answers. */
export const Ask = Context.Reference<{ readonly question: (text: string) => Effect.Effect<Option.Option<string>> }>("@gauntlet/cli/Ask", {
  defaultValue: () => ({ question: terminalQuestion(process.stdin, process.stdout) }),
})
export const answers = (...replies: ReadonlyArray<string>) => {
  const queue = [...replies]
  return Layer.succeed(Ask, { question: () => Effect.sync(() => Option.fromNullishOr(queue.shift())) })
}

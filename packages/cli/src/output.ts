import { Context, Effect, Layer, Option, Ref } from "effect"
import { createInterface } from "node:readline/promises"
import { GateProgress, type GateProgressShape } from "@gauntlet/core"

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

/** A duration for people: 850ms, 12s, 3m 05s. */
const took = (ms: number) =>
  ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`

/**
 * Gate progress for a terminal: "  mutation... 42s" ticking while a gate runs,
 * then "  mutation: passed (1m 05s)". Nothing when stderr isn't a terminal.
 */
export const terminalGateProgress = (stream: NodeJS.WriteStream = process.stderr): GateProgressShape | undefined => {
  if (stream.isTTY !== true) return undefined
  let timer: ReturnType<typeof setInterval> | undefined
  return {
    start: (check) =>
      Effect.sync(() => {
        const started = Date.now()
        stream.write(`  ${check}...`)
        timer = setInterval(() => stream.write(`\r\x1b[K  ${check}... ${took(Date.now() - started)}`), 1000)
      }),
    end: (check, status, ms) =>
      Effect.sync(() => {
        if (timer !== undefined) clearInterval(timer)
        timer = undefined
        stream.write(`\r\x1b[K  ${check}: ${status} (${took(ms)})\n`)
      }),
  }
}

/** Runs a command a person is watching with gate progress shown, when there's a terminal to show it in. */
export const withGateProgress = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
  const shown = terminalGateProgress()
  return shown === undefined ? effect : effect.pipe(Effect.provideService(GateProgress, shown))
}

/**
 * Hands the terminal to Claude Code with a prompt, until the person quits it.
 * False when Claude Code isn't installed. Tests supply their own.
 */
export const LaunchAgent = Context.Reference<{ readonly claude: (cwd: string, prompt: string) => Effect.Effect<boolean> }>("@gauntlet/cli/LaunchAgent", {
  defaultValue: () => ({
    claude: (cwd, prompt) =>
      Effect.sync(() => {
        const bin = Bun.which("claude")
        if (bin === null) return false
        Bun.spawnSync([bin, prompt], { cwd, stdio: ["inherit", "inherit", "inherit"] })
        return true
      }),
  }),
})
export const launches = (calls: Array<{ cwd: string; prompt: string }>, installed = true) =>
  Layer.succeed(LaunchAgent, { claude: (cwd, prompt) => Effect.sync(() => (installed && calls.push({ cwd, prompt }), installed)) })

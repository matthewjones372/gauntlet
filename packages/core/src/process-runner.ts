import { Context, Data, Duration, Effect, Exit, Layer, Option, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export interface RunRequest {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  /** Extra or overriding environment variables. */
  readonly env?: Readonly<Record<string, string>>
  /** Start from an empty environment instead of inheriting Gauntlet's own. */
  readonly isolatedEnv?: boolean
  readonly timeout?: Duration.Input
  /** Written to the process's standard input: lists that would otherwise grow its argv past what the OS allows (E2BIG). */
  readonly stdin?: string
}

export interface RunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export class ProcessFailed extends Data.TaggedError("ProcessFailed")<{
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly reason: string
}> {}

export class ProcessTimedOut extends Data.TaggedError("ProcessTimedOut")<{
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly timeout: string
}> {}

/** Runs a subprocess to completion and returns its exit code and output. */
export class ProcessRunner extends Context.Service<ProcessRunner, {
  readonly run: (request: RunRequest) => Effect.Effect<RunResult, ProcessFailed | ProcessTimedOut>
}>()("@gauntlet/core/ProcessRunner") {}

const DEFAULT_TIMEOUT = "30 minutes"

/**
 * How long a tool may run: the tool's own limit, or GAUNTLET_TOOL_TIMEOUT
 * ("5 minutes", or a bare number of minutes) when it's set. A hung tool
 * otherwise holds a check, or a CI job, until something far above it gives up.
 */
export const toolTimeout = (fallback: Duration.Input, env: Readonly<Record<string, string | undefined>> = process.env): Duration.Input => {
  const set = env.GAUNTLET_TOOL_TIMEOUT?.trim()
  if (!set) return fallback
  const input = /^\d+(\.\d+)?$/.test(set) ? `${set} minutes` : set
  return Option.match(Duration.fromInput(input as Duration.Input), { onNone: () => fallback, onSome: (d) => d })
}

/** Why a tool's run produced no result, for a reason: it ran out of time, or never started. */
export const whyNotRun = (tool: string, exit: Exit.Exit<unknown, unknown>): string => {
  if (!Exit.isFailure(exit)) return `${tool} couldn't be run`
  const fail = exit.cause.reasons.find((r) => r._tag === "Fail")
  const error = fail && "error" in fail ? fail.error : undefined
  if (error instanceof ProcessTimedOut) return `${tool} didn't finish within ${error.timeout} and was stopped (it may have hung; GAUNTLET_TOOL_TIMEOUT sets the limit)`
  if (error instanceof ProcessFailed) return `${tool} couldn't be started: ${error.reason}`
  return `${tool} couldn't be started or was interrupted`
}

export const ProcessRunnerLive = Layer.effect(
  ProcessRunner,
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const text = <E>(stream: Stream.Stream<Uint8Array, E>) => stream.pipe(Stream.decodeText(), Stream.mkString)
    return {
      run: (request: RunRequest) => {
        const failed = (reason: unknown) =>
          new ProcessFailed({ command: request.command, args: request.args, reason: String(reason) })
        const timeout = request.timeout ?? toolTimeout(DEFAULT_TIMEOUT)
        return Effect.scoped(
          Effect.gen(function*() {
            const command = ChildProcess.make(request.command, [...request.args], {
              cwd: request.cwd,
              env: { ...request.env },
              extendEnv: !request.isolatedEnv,
              ...(request.stdin !== undefined ? { stdin: Stream.make(new TextEncoder().encode(request.stdin)) } : {}),
            })
            const handle = yield* spawner.spawn(command)
            const [stdout, stderr, exitCode] = yield* Effect.all(
              [text(handle.stdout), text(handle.stderr), handle.exitCode],
              { concurrency: "unbounded" },
            )
            return { exitCode: Number(exitCode), stdout, stderr }
          }),
        ).pipe(
          Effect.mapError(failed),
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () =>
              Effect.fail(new ProcessTimedOut({ command: request.command, args: request.args, timeout: Duration.format(Duration.fromInputUnsafe(timeout)) })),
          }),
        )
      },
    }
  }),
)

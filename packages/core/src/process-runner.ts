import { Context, Data, Duration, Effect, Layer, Stream } from "effect"
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

const DEFAULT_TIMEOUT = Duration.minutes(30)

export const ProcessRunnerLive = Layer.effect(
  ProcessRunner,
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const text = <E>(stream: Stream.Stream<Uint8Array, E>) => stream.pipe(Stream.decodeText(), Stream.mkString)
    return {
      run: (request: RunRequest) => {
        const failed = (reason: unknown) =>
          new ProcessFailed({ command: request.command, args: request.args, reason: String(reason) })
        const timeout = request.timeout ?? DEFAULT_TIMEOUT
        return Effect.scoped(
          Effect.gen(function*() {
            const command = ChildProcess.make(request.command, [...request.args], {
              cwd: request.cwd,
              env: { ...request.env },
              extendEnv: !request.isolatedEnv,
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

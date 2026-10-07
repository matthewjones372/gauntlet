import type { GateContext } from "@gauntlet/core"
import { ProcessRunner } from "@gauntlet/core"
import { Effect, FileSystem, Path } from "effect"
import initScript from "./assets/gauntlet.init.gradle" with { type: "text" }

export interface GradleRun {
  readonly command: ReadonlyArray<string>
  readonly exitCode: number
  readonly stderr: string
  /** Set when Gradle couldn't be started at all. */
  readonly error?: string
}

/**
 * Runs Gradle tasks in the judged checkout, in a fresh process with no build
 * cache, with Gauntlet's init script pointing reports at `ctx.outputDir`.
 */
export const gradle = (ctx: GateContext, tasks: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const runner = yield* ProcessRunner
    const wrapper = path.join(ctx.dir, "gradlew")
    const command = ["./gradlew", ...tasks]
    if (!(yield* fs.exists(wrapper).pipe(Effect.orElseSucceed(() => false)))) {
      return { command, exitCode: -1, stderr: "", error: "no Gradle wrapper (gradlew) in the repository" } satisfies GradleRun
    }
    // Next to the output directories, never inside one, so it isn't read as a report.
    const script = path.join(path.dirname(ctx.outputDir), "gauntlet.init.gradle")
    yield* fs.writeFileString(script, initScript).pipe(Effect.orElseSucceed(() => undefined))
    const args = ["--no-daemon", "--no-build-cache", "--no-configuration-cache", "--console=plain", "-q", "--init-script", script, ...tasks]
    const result = yield* Effect.exit(runner.run({ command: "sh", args: ["./gradlew", ...args], cwd: ctx.dir, env: { GAUNTLET_OUT: ctx.outputDir, ...env } }))
    if (result._tag === "Failure") return { command, exitCode: -1, stderr: "", error: "Gradle couldn't be started or timed out" } satisfies GradleRun
    return { command, exitCode: result.value.exitCode, stderr: result.value.stderr } satisfies GradleRun
  })

/** Gradle's message when a task doesn't exist in the build. */
export const taskMissing = (stderr: string, task: string) => new RegExp(`Task '${task}' not found|Cannot locate tasks? that match '${task}'`).test(stderr)

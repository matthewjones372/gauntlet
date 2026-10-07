import type { GateContext } from "@gauntlet/core"
import { ProcessRunner } from "@gauntlet/core"
import { Effect } from "effect"

// How the Scala pack runs sbt: in batch mode, without colours or the sbt
// server, in the judged checkout. Each gate is one sbt invocation; settings
// that point reports at the output directory are passed as `set` commands,
// so the project's build files are never edited.

export interface ToolRun {
  readonly command: ReadonlyArray<string>
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly error?: string
}

export const sbt = (ctx: GateContext, commands: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function*() {
    const runner = yield* ProcessRunner
    const argv = ["sbt", "-batch", "-no-colors", "-Dsbt.server.forcestart=false", "-Dsbt.supershell=false", ...commands]
    const result = yield* Effect.exit(runner.run({ command: argv[0]!, args: argv.slice(1), cwd: ctx.dir, env: { NO_COLOR: "1", ...env } }))
    if (result._tag === "Failure") return { command: argv, exitCode: -1, stdout: "", stderr: "", error: "sbt couldn't be started or timed out" } satisfies ToolRun
    return { command: argv, ...result.value } satisfies ToolRun
  })

/** A Scala string literal for a path in a `set` command. */
export const scalaString = (s: string) => JSON.stringify(s)

const IGNORED = /(^|\/)(target|project\/target|project\/project|\.bsp|\.metals|\.bloop)\//

export const isScala = (p: string) => /\.(scala|sc)$/.test(p) && !IGNORED.test(p) && !/(^|\/)project\//.test(p)
export const isTestFile = (p: string) => isScala(p) && /(^|\/)src\/(test|it)\//.test(p)
export const isMainSource = (p: string) => isScala(p) && /(^|\/)src\/main\//.test(p)

/** The package path of a source file: `src/main/scala/svc/domain/Money.scala` is `svc.domain`. */
export const packageOf = (p: string) => p.replace(/^(.*\/)?src\/(main|test|it)\/scala(-[\d.]+)?\//, "").replace(/\/?[^/]+$/, "").replaceAll("/", ".")

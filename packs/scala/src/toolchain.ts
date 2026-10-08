import type { GateContext } from "@gauntlet/core"
import { ProcessRunner } from "@gauntlet/core"
import { Effect, FileSystem, Path } from "effect"

// How the Scala pack runs sbt: one sbt server per check, in the judged
// checkout, that every gate of the check talks to with the thin client
// (ADR 0020). Starting sbt and loading the build takes most of a gate's time;
// the server pays it once. Each call starts from the build as written:
// `session clear-all` and `reload` drop whatever an earlier gate `set`, so
// settings that point reports at one gate's output directory never leak into
// the next. The project's build files are never edited.

export interface ToolRun {
  readonly command: ReadonlyArray<string>
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly error?: string
}

/** The JVM option that ties an sbt server to one check, so a crashed check's server can be found and ended. */
export const serverMarker = (root: string) => `-Dgauntlet.check=${root}`

// The thin client colours its output whatever it's told; reports never need the escapes.
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g
const plain = (s: string) => s.replace(ANSI, "")

const serverOpts = (ctx: GateContext, dirname: (p: string) => string) =>
  [process.env.SBT_OPTS ?? "", serverMarker(dirname(ctx.outputDir)), "-Dsbt.supershell=false", "-Dsbt.log.noformat=true"].filter((s) => s !== "").join(" ")

export const sbt = (ctx: GateContext, commands: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function*() {
    const runner = yield* ProcessRunner
    const path = yield* Path.Path
    const argv = ["sbt", "--client", ["session clear-all", "reload", ...commands].join("; ")]
    const result = yield* Effect.exit(runner.run({ command: argv[0]!, args: argv.slice(1), cwd: ctx.dir, env: { NO_COLOR: "1", SBT_OPTS: serverOpts(ctx, path.dirname), ...env } }))
    if (result._tag === "Failure") return { command: argv, exitCode: -1, stdout: "", stderr: "", error: "sbt couldn't be started or timed out" } satisfies ToolRun
    return { command: argv, ...result.value, stdout: plain(result.value.stdout), stderr: plain(result.value.stderr) } satisfies ToolRun
  })

/** Ends the check's sbt server: asked to shut down, then any process still carrying the check's marker. */
export const stopServer = (check: { readonly dir: string; readonly root: string }) =>
  Effect.gen(function*() {
    const runner = yield* ProcessRunner
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    // Only when a gate started one: the client would otherwise start a server just to stop it.
    const active = yield* fs.exists(path.join(check.dir, "project", "target", "active.json")).pipe(Effect.orElseSucceed(() => false))
    if (active) yield* runner.run({ command: "sbt", args: ["--client", "shutdown"], cwd: check.dir, env: { NO_COLOR: "1" }, timeout: "60 seconds" }).pipe(Effect.ignore)
    yield* runner.run({ command: "pkill", args: ["-f", "--", serverMarker(check.root)], cwd: check.root, env: {} }).pipe(Effect.ignore)
  })

/** A Scala string literal for a path in a `set` command. */
export const scalaString = (s: string) => JSON.stringify(s)

const IGNORED = /(^|\/)(target|project\/target|project\/project|\.bsp|\.metals|\.bloop)\//

export const isScala = (p: string) => /\.(scala|sc)$/.test(p) && !IGNORED.test(p) && !/(^|\/)project\//.test(p)
export const isTestFile = (p: string) => isScala(p) && /(^|\/)src\/(test|it)\//.test(p)
export const isMainSource = (p: string) => isScala(p) && /(^|\/)src\/main\//.test(p)

/** The package path of a source file: `src/main/scala/svc/domain/Money.scala` is `svc.domain`. */
export const packageOf = (p: string) => p.replace(/^(.*\/)?src\/(main|test|it)\/scala(-[\d.]+)?\//, "").replace(/\/?[^/]+$/, "").replaceAll("/", ".")

import type { GateContext } from "@gauntlet/core"
import { ProcessRunner } from "@gauntlet/core"
import { Effect, FileSystem, Option, Path } from "effect"
import { createHash } from "node:crypto"
import { homedir } from "node:os"

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

// ---------- the compiled build definition, cached between checks (ADR 0020) ----------
//
// Before any gate can run, sbt compiles the build definition in project/
// (plugins.sbt, build.properties, any .scala build code). Every check has a
// fresh worktree, so every check paid for that compile. project/** is runner
// configuration, restored from the base commit, so the compiled result depends
// only on base content and the JDK. It's built once per key in a clean
// directory holding nothing but those files, and copied into each checkout.
// Nothing is ever copied back out of a checkout that ran the change's code.

const BUILD_DEFINITION = /^project\/(?!target\/|project\/target\/)[^/].*\.(sbt|scala|properties)$|^project\/project\/[^/]+\.(sbt|scala|properties)$/

let javaVersion: string | undefined

/** The cache key: the build definition's files and the JDK that compiles them. */
export const buildDefinitionKey = (files: ReadonlyArray<{ readonly path: string; readonly text: string }>, jdk: string) => {
  const hash = createHash("sha256")
  hash.update(`jdk ${jdk}\n`)
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) hash.update(`${f.path}\n${f.text}\n\0`)
  return hash.digest("hex").slice(0, 32)
}

const cacheRoot = () => process.env.GAUNTLET_CACHE_DIR ?? `${homedir()}/.cache/gauntlet`

/** Copies the compiled build definition into the checkout, building it first when this key hasn't been built. Once per check. */
export const warmBuildDefinition = (ctx: GateContext) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const runner = yield* ProcessRunner
    const marker = path.join(path.dirname(ctx.outputDir), ".sbt-build-definition")
    if (yield* fs.exists(marker).pipe(Effect.orElseSucceed(() => true))) return
    yield* fs.writeFileString(marker, "").pipe(Effect.ignore)
    if (yield* fs.exists(path.join(ctx.dir, "project", "target")).pipe(Effect.orElseSucceed(() => true))) return
    const files: { path: string; text: string }[] = []
    for (const p of ctx.files.filter((f) => BUILD_DEFINITION.test(f))) {
      const text = yield* fs.readFileString(path.join(ctx.dir, p)).pipe(Effect.option)
      if (Option.isSome(text)) files.push({ path: p, text: text.value })
    }
    if (files.length === 0) return
    javaVersion ??= yield* runner.run({ command: "java", args: ["-version"], cwd: ctx.dir }).pipe(Effect.map((r) => r.stderr.trim()), Effect.orElseSucceed(() => "unknown"))
    const cached = path.join(cacheRoot(), "sbt-build-definition", buildDefinitionKey(files, `${process.env.JAVA_HOME ?? ""} ${javaVersion}`))
    if (!(yield* fs.exists(path.join(cached, "target")).pipe(Effect.orElseSucceed(() => false)))) {
      // Built from the base files alone, in batch mode, so no server or change is involved.
      const built = yield* Effect.scoped(Effect.gen(function*() {
        const clean = yield* fs.makeTempDirectoryScoped({ prefix: "gauntlet-sbt-build-" })
        for (const f of files) {
          yield* fs.makeDirectory(path.dirname(path.join(clean, f.path)), { recursive: true })
          yield* fs.writeFileString(path.join(clean, f.path), f.text)
        }
        const r = yield* runner.run({ command: "sbt", args: ["-batch", "-no-colors", "-Dsbt.server.forcestart=false", "exit"], cwd: clean, env: { NO_COLOR: "1" }, timeout: "10 minutes" })
        if (r.exitCode !== 0) return false
        const staging = `${cached}.${process.pid}.${Date.now()}`
        yield* fs.makeDirectory(staging, { recursive: true })
        yield* fs.copy(path.join(clean, "project", "target"), path.join(staging, "target"))
        if (yield* fs.exists(path.join(clean, "project", "project"))) yield* fs.copy(path.join(clean, "project", "project"), path.join(staging, "project"))
        // Another check may have built the same key meanwhile; either copy is good.
        yield* fs.rename(staging, cached).pipe(Effect.catch(() => fs.remove(staging, { recursive: true }).pipe(Effect.ignore)))
        return true
      })).pipe(Effect.orElseSucceed(() => false))
      if (!built) return
    }
    yield* fs.copy(path.join(cached, "target"), path.join(ctx.dir, "project", "target")).pipe(Effect.ignore)
    if (yield* fs.exists(path.join(cached, "project")).pipe(Effect.orElseSucceed(() => false))) {
      yield* fs.copy(path.join(cached, "project"), path.join(ctx.dir, "project", "project"), { overwrite: false }).pipe(Effect.ignore)
    }
  })

export const sbt = (ctx: GateContext, commands: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function*() {
    const runner = yield* ProcessRunner
    const path = yield* Path.Path
    yield* warmBuildDefinition(ctx).pipe(Effect.ignore)
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

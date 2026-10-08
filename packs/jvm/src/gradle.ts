import type { GateContext } from "@gauntlet/core"
import { ProcessRunner } from "@gauntlet/core"
import { Effect, FileSystem, Option, Path } from "effect"
import initScript from "./assets/gauntlet.init.gradle" with { type: "text" }

export interface GradleRun {
  readonly command: ReadonlyArray<string>
  readonly exitCode: number
  readonly stderr: string
  /** Set when Gradle couldn't be started at all. */
  readonly error?: string
}

/** Gradle's own default when a build sets no `org.gradle.jvmargs`. */
const DEFAULT_JVMARGS = "-Xmx512m -XX:MaxMetaspaceSize=384m"

/** The directory a check's output directories sit in: one per check, so it names the check. */
export const checkRoot = (ctx: GateContext, dirname: (p: string) => string) => dirname(ctx.outputDir)

/** The JVM argument that ties a Gradle daemon to one check (ADR 0020). */
export const daemonMarker = (root: string) => `-Dgauntlet.check=${root}`

/** The build's `org.gradle.jvmargs` from gradle.properties (restored from base), or Gradle's default. */
export const buildJvmArgs = (properties: string | undefined): string => {
  const lines = (properties ?? "").split(/\r?\n/)
  let value: string | undefined
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*org\.gradle\.jvmargs\s*[=:]\s*(.*)$/.exec(lines[i]!)
    if (!m) continue
    // A trailing backslash continues the value on the next line.
    let v = m[1]!
    while (v.endsWith("\\") && i + 1 < lines.length) v = `${v.slice(0, -1).trimEnd()} ${lines[++i]!.trim()}`
    value = v.trim()
  }
  return value !== undefined && value !== "" ? value : DEFAULT_JVMARGS
}

/**
 * Runs Gradle tasks in the judged checkout, with no build cache, with
 * Gauntlet's init script pointing reports at `ctx.outputDir`. The gates of one
 * check share one Gradle daemon that no other build can use: its JVM
 * arguments carry the check's own directory, so no daemon from an earlier
 * check (or the user's own builds) is ever reused, and `stopDaemon` ends it
 * when the check is done (ADR 0020).
 */
/**
 * The Gradle wrapper for the build in \`dir\`: its own, or for an included
 * build without one (ADR 0022), the nearest above it inside the checkout. The
 * search stops at the checkout's root, which holds \`.git\`.
 */
export const findWrapper = (dir: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const exists = (p: string) => fs.exists(p).pipe(Effect.orElseSucceed(() => false))
    for (let at = dir; ; at = path.dirname(at)) {
      if (yield* exists(path.join(at, "gradlew"))) return Option.some(path.join(at, "gradlew"))
      if ((yield* exists(path.join(at, ".git"))) || path.dirname(at) === at) return Option.none<string>()
    }
  })

export const gradle = (ctx: GateContext, tasks: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const runner = yield* ProcessRunner
    const found = yield* findWrapper(ctx.dir)
    const own = Option.isSome(found) && path.dirname(found.value) === ctx.dir
    const command = [own || Option.isNone(found) ? "./gradlew" : path.relative(ctx.dir, found.value), ...tasks]
    if (Option.isNone(found)) {
      return { command, exitCode: -1, stderr: "", error: "no Gradle wrapper (gradlew) in the repository" } satisfies GradleRun
    }
    // Next to the output directories, never inside one, so it isn't read as a report.
    const script = path.join(path.dirname(ctx.outputDir), "gauntlet.init.gradle")
    yield* fs.writeFileString(script, initScript).pipe(Effect.orElseSucceed(() => undefined))
    const properties = yield* fs.readFileString(path.join(ctx.dir, "gradle.properties")).pipe(Effect.option)
    const jvmargs = `${buildJvmArgs(properties._tag === "Some" ? properties.value : undefined)} ${daemonMarker(checkRoot(ctx, path.dirname))}`
    const args = [
      "--daemon", `-Dorg.gradle.jvmargs=${jvmargs}`, `-Dorg.gradle.daemon.idletimeout=${IDLE_MS}`,
      "--no-build-cache", "--no-configuration-cache", "--no-watch-fs", "--console=plain", "-q", "--init-script", script, ...tasks,
    ]
    const result = yield* Effect.exit(runner.run({ command: "sh", args: [own ? "./gradlew" : found.value, ...args], cwd: ctx.dir, env: { GAUNTLET_OUT: ctx.outputDir, ...env } }))
    if (result._tag === "Failure") return { command, exitCode: -1, stderr: "", error: "Gradle couldn't be started or timed out" } satisfies GradleRun
    return { command, exitCode: result.value.exitCode, stderr: result.value.stderr } satisfies GradleRun
  })

/** A daemon left behind (a crash before `stopDaemon`) exits on its own after this long idle. */
const IDLE_MS = 120_000

/** Ends the check's Gradle daemon, if it started one. */
export const stopDaemon = (root: string) =>
  Effect.gen(function*() {
    const runner = yield* ProcessRunner
    yield* runner.run({ command: "pkill", args: ["-f", "--", daemonMarker(root)], cwd: root, env: {} }).pipe(Effect.ignore)
  })

/** Gradle's message when a task doesn't exist in the build. */
export const taskMissing = (stderr: string, task: string) => new RegExp(`Task '${task}' not found|Cannot locate tasks? that match '${task}'`).test(stderr)

import type { GateContext } from "@gauntlet/core"
import { ProcessRunner } from "@gauntlet/core"
import { Effect, FileSystem, Option, Path, Schema } from "effect"

// How a TypeScript project builds and tests: its package manager, test
// runner and installed tools. Everything runs in the judged checkout, which
// is a fresh worktree, so dependencies are installed once per check first.

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm"
export type TestRunner = "vitest" | "jest" | "bun"

const PackageJson = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  workspaces: Schema.optionalKey(Schema.Unknown),
})
type PackageJson = typeof PackageJson.Type

export interface Toolchain {
  readonly manager: PackageManager
  readonly runner: Option.Option<TestRunner>
  readonly deps: ReadonlySet<string>
}

const decodePackageJson = Schema.decodeUnknownOption(Schema.fromJsonString(PackageJson))

export const packageManager = (files: ReadonlyArray<string>): PackageManager =>
  files.includes("bun.lock") || files.includes("bun.lockb") ? "bun"
  : files.includes("pnpm-lock.yaml") ? "pnpm"
  : files.includes("yarn.lock") ? "yarn"
  : "npm"

export const testRunner = (deps: ReadonlySet<string>, manager: PackageManager): Option.Option<TestRunner> =>
  deps.has("vitest") ? Option.some("vitest") : deps.has("jest") ? Option.some("jest") : manager === "bun" ? Option.some("bun") : Option.none()

export const toolchain = (ctx: GateContext) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const text = yield* fs.readFileString(path.join(ctx.dir, "package.json")).pipe(Effect.option)
    const pkg: PackageJson = Option.getOrElse(Option.flatMap(text, decodePackageJson), () => ({}))
    const deps = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})])
    const manager = packageManager(ctx.files)
    return { manager, runner: testRunner(deps, manager), deps } satisfies Toolchain
  })

const INSTALL: Record<PackageManager, ReadonlyArray<string>> = {
  bun: ["bun", "install", "--frozen-lockfile"],
  pnpm: ["pnpm", "install", "--frozen-lockfile"],
  yarn: ["yarn", "install", "--frozen-lockfile"],
  npm: ["npm", "ci", "--no-audit", "--no-fund"],
}

export interface ToolRun {
  readonly command: ReadonlyArray<string>
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly error?: string
}

const exec = (ctx: GateContext, argv: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function*() {
    const runner = yield* ProcessRunner
    const result = yield* Effect.exit(runner.run({ command: argv[0]!, args: argv.slice(1), cwd: ctx.dir, env: { CI: "true", NO_COLOR: "1", ...env } }))
    if (result._tag === "Failure") return { command: argv, exitCode: -1, stdout: "", stderr: "", error: `${argv[0]} couldn't be started or timed out` } satisfies ToolRun
    return { command: argv, ...result.value } satisfies ToolRun
  })

/**
 * Installs dependencies with the lockfile, once per check. The result is
 * remembered next to the output directories (never inside one), so later
 * gates reuse it.
 */
export const ensureInstalled = (ctx: GateContext, chain: Toolchain) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const marker = path.join(path.dirname(ctx.outputDir), ".typescript-install")
    const previous = yield* fs.readFileString(marker).pipe(Effect.option)
    if (Option.isSome(previous)) return previous.value === "ok" ? Option.none<string>() : Option.some(previous.value)
    const lockless = chain.manager === "npm" && !ctx.files.includes("package-lock.json")
    const run = yield* exec(ctx, lockless ? ["npm", "install", "--no-audit", "--no-fund"] : INSTALL[chain.manager])
    const outcome = run.error ?? (run.exitCode === 0 ? "ok" : `dependency install failed (${run.command.join(" ")} exited with ${run.exitCode})`)
    yield* fs.writeFileString(marker, outcome).pipe(Effect.orElseSucceed(() => undefined))
    return outcome === "ok" ? Option.none<string>() : Option.some(outcome)
  })

/** Runs a tool installed in the project's node_modules/.bin. */
export const tool = (ctx: GateContext, bin: string, args: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const local = path.join(ctx.dir, "node_modules", ".bin", bin)
    if (!(yield* fs.exists(local).pipe(Effect.orElseSucceed(() => false)))) {
      return { command: [bin, ...args], exitCode: -1, stdout: "", stderr: "", error: `${bin} isn't installed in the project (add it to devDependencies)` } satisfies ToolRun
    }
    const run = yield* exec(ctx, [local, ...args], env)
    return { ...run, command: [bin, ...args] }
  })

/** Runs `bun` itself (the test runner and coverage are built in). */
export const bun = (ctx: GateContext, args: ReadonlyArray<string>) => exec(ctx, ["bun", ...args])

const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)__tests__\//
const SOURCE = /\.([cm]?ts|tsx|[cm]?js|jsx)$/
const IGNORED = /(^|\/)(node_modules|dist|build|coverage|reports|\.stryker-tmp)\//

export const isTsSource = (p: string) => SOURCE.test(p) && !p.endsWith(".d.ts") && !IGNORED.test(p)
export const isTestFile = (p: string) => TEST_FILE.test(p)
/** Main code: source files that aren't tests or tool configuration. */
export const isMainSource = (p: string) => isTsSource(p) && !isTestFile(p) && !/(^|\/)[^/]+\.config\.[cm]?[jt]s$/.test(p) && !/(^|\/)(test|tests)\//.test(p)

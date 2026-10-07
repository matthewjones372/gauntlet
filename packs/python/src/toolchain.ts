import type { GateContext } from "@gauntlet/core"
import { ProcessRunner } from "@gauntlet/core"
import { Effect, FileSystem, Option, Path } from "effect"
import { parseDependencies } from "./dependencies.ts"

// How a Python project installs and runs its tools: uv, poetry or a pip
// virtualenv. Everything runs in the judged checkout (a fresh worktree), so
// dependencies are installed once per check first.

export type Manager = "uv" | "poetry" | "pip"

export const manager = (files: ReadonlyArray<string>): Manager =>
  files.includes("uv.lock") ? "uv" : files.includes("poetry.lock") ? "poetry" : "pip"

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
    const result = yield* Effect.exit(runner.run({
      command: argv[0]!,
      args: argv.slice(1),
      cwd: ctx.dir,
      // No bytecode or caches written into the checkout; no colour codes in output.
      env: { PYTHONDONTWRITEBYTECODE: "1", NO_COLOR: "1", PY_COLORS: "0", ...env },
    }))
    if (result._tag === "Failure") return { command: argv, exitCode: -1, stdout: "", stderr: "", error: `${argv[0]} couldn't be started or timed out` } satisfies ToolRun
    return { command: argv, ...result.value } satisfies ToolRun
  })

const requirementFiles = (files: ReadonlyArray<string>) =>
  files.filter((f) => /^requirements([-_.]?(dev|test|tests))?\.txt$/.test(f)).sort()

/** Installs dependencies with the lockfile, once per check; remembered next to the output directories. */
export const ensureInstalled = (ctx: GateContext) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const marker = path.join(path.dirname(ctx.outputDir), ".python-install")
    const previous = yield* fs.readFileString(marker).pipe(Effect.option)
    if (Option.isSome(previous)) return previous.value === "ok" ? Option.none<string>() : Option.some(previous.value)
    const steps: ReadonlyArray<ReadonlyArray<string>> = (() => {
      switch (manager(ctx.files)) {
        case "uv": return [["uv", "sync", "--frozen", "--all-groups"]]
        case "poetry": return [["poetry", "install", "--no-interaction", "--sync"]]
        case "pip": return [
          ["python3", "-m", "venv", ".venv"],
          ...requirementFiles(ctx.files).map((r) => [".venv/bin/pip", "install", "-q", "-r", r]),
          ...(ctx.files.includes("pyproject.toml") ? [[".venv/bin/pip", "install", "-q", "-e", "."]] : []),
        ]
      }
    })()
    let outcome = "ok"
    for (const step of steps) {
      const run = yield* exec(ctx, step)
      if (run.error || run.exitCode !== 0) {
        outcome = run.error ?? `dependency install failed (${step.join(" ")} exited with ${run.exitCode})`
        break
      }
    }
    yield* fs.writeFileString(marker, outcome).pipe(Effect.orElseSucceed(() => undefined))
    return outcome === "ok" ? Option.none<string>() : Option.some(outcome)
  })

/** Runs a tool from the project's environment: `uv run`, `poetry run`, or the virtualenv's bin. */
export const tool = (ctx: GateContext, bin: string, args: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}) => {
  switch (manager(ctx.files)) {
    case "uv": return exec(ctx, ["uv", "run", "--frozen", "--no-sync", bin, ...args], env).pipe(Effect.map((r) => ({ ...r, command: [bin, ...args] })))
    case "poetry": return exec(ctx, ["poetry", "run", bin, ...args], env).pipe(Effect.map((r) => ({ ...r, command: [bin, ...args] })))
    case "pip": return exec(ctx, [`.venv/bin/${bin}`, ...args], env).pipe(Effect.map((r) => ({ ...r, command: [bin, ...args] })))
  }
}

/** Whether the project declares a dependency, in pyproject.toml or a requirements file. */
export const declares = (ctx: GateContext, name: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    for (const f of ctx.files.filter((f) => /^(pyproject\.toml|requirements[^/]*\.txt)$/.test(f))) {
      const text = yield* fs.readFileString(path.join(ctx.dir, f)).pipe(Effect.option)
      if (Option.isSome(text) && parseDependencies(f, text.value).some((d) => d.trim().toLowerCase().replaceAll("_", "-").startsWith(name))) return true
    }
    return false
  })

/** Whether a tool is installed in the project's environment. */
export const has = (ctx: GateContext, bin: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const venv = manager(ctx.files) === "poetry" ? undefined : path.join(ctx.dir, ".venv", "bin", bin)
    if (venv) return yield* fs.exists(venv).pipe(Effect.orElseSucceed(() => false))
    const r = yield* exec(ctx, ["poetry", "run", "which", bin])
    return r.exitCode === 0
  })

const TEST_FILE = /(^|\/)(test_[^/]*|[^/]*_test)\.py$|(^|\/)conftest\.py$/
const IGNORED = /(^|\/)(\.venv|venv|\.tox|build|dist|mutants|__pycache__|\.mypy_cache)\//

export const isPython = (p: string) => p.endsWith(".py") && !IGNORED.test(p)
export const isTestFile = (p: string) => TEST_FILE.test(p) || /(^|\/)tests?\//.test(p)
export const isMainSource = (p: string) => isPython(p) && !isTestFile(p) && !/(^|\/)(setup|noxfile|conftest)\.py$/.test(p)

/** The importable module name of a source file: `src/svc/domain/money.py` is `svc.domain.money`. */
export const moduleName = (p: string) => p.replace(/^src\//, "").replace(/\.py$/, "").replace(/\/__init__$/, "").replaceAll("/", ".")

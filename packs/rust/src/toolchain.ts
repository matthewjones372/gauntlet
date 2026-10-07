import type { GateContext } from "@gauntlet/core"
import { ProcessRunner } from "@gauntlet/core"
import { Effect, FileSystem, Option, Path } from "effect"

// How the Rust pack runs Cargo. Everything runs in the judged checkout. The
// target directory is shared by the gates of one check (next to the output
// directories) and never across checks, so no earlier build vouches for this
// code; with a Cargo.lock, dependencies are --locked.

export interface ToolRun {
  readonly command: ReadonlyArray<string>
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly error?: string
}

export const targetDir = (ctx: GateContext) => Path.Path.use((path) => Effect.succeed(path.join(path.dirname(ctx.outputDir), "cargo-target")))

export const exec = (ctx: GateContext, argv: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function*() {
    const runner = yield* ProcessRunner
    const target = yield* targetDir(ctx)
    const result = yield* Effect.exit(runner.run({
      command: argv[0]!,
      args: argv.slice(1),
      cwd: ctx.dir,
      env: { CARGO_TARGET_DIR: target, CARGO_TERM_COLOR: "never", CARGO_INCREMENTAL: "0", RUST_BACKTRACE: "0", ...env },
    }))
    if (result._tag === "Failure") return { command: argv, exitCode: -1, stdout: "", stderr: "", error: `${argv[0]} couldn't be started or timed out` } satisfies ToolRun
    return { command: argv, ...result.value } satisfies ToolRun
  })

/** `--locked` when the repository has a Cargo.lock, so a build never picks new dependency versions. */
export const locked = (ctx: GateContext): string[] => (ctx.files.includes("Cargo.lock") ? ["--locked"] : [])

/** Whether a cargo subcommand is installed (`cargo nextest`, `cargo mutants`, `cargo llvm-cov`). */
export const hasSubcommand = (ctx: GateContext, sub: string) =>
  exec(ctx, ["cargo", sub, "--version"]).pipe(Effect.map((r) => r.exitCode === 0))

/** Fetches dependencies once per check; remembered next to the output directories. */
export const ensureFetched = (ctx: GateContext) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const marker = path.join(path.dirname(ctx.outputDir), ".cargo-fetch")
    const previous = yield* fs.readFileString(marker).pipe(Effect.option)
    if (Option.isSome(previous)) return previous.value === "ok" ? Option.none<string>() : Option.some(previous.value)
    if (!ctx.files.includes("Cargo.toml")) return Option.some("no Cargo.toml at the repository root")
    const r = yield* exec(ctx, ["cargo", "fetch", ...locked(ctx)])
    const outcome = r.error ?? (r.exitCode === 0 ? "ok" : `cargo fetch failed: ${r.stderr.trim().split("\n").at(-1) ?? ""}`)
    yield* fs.writeFileString(marker, outcome).pipe(Effect.orElseSucceed(() => undefined))
    return outcome === "ok" ? Option.none<string>() : Option.some(outcome)
  })

const IGNORED = /(^|\/)(target|\.cargo|mutants\.out[^/]*)\//

export const isRust = (p: string) => p.endsWith(".rs") && !IGNORED.test(p)
/** Integration tests, benches and examples: whole files of tests. Inline #[cfg(test)] modules are found by the detectors. */
export const isTestFile = (p: string) => isRust(p) && /(^|\/)(tests|benches)\//.test(p)
export const isMainSource = (p: string) => isRust(p) && !isTestFile(p) && !/(^|\/)(examples)\//.test(p) && !/(^|\/)build\.rs$/.test(p)

/** The module path of a source file in its crate: `src/domain/money.rs` is `domain::money`, `src/lib.rs` is ``. */
export const modulePath = (p: string) =>
  p.replace(/^(.*\/)?src\//, "").replace(/\.rs$/, "").replace(/(^|\/)(mod|lib|main)$/, "").replaceAll("/", "::")

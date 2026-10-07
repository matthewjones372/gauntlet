import type { GateContext } from "@gauntlet/core"
import { ProcessRunner } from "@gauntlet/core"
import { Effect, FileSystem, Option, Path } from "effect"

// How the Go pack runs the toolchain. Everything runs in the judged checkout
// with a pinned environment: no automatic toolchain downloads, no workspace
// files, read-only modules, and never cached test results (-count=1).

export interface ToolRun {
  readonly command: ReadonlyArray<string>
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly error?: string
}

export const GO_ENV: Readonly<Record<string, string>> = { GOTOOLCHAIN: "local", GOWORK: "off", GOFLAGS: "-mod=readonly", CGO_ENABLED: "0", NO_COLOR: "1" }

export const exec = (ctx: GateContext, argv: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function*() {
    const runner = yield* ProcessRunner
    const result = yield* Effect.exit(runner.run({ command: argv[0]!, args: argv.slice(1), cwd: ctx.dir, env: { ...GO_ENV, ...env } }))
    if (result._tag === "Failure") return { command: argv, exitCode: -1, stdout: "", stderr: "", error: `${argv[0]} couldn't be started or timed out` } satisfies ToolRun
    return { command: argv, ...result.value } satisfies ToolRun
  })

/** The module path from go.mod, such as `example.com/svc`. */
export const modulePath = (ctx: GateContext) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const text = yield* fs.readFileString(path.join(ctx.dir, "go.mod")).pipe(Effect.option)
    return Option.flatMap(text, (t) => Option.fromNullishOr(/^module\s+(\S+)/m.exec(t)?.[1]))
  })

/** Downloads modules once per check; remembered next to the output directories. */
export const ensureModules = (ctx: GateContext) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const marker = path.join(path.dirname(ctx.outputDir), ".go-modules")
    const previous = yield* fs.readFileString(marker).pipe(Effect.option)
    if (Option.isSome(previous)) return previous.value === "ok" ? Option.none<string>() : Option.some(previous.value)
    if (!ctx.files.includes("go.mod")) return Option.some("no go.mod at the repository root")
    const r = yield* exec(ctx, ["go", "mod", "download"])
    const outcome = r.error ?? (r.exitCode === 0 ? "ok" : `go mod download failed: ${r.stderr.trim().split("\n")[0] ?? ""}`)
    yield* fs.writeFileString(marker, outcome).pipe(Effect.orElseSucceed(() => undefined))
    return outcome === "ok" ? Option.none<string>() : Option.some(outcome)
  })

/** A Go tool installed with `go install`: on PATH, or in GOBIN or GOPATH/bin. */
export const goTool = (ctx: GateContext, bin: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const onPath = yield* exec(ctx, ["sh", "-c", `command -v ${bin}`])
    if (onPath.exitCode === 0 && onPath.stdout.trim() !== "") return Option.some(onPath.stdout.trim())
    for (const v of ["GOBIN", "GOPATH"]) {
      const dir = (yield* exec(ctx, ["go", "env", v])).stdout.trim()
      if (dir === "") continue
      const candidate = v === "GOBIN" ? path.join(dir, bin) : path.join(dir.split(":")[0]!, "bin", bin)
      if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) return Option.some(candidate)
    }
    return Option.none<string>()
  })

const IGNORED = /(^|\/)(vendor|testdata|\.git)\//

export const isGo = (p: string) => p.endsWith(".go") && !IGNORED.test(p)
export const isTestFile = (p: string) => isGo(p) && p.endsWith("_test.go")
export const isMainSource = (p: string) => isGo(p) && !p.endsWith("_test.go")

/** The directory of a package as `go test` wants it: `./money`, or `.` for the root. */
export const packageDir = (file: string) => {
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ""
  return dir === "" ? "." : `./${dir}`
}

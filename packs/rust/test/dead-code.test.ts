import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { explainPolicy, type GateRun, ProcessFailed, ProcessRunner, type RunRequest } from "@gauntlet/core"
import { compilePolicy } from "@gauntlet/dsl"
import { Effect, Layer } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fakeGate } from "../../../packages/core/test/fake-gate.ts"
import { spec } from "../src/catalog.ts"
import { isCargoJson, parseRustcDeadCode } from "../src/deadcode.ts"
import { deadCode } from "../src/gates.ts"
import { onboard } from "../src/onboard.ts"

// Spec 0017 §4, the Rust pack: rustc's dead-code lints as dead-code findings.
// The fixture is what cargo 1.95.0 printed (`cargo check --workspace
// --all-targets --message-format=json`, its paths made /repo) for a library
// with an unused import, variable, function, field, variant, constant, macro,
// methods, type alias and unreachable statement, a crate-visible function
// nothing calls, and a private function only its tests call. The library and
// its test build both report most of them: each is one finding.

const fixture = readFileSync(join(import.meta.dir, "fixtures", "cargo-check", "cargo-check-1.95.0.json"), "utf8")

const summary = (run: { results: ReadonlyArray<{ ruleId: string; message: { text: string }; locations?: ReadonlyArray<{ physicalLocation?: { artifactLocation?: { uri: string }; region?: { startLine?: number } } }> }> }) =>
  run.results.map((r) => ({ ruleId: r.ruleId, message: r.message.text, path: r.locations?.[0]?.physicalLocation?.artifactLocation?.uri, line: r.locations?.[0]?.physicalLocation?.region?.startLine }))

const at = (kind: string, message: string, line: number, path = "src/lib.rs") => ({ ruleId: `dead-code/${kind}`, message, path, line })
const EXPECTED = [
  at("unused-import", "unused import: `std::collections::HashMap`", 1),
  at("unused-variable", "unused variable: `unused`", 6),
  at("unused-function", "function `helper` is never used", 10),
  at("unused-field", "field `note` is never read", 16),
  at("unused-variant", "variant `Debit` is never constructed", 32),
  at("unused-constant", "constant `RATE` is never used", 42),
  at("unused-macro", "unused macro definition: `never`", 44),
  at("unreachable-code", "unreachable statement", 50),
  at("unused-function", "function `tested_only` is never used", 54),
  at("unused-field", "fields `a` and `b` are never read", 70),
  at("unused-method", "methods `first` and `second` are never used", 76),
  at("unused-type-alias", "type alias `Alias` is never used", 80),
  at("unused-function", "function `crate_only` is never used", 1, "src/util.rs"),
]

describe("cargo check's messages as dead code", () => {
  test("each dead-code lint is a finding of its kind, with its file and line, once across targets", () => {
    const run = parseRustcDeadCode(fixture, "/repo")
    expect(run.tool.driver.name).toBe("rustc")
    expect(summary(run)).toEqual(EXPECTED)
    expect(run.results.every((r) => r.level === "warning")).toBe(true)
  })

  const message = (code: string | null, text: string, level = "warning") =>
    JSON.stringify({ reason: "compiler-message", message: { code: code === null ? null : { code }, level, message: text, spans: [{ file_name: "src/a.rs", line_start: 3, is_primary: true }] } })

  test("other lints and errors aren't dead code; what dead_code names sets the kind", () => {
    const stdout = [
      message("clippy::needless_return", "unneeded `return` statement"),
      message("unused_mut", "variable does not need to be mutable"),
      message("E0425", "cannot find value `x` in this scope", "error"),
      message(null, "1 warning emitted"),
      message("dead_code", "associated function `new` is never used"),
      message("dead_code", "multiple variants are never constructed"),
      message("dead_code", "something new is never used"),
      JSON.stringify({ reason: "build-finished", success: true }),
    ].join("\n")
    expect(summary(parseRustcDeadCode(stdout, "/repo")).map((r) => r.ruleId)).toEqual(["dead-code/unused-function", "dead-code/unused-variant", "dead-code/unused-item"])
  })

  test("only cargo's JSON messages are read", () => {
    expect(isCargoJson(fixture)).toBe(true)
    expect(isCargoJson("")).toBe(true)
    expect(isCargoJson("warning: unused import: `x`\n")).toBe(false)
    expect(isCargoJson("{\"reason\":\"build-finished\"}\n{}\n")).toBe(false)
  })
})

const FILES = { "Cargo.toml": "[package]\nname = \"money\"\n", "Cargo.lock": "", "src/lib.rs": "" }

/** The gate with a process runner that answers `cargo check` as given; cargo can't be started when `missing`. */
const cargoGate = (answer: { exitCode?: number; stdout?: string; stderr?: string }, missing = false) => {
  const g = fakeGate(FILES)
  const calls: RunRequest[] = []
  const layer = Layer.mergeAll(
    Layer.succeed(ProcessRunner, {
      run: (r) => {
        calls.push(r)
        if (missing) return Effect.fail(new ProcessFailed({ command: r.command, args: r.args, reason: "ENOENT: no such file or directory, posix_spawn 'cargo'" }))
        if (r.args[0] === "check") return Effect.succeed({ exitCode: answer.exitCode ?? 0, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" })
        return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" })
      },
    }),
    BunServices.layer,
  )
  const run = () => Effect.runPromise(deadCode({ kind: "gate", name: "dead-code", ratchet: true, scope: "all" }, g.ctx).pipe(Effect.provide(layer)) as Effect.Effect<GateRun, never, never>)
  return { ctx: g.ctx, calls, run }
}

describe("the dead-code gate", () => {
  test("runs cargo check over every target and reports rustc's dead-code lints, keeping its messages in the output directory", async () => {
    const g = cargoGate({ stdout: fixture })
    const r = await g.run()
    expect(r.error).toBeUndefined()
    const call = g.calls.find((c) => c.args[0] === "check")!
    expect([call.command, ...call.args]).toEqual(["cargo", "check", "--workspace", "--all-targets", "--message-format=json", "--locked"])
    expect(r.runs.flatMap((x) => summary(x))).toHaveLength(EXPECTED.length)
    expect(existsSync(join(g.ctx.outputDir, "cargo-check.json"))).toBe(true)
    expect(existsSync(join(g.ctx.outputDir, "dead-code.sarif"))).toBe(true)
  })

  test("without cargo it's an error saying how to install it, not a pass", async () => {
    const r = await cargoGate({}, true).run()
    expect(r.error).toBe("cargo isn't installed (https://rustup.rs)")
    expect(r.notSetUp).toBe(true)
  })

  test("code that doesn't compile is an error, with what cargo said", async () => {
    const r = await cargoGate({ exitCode: 101, stderr: "    Checking money v0.1.0\nerror: could not compile `money` (lib) due to 1 previous error\n" }).run()
    expect(r.error).toBe("cargo check couldn't check the code: error: could not compile `money` (lib) due to 1 previous error")
  })

  test("output that isn't cargo's JSON messages is an error quoting it", async () => {
    expect((await cargoGate({ stdout: "warning: unused import: `x`\n" }).run()).error).toBe("cargo check's messages couldn't be read: warning: unused import: `x`")
  })
})

describe("the policy language", () => {
  const compile = (gates: string) => compilePolicy({ file: ".gauntlet/policy.gx", text: `gauntlet "svc"\nuse rust\nmode enforce\nowners @p\ngates { fast { ${gates} } }\nreview { auto when all gates pass }\n` }, [spec])

  test("accepts `dead-code`, `dead-code ratchet` and `dead-code advise on changed`", () => {
    for (const gates of ["build, dead-code", "build, dead-code ratchet", "dead-code advise on changed"]) {
      const c = compile(gates)
      if (c._tag === "Invalid") throw new Error(`'${gates}' didn't compile: ${JSON.stringify(c.diagnostics)}`)
      expect(c.compiled.ir.gates[0]!.checks.some((x) => x.kind === "gate" && x.name === "dead-code")).toBe(true)
    }
  })

  test("explain says what a dead-code ratchet holds", () => {
    const c = compile("build, dead-code ratchet")
    if (c._tag === "Invalid") throw new Error("didn't compile")
    expect(explainPolicy(c.compiled.ir, "gates")).toContain("dead-code and no worse than the baseline")
  })
})

describe("setting up", () => {
  test("init doesn't draft dead-code: clippy reports rustc's lints, and `lint ratchet` holds them", () => {
    const files: Record<string, string> = { "Cargo.toml": "", "src/lib.rs": "" }
    const o = onboard({ files: Object.keys(files).sort(), read: (p) => files[p] })
    expect(o.fast).toEqual(["build", "lint ratchet"])
  })
})

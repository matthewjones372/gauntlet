import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { type GateContext, ProcessRunner, type RunRequest } from "@gauntlet/core"
import type { Check } from "@gauntlet/ir"
import { Effect, Layer } from "effect"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { build, coverage, lint, mutation, runSuite } from "../src/gates.ts"

// The Rust gates with a scripted process runner: what they run, and how they
// read what the tools write into the output directory. The real tools are
// covered by the end-to-end test.

const FILES: Record<string, string> = {
  "Cargo.toml": "[package]\nname = \"svc\"\n",
  "Cargo.lock": "",
  "src/lib.rs": "pub fn add(a: i64, b: i64) -> i64 {\n    a + b\n}\n",
  "src/types.rs": "pub struct Money(pub i64);\n",
  "tests/add.rs": "#[test]\nfn adds() { assert_eq!(svc::add(1, 2), 3); }\n",
}

type Handler = (r: RunRequest, out: string) => { exitCode?: number; stdout?: string; stderr?: string }

const gate = (handler: Handler, scope?: string[], added: Record<string, number[]> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "gauntlet-rs-gate-"))
  for (const [p, t] of Object.entries(FILES)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), t)
  }
  const out = join(mkdtempSync(join(tmpdir(), "gauntlet-rs-out-")), "0-check")
  mkdirSync(out)
  const ctx: GateContext = {
    dir,
    outputDir: out,
    collect: Effect.sync(() => readdirSync(out, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => ({ path: join(e.parentPath, e.name).slice(out.length + 1), content: readFileSync(join(e.parentPath, e.name), "utf8") }))),
    ir: { zones: [], arch: [] } as never,
    facts: { addedLines: new Map(Object.entries(added).map(([p, ls]) => [p, ls.map((line) => ({ line, text: (FILES[p] ?? "").split("\n")[line - 1] ?? "" }))])) } as never,
    ...(scope ? { scope } : {}),
    files: Object.keys(FILES).sort(),
    legacy: [],
  }
  const calls: RunRequest[] = []
  const layer = Layer.mergeAll(Layer.succeed(ProcessRunner, {
    run: (r) => Effect.sync(() => {
      calls.push(r)
      if (r.args[0] === "fetch" || r.args[1] === "--version") return { exitCode: 0, stdout: "", stderr: "" }
      const res = handler(r, out)
      return { exitCode: res.exitCode ?? 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" }
    }),
  }), BunServices.layer)
  const run = <A, E, R>(e: Effect.Effect<A, E, R>) => Effect.runPromise(e.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>)
  return { ctx, calls, run, last: (sub: string) => calls.filter((c) => c.args[0] === sub).at(-1)! }
}

const GATE = { kind: "gate", name: "x", ratchet: false, scope: "all" } as Extract<Check, { kind: "gate" }>

describe("Rust gates", () => {
  test("build compiles every target, locked, with a target directory per check", async () => {
    const g = gate(() => ({}))
    await g.run(build(GATE, g.ctx))
    const call = g.last("build")
    expect(call.args).toEqual(["build", "--workspace", "--all-targets", "--locked"])
    expect(call.env?.CARGO_TARGET_DIR).toBe(join(dirname(g.ctx.outputDir), "cargo-target"))
  })

  test("the suite runs nextest with Gauntlet's own config: JUnit into the output directory, no retries", async () => {
    const g = gate((_r, out) => {
      writeFileSync(join(out, "junit.xml"), `<testsuites><testsuite name="svc::add"><testcase name="adds" classname="svc::add"><failure message="no"/></testcase></testsuite></testsuites>`)
      return { exitCode: 100 }
    })
    const res = await g.run(runSuite({ name: "unit", location: "tests/**" }, g.ctx))
    expect(res.tests?.counts.failed).toBe(1)
    const call = g.last("nextest")
    const config = readFileSync(call.args[call.args.indexOf("--config-file") + 1]!, "utf8")
    expect(config).toContain("retries = 0")
    expect(config).toContain(`path = ${JSON.stringify(join(g.ctx.outputDir, "junit.xml"))}`)
  })

  test("reruns filter the tests and vary parallelism by seed", async () => {
    const g = gate(() => ({}))
    await g.run(runSuite({ name: "unit", location: "tests/**" }, g.ctx, { files: ["tests/add.rs"], ids: [], seed: 6 }))
    expect(g.last("nextest").args.slice(-3)).toEqual(["--test-threads=3", "-E", "binary(=add)"])
    expect((await g.run(runSuite({ name: "unit", location: "tests/**" }, g.ctx, { files: ["README.md"], ids: [], seed: 1 }))).error).toBe("no tests to run again")
  })

  test("lint turns clippy's JSON into SARIF, and says when clippy couldn't check the code", async () => {
    const message = JSON.stringify({ reason: "compiler-message", message: { code: { code: "clippy::needless_return" }, level: "warning", message: "unneeded return", spans: [{ file_name: "src/lib.rs", line_start: 2, is_primary: true }] } })
    const g = gate(() => ({ stdout: `${message}\n` }))
    const res = await g.run(lint(GATE, g.ctx))
    expect(res.runs.map((r) => `${r.tool.driver.name}:${r.results.length}`)).toEqual(["clippy:1", "rust-rules:0"])
    expect(readFileSync(join(g.ctx.outputDir, "clippy.json"), "utf8")).toBe(`${message}\n`)
    const broken = gate(() => ({ exitCode: 101, stderr: "   Compiling svc\nerror[E0308]: mismatched types\n" }))
    expect((await broken.run(lint(GATE, broken.ctx))).error).toBe("clippy couldn't check the code: error[E0308]: mismatched types")
  })

  test("mutation mutates the files in scope and scores cargo-mutants' outcomes", async () => {
    const g = gate((_r, out) => {
      mkdirSync(join(out, "mutants.out"))
      const m = (summary: string, line: number) => ({ scenario: { Mutant: { name: `src/lib.rs:${line}:5: replace + with -`, file: "src/lib.rs", span: { start: { line } } } }, summary })
      writeFileSync(join(out, "mutants.out", "outcomes.json"), JSON.stringify({ outcomes: [{ scenario: "Baseline", summary: "Success" }, m("CaughtMutant", 2), m("MissedMutant", 2), m("Unviable", 2)] }))
      return {}
    }, ["src/lib.rs"])
    const res = await g.run(mutation(GATE, g.ctx))
    expect(g.last("mutants").args).toEqual(["mutants", "--no-shuffle", "--output", g.ctx.outputDir, "--file", "src/lib.rs"])
    // Mutated builds never land where the other gates build and test.
    expect(g.last("mutants").env?.CARGO_TARGET_DIR).toBe(join(dirname(g.ctx.outputDir), "cargo-target-mutants"))
    expect(res.metrics?.mutation).toMatchObject({ value: 50, perFile: { "src/lib.rs": 50 } })
    expect(res.runs[0]!.results[0]!.message.text).toBe("No test kills this mutant: replace + with -")
  })

  test("coverage reads cargo-llvm-cov's lcov; struct-only files aren't uncovered", async () => {
    const g = gate((_r, out) => {
      writeFileSync(join(out, "lcov.info"), `SF:${join("/x", "src/lib.rs")}\nDA:1,1\nDA:2,1\nend_of_record\n`)
      return {}
    }, ["src/lib.rs", "src/types.rs"], { "src/lib.rs": [2], "src/types.rs": [1] })
    const res = await g.run(coverage(GATE, { ...g.ctx, dir: "/x" }))
    expect(res.metrics?.coverage).toMatchObject({ value: 100 })
  })
})

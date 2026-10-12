import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { irHash } from "@gauntlet/ir"
import { Effect, Layer, Option } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { jvm } from "../../dsl/test/fixtures/catalog.ts"
import {
  agentSummary, buildReport, decide, failingToolSaid, type GateImpl, type GateRun, mergeBuildRuns, type Pack, type PreparedWorkspace, ProcessRunner, ProcessRunnerLive,
  redact, renderAgentSummary, renderMarkdown, runGates, toolSaid,
} from "../src/index.ts"
import { cleanEvidence, compiled, noFacts } from "./fixtures.ts"

// A failing tool says why: a build that "exited with 1" names nothing to fix.
// A real process (a shell script standing in for a compiler) fails with a
// known message, and its last lines reach the reason, the PR comment and the
// agent's summary, short and with secrets masked.

const checkout = mkdtempSync(join(tmpdir(), "gauntlet-said-"))
const outputs = mkdtempSync(join(tmpdir(), "gauntlet-said-out-"))
const workspace: PreparedWorkspace = {
  dir: checkout,
  base: "b",
  head: "h",
  materialised: [],
  outputDir: (check) => Effect.succeed(`${outputs}/${check}`),
  collect: () => Effect.succeed([]),
}

/** A build gate whose tool is a shell script, read as packs read theirs. */
const scripted = (script: string, extra: Partial<GateRun> = {}): GateImpl => (_check, ctx) =>
  Effect.gen(function*() {
    const runner = yield* ProcessRunner
    const r = yield* runner.run({ command: "sh", args: ["-c", script], cwd: ctx.dir }).pipe(Effect.orDie)
    return { command: ["sh", "-c", "compile"], exitCode: r.exitCode, runs: [], ...failingToolSaid(r), ...extra }
  })

const policyText = `gauntlet "x"\nuse jvm\nowners @p\ngates { fast { build } }\n`
const policy = compiled(policyText)

const check = (build: GateImpl) =>
  Effect.runPromise(
    runGates({ ir: policy.ir, facts: noFacts({ files: [{ path: "src/A.kt", status: "modified", added: 1, removed: 0 }] }), workspace, packs: [{ spec: jvm, runnerConfig: [], manifests: [], detectors: [], gates: { build } } satisfies Pack], baseline: Option.none(), renames: new Map(), files: [] })
      .pipe(Effect.provide(Layer.mergeAll(ProcessRunnerLive.pipe(Layer.provide(BunServices.layer)), BunServices.layer))),
  )

const COMPILER = [
  "echo 'Compiling 3 Kotlin files'",
  `echo "${checkout}/src/A.kt:3:9: error: unresolved reference: total" >&2`,
  "echo 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 was set' >&2",
  "echo 'compilation failed' >&2",
  "exit 1",
].join("\n")

describe("a failing tool says why", () => {
  test("an outcome gate's reason carries the tool's last lines, with the checkout's path and the token taken out", async () => {
    const out = await check(scripted(COMPILER))
    expect(out.checks[0]!.status).toBe("failed")
    expect(out.checks[0]!.reason).toBe("exited with 1: src/A.kt:3:9: error: unresolved reference: total / GITHUB_TOKEN=*** was set / compilation failed")
  })

  test("the reason reaches the PR comment and the agent's summary", async () => {
    const out = await check(scripted(COMPILER))
    const facts = noFacts({ base: "1".repeat(40), head: "2".repeat(40), files: [{ path: "src/A.kt", status: "modified", added: 1, removed: 0 }] })
    const evidence = cleanEvidence({ checks: out.checks })
    const decision = decide({ ...policy, facts, evidence, mode: "enforce" })
    const report = buildReport({
      gauntletVersion: "0.1.0",
      policy: { ...policy, irHash: irHash(policy.ir), origin: "base", firstAdoption: false, drift: [], notes: [] },
      facts, checks: out.checks, ratchets: [], integrity: evidence.integrity, violations: [], imports: [], decision,
    })
    const comment = renderMarkdown(report)
    const summary = renderAgentSummary(agentSummary(report, "/r"))
    for (const text of [comment, summary]) {
      expect(text).toContain("unresolved reference: total")
      expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz")
      expect(text).not.toContain(checkout)
    }
  })

  test("a tool that errors says what it printed too, unless the error already quotes it", async () => {
    const out = await check(scripted("echo 'java.lang.OutOfMemoryError: Metaspace' >&2; exit 1", { error: "sbt couldn't start" }))
    expect(out.checks[0]!).toMatchObject({ status: "errored", reason: "sbt couldn't start; the tool said: java.lang.OutOfMemoryError: Metaspace" })
    const quoted = await check(scripted("echo 'boom' >&2; exit 1", { error: "it failed: boom" }))
    expect(quoted.checks[0]!.reason).toBe("it failed: boom")
  })

  test("a tool that printed nothing still says only how it exited", async () => {
    const out = await check(scripted("exit 3"))
    expect(out.checks[0]!.reason).toBe("exited with 3")
  })

  test("with several builds, the failing build's lines are named by its folder", () => {
    const ok: GateRun = { command: ["sbt"], exitCode: 0, runs: [] }
    const bad: GateRun = { command: ["sbt"], exitCode: 1, runs: [], output: ["Server is already booting", "Create a new server? y/n (default y)"] }
    expect(mergeBuildRuns([{ dir: "bank", run: ok }, { dir: "checks", run: bad }]).output).toEqual(["checks: Server is already booting", "Create a new server? y/n (default y)"])
  })
})

describe("toolSaid", () => {
  test("keeps the last few lines, short, without colour codes, blanks or stack frames", () => {
    const long = "x".repeat(500)
    const output = ["one", "two", "", "\u001b[31mthree\u001b[0m", "java.lang.IllegalStateException: no", "\tat sbt.Main.run(Main.scala:12)", "\t... 3 more", "four", long].join("\n")
    const said = toolSaid(output)
    expect(said).toEqual(["two", "three", "java.lang.IllegalStateException: no", "four", `${"x".repeat(199)}…`])
  })

  test("a tool's own error lines are preferred, and its plain tail kept when it marks none", () => {
    const pick = (lines: ReadonlyArray<string>) => lines.filter((l) => l.startsWith("E "))
    expect(toolSaid("a\nE bad\nb\nc", { pick })).toEqual(["E bad"])
    expect(toolSaid("a\nb", { pick })).toEqual(["a", "b"])
  })

  test("a passing run, or one that couldn't start, says nothing", () => {
    expect(failingToolSaid({ exitCode: 0, stdout: "", stderr: "warning" })).toEqual({})
    expect(failingToolSaid({ exitCode: -1, stdout: "", stderr: "x", error: "timed out" })).toEqual({})
    expect(failingToolSaid({ exitCode: 2, stdout: "src/a.ts(1,1): error TS2304: Cannot find name 'x'.", stderr: "" })).toEqual({ output: ["src/a.ts(1,1): error TS2304: Cannot find name 'x'."] })
  })
})

describe("redact", () => {
  test("masks the values of secret-named environment variables and token shapes, and keeps code locations", () => {
    const env = { NEXUS_PASSWORD: "hunter2hunter2", HOME: "/home/me" }
    expect(redact("auth failed for hunter2hunter2 in /home/me", env)).toBe("auth failed for *** in /home/me")
    expect(redact("Authorization: Bearer abc.def.ghijklmnop", {})).toBe("Authorization: Bearer ***")
    expect(redact("fetching https://bot:s3cretpass@repo.example.com/x", {})).toBe("fetching https://***@repo.example.com/x")
    expect(redact("key AKIAABCDEFGHIJKLMNOP", {})).toBe("key ***")
    expect(redact("password: letmein", {})).toBe("password: ***")
    expect(redact("src/auth/TokenService.scala:12:5: Not found: x", {})).toBe("src/auth/TokenService.scala:12:5: Not found: x")
  })
})

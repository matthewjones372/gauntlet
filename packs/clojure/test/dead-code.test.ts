import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { explainPolicy, type GateRun, ProcessFailed, ProcessRunner, type RunRequest } from "@gauntlet/core"
import { compilePolicy } from "@gauntlet/dsl"
import { Effect, Layer, Option } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fakeGate } from "../../../packages/core/test/fake-gate.ts"
import { spec } from "../src/catalog.ts"
import { parseKondoDeadCode } from "../src/deadcode.ts"
import { deadCode } from "../src/gates.ts"
import { onboard } from "../src/onboard.ts"

// Spec 0017 §4, the Clojure pack: clj-kondo's unused-* findings as dead-code
// findings. The fixture is what clj-kondo v2026.08.04 printed (`clj-kondo
// --lint src test --config '{:output {:format :json}}' --parallel`) for a
// namespace with an unused require, referred var and import, two unused
// private vars, an unused let binding and an unused argument.

const fixture = readFileSync(join(import.meta.dir, "fixtures", "clj-kondo", "clj-kondo-v2026.08.04.json"), "utf8")

const summary = (run: { results: ReadonlyArray<{ ruleId: string; level?: string; message: { text: string }; locations?: ReadonlyArray<{ physicalLocation?: { artifactLocation?: { uri: string }; region?: { startLine?: number } } }> }> }) =>
  run.results.map((r) => ({ ruleId: r.ruleId, message: r.message.text, path: r.locations?.[0]?.physicalLocation?.artifactLocation?.uri, line: r.locations?.[0]?.physicalLocation?.region?.startLine }))

const at = (kind: string, message: string, line: number) => ({ ruleId: `dead-code/${kind}`, message, path: "src/svc/money.clj", line })
const EXPECTED = [
  at("unused-namespace", "namespace clojure.string is required but never used", 2),
  at("unused-referred-var", "#'clojure.set/difference is referred but never used", 3),
  at("unused-import", "Unused import Date", 4),
  at("unused-private-var", "Unused private var svc.money/never-called", 6),
  at("unused-private-var", "Unused private var svc.money/unused-rate", 9),
  at("unused-binding", "unused binding unused", 12),
  at("unused-binding", "unused binding ctx", 18),
]

const finding = (type: string, level = "warning", message = type) => ({ filename: "src/a.clj", row: 3, col: 1, type, level, message })
const report = (...findings: ReadonlyArray<object>) => JSON.stringify({ findings, summary: { error: 0, warning: findings.length } })

describe("clj-kondo's JSON as dead code", () => {
  test("each unused-* finding is a dead-code finding of its kind, with its file and line", () => {
    const parsed = Option.getOrThrow(parseKondoDeadCode(fixture, "/repo"))
    if (parsed._tag !== "Read") throw new Error("not read")
    expect(parsed.run.tool.driver.name).toBe("clj-kondo")
    expect(summary(parsed.run)).toEqual(EXPECTED)
    expect(parsed.run.results.every((r) => r.level === "warning")).toBe(true)
  })

  test("other linters' findings aren't dead code; an unused alias is, when the project turns it on", () => {
    const parsed = Option.getOrThrow(parseKondoDeadCode(report(finding("redundant-do"), finding("unresolved-symbol", "error"), finding("unused-alias")), "/repo"))
    if (parsed._tag !== "Read") throw new Error("not read")
    expect(summary(parsed.run)).toEqual([{ ruleId: "dead-code/unused-alias", message: "unused-alias", path: "src/a.clj", line: 3 }])
  })

  test("a file clj-kondo couldn't read is said, where and why: its dead code would go unseen", () => {
    expect(Option.getOrThrow(parseKondoDeadCode(report(finding("unused-binding"), finding("syntax", "error", "Unmatched bracket: unexpected )")), "/repo")))
      .toEqual({ _tag: "Unread", where: "src/a.clj:3: Unmatched bracket: unexpected )" })
  })

  test("output that isn't clj-kondo's JSON isn't read", () => {
    expect(Option.isNone(parseKondoDeadCode("WARNING: some JVM noise", "/repo"))).toBe(true)
    expect(Option.isNone(parseKondoDeadCode("{}", "/repo"))).toBe(true)
  })
})

const FILES = { "deps.edn": "{:paths [\"src\"]}\n", "src/svc/money.clj": "(ns svc.money)\n", "test/svc/money_test.clj": "(ns svc.money-test)\n" }

/** The gate with a process runner that answers `clj-kondo` as given, or can't start it when `missing`. */
const kondoGate = (answer: { exitCode?: number; stdout?: string; stderr?: string }, missing = false) => {
  const g = fakeGate(FILES)
  const calls: RunRequest[] = []
  const layer = Layer.mergeAll(
    Layer.succeed(ProcessRunner, {
      run: (r) => {
        calls.push(r)
        if (missing) return Effect.fail(new ProcessFailed({ command: r.command, args: r.args, reason: "ENOENT: no such file or directory, posix_spawn 'clj-kondo'" }))
        return Effect.succeed({ exitCode: answer.exitCode ?? 0, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" })
      },
    }),
    BunServices.layer,
  )
  const run = () => Effect.runPromise(deadCode({ kind: "gate", name: "dead-code", ratchet: true, scope: "all" }, g.ctx).pipe(Effect.provide(layer)) as Effect.Effect<GateRun, never, never>)
  return { ctx: g.ctx, calls, run }
}

describe("the dead-code gate", () => {
  test("runs clj-kondo over main and test code and reports its unused-* findings, keeping its JSON in the output directory", async () => {
    const g = kondoGate({ exitCode: 2, stdout: fixture })
    const r = await g.run()
    expect(r.error).toBeUndefined()
    expect([g.calls[0]!.command, ...g.calls[0]!.args]).toEqual(["clj-kondo", "--lint", "src", "test", "--config", "{:output {:format :json}}", "--parallel"])
    expect(r.exitCode).toBe(0)
    expect(r.runs.flatMap((x) => summary(x))).toEqual(EXPECTED)
    expect(existsSync(join(g.ctx.outputDir, "clj-kondo-dead-code.json"))).toBe(true)
    expect(existsSync(join(g.ctx.outputDir, "clj-kondo-dead-code.sarif"))).toBe(true)
  })

  test("without clj-kondo installed it's an error saying how to install it, not a pass", async () => {
    const r = await kondoGate({}, true).run()
    expect(r.error).toBe("clj-kondo isn't installed (https://github.com/clj-kondo/clj-kondo/blob/master/doc/install.md)")
    expect(r.notSetUp).toBe(true)
  })

  test("output it can't read is an error quoting it", async () => {
    expect((await kondoGate({ exitCode: 2, stdout: "WARNING: some JVM noise\n" }).run()).error).toBe("clj-kondo's output couldn't be read: WARNING: some JVM noise")
  })

  test("a file it couldn't read, or a crash, is an error with what clj-kondo said", async () => {
    expect((await kondoGate({ exitCode: 3, stdout: report(finding("syntax", "error", "Unmatched bracket: unexpected )")) }).run()).error).toBe("clj-kondo couldn't read the code: src/a.clj:3: Unmatched bracket: unexpected )")
    expect((await kondoGate({ exitCode: 1, stderr: "Exception in thread main\n" }).run()).error).toBe("clj-kondo couldn't lint the code: Exception in thread main")
  })
})

describe("the policy language", () => {
  const compile = (gates: string) => compilePolicy({ file: ".gauntlet/policy.gx", text: `gauntlet "svc"\nuse clojure\nmode enforce\nowners @p\ngates { fast { ${gates} } }\nreview { auto when all gates pass }\n` }, [spec])

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
  test("init doesn't draft dead-code: `lint ratchet` already holds clj-kondo's unused-* findings", () => {
    const files: Record<string, string> = { "deps.edn": "{}", ".clj-kondo/config.edn": "{}", "src/a.clj": "", "test/a_test.clj": "" }
    const o = onboard({ files: Object.keys(files).sort(), read: (p) => files[p] })
    expect(o.fast).toContain("lint ratchet")
    expect(o.fast).not.toContain("dead-code ratchet")
  })
})

import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { explainPolicy, type GateRun, ProcessRunner, type RunRequest } from "@gauntlet/core"
import { compilePolicy } from "@gauntlet/dsl"
import { Effect, Layer, Option } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fakeGate } from "../../../packages/core/test/fake-gate.ts"
import { spec } from "../src/catalog.ts"
import { DEADCODE_MODULE, parseDeadcode } from "../src/deadcode.ts"
import { deadCode } from "../src/gates.ts"

// Spec 0017 §4, the Go pack: deadcode's JSON report as dead-code findings. The
// fixture is what deadcode v0.52.0 printed (`deadcode -test -json ./...`) for
// a module whose main calls money.Add and nothing else.

const fixture = readFileSync(join(import.meta.dir, "fixtures", "deadcode", "deadcode-v0.52.0.json"), "utf8")

const summary = (run: { results: ReadonlyArray<{ ruleId: string; message: { text: string }; locations?: ReadonlyArray<{ physicalLocation?: { artifactLocation?: { uri: string }; region?: { startLine?: number } } }> }> }) =>
  run.results.map((r) => ({ ruleId: r.ruleId, message: r.message.text, path: r.locations?.[0]?.physicalLocation?.artifactLocation?.uri, line: r.locations?.[0]?.physicalLocation?.region?.startLine }))

const EXPECTED = [
  { ruleId: "dead-code/unreachable-func", message: "unreachable func: neverCalled", path: "cmd/app/main.go", line: 13 },
  { ruleId: "dead-code/unreachable-func", message: "unreachable func: Sub", path: "money/money.go", line: 7 },
  { ruleId: "dead-code/unreachable-func", message: "unreachable func: Money.unusedMethod", path: "money/money.go", line: 11 },
  { ruleId: "dead-code/unreachable-func", message: "unreachable func: helper", path: "money/money.go", line: 13 },
]

describe("deadcode's JSON report", () => {
  test("each unreachable function is a dead-code finding with its file and line", () => {
    const run = Option.getOrThrow(parseDeadcode(fixture, "/repo"))
    expect(run.tool.driver.name).toBe("deadcode")
    expect(summary(run)).toEqual(EXPECTED)
  })

  test("no dead code prints null, which is no findings", () => {
    expect(Option.getOrThrow(parseDeadcode("null\n", "/repo")).results).toEqual([])
  })

  test("generated code and marker methods aren't findings; absolute paths are made relative", () => {
    const json = JSON.stringify([{ Name: "p", Path: "x/p", Funcs: [
      { Name: "gen", Position: { File: "/repo/p/gen.go", Line: 3, Col: 6 }, Generated: true, Marker: false },
      { Name: "T.isNode", Position: { File: "/repo/p/p.go", Line: 5, Col: 12 }, Generated: false, Marker: true },
      { Name: "dead", Position: { File: "/repo/p/p.go", Line: 9, Col: 6 }, Generated: false, Marker: false },
    ] }])
    expect(summary(Option.getOrThrow(parseDeadcode(json, "/repo")))).toEqual([{ ruleId: "dead-code/unreachable-func", message: "unreachable func: dead", path: "p/p.go", line: 9 }])
  })

  test("output that isn't deadcode's JSON report isn't read", () => {
    expect(Option.isNone(parseDeadcode("deadcode: no main packages", "/repo"))).toBe(true)
    expect(Option.isNone(parseDeadcode("{}", "/repo"))).toBe(true)
  })
})

const FILES = { "go.mod": "module example.com/svc\n\ngo 1.22\n", "money/money.go": "package money\n" }

/** The gate with a process runner that answers `deadcode` (found on PATH unless `missing`) as given. */
const deadcodeGate = (answer: { exitCode?: number; stdout?: string; stderr?: string }, missing = false) => {
  const g = fakeGate(FILES)
  const calls: RunRequest[] = []
  const layer = Layer.mergeAll(
    Layer.succeed(ProcessRunner, {
      run: (r) => Effect.sync(() => {
        calls.push(r)
        if (r.command === "sh" && r.args[1]?.startsWith("command -v ")) return missing ? { exitCode: 1, stdout: "", stderr: "" } : { exitCode: 0, stdout: `/bin/${r.args[1].slice(11)}\n`, stderr: "" }
        if (r.command === "/bin/deadcode") return { exitCode: answer.exitCode ?? 0, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" }
        return { exitCode: 0, stdout: "", stderr: "" }
      }),
    }),
    BunServices.layer,
  )
  const run = () => Effect.runPromise(deadCode({ kind: "gate", name: "dead-code", ratchet: true, scope: "all" }, g.ctx).pipe(Effect.provide(layer)) as Effect.Effect<GateRun, never, never>)
  return { ctx: g.ctx, calls, run }
}

describe("the dead-code gate", () => {
  test("runs deadcode with tests as roots and reports its findings, keeping the report in the output directory", async () => {
    const g = deadcodeGate({ stdout: fixture })
    const r = await g.run()
    expect(r.error).toBeUndefined()
    const call = g.calls.find((c) => c.command === "/bin/deadcode")!
    expect(call.args).toEqual(["-test", "-json", "./..."])
    expect(call.env).toMatchObject({ GOTOOLCHAIN: "local", GOWORK: "off", GOFLAGS: "-mod=readonly" })
    expect(r.runs.flatMap((x) => summary(x))).toEqual(EXPECTED)
    expect(existsSync(join(g.ctx.outputDir, "deadcode.json"))).toBe(true)
    expect(existsSync(join(g.ctx.outputDir, "deadcode.sarif"))).toBe(true)
  })

  test("without deadcode installed it's an error naming the pinned version to install, not a pass", async () => {
    const g = deadcodeGate({}, true)
    const r = await g.run()
    expect(r.error).toBe("deadcode isn't installed (go install golang.org/x/tools/cmd/deadcode@v0.52.0)")
    expect(r.notSetUp).toBe(true)
    expect(DEADCODE_MODULE).toBe("golang.org/x/tools/cmd/deadcode@v0.52.0")
  })

  test("a module with no main package and no tests says so", async () => {
    expect((await deadcodeGate({ exitCode: 1, stderr: "deadcode: no main packages\n" }).run()).error).toBe("deadcode found no main package or test to start from")
  })

  test("code that doesn't load is an error, with what deadcode said", async () => {
    const r = await deadcodeGate({ exitCode: 1, stderr: "money/bad.go:2:14: expected ')', found '{'\ndeadcode: packages contain errors\n" }).run()
    expect(r.error).toBe("deadcode couldn't run: deadcode: packages contain errors")
  })
})

describe("the policy language", () => {
  const compile = (gates: string) => compilePolicy({ file: ".gauntlet/policy.gx", text: `gauntlet "svc"\nuse go\nmode enforce\nowners @p\ngates { fast { ${gates} } }\nreview { auto when all gates pass }\n` }, [spec])

  test("accepts `dead-code`, `dead-code ratchet` and `dead-code advise on changed`", () => {
    for (const gates of ["build, dead-code", "build, dead-code ratchet", "dead-code advise on changed"]) {
      const c = compile(gates)
      if (c._tag === "Invalid") throw new Error(`'${gates}' didn't compile: ${JSON.stringify(c.diagnostics)}`)
      expect(c.compiled.ir.gates[0]!.checks.some((x) => x.kind === "gate" && x.name === "dead-code")).toBe(true)
    }
    const ratchet = compile("dead-code ratchet")
    if (ratchet._tag === "Invalid") throw new Error("didn't compile")
    expect(ratchet.compiled.ir.gates[0]!.checks[0]).toMatchObject({ kind: "gate", name: "dead-code", ratchet: true })
  })

  test("`dead-code advise` can't also ratchet, as with any gate's advice", () => {
    expect(compile("dead-code advise ratchet")._tag).toBe("Invalid")
  })

  test("explain says what a dead-code ratchet holds", () => {
    const c = compile("build, dead-code ratchet")
    if (c._tag === "Invalid") throw new Error("didn't compile")
    expect(explainPolicy(c.compiled.ir, "gates")).toContain("dead-code and no worse than the baseline")
  })
})

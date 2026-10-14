import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { explainPolicy, type GateRun, ProcessRunner, type RunRequest } from "@gauntlet/core"
import { compilePolicy } from "@gauntlet/dsl"
import { Effect, Layer, Option } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fakeGate } from "../../../packages/core/test/fake-gate.ts"
import { spec } from "../src/catalog.ts"
import { deadCode } from "../src/gates.ts"
import { pythonPack } from "../src/index.ts"
import { onboard } from "../src/onboard.ts"
import { MIN_CONFIDENCE, parseVulture, vultureArgs } from "../src/vulture.ts"

// Spec 0017 §4, the Python pack: vulture's report as dead-code findings. The
// fixture is what vulture 2.16 printed (`vulture --min-confidence 0 src
// tests`) for a src layout whose money module has an unused import, property,
// method, attribute, class, function, argument and unreachable code, and
// whose test asks for a fixture only for what it sets up.

const fixture = readFileSync(join(import.meta.dir, "fixtures", "vulture", "vulture-2.16.txt"), "utf8")

const summary = (run: { results: ReadonlyArray<{ ruleId: string; message: { text: string }; locations?: ReadonlyArray<{ physicalLocation?: { artifactLocation?: { uri: string }; region?: { startLine?: number } } }> }> }) =>
  run.results.map((r) => ({ ruleId: r.ruleId, message: r.message.text, path: r.locations?.[0]?.physicalLocation?.artifactLocation?.uri, line: r.locations?.[0]?.physicalLocation?.region?.startLine }))

const at = (ruleId: string, message: string, line: number) => ({ ruleId: `dead-code/${ruleId}`, message, path: "src/svc/money.py", line })
const EXPECTED = [
  at("unused-import", "unused import 'os'", 1),
  at("unused-property", "unused property 'is_zero'", 10),
  at("unused-method", "unused method 'unused_method'", 14),
  at("unused-attribute", "unused attribute 'last_added'", 18),
  at("unused-class", "unused class 'Ledger'", 22),
  at("unused-function", "unused function 'helper'", 30),
  at("unused-variable", "unused variable 'unused_arg'", 30),
  at("unreachable-code", "unreachable code after 'return'", 33),
  at("unused-function", "unused function 'branchy'", 36),
  at("unreachable-code", "unsatisfiable 'if' condition", 37),
  at("unreachable-code", "unsatisfiable 'while' condition", 39),
]

describe("vulture's report", () => {
  test("each line is a dead-code finding of its kind, with its file and line; test files' aren't", () => {
    const run = Option.getOrThrow(parseVulture(fixture, "/repo"))
    expect(run.tool.driver.name).toBe("vulture")
    expect(summary(run)).toEqual(EXPECTED)
  })

  test("nothing unused prints nothing, which is no findings", () => {
    expect(Option.getOrThrow(parseVulture("", "/repo")).results).toEqual([])
  })

  test("absolute paths are made relative; a redundant condition is unreachable code; sizes are allowed", () => {
    const text = "/repo/app.py:4: redundant if-condition (100% confidence)\n/repo/app.py:9: unused function 'f' (60% confidence, 3 lines)\n"
    expect(summary(Option.getOrThrow(parseVulture(text, "/repo")))).toEqual([
      { ruleId: "dead-code/unreachable-code", message: "redundant if-condition", path: "app.py", line: 4 },
      { ruleId: "dead-code/unused-function", message: "unused function 'f'", path: "app.py", line: 9 },
    ])
  })

  test("output that isn't vulture's report isn't read", () => {
    expect(Option.isNone(parseVulture("Traceback (most recent call last):\n", "/repo"))).toBe(true)
    expect(Option.isNone(parseVulture("src/a.py:1: unused import 'os' (90% confidence)\nsomething else\n", "/repo"))).toBe(true)
  })
})

describe("vulture's arguments", () => {
  const files = ["pyproject.toml", "setup.py", "src/svc/money.py", "tests/test_money.py", "docs/conf.txt", ".venv/lib/x.py"]

  test("every top-level directory or file with Python in it, at Gauntlet's minimum confidence", () => {
    expect(MIN_CONFIDENCE).toBe(80)
    expect(vultureArgs("[project]\nname = \"x\"\n", files)).toEqual(["--min-confidence", "80", "setup.py", "src", "tests"])
  })

  test("a project's own [tool.vulture] paths and min_confidence are kept", () => {
    expect(vultureArgs("[tool.vulture]\nmin_confidence = 60\npaths = [\"src\", \"vulture_whitelist.py\"]\n\n[tool.ruff]\nline-length = 100\n", files)).toEqual([])
    expect(vultureArgs("[tool.vulture]\nmin_confidence = 60\n", files)).toEqual(["setup.py", "src", "tests"])
    expect(vultureArgs("[tool.vulture]\npaths = [\"src\"]\n", files)).toEqual(["--min-confidence", "80"])
  })
})

const FILES = { "uv.lock": "", "pyproject.toml": "[dependency-groups]\ndev = [\"vulture\"]\n", "src/svc/money.py": "", "tests/test_money.py": "" }

/** The gate with a process runner that answers `uv run … vulture` as given; vulture is installed unless `missing`. */
const vultureGate = (answer: { exitCode?: number; stdout?: string; stderr?: string }, missing = false) => {
  const g = fakeGate({ ...FILES, ...(missing ? {} : { ".venv/bin/vulture": "" }) })
  const calls: RunRequest[] = []
  const layer = Layer.mergeAll(
    Layer.succeed(ProcessRunner, {
      run: (r) => Effect.sync(() => {
        calls.push(r)
        if (r.command === "uv" && r.args.includes("vulture")) return { exitCode: answer.exitCode ?? 0, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" }
        return { exitCode: 0, stdout: "", stderr: "" }
      }),
    }),
    BunServices.layer,
  )
  const run = () => Effect.runPromise(deadCode({ kind: "gate", name: "dead-code", ratchet: true, scope: "all" }, g.ctx).pipe(Effect.provide(layer)) as Effect.Effect<GateRun, never, never>)
  return { ctx: g.ctx, calls, run }
}

describe("the dead-code gate", () => {
  test("runs the project's vulture and reports its findings, keeping the report in the output directory", async () => {
    const g = vultureGate({ exitCode: 3, stdout: fixture })
    const r = await g.run()
    expect(r.error).toBeUndefined()
    const call = g.calls.find((c) => c.command === "uv" && c.args.includes("vulture"))!
    expect(call.args).toEqual(["run", "--frozen", "--no-sync", "vulture", "--min-confidence", "80", "src", "tests"])
    expect(r.command).toEqual(["vulture", "--min-confidence", "80", "src", "tests"])
    expect(r.exitCode).toBe(0)
    expect(r.runs.flatMap((x) => summary(x))).toEqual(EXPECTED)
    expect(existsSync(join(g.ctx.outputDir, "vulture.txt"))).toBe(true)
    expect(existsSync(join(g.ctx.outputDir, "vulture.sarif"))).toBe(true)
  })

  test("without vulture installed it's an error saying how to add it, not a pass", async () => {
    const r = await vultureGate({}, true).run()
    expect(r.error).toBe("vulture isn't installed in the project: add it as a dev dependency")
    expect(r.notSetUp).toBe(true)
  })

  test("code vulture can't read is an error, with what vulture said", async () => {
    const r = await vultureGate({ exitCode: 3, stdout: "src/svc/money.py:1: unused import 'os' (90% confidence)\n", stderr: "src/svc/bad.py:1: invalid syntax at \"def broken(:\"\n" }).run()
    expect(r.error).toBe("vulture couldn't read the code: src/svc/bad.py:1: invalid syntax at \"def broken(:\"")
  })

  test("a report it can't read is an error quoting it", async () => {
    const r = await vultureGate({ exitCode: 3, stdout: "vulture 9: a new format\n" }).run()
    expect(r.error).toBe("vulture's report couldn't be read: vulture 9: a new format")
  })

  test("bad configuration is an error, with what vulture said", async () => {
    const r = await vultureGate({ exitCode: 2, stderr: "Data type for exclude must be 'list'\n" }).run()
    expect(r.error).toBe("vulture couldn't run: Data type for exclude must be 'list'")
    expect((await vultureGate({ exitCode: 2, stderr: "usage: vulture [options]\nvulture: error: unrecognized arguments: --nope\n" }).run()).error).toBe("vulture couldn't run: vulture: error: unrecognized arguments: --nope")
  })
})

describe("the policy language", () => {
  const compile = (gates: string) => compilePolicy({ file: ".gauntlet/policy.gx", text: `gauntlet "svc"\nuse python\nmode enforce\nowners @p\ngates { fast { ${gates} } }\nreview { auto when all gates pass }\n` }, [spec])

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
  const view = (files: Record<string, string>) => ({ files: Object.keys(files).sort(), read: (p: string) => files[p] })

  test("init drafts `dead-code ratchet` when the project already uses vulture, and protects its whitelist", () => {
    const o = onboard(view({ "pyproject.toml": "[dependency-groups]\ndev = [\"pytest\", \"vulture>=2\"]\n", "uv.lock": "", "vulture_whitelist.py": "", "src/x/a.py": "", "tests/test_a.py": "" }))
    expect(o.fast).toContain("dead-code ratchet")
    expect(o.protect.config).toEqual(["pyproject.toml", "vulture_whitelist.py"])
  })

  test("init doesn't draft it otherwise", () => {
    expect(onboard(view({ "pyproject.toml": "[dependency-groups]\ndev = [\"pytest\"]\n", "src/x/a.py": "" })).fast).not.toContain("dead-code ratchet")
  })

  test("a vulture whitelist is runner configuration, put back to base before anything runs", () => {
    expect(pythonPack.runnerConfig).toEqual(expect.arrayContaining(["vulture_whitelist.py", "**/vulture_whitelist.py"]))
  })
})

import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { type GateContext, ProcessRunner, type RunRequest } from "@gauntlet/core"
import type { Check } from "@gauntlet/ir"
import { Effect, Layer, Option } from "effect"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { build, coverage, lint, mutation, runSuite } from "../src/gates.ts"
import { tamper } from "../src/tamper.ts"

// The Go gates with a scripted process runner: what they run, and how they
// read what the tools write into the output directory. The real tools are
// covered by the end-to-end test.

type Handler = (r: RunRequest, out: string) => { exitCode?: number; stdout?: string; stderr?: string }

const FILES: Record<string, string> = {
  "go.mod": "module example.com/svc\n\ngo 1.27\n",
  "money/money.go": "package money\n\n// Add adds.\nfunc Add(a, b int64) int64 { return a + b }\n",
  "money/money_test.go": "package money\n\nimport \"testing\"\n\nfunc TestAdd(t *testing.T) {\n\tif got := Add(1, 2); got != 3 {\n\t\tt.Errorf(\"got %d\", got)\n\t}\n}\n",
  "money/types.go": "package money\n\n// Money is an amount.\ntype Money struct{ Minor int64 }\n",
}

const gate = (scope?: string[], added: Record<string, number[]> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "gauntlet-go-gate-"))
  for (const [p, t] of Object.entries(FILES)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), t)
  }
  const out = join(mkdtempSync(join(tmpdir(), "gauntlet-go-out-")), "0-check")
  mkdirSync(out)
  const ctx: GateContext = {
    dir,
    outputDir: out,
    collect: Effect.sync(() => readdirSync(out, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => {
      const full = join(e.parentPath, e.name)
      return { path: full.slice(out.length + 1), content: readFileSync(full, "utf8") }
    })),
    ir: { zones: [], arch: [] } as never,
    facts: { addedLines: new Map(Object.entries(added).map(([p, ls]) => [p, ls.map((line) => ({ line, text: (FILES[p] ?? "").split("\n")[line - 1] ?? "" }))])) } as never,
    ...(scope ? { scope } : {}),
    files: Object.keys(FILES).sort(),
    legacy: [],
  }
  return ctx
}

const run = <A>(effect: Effect.Effect<A, never, never>) => Effect.runPromise(effect)
const withRunner = (ctx: GateContext, handler: Handler) => {
  const calls: RunRequest[] = []
  const layer = Layer.succeed(ProcessRunner, {
    run: (r) => Effect.sync(() => {
      calls.push(r)
      // Tools on PATH resolve to their own name; nothing is in GOBIN or GOPATH.
      if (r.command === "sh" && r.args[1]?.startsWith("command -v ")) return { exitCode: 0, stdout: `/bin/${r.args[1].slice(11)}\n`, stderr: "" }
      if (r.command === "go" && r.args[0] === "env") return { exitCode: 0, stdout: "\n", stderr: "" }
      if (r.command === "go" && r.args[0] === "mod") return { exitCode: 0, stdout: "", stderr: "" }
      const res = handler(r, ctx.outputDir)
      return { exitCode: res.exitCode ?? 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" }
    }),
  })
  return { calls, provide: <A, E, R>(e: Effect.Effect<A, E, R>) => e.pipe(Effect.provide(Layer.mergeAll(layer, BunServices.layer))) as Effect.Effect<A, E, never> }
}

const GATE = { kind: "gate", name: "x", ratchet: false, scope: "all" } as Extract<Check, { kind: "gate" }>
const events = (xs: object[]) => xs.map((x) => JSON.stringify(x)).join("\n")

describe("Go gates", () => {
  test("build compiles packages, then tests without running them", async () => {
    const ctx = gate()
    const r = withRunner(ctx, () => ({}))
    expect((await run(r.provide(build(GATE, ctx)))).exitCode).toBe(0)
    expect(r.calls.filter((c) => c.command === "go" && c.args[0] !== "mod").map((c) => c.args.join(" "))).toEqual(["build ./...", "test -count=1 -run ^$ ./..."])
    expect(r.calls[0]!.env).toMatchObject({ GOTOOLCHAIN: "local", GOWORK: "off", GOFLAGS: "-mod=readonly" })
  })

  test("a module download failure blocks the gate with the reason", async () => {
    const ctx = gate()
    const layer = Layer.succeed(ProcessRunner, { run: () => Effect.succeed({ exitCode: 1, stdout: "", stderr: "go: example.com/x@v1: not found\n" }) })
    const res = await run(build(GATE, ctx).pipe(Effect.provide(Layer.mergeAll(layer, BunServices.layer))))
    expect(res.error).toBe("go mod download failed: go: example.com/x@v1: not found")
  })

  test("the suite runs go test -json uncached, keeps the output as evidence, and reruns subsets shuffled", async () => {
    const ctx = gate()
    const json = events([
      { Action: "output", Package: "example.com/svc/money", Test: "TestAdd", Output: "    money_test.go:7: got 4\n" },
      { Action: "fail", Package: "example.com/svc/money", Test: "TestAdd" },
    ])
    const r = withRunner(ctx, () => ({ exitCode: 1, stdout: json }))
    const res = await run(r.provide(runSuite({ name: "unit", location: "**/*_test.go" }, ctx)))
    expect(r.calls.at(-1)!.args).toEqual(["test", "-json", "-count=1", "./..."])
    expect(res.tests?.counts.failed).toBe(1)
    expect(readFileSync(join(ctx.outputDir, "go-test.json"), "utf8")).toBe(json)
    const again = gate()
    const r2 = withRunner(again, () => ({ stdout: "" }))
    await run(r2.provide(runSuite({ name: "unit", location: "**/*_test.go" }, again, { files: [], ids: ["example.com/svc/money.TestAdd"], seed: 42 })))
    expect(r2.calls.at(-1)!.args).toEqual(["test", "-json", "-count=1", "-shuffle=42", "-run", "^(TestAdd)$", "./money"])
  })

  test("lint reads golangci-lint's SARIF from the output directory, with a cache of its own", async () => {
    const ctx = gate()
    const r = withRunner(ctx, (c, out) => {
      if (c.command.endsWith("golangci-lint")) {
        writeFileSync(join(out, "golangci.sarif"), JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "golangci-lint" } }, results: [{ ruleId: "errcheck", level: "error", message: { text: "unchecked" }, locations: [{ physicalLocation: { artifactLocation: { uri: "money/money.go" }, region: { startLine: 4 } } }] }] }] }))
      }
      return {}
    })
    const res = await run(r.provide(lint(GATE, ctx)))
    expect(res.runs.map((x) => `${x.tool.driver.name}:${x.results.length}`)).toEqual(["golangci-lint:1", "go-rules:0"])
    const call = r.calls.find((c) => c.command.endsWith("golangci-lint"))!
    expect(call.args).toContain("--issues-exit-code=0")
    expect(call.env?.GOLANGCI_LINT_CACHE).toBe(join(dirname(ctx.outputDir), "golangci-cache"))
  })

  test("lint fails loudly when golangci-lint can't run or writes nothing", async () => {
    const ctx = gate()
    expect((await run(withRunner(ctx, () => ({ exitCode: 3, stderr: "config invalid" })).provide(lint(GATE, ctx)))).error).toBe("golangci-lint couldn't run: config invalid")
    const quiet = gate()
    expect((await run(withRunner(quiet, () => ({})).provide(lint(GATE, quiet)))).error).toBe("golangci-lint wrote no SARIF report")
  })

  test("mutation mutates only the files in scope and scores gremlins' results", async () => {
    const ctx = gate(["money/money.go"])
    const r = withRunner(ctx, (c, out) => {
      if (c.command.endsWith("gremlins")) {
        writeFileSync(join(out, "gremlins.json"), JSON.stringify({ files: [{ file_name: "money/money.go", mutations: [
          { type: "ARITHMETIC_BASE", status: "KILLED", line: 4 }, { type: "INVERT_NEGATIVES", status: "LIVED", line: 4 }, { type: "X", status: "NOT VIABLE", line: 4 },
        ] }] }))
      }
      return {}
    })
    const res = await run(r.provide(mutation(GATE, ctx)))
    expect(res.metrics?.mutation).toMatchObject({ value: 50, perFile: { "money/money.go": 50 } })
    expect(res.runs[0]!.results.map((x) => x.message.text)).toEqual(["No test kills a invert negatives mutant"])
    const args = r.calls.find((c) => c.command.endsWith("gremlins"))!.args
    expect(args).toContain("^money/types\\.go$")
    expect(args).not.toContain("^money/money\\.go$")
  })

  test("mutation with nothing in scope, or no report, says so", async () => {
    const none = gate(["money/money_test.go"])
    expect((await run(withRunner(none, () => ({})).provide(mutation(GATE, none)))).nothingInScope).toBe("no main Go files in scope to mutate")
    const silent = gate(["money/money.go"])
    expect((await run(withRunner(silent, () => ({ stderr: "boom" })).provide(mutation(GATE, silent)))).error).toBe("gremlins wrote no report: boom")
  })

  test("coverage counts changed statements, and changed code missing from the profile as uncovered, but not type-only files", async () => {
    const ctx = gate(["money/money.go", "money/types.go"], { "money/money.go": [4], "money/types.go": [3, 4] })
    const r = withRunner(ctx, (_c, out) => {
      writeFileSync(join(out, "cover.out"), "mode: set\nexample.com/svc/money/money.go:4.40,4.56 1 1\n")
      return {}
    })
    const res = await run(r.provide(coverage(GATE, ctx)))
    expect(res.metrics?.coverage).toMatchObject({ value: 100, perFile: { "money/money.go": 100 } })
    expect(r.calls.find((c) => c.args.includes("-covermode=set"))!.args).toContain("-coverpkg=./...")
  })
})

describe("Go tamper fixtures", () => {
  test("each fixture is built from the project's own files", async () => {
    const files = Object.keys(FILES).sort()
    const out = await Effect.runPromise(tamper({
      files,
      read: (p) => Effect.succeed(Option.fromNullishOr(FILES[p])),
      ir: undefined as never,
      isTestPath: (p) => p.endsWith("_test.go"),
    }))
    expect(out.map((t) => t.fixture)).toEqual(["deleted-test", "added-skip", "weakened-assertion", "added-suppression", "test-id-in-main", "hardcoded-expected-value", "edited-test-setup"])
    const content = (f: string) => out.find((t) => t.fixture === f)!.edits[0]!.content!
    expect(content("deleted-test")).not.toContain("func TestAdd")
    expect(content("added-skip")).toContain("\tt.Skip(\"gauntlet selftest\")")
    expect(content("weakened-assertion")).not.toContain("t.Errorf")
    expect(content("added-suppression")).toContain("//nolint")
    expect(out.find((t) => t.fixture === "test-id-in-main")!.edits[0]).toEqual({ path: "money/gauntlet_selftest_probe.go", content: "package money\n\nimport \"testing\"\n\nvar gauntletSelftestProbe = testing.Testing()\n" })
    expect(content("hardcoded-expected-value")).toContain("func Add(a, b int64) int64 {\n\treturn 3\n}")
    expect(content("edited-test-setup")).toContain("func TestMain(m *testing.M) { gauntletSelftestOs.Exit(0) }")
  })
})

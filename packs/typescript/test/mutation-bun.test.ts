import { afterEach, describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { ProcessRunnerLive } from "@gauntlet/core"
import { Effect, Layer } from "effect"
import { noFacts } from "../../../packages/core/test/fixtures.ts"
import { mutation } from "../src/gates.ts"

// Under Bun every mutant used to run the whole suite. Now only the changed
// lines are mutated, only the tests that run them are used, each run stops at
// the first failure, and survivors are checked again against the whole suite.
// Stryker is a stand-in that logs its config; bun test is real.

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

const FAKE_STRYKER = `#!/usr/bin/env bun
const config = (await import(process.argv[3])).default
const fs = require("node:fs")
fs.appendFileSync(process.env.STRYKER_LOG, JSON.stringify({ mutate: config.mutate, command: config.commandRunner?.command, report: config.jsonReporter.fileName }) + "\\n")
const confirm = config.jsonReporter.fileName.endsWith("confirm.json")
if (confirm && process.env.WHOLE_SUITE_FAILS) process.exit(1)
const mutants = [
  { status: confirm ? "Killed" : "Survived", mutatorName: "BooleanLiteral", location: { start: { line: 2, column: 10 }, end: { line: 2, column: 14 } } },
  ...(confirm ? [] : [{ status: "Killed", mutatorName: "ArithmeticOperator", location: { start: { line: 2, column: 20 }, end: { line: 2, column: 25 } } }]),
]
fs.mkdirSync(require("node:path").dirname(config.jsonReporter.fileName), { recursive: true })
fs.writeFileSync(config.jsonReporter.fileName, JSON.stringify({ files: { ["src/a.ts"]: { mutants } } }))
`

const project = () => {
  const root = mkdtempSync(join(tmpdir(), "gauntlet-mutation-"))
  dirs.push(root)
  const dir = join(root, "checkout")
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "p", devDependencies: { "@stryker-mutator/core": "9" } }),
    "bun.lock": "",
    "src/a.ts": "export const a = (n: number) => {\n  return n > 0 ? true : n + 1\n}\n",
    "src/c.ts": "export const other = () => 1\n",
    "src/a.test.ts": "import { expect, test } from \"bun:test\"\nimport { a } from \"./a.ts\"\ntest(\"a\", () => expect(a(1)).toBe(true))\n",
    "src/b.test.ts": "import { expect, test } from \"bun:test\"\nimport { other } from \"./c.ts\"\ntest(\"b\", () => expect(other()).toBe(1))\n",
    "node_modules/.bin/stryker": FAKE_STRYKER,
  }
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), c)
  }
  chmodSync(join(dir, "node_modules/.bin/stryker"), 0o755)
  const outputDir = join(root, "outputs", "1-mutation")
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(join(root, "outputs", ".typescript-install"), "ok")
  return { dir, outputDir, log: join(root, "stryker.log"), files: Object.keys(files).filter((f) => !f.startsWith("node_modules")) }
}

const walk = (d: string): string[] => readdirSync(d).flatMap((n) => statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)])

const run = async (p: ReturnType<typeof project>, wholeSuiteFails = false) => {
  process.env.STRYKER_LOG = p.log
  if (wholeSuiteFails) process.env.WHOLE_SUITE_FAILS = "1"
  else delete process.env.WHOLE_SUITE_FAILS
  const ctx = {
    dir: p.dir,
    outputDir: p.outputDir,
    collect: Effect.sync(() => walk(p.outputDir).map((f) => ({ path: relative(p.outputDir, f), content: readFileSync(f, "utf8") }))),
    ir: {} as never,
    facts: noFacts({ addedLines: new Map([["src/a.ts", [{ line: 2, text: "  return n > 0 ? true : n + 1" }]]]) }),
    scope: ["src/a.ts"],
    files: p.files,
    legacy: [],
  }
  const result = await Effect.runPromise(mutation({ kind: "gate", name: "mutation", scope: "changed" } as never, ctx).pipe(Effect.provide(Layer.provideMerge(ProcessRunnerLive, BunServices.layer))))
  return { result, calls: readFileSync(p.log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) }
}

describe("mutation under bun test", () => {
  test("mutates the changed lines with the tests that run them, then confirms survivors with the whole suite", async () => {
    const { result, calls } = await run(project())
    expect(calls[0]).toMatchObject({ mutate: ["src/a.ts:2-2"], command: "bun test --bail './src/a.test.ts'" })
    expect(calls[1]).toMatchObject({ mutate: ["src/a.ts:2-2"], command: "bun test --bail" })
    // The survivor the related tests left, the whole suite killed.
    expect(result.metrics?.mutation?.value).toBe(100)
  }, 60_000)

  test("when the whole suite can't run under Stryker, the related tests' verdict stands", async () => {
    const { result, calls } = await run(project(), true)
    expect(calls).toHaveLength(2)
    expect(result.metrics?.mutation?.value).toBe(50)
    expect(result.runs[0]?.results).toHaveLength(1)
  }, 60_000)
})

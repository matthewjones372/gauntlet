import { afterEach, describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { ProcessRunnerLive } from "@gauntlet/core"
import { Effect, Layer } from "effect"
import { noFacts } from "../../../packages/core/test/fixtures.ts"
import { mutation } from "../src/gates.ts"

// Recording a baseline mutates the whole project. Under Bun that meant every
// mutant running the whole suite; now the files go to Stryker in batches, each
// running only the tests that load them. Stryker is a stand-in; bun test is real.

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
    "src/lonely.ts": "export const lonely = () => 3\n",
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
    files: p.files,
    legacy: [],
  }
  const result = await Effect.runPromise(mutation({ kind: "gate", name: "mutation", ratchet: true } as never, ctx).pipe(Effect.provide(Layer.provideMerge(ProcessRunnerLive, BunServices.layer))))
  return { result, calls: readFileSync(p.log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) }
}

describe("a baseline's mutation under bun test", () => {
  test("each batch runs only the tests that load its files; files no test loads run nothing", async () => {
    const { calls } = await run(project())
    const byFiles = Object.fromEntries(calls.map((c: { mutate: string[]; command: string }) => [c.mutate.join(","), c.command]))
    expect(byFiles["src/a.ts"]).toBe("bun test --bail './src/a.test.ts'")
    expect(byFiles["src/c.ts"]).toBe("bun test --bail './src/b.test.ts'")
    expect(byFiles["src/lonely.ts"]).toBe("true")
    expect(calls.every((c: { command: string }) => c.command !== "bun test --bail")).toBe(true)
  }, 60_000)
})

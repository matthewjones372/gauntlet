import { afterEach, describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { ProcessRunnerLive } from "@gauntlet/core"
import { Effect, Layer, Option } from "effect"
import { noFacts } from "../../../packages/core/test/fixtures.ts"
import { mutation } from "../src/gates.ts"
import { parseStryker } from "../src/reports.ts"

// Spec 0016: recording a baseline, Stryker reports every test that kills each
// mutant (disableBail), and the gate reads them into the kill map by name.

const REPORT = {
  files: {
    "/repo/src/fx.ts": {
      mutants: [
        { status: "Killed", mutatorName: "ArithmeticOperator", location: { start: { line: 2 } }, killedBy: ["1", "2"], coveredBy: ["1", "2", "3"] },
        { status: "Survived", mutatorName: "BooleanLiteral", location: { start: { line: 4 } }, coveredBy: ["3"] },
      ],
    },
  },
  testFiles: {
    "/repo/src/fx.test.ts": { tests: [{ id: "1", name: "convert GBP to USD" }, { id: "2", name: "convert rounds" }, { id: "3", name: "convert runs" }] },
  },
}

describe("parseStryker", () => {
  test("names each mutant's killers and the tests that ran it, by file and name", () => {
    const [killed, survived] = Option.getOrThrow(parseStryker(JSON.stringify(REPORT), "/repo"))
    expect(killed!.killedBy).toEqual(["src/fx.test.ts > convert GBP to USD", "src/fx.test.ts > convert rounds"])
    expect(killed!.coveredBy).toEqual(["src/fx.test.ts > convert GBP to USD", "src/fx.test.ts > convert rounds", "src/fx.test.ts > convert runs"])
    expect(survived!.killedBy).toEqual([])
    expect(survived!.coveredBy).toEqual(["src/fx.test.ts > convert runs"])
  })

  test("a test id the report doesn't name stays as it is", () => {
    const report = { ...REPORT, testFiles: { "/repo/src/fx.test.ts": { tests: [{ id: "1", name: "convert GBP to USD" }] } } }
    expect(Option.getOrThrow(parseStryker(JSON.stringify(report), "/repo"))[0]!.killedBy).toEqual(["src/fx.test.ts > convert GBP to USD", "2"])
  })

  test("without per-test results (Bun's command runner), no killers", () => {
    const { testFiles: _, ...plain } = REPORT
    expect(Option.getOrThrow(parseStryker(JSON.stringify(plain), "/repo"))[0]!.killedBy).toBeUndefined()
  })
})

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

const FAKE_STRYKER = `#!/usr/bin/env bun
const config = (await import(process.argv[3])).default
const fs = require("node:fs")
fs.appendFileSync(process.env.STRYKER_LOG, JSON.stringify({ disableBail: config.disableBail ?? false, runner: config.testRunner }) + "\\n")
const report = ${JSON.stringify({ files: { "src/fx.ts": REPORT.files["/repo/src/fx.ts"] }, testFiles: { "src/fx.test.ts": REPORT.testFiles["/repo/src/fx.test.ts"] } })}
fs.mkdirSync(require("node:path").dirname(config.jsonReporter.fileName), { recursive: true })
fs.writeFileSync(config.jsonReporter.fileName, JSON.stringify(report))
`

const project = () => {
  const root = mkdtempSync(join(tmpdir(), "gauntlet-stryker-"))
  dirs.push(root)
  const dir = join(root, "checkout")
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "p", devDependencies: { "@stryker-mutator/core": "9", "@stryker-mutator/vitest-runner": "9", vitest: "3" } }),
    "bun.lock": "",
    "src/fx.ts": "export const convert = (n: number) => {\n  return n * 2\n}\nexport const on = true\n",
    "src/fx.test.ts": "import { expect, test } from \"vitest\"\n",
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

const run = async (recordKillMap: boolean) => {
  const p = project()
  process.env.STRYKER_LOG = p.log
  const ctx = {
    dir: p.dir,
    outputDir: p.outputDir,
    collect: Effect.sync(() => walk(p.outputDir).map((f) => ({ path: relative(p.outputDir, f), content: readFileSync(f, "utf8") }))),
    ir: {} as never,
    facts: noFacts(),
    files: p.files,
    legacy: [],
    ...(recordKillMap ? { recordKillMap: true } : {}),
  }
  const result = await Effect.runPromise(mutation({ kind: "gate", name: "mutation" } as never, ctx).pipe(Effect.provide(Layer.provideMerge(ProcessRunnerLive, BunServices.layer))))
  return { result, calls: readFileSync(p.log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) }
}

describe("the Stryker gate and the kill map", () => {
  test("recording a baseline turns off bail, and the gate hands on the kill map", async () => {
    const { result, calls } = await run(true)
    expect(calls[0]).toEqual({ disableBail: true, runner: "vitest" })
    expect(result.killMap).toEqual({
      mutants: [{ path: "src/fx.ts", line: 2 }, { path: "src/fx.ts", line: 4 }],
      tests: {
        "src/fx.test.ts > convert GBP to USD": { killed: [0], reached: 1 },
        "src/fx.test.ts > convert rounds": { killed: [0], reached: 1 },
        "src/fx.test.ts > convert runs": { killed: [], reached: 2 },
      },
    })
  }, 60_000)

  test("a check keeps bail on and hands on no kill map: one killer per mutant would make the others look redundant", async () => {
    const { result, calls } = await run(false)
    expect(calls[0]).toEqual({ disableBail: false, runner: "vitest" })
    expect(result.killMap).toBeUndefined()
  }, 60_000)
})

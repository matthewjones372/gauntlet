import { BunServices } from "@effect/platform-bun"
import { type GateContext, ProcessRunner, type RunRequest, suiteSelections } from "@gauntlet/core"
import { compilePolicy } from "@gauntlet/dsl"
import { ProcessRunnerLive } from "@gauntlet/core"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { runSuite } from "../src/gates.ts"
import { typescriptPack } from "../src/index.ts"
import { bunfigOf, bunPassed, reachesUnseen, resolveImport, testFileOf, testMapOf } from "../src/test-map.ts"
import { isMainSource } from "../src/toolchain.ts"

// The TypeScript pack's test map (spec 0013): a baseline runs each test file
// on its own with coverage and maps it to the files it loaded; a check of an
// affected suite runs the test files that loaded what the change touches.

const unit = { name: "unit", location: "test/**" }

describe("which test file a test belongs to", () => {
  const files = new Set(["test/a.test.ts", "test/a.test.tsx", "test/b.spec.ts"])

  test("Jest's `<file> > <name>` and Vitest's `<file>.<name>`, the longest file that fits", () => {
    expect(testFileOf("test/a.test.ts > money > adds", files)).toBe("test/a.test.ts")
    expect(testFileOf("test/a.test.ts.money > adds", files)).toBe("test/a.test.ts")
    expect(testFileOf("test/a.test.tsx.renders.x", files)).toBe("test/a.test.tsx")
    expect(testFileOf("test/b.spec.ts.works", files)).toBe("test/b.spec.ts")
  })

  test("none for ids that name no file, as bun's did before ADR 0027", () => {
    expect(testFileOf(".top", files)).toBeUndefined()
    expect(testFileOf("money.adds", files)).toBeUndefined()
  })
})

describe("following a test's helpers", () => {
  const files = new Set(["src/money.ts", "src/index.ts", "test/helpers.ts", "test/run.ts", "test/a.test.ts", "data/rates.json"])

  test("relative imports resolve as TypeScript does: .js to .ts, a missing extension, a folder's index", () => {
    expect(resolveImport("test/a.test.ts", "../src/money.js", files)).toBe("src/money.ts")
    expect(resolveImport("test/a.test.ts", "../src/money", files)).toBe("src/money.ts")
    expect(resolveImport("test/a.test.ts", "../src", files)).toBe("src/index.ts")
    expect(resolveImport("test/a.test.ts", "../data/rates.json", files)).toBe("data/rates.json")
    expect(resolveImport("test/a.test.ts", "./gone", files)).toBeUndefined()
  })

  const unseen = (texts: Record<string, string>) => reachesUnseen("test/a.test.ts", (p) => texts[p], isMainSource, new Set([...files, ...Object.keys(texts)]))

  test("a test that imports main code and plain helpers is seen by its coverage", () => {
    expect(unseen({ "test/a.test.ts": `import { m } from "../src/money.ts"\nimport { h } from "./helpers"\nimport rates from "../data/rates.json"`, "test/helpers.ts": `export const h = 1` })).toBe(false)
    // Main code that starts processes is what the test exercises; only test-side code is followed.
    expect(unseen({ "test/a.test.ts": `import { m } from "../src/money.ts"`, "src/money.ts": `import { spawn } from "node:child_process"` })).toBe(false)
  })

  test("a test that starts processes or workers, itself or through a helper, isn't", () => {
    expect(unseen({ "test/a.test.ts": `import { spawnSync } from "node:child_process"` })).toBe(true)
    expect(unseen({ "test/a.test.ts": `const p = Bun.spawn(["bun", "src/cli.ts"])` })).toBe(true)
    expect(unseen({ "test/a.test.ts": `import { $ } from "bun"` })).toBe(true)
    expect(unseen({ "test/a.test.ts": `new Worker(new URL("./w.ts", import.meta.url))` })).toBe(true)
    expect(unseen({ "test/a.test.ts": `import { run } from "./run.ts"`, "test/run.ts": `import { execa } from "execa"` })).toBe(true)
  })

  test("nor is one that imports a computed path, or a relative path that names no file", () => {
    expect(unseen({ "test/a.test.ts": "const m = await import(`../src/${name}.ts`)" })).toBe(true)
    expect(unseen({ "test/a.test.ts": `import { g } from "./gone"` })).toBe(true)
  })
})

describe("the map from each test file's run", () => {
  test("each test file maps to what it loaded and to itself", () => {
    expect(testMapOf([
      { testFile: "test/b.test.ts", loaded: ["src/fx.ts", "src/money.ts"], unseen: false },
      { testFile: "test/a.test.ts", loaded: ["src/money.ts"], unseen: false },
    ])).toEqual({ "test/a.test.ts": ["src/money.ts", "test/a.test.ts"], "test/b.test.ts": ["src/fx.ts", "src/money.ts", "test/b.test.ts"] })
  })

  test("a run that failed, or a test coverage can't follow, maps to everything any test loaded", () => {
    const map = testMapOf([
      { testFile: "test/a.test.ts", loaded: ["src/money.ts"], unseen: false },
      { testFile: "test/b.test.ts", loaded: undefined, unseen: false },
      { testFile: "test/c.test.ts", loaded: ["src/cli.ts"], unseen: true },
    ])
    const everything = ["src/cli.ts", "src/money.ts", "test/a.test.ts", "test/b.test.ts", "test/c.test.ts"]
    expect(map["test/b.test.ts"]).toEqual(everything)
    expect(map["test/c.test.ts"]).toEqual(everything)
    expect(map["test/a.test.ts"]).toEqual(["src/money.ts", "test/a.test.ts"])
  })
})

describe("bun's configuration and reports", () => {
  test("bunfig.toml's preloads, and the coverage settings bun puts before the command line", () => {
    expect(bunfigOf(`[test]\npreload = ["./test/setup.ts", "happy-dom"]\ncoverageThreshold = 0.9\n`)).toEqual({ preload: ["./test/setup.ts", "happy-dom"], overrides: undefined })
    expect(bunfigOf(`[test]\npreload = "./test/setup.ts"\ncoverageReporter = ["text", "lcov"]\n`)).toEqual({ preload: ["./test/setup.ts"], overrides: undefined })
    // A top-level preload is for `bun run`, not `bun test`.
    expect(bunfigOf(`preload = ["./x.ts"]\n[install]\nexact = true\n`)).toEqual({ preload: [], overrides: undefined })
    expect(bunfigOf(`[test]\ncoverageReporter = ["text"]\n`)).toMatchObject({ overrides: "coverageReporter" })
    expect(bunfigOf(`[test]\ncoverageDir = "out"\n`)).toMatchObject({ overrides: "coverageDir" })
    expect(bunfigOf(`[test\n`)).toBe("bunfig.toml couldn't be read")
  })

  test("a run passed when its report has tests and no failures, whatever bun's exit code", () => {
    expect(bunPassed(`<testsuites name="bun test" tests="2" assertions="2" failures="0" skipped="0"><testsuite/></testsuites>`)).toBe(true)
    expect(bunPassed(`<testsuites name="bun test" tests="2" failures="1"></testsuites>`)).toBe(false)
    expect(bunPassed(`<testsuites name="bun test" tests="0" failures="0"></testsuites>`)).toBe(false)
    expect(bunPassed(undefined)).toBe(false)
  })
})

// ---------- recording, with a fake Vitest, Jest and bun ----------

const lcov = (hit: Record<string, boolean>) => Object.entries(hit).map(([f, h]) => `SF:${f}\nDA:1,${h ? 1 : 0}\nend_of_record`).join("\n")

const VITEST_JUNIT = `<testsuites><testsuite name="test/a.test.ts"><testcase classname="test/a.test.ts" name="money &gt; adds"/></testsuite><testsuite name="test/b.test.ts"><testcase classname="test/b.test.ts" name="converts"/></testsuite></testsuites>`
const BUN_JUNIT = `<testsuites name="bun test" tests="2" failures="0"><testsuite name="test/a.test.ts" file="test/a.test.ts"><testsuite name="money" file="test/a.test.ts"><testcase classname="money" name="adds" file="test/a.test.ts"/></testsuite></testsuite><testsuite name="test/b.test.ts" file="test/b.test.ts"><testcase classname="" name="converts" file="test/b.test.ts"/></testsuite></testsuites>`
const JEST_JSON = JSON.stringify({ testResults: [{ name: "test/a.test.ts", assertionResults: [{ fullName: "money adds", status: "passed" }] }] })

const SOURCES: Record<string, string> = {
  "bun.lock": "",
  "src/money.ts": "export const money = 1\n",
  "src/fx.ts": "import { money } from \"./money.ts\"\nexport const fx = money\n",
  "src/unused.ts": "export const unused = 1\n",
  "test/a.test.ts": "import { money } from \"../src/money.ts\"\n",
  "test/b.test.ts": "import { fx } from \"../src/fx.ts\"\n",
}

/**
 * A checkout and a fake runner: the suite's run writes its report, and each
 * test file's coverage run writes lcov with what `loads` says it loaded (a
 * missing entry fails that run).
 */
const project = (
  runner: "vitest" | "jest" | "bun",
  options: { readonly junit?: string; readonly loads?: Record<string, Record<string, boolean>>; readonly extra?: Record<string, string>; readonly belowThreshold?: boolean } = {},
) => {
  const files: Record<string, string> = {
    ...SOURCES,
    "package.json": JSON.stringify({ devDependencies: runner === "bun" ? {} : { [runner]: "1" } }),
    ...(runner === "bun" ? {} : { [`node_modules/.bin/${runner}`]: "" }),
    ...options.extra,
  }
  const dir = mkdtempSync(join(tmpdir(), "gauntlet-ts-map-"))
  const write = (path: string, content: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  for (const [p, t] of Object.entries(files)) write(join(dir, p), t)
  const out = join(mkdtempSync(join(tmpdir(), "gauntlet-out-")), "0-unit")
  mkdirSync(out)
  const loads = options.loads ?? { "test/a.test.ts": { "src/money.ts": true, "src/unused.ts": false }, "test/b.test.ts": { "src/fx.ts": true, [join(dir, "src/money.ts")]: true, "node_modules/x/index.js": true } }
  const calls: RunRequest[] = []
  const arg = (r: RunRequest, prefix: string) => r.args.find((a) => a.startsWith(prefix))?.slice(prefix.length)
  const layer = Layer.mergeAll(
    Layer.succeed(ProcessRunner, {
      run: (r) =>
        Effect.sync(() => {
          calls.push(r)
          const coverageDir = arg(r, "--coverage.reportsDirectory=") ?? arg(r, "--coverageDirectory=") ?? arg(r, "--coverage-dir=")
          if (coverageDir !== undefined) {
            const file = runner === "vitest" ? r.args[1]! : runner === "bun" ? r.args[1]!.replace(/^\.\//, "") : Object.keys(loads).find((f) => r.args.at(-1)!.includes(f.replaceAll(".", "\\.")))!
            const loaded = loads[file]
            const report = arg(r, "--reporter-outfile=")
            if (loaded === undefined) {
              if (report !== undefined) write(report, `<testsuites name="bun test" tests="1" failures="1"></testsuites>`)
              return { exitCode: 1, stdout: "", stderr: "failed" }
            }
            write(join(coverageDir, "lcov.info"), lcov(loaded))
            // A bunfig coverage threshold fails a run whose tests all passed.
            if (report !== undefined) write(report, `<testsuites name="bun test" tests="1" failures="0"></testsuites>`)
            return { exitCode: options.belowThreshold ? 1 : 0, stdout: "", stderr: "" }
          }
          const junit = arg(r, "--outputFile.junit=") ?? arg(r, "--reporter-outfile=")
          if (junit !== undefined) write(junit, options.junit ?? (runner === "bun" ? BUN_JUNIT : VITEST_JUNIT))
          const jest = arg(r, "--outputFile=")
          if (jest !== undefined) write(jest, JEST_JSON)
          return { exitCode: 0, stdout: "", stderr: "" }
        }),
    }),
    BunServices.layer,
  )
  const ctx: GateContext = {
    dir,
    outputDir: out,
    collect: Effect.sync(() => readdirSync(out, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => ({ path: join(e.parentPath, e.name).slice(out.length + 1), content: readFileSync(join(e.parentPath, e.name), "utf8") }))),
    ir: { zones: [], arch: [] } as never,
    facts: { addedLines: new Map() } as never,
    files: Object.keys(files).filter((f) => !f.startsWith("node_modules/")).sort(),
    legacy: [],
    recordTestMap: true,
  }
  const run = <A, E, R>(e: Effect.Effect<A, E, R>) => Effect.runPromise(e.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>)
  return { ctx, calls, run, out }
}

describe("recording the TypeScript test map", () => {
  test("a baseline runs each test file on its own with coverage, apart from the suite's reports, and maps what it loaded", async () => {
    const p = project("vitest")
    const r = await p.run(runSuite(unit, p.ctx))
    expect(r.tests?.ids).toEqual(["test/a.test.ts.money > adds", "test/b.test.ts.converts"])
    expect(r.testMap).toEqual({
      "test/a.test.ts": ["src/money.ts", "test/a.test.ts"],
      "test/b.test.ts": ["src/fx.ts", "src/money.ts", "test/b.test.ts"],
    })
    const mapping = p.calls.filter((c) => c.args.includes("--coverage.enabled=true"))
    // The runs go side by side, so they finish in any order.
    expect(mapping.map((c) => c.args[1]).sort()).toEqual(["test/a.test.ts", "test/b.test.ts"])
    expect(mapping.every((c) => c.args.some((a) => a.startsWith(`--coverage.reportsDirectory=${p.out}-testmap/`)))).toBe(true)
    // The suite's own proof stays its own run's.
    expect(readdirSync(p.out, { recursive: true }).map(String)).toEqual(["junit.xml"])
  })

  test("Jest runs each test file by an exact pattern", async () => {
    const p = project("jest", { loads: { "test/a.test.ts": { "src/money.ts": true } } })
    const r = await p.run(runSuite(unit, p.ctx))
    expect(r.testMap).toEqual({ "test/a.test.ts": ["src/money.ts", "test/a.test.ts"] })
    expect(p.calls.at(-1)!.args).toEqual(expect.arrayContaining(["--coverage", "--testPathPatterns", "(^|/)test/a\\.test\\.ts$"]))
  })

  test("bun runs each test file by its path, with lcov and a JUnit report of its own", async () => {
    const p = project("bun")
    const r = await p.run(runSuite(unit, p.ctx))
    expect(r.tests?.ids).toEqual(["test/a.test.ts.money.adds", "test/b.test.ts.converts"])
    expect(r.testMap).toEqual({
      "test/a.test.ts": ["src/money.ts", "test/a.test.ts"],
      "test/b.test.ts": ["src/fx.ts", "src/money.ts", "test/b.test.ts"],
    })
    const mapping = p.calls.filter((c) => c.args.includes("--coverage"))
    expect(mapping.map((c) => c.args.slice(0, 5)).sort((x, y) => (x[1]! < y[1]! ? -1 : 1))).toEqual([
      ["test", "./test/a.test.ts", "--coverage", "--coverage-reporter=lcov", `--coverage-dir=${p.out}-testmap/0`],
      ["test", "./test/b.test.ts", "--coverage", "--coverage-reporter=lcov", `--coverage-dir=${p.out}-testmap/1`],
    ])
    expect(mapping.every((c) => c.args.includes("--reporter=junit") && c.args.some((a) => a.startsWith(`--reporter-outfile=${p.out}-testmap/`)))).toBe(true)
    expect(readdirSync(p.out, { recursive: true }).map(String)).toEqual(["junit.xml"])
  })

  test("bun: a run that only missed a coverage threshold counts, one whose tests failed doesn't", async () => {
    const p = project("bun", { belowThreshold: true, loads: { "test/a.test.ts": { "src/money.ts": true } } })
    const r = await p.run(runSuite(unit, p.ctx))
    expect(r.testMap).toEqual({
      "test/a.test.ts": ["src/money.ts", "test/a.test.ts"],
      "test/b.test.ts": ["src/money.ts", "test/a.test.ts", "test/b.test.ts"],
    })
  })

  test("bun: a test-side file a test imports counts as loaded, though bun's coverage leaves out files named like tests", async () => {
    const p = project("bun", {
      extra: { "test/b.test.ts": `import { fx } from "../src/fx.ts"\nimport { shared } from "./shared.test.ts"\n`, "test/shared.test.ts": "export const shared = 1\n" },
    })
    const r = await p.run(runSuite(unit, p.ctx))
    expect(r.testMap?.["test/b.test.ts"]).toEqual(["src/fx.ts", "src/money.ts", "test/b.test.ts", "test/shared.test.ts"])
  })

  test("bun: a preload runs in each test file's own process, so it doesn't stop the map", async () => {
    const p = project("bun", { extra: { "bunfig.toml": `[test]\npreload = ["./test/setup.ts"]\n`, "test/setup.ts": `import { money } from "../src/money.ts"\n` } })
    const r = await p.run(runSuite(unit, p.ctx))
    expect(r.testMapMissing).toBeUndefined()
    expect(Object.keys(r.testMap ?? {})).toEqual(["test/a.test.ts", "test/b.test.ts"])
  })

  test("a test file whose own run fails maps to everything any test loaded", async () => {
    const p = project("vitest", { loads: { "test/a.test.ts": { "src/money.ts": true } } })
    const r = await p.run(runSuite(unit, p.ctx))
    expect(r.testMap?.["test/b.test.ts"]).toEqual(["src/money.ts", "test/a.test.ts", "test/b.test.ts"])
  })

  test("no map, and why, for a global setup, bun settings that hide coverage or a preload it can't follow, tests not named after a file, or no coverage at all", async () => {
    const cases: Array<[ReturnType<typeof project>, string]> = [
      [project("bun", { extra: { "bunfig.toml": `[test]\ncoverageDir = "cov"\n` } }), "bunfig.toml sets coverageDir"],
      [project("bun", { extra: { "bunfig.toml": `[test]\ncoverageReporter = ["text"]\n` } }), "bunfig.toml sets coverageReporter"],
      [project("bun", { extra: { "bunfig.toml": `[test]\npreload = ["./test/server.ts"]\n`, "test/server.ts": `Bun.spawn(["bun", "src/server.ts"])\n` } }), "bunfig.toml preloads test/server.ts, which starts processes"],
      [project("bun", { extra: { "bunfig.toml": `[test]\npreload = ["./src/boot.ts"]\n`, "src/boot.ts": `import { spawn } from "node:child_process"\n` } }), "bunfig.toml preloads src/boot.ts"],
      [project("bun", { loads: {} }), "no test file's run wrote coverage"],
      [project("vitest", { extra: { "vitest.config.ts": `export default { test: { globalSetup: "./test/db.ts" } }` } }), "vitest.config.ts sets a global setup"],
      [project("vitest", { junit: `<testsuite name="x"><testcase classname="money" name="adds"/></testsuite>` }), "1 test the suite ran isn't named after a test file, such as money.adds"],
      [project("vitest", { loads: {} }), "no test file's run wrote coverage: add @vitest/coverage-v8"],
    ]
    for (const [p, why] of cases) {
      const r = await p.run(runSuite(unit, p.ctx))
      expect(r.tests?.ids.length).toBeGreaterThan(0)
      expect(r.testMap).toBeUndefined()
      expect(r.testMapMissing).toContain(why)
    }
  })

  test("only a baseline maps: not a check, nor a rerun", async () => {
    const p = project("vitest")
    const r = await p.run(runSuite(unit, { ...p.ctx, recordTestMap: false }))
    expect(r.testMap).toBeUndefined()
    expect(p.calls.some((c) => c.args.includes("--coverage.enabled=true"))).toBe(false)
    expect(existsSync(`${p.out}-testmap`)).toBe(false)
  })
})

describe("running the tests a change affects", () => {
  const affected = { files: ["test/new.test.ts"], ids: [], seed: 7, classes: ["test/a.test.ts"], affected: true as const }
  const withNew = { "test/new.test.ts": "" }

  test("the selected test files and the new ones run, in the usual order", async () => {
    for (const runner of ["vitest", "bun"] as const) {
      const p = project(runner, { extra: withNew })
      await p.run(runSuite(unit, { ...p.ctx, recordTestMap: false }, affected))
      const args = p.calls.at(-1)!.args
      // Bun takes the files by path: a bare argument is a filter that also runs every file whose path contains it.
      expect(args.slice(0, 3)).toEqual(runner === "vitest" ? ["run", "test/a.test.ts", "test/new.test.ts"] : ["test", "./test/a.test.ts", "./test/new.test.ts"])
      expect(args.some((a) => /shuffle|randomize|seed/.test(a))).toBe(false)
    }
    const j = project("jest", { extra: withNew })
    await j.run(runSuite(unit, { ...j.ctx, recordTestMap: false }, affected))
    expect(j.calls.at(-1)!.args).toEqual(expect.arrayContaining(["--testPathPatterns", "(^|/)test/a\\.test\\.ts$|(^|/)test/new\\.test\\.ts$"]))
    expect(j.calls.at(-1)!.args).not.toContain("--randomize")
  })

  test("a selected test file the change deleted doesn't run, and with nothing left the whole suite does", async () => {
    const p = project("vitest")
    await p.run(runSuite(unit, { ...p.ctx, recordTestMap: false }, { ...affected, classes: ["test/a.test.ts", "test/gone.test.ts"], files: [] }))
    expect(p.calls.at(-1)!.args.slice(0, 3)).toEqual(["run", "test/a.test.ts", "--reporter=junit"])
    await p.run(runSuite(unit, { ...p.ctx, recordTestMap: false }, { ...affected, classes: ["test/gone.test.ts"], files: [] }))
    expect(p.calls.at(-1)!.args.slice(0, 3)).toEqual(["run", "test", "--reporter=junit"])
    const b = project("bun")
    await b.run(runSuite(unit, { ...b.ctx, recordTestMap: false }, { ...affected, classes: ["test/a.test.ts", "test/gone.test.ts"], files: [] }))
    expect(b.calls.at(-1)!.args.slice(0, 3)).toEqual(["test", "./test/a.test.ts", "--reporter=junit"])
    await b.run(runSuite(unit, { ...b.ctx, recordTestMap: false }, { ...affected, classes: ["test/gone.test.ts"], files: [] }))
    expect(b.calls.at(-1)!.args.slice(0, 3)).toEqual(["test", "test", "--reporter=junit"])
  })
})

describe("what a TypeScript change selects", () => {
  const compiled = compilePolicy({
    file: ".gauntlet/policy.gx",
    text: `gauntlet "svc"\nuse typescript\nowners @platform\nprotect { tests "test/**" }\nsuites { unit "test/**" affected }\ngates { verify { unit } }\n`,
  }, [typescriptPack.spec])
  if (compiled._tag === "Invalid") throw new Error("the policy doesn't compile")
  const ir = compiled.compiled.ir
  const map = {
    "test/a.test.ts": ["src/money.ts", "test/a.test.ts"],
    "test/b.test.ts": ["src/fx.ts", "src/money.ts", "test/b.test.ts", "test/helpers.ts"],
  }
  const select = (changes: ReadonlyArray<{ path: string; status: "modified" | "added" | "deleted" }>, dependencyChanges: ReadonlyArray<never> = []) =>
    suiteSelections({ ir, packs: [typescriptPack], facts: { base: "b", head: "h", dependencyChanges }, map, changes, isTestPath: (x) => x.startsWith("test/") }).get("unit")!.get(".")!
  const modified = (path: string) => ({ path, status: "modified" as const })

  test("the test files that loaded a changed file run, and the rest are left out", () => {
    expect(select([modified("src/fx.ts")])).toEqual({ kind: "some", classes: ["test/b.test.ts"], files: [], deselected: ["test/a.test.ts"] })
    expect(select([modified("test/a.test.ts"), { path: "test/new.test.ts", status: "added" }])).toEqual({ kind: "some", classes: ["test/a.test.ts"], files: ["test/new.test.ts"], deselected: ["test/b.test.ts"] })
  })

  test("everything runs for what the map can't vouch for", () => {
    for (const path of ["tsconfig.json", "package.json", "vitest.config.ts", "bunfig.toml", "bun.lock", "src/new.ts", "test/setup.ts", "data/rates.json"]) {
      expect(select([modified(path)])).toMatchObject({ kind: "all" })
    }
  })
})

// ---------- recording with bun itself ----------

describe("bun's test map, with bun itself", () => {
  const files: Record<string, string> = {
    "package.json": "{}",
    "bun.lock": "",
    // A threshold every run misses: bun exits 1 though every test passed.
    "bunfig.toml": `[test]\npreload = ["./test/setup.ts"]\ncoverageThreshold = 1\n`,
    "src/boot.ts": "export const booted = true\n",
    "src/money.ts": "export const money = (n: number) => n + 1\nexport const other = (n: number) => (n > 0 ? 1 : 2)\n",
    "src/fx.ts": "import { money } from \"./money.ts\"\nexport const fx = (n: number) => money(n) * 2\n",
    "src/unused.ts": "export const unused = 1\n",
    "test/setup.ts": "import { booted } from \"../src/boot.ts\"\nif (!booted) throw new Error(\"not booted\")\n",
    "test/a.test.ts": "import { expect, test } from \"bun:test\"\nimport { money } from \"../src/money.ts\"\ntest(\"adds\", () => expect(money(1)).toBe(2))\n",
    "test/b.test.ts": "import { describe, expect, test } from \"bun:test\"\nimport { fx } from \"../src/fx.ts\"\ndescribe(\"fx\", () => { test(\"converts\", () => expect(fx(1)).toBe(4)) })\n",
    // Bun takes a bare argument as a filter: `test/a.test.ts` would run this too.
    "pkg/test/a.test.ts": "import { expect, test } from \"bun:test\"\ntest(\"elsewhere\", () => expect(1).toBe(1))\n",
  }
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "gauntlet-bun-map-"))
    const dir = join(root, "repo")
    for (const [p, t] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true })
      writeFileSync(join(dir, p), t)
    }
    const out = join(root, "outputs", "0-unit")
    mkdirSync(out, { recursive: true })
    writeFileSync(join(root, "outputs", ".typescript-install"), "ok")
    const ctx: GateContext = {
      dir,
      outputDir: out,
      collect: Effect.sync(() => readdirSync(out, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => ({ path: join(e.parentPath, e.name).slice(out.length + 1), content: readFileSync(join(e.parentPath, e.name), "utf8") }))),
      ir: { zones: [], arch: [] } as never,
      facts: { addedLines: new Map() } as never,
      files: Object.keys(files).sort(),
      legacy: [],
    }
    const run = <A, E, R>(e: Effect.Effect<A, E, R>) => Effect.runPromise(e.pipe(Effect.provide(Layer.provideMerge(ProcessRunnerLive, BunServices.layer))) as Effect.Effect<A, E, never>)
    return { ctx, run }
  }

  test("each test file maps to what its own run loaded, preload included, and a check runs exactly the selected files", async () => {
    const p = setup()
    const r = await p.run(runSuite({ name: "unit", location: "test/**" }, { ...p.ctx, recordTestMap: true }))
    expect(r.testMapMissing).toBeUndefined()
    expect(r.testMap).toEqual({
      // The suite's own run takes its folder as a filter, which this file's path contains too.
      "pkg/test/a.test.ts": ["pkg/test/a.test.ts", "src/boot.ts", "test/setup.ts"],
      "test/a.test.ts": ["src/boot.ts", "src/money.ts", "test/a.test.ts", "test/setup.ts"],
      "test/b.test.ts": ["src/boot.ts", "src/fx.ts", "src/money.ts", "test/b.test.ts", "test/setup.ts"],
    })
    const q = setup()
    const s = await q.run(runSuite({ name: "unit", location: "test/**" }, q.ctx, { files: [], ids: [], seed: 1, classes: ["test/a.test.ts"], affected: true }))
    expect(s.tests?.ids).toEqual(["test/a.test.ts.adds"])
  }, 60_000)
})

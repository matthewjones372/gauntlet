import type { GateContext, GateImpl, GateRun, ProcessRunner, SuiteImpl, TestSubset } from "@gauntlet/core"
import { globMatches } from "@gauntlet/dsl"
import { prettyCanonicalJson } from "@gauntlet/ir"
import { convertJUnit, decodeLog, type Log, relativeUri, type Result, type Run, SARIF_SCHEMA, SARIF_VERSION } from "@gauntlet/sarif"
import { availableParallelism } from "node:os"
import { Effect, FileSystem, Option, Path } from "effect"
import { convertEslintJson, convertJestJson, DETECTED, type Mutant, parseLcov, parseStryker, UNDETECTED } from "./reports.ts"
import { runRules } from "./rules.ts"
import { line, ofType, parseTs } from "./syntax.ts"
import { bun, ensureInstalled, isMainSource, isTsSource, tool, type ToolRun, type Toolchain, toolchain } from "./toolchain.ts"

// The TypeScript pack's gates. Each installs dependencies once per check,
// runs the project's own tool, and reads only what it wrote into the check's
// output directory (ADR 0012).

const base = (r: ToolRun): GateRun => ({ command: r.command.map((a) => a), exitCode: r.exitCode, runs: [], ...(r.error ? { error: r.error } : {}) })

const failed = (command: ReadonlyArray<string>, error: string): GateRun => ({ command, exitCode: -1, runs: [], error })

/** Installs dependencies (once per check) and returns the toolchain, or a gate result explaining why it can't run. */
const prepared = (ctx: GateContext, gate: string) =>
  Effect.gen(function*() {
    const chain = yield* toolchain(ctx)
    const install = yield* ensureInstalled(ctx, chain)
    return Option.isSome(install) ? { chain, blocked: failed([gate], install.value) } : { chain, blocked: undefined }
  })

const readFiles = (ctx: GateContext, paths: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const out: { path: string; text: string }[] = []
    for (const p of paths) {
      const text = yield* fs.readFileString(path.join(ctx.dir, p)).pipe(Effect.option)
      if (Option.isSome(text)) out.push({ path: p, text: text.value })
    }
    return out
  })

const writeSarif = (ctx: GateContext, file: string, run: Run) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const log: Log = { version: SARIF_VERSION, $schema: SARIF_SCHEMA, runs: [run] }
    yield* fs.writeFileString(path.join(ctx.outputDir, file), prettyCanonicalJson(log)).pipe(Effect.orElseSucceed(() => undefined))
  })

const reports = (ctx: GateContext, test: (path: string) => boolean) => ctx.collect.pipe(Effect.map((files) => files.filter((f) => test(f.path))))

/** The fixed part of a glob, used as a test path filter: `packages/core/test` from `packages/core/test/**`. */
const literalPrefix = (glob: string) => glob.split("/").filter((_, i, all) => !all.slice(0, i + 1).some((s) => /[*?[{]/.test(s))).join("/")

// ---------- build: the type checker ----------

export const build: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const { blocked } = yield* prepared(ctx, "tsc")
    if (blocked) return blocked
    if (!ctx.files.includes("tsconfig.json")) return failed(["tsc"], "no tsconfig.json at the repository root")
    return base(yield* tool(ctx, "tsc", ["--noEmit", "-p", "."]))
  })

// ---------- suites ----------

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Runs the suite, or with `subset` only those test files, shuffled by its seed. */
const runTests = (ctx: GateContext, chain: Toolchain, filter: string, subset?: TestSubset) =>
  Effect.gen(function*() {
    const runner = Option.getOrUndefined(chain.runner)
    const out = ctx.outputDir
    const paths = subset ? [...subset.files] : filter ? [filter] : []
    switch (runner) {
      case "vitest":
        return yield* tool(ctx, "vitest", ["run", ...paths, ...(subset ? ["--sequence.shuffle", `--sequence.seed=${subset.seed}`] : []), "--reporter=junit", `--outputFile.junit=${out}/junit.xml`])
      case "jest":
        return yield* tool(ctx, "jest", ["--ci", "--json", `--outputFile=${out}/jest/results.json`, ...(paths.length > 0 ? ["--testPathPatterns", paths.map(escape).join("|")] : []),
          ...(subset ? ["--randomize", `--seed=${subset.seed}`] : [])])
      case "bun":
        return yield* bun(ctx, ["test", ...paths, ...(subset ? ["--randomize", `--seed=${subset.seed}`] : []), "--reporter=junit", // bun silently skips the report if its directory is missing, so write at the top level.
          `--reporter-outfile=${out}/junit.xml`])
      default:
        return { command: ["test"], exitCode: -1, stdout: "", stderr: "", error: "no test runner found: add vitest or jest, or use bun" } satisfies ToolRun
    }
  })

export const runSuite: SuiteImpl = (suite, ctx, subset) =>
  Effect.gen(function*() {
    const { chain, blocked } = yield* prepared(ctx, "test")
    if (blocked) return blocked
    if (subset && subset.files.length === 0) return failed(["test"], "no test files to run again")
    const r = yield* runTests(ctx, chain, literalPrefix(suite.location), subset)
    if (r.error) return base(r)
    const files = yield* reports(ctx, (p) => p.endsWith(".xml") || p === "jest/results.json")
    const jest = files.find((f) => f.path === "jest/results.json")
    if (jest) {
      const converted = convertJestJson(suite.name, jest.content, ctx.dir)
      return Option.match(converted, {
        onNone: () => ({ ...base(r), error: "jest's JSON results couldn't be read" }),
        onSome: (c) => ({ ...base(r), runs: [c.run], tests: { counts: c.counts, ids: c.ids } }),
      })
    }
    const xml = files.filter((f) => f.path.endsWith(".xml"))
    if (xml.length === 0) return base(r)
    const junit = yield* Effect.exit(convertJUnit(suite.name, xml.map((f) => ({ path: f.path, content: f.content }))))
    if (junit._tag === "Failure") return { ...base(r), error: "the JUnit XML couldn't be read" }
    return { ...base(r), runs: [junit.value.run], tests: { counts: junit.value.counts, ids: junit.value.tests.map((t) => t.id) } }
  })

// ---------- lint: Biome or eslint, plus the zones' TypeScript rules ----------

export const lint: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const { chain, blocked } = yield* prepared(ctx, "lint")
    if (blocked) return blocked
    let r: ToolRun
    const runs: Run[] = []
    if (chain.deps.has("@biomejs/biome")) {
      r = yield* tool(ctx, "biome", ["lint", "--reporter=sarif", `--reporter-file=${ctx.outputDir}/biome.sarif`])
      if (r.error) return base(r)
      const file = (yield* reports(ctx, (p) => p === "biome.sarif"))[0]
      const log = file ? yield* Effect.option(decodeLog(file.content)) : Option.none()
      if (Option.isNone(log)) return { ...base(r), error: "Biome wrote no SARIF report" }
      runs.push(...log.value.runs.map((run) => ({
        ...run,
        tool: { driver: { ...run.tool.driver, name: "biome" } },
        // Biome also reports configuration problems; only source findings are lint evidence.
        results: run.results.map((x) => ({
          ...x,
          ...(x.locations ? { locations: x.locations.map((l) => ({ ...l, physicalLocation: { ...l.physicalLocation, ...(l.physicalLocation?.artifactLocation ? { artifactLocation: { uri: relativeUri(l.physicalLocation.artifactLocation.uri, ctx.dir) } } : {}) } })) } : {}),
        }))
          .filter((x) => isTsSource(x.locations?.[0]?.physicalLocation?.artifactLocation?.uri ?? ""))
          // Biome's infos ("note") are suggestions it never fails on itself, and some
          // (useLiteralKeys) contradict TypeScript settings; findings are warnings and errors.
          .filter((x) => x.level !== "note" && x.level !== "none"),
      })))
    } else if (chain.deps.has("eslint")) {
      r = yield* tool(ctx, "eslint", [".", "--format", "json", "--output-file", `${ctx.outputDir}/eslint.json`])
      if (r.error) return base(r)
      const file = (yield* reports(ctx, (p) => p === "eslint.json"))[0]
      const run = file ? convertEslintJson(file.content, ctx.dir) : Option.none()
      if (Option.isNone(run)) return { ...base(r), error: "eslint wrote no JSON report" }
      runs.push(run.value)
    } else {
      return failed(["lint"], "no linter: add @biomejs/biome or eslint to devDependencies")
    }

    const results: Result[] = []
    for (const zone of ctx.ir.zones.filter((z) => z.rules.length > 0)) {
      const files = ctx.files.filter((p) => isTsSource(p) && zone.globs.some((g) => globMatches(g, p)) && (ctx.scope === undefined || ctx.scope.includes(p)))
      results.push(...runRules(zone.rules, yield* readFiles(ctx, files)))
    }
    const rulesRun: Run = { tool: { driver: { name: "ts-rules" } }, results }
    yield* writeSarif(ctx, "ts-rules.sarif", rulesRun)
    return { ...base(r), exitCode: 0, runs: [...runs, rulesRun] }
  })

// ---------- arch: import analysis ----------

/**
 * `module a must not depend on b`. A file belongs to a module when a path
 * segment is the module's name. Relative imports resolve to paths; bare
 * imports of workspace packages resolve to the package's directory.
 */
export const arch: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const manifests = yield* readFiles(ctx, ctx.files.filter((p) => p.endsWith("package.json") && !p.includes("node_modules/")))
    const workspaces = new Map(manifests.flatMap((m) => {
      const name = /"name"\s*:\s*"([^"]+)"/.exec(m.text)?.[1]
      return name ? [[name, path.dirname(m.path)] as const] : []
    }))
    const resolve = (from: string, spec: string): string | undefined => {
      if (spec.startsWith(".")) return path.normalize(path.join(path.dirname(from), spec))
      for (const [name, dir] of workspaces) if (spec === name || spec.startsWith(`${name}/`)) return dir === "." ? spec : `${dir}${spec.slice(name.length)}`
      return undefined
    }
    const belongs = (p: string, module: string) => p.split("/").includes(module)
    const sources = yield* readFiles(ctx, ctx.files.filter(isMainSource))
    const results: Result[] = []
    for (const rule of ctx.ir.arch) {
      for (const target of rule.mustNotDependOn) {
        for (const f of sources.filter((s) => belongs(s.path, rule.module) && !belongs(s.path, target))) {
          for (const imp of ofType(parseTs(f.path, f.text).rootNode, "import_statement", "export_statement")) {
            const spec = imp.childForFieldName("source")?.text.slice(1, -1)
            const resolved = spec === undefined ? undefined : resolve(f.path, spec)
            if (spec !== undefined && resolved !== undefined && belongs(resolved, target)) {
              results.push({
                ruleId: `arch/${rule.module}-must-not-depend-on-${target}`,
                level: "error",
                message: { text: `${rule.module} imports ${spec}, which belongs to ${target}.` },
                locations: [{ physicalLocation: { artifactLocation: { uri: f.path }, region: { startLine: line(imp) } } }],
              })
            }
          }
        }
      }
    }
    const run: Run = { tool: { driver: { name: "ts-arch" } }, results }
    yield* writeSarif(ctx, "arch.sarif", run)
    return { command: ["gauntlet", "arch"], exitCode: 0, runs: [run] }
  })

// ---------- mutation: StrykerJS ----------

const STRYKER_CONFIGS = [
  "stryker.config.json", "stryker.conf.json", ".strykerrc.json", ".strykerrc",
  "stryker.config.mjs", "stryker.config.js", "stryker.config.cjs", "stryker.conf.mjs", "stryker.conf.js",
]

/**
 * Stryker settings for a project without its own config: the test runner it
 * already uses, its main sources mutated and its tests left alone. Bun has no
 * Stryker plugin, so Stryker's built-in command runner runs \`bun test\`.
 * A string explains what's missing.
 */
export const strykerDefaults = (chain: Toolchain, files: ReadonlyArray<string>): Record<string, unknown> | string => {
  const runner = Option.getOrUndefined(chain.runner)
  const sources = files.some((f) => f.startsWith("src/")) ? ["src/**/*.{ts,tsx,js,jsx,mts,cts}"] : ["**/*.{ts,tsx,js,jsx,mts,cts}", "!node_modules/**", "!dist/**", "!build/**"]
  const mutate = [...sources, "!**/*.{test,spec}.*", "!**/__tests__/**", "!**/*.d.ts"]
  // Stryker rewrites tsconfig.json with TypeScript's JavaScript API, which
  // TypeScript 7 no longer has. The sandbox is a full copy of the project, so
  // relative paths in it still resolve: point Stryker at no tsconfig at all.
  const common = { mutate, tsconfigFile: "gauntlet.no-tsconfig.json" }
  switch (runner) {
    case "vitest":
      return chain.deps.has("@stryker-mutator/vitest-runner") ? { testRunner: "vitest", coverageAnalysis: "perTest", ...common } : "Stryker needs its Vitest plugin: add @stryker-mutator/vitest-runner"
    case "jest":
      return chain.deps.has("@stryker-mutator/jest-runner") ? { testRunner: "jest", coverageAnalysis: "perTest", ...common } : "Stryker needs its Jest plugin: add @stryker-mutator/jest-runner"
    case "bun":
      return { testRunner: "command", commandRunner: { command: "bun test" }, coverageAnalysis: "off", ...common }
    default:
      return "no test runner found for Stryker: add vitest or jest, or use bun test"
  }
}

/** Consecutive line numbers as ranges, for Stryker's \`file:start-end\` mutate entries. */
export const lineRanges = (lines: ReadonlyArray<number>): Array<readonly [number, number]> => {
  const sorted = [...new Set(lines)].sort((a, b) => a - b)
  const ranges: Array<[number, number]> = []
  for (const n of sorted) {
    const last = ranges.at(-1)
    if (last && n === last[1] + 1) last[1] = n
    else ranges.push([n, n])
  }
  return ranges
}

/** The test files \`bun test\` runs: \`*.test.*\`, \`*_test.*\`, \`*.spec.*\` and \`*_spec.*\`. */
const BUN_TEST_FILE = /[._](test|spec)\.[cm]?[jt]sx?$/
const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`

/**
 * The test files that load any of \`targets\`, found by running each test file
 * on its own with coverage. Bun has no Stryker plugin, so without this every
 * mutant runs the whole suite; a test that never loads a file can't kill a
 * mutant in it. (Bun's line counts aren't exact enough to go by line.) None
 * when no test file loads them (code reached only through a subprocess, say):
 * then the whole suite runs, as before.
 */
const relatedTests = (ctx: GateContext, targets: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const loads = yield* testsLoading(ctx)
    if (Option.isNone(loads)) return Option.none<ReadonlyArray<string>>()
    const related = [...loads.value].flatMap(([test, files]) => (targets.some((t) => files.has(t)) ? [test] : []))
    return related.length > 0 ? Option.some([...new Set(related)]) : Option.none<ReadonlyArray<string>>()
  })

/** Which files each test file loads, from running each one on its own with coverage. None with fewer than two test files. */
const testsLoading = (ctx: GateContext) =>
  Effect.gen(function*() {
    const tests = ctx.files.filter((f) => isTsSource(f) && BUN_TEST_FILE.test(f))
    if (tests.length < 2) return Option.none<ReadonlyMap<string, ReadonlySet<string>>>()
    const took = new Map<string, number>()
    yield* Effect.forEach(tests, (t, i) =>
      Effect.gen(function*() {
        const started = Date.now()
        yield* bun(ctx, ["test", `./${t}`, "--coverage", "--coverage-reporter=lcov", `--coverage-dir=${ctx.outputDir}/related/${i}`])
        took.set(t, Date.now() - started)
      }), { concurrency: Math.max(1, availableParallelism() - 1), discard: true })
    const lcovs = yield* reports(ctx, (p) => p.startsWith("related/") && p.endsWith("lcov.info"))
    // Fastest first: with --bail a mutant one quick test kills never waits for a slow one.
    const order = (t: string) => took.get(t) ?? Number.MAX_SAFE_INTEGER
    const loads = new Map<string, ReadonlySet<string>>()
    for (const l of [...lcovs].sort((a, b) => order(tests[Number(a.path.split("/")[1])]!) - order(tests[Number(b.path.split("/")[1])]!))) {
      const test = tests[Number(l.path.split("/")[1])]
      if (test) loads.set(test, new Set(parseLcov(l.content, ctx.dir).map((f) => f.path)))
    }
    return Option.some(loads as ReadonlyMap<string, ReadonlySet<string>>)
  })

/** How many Stryker runs a whole-project run is split into at most. */
const MAX_BATCHES = 12

/**
 * Source files in batches, each with the tests that load any of its files,
 * for mutating a whole project under bun test without every mutant running
 * the whole suite. Files with the same tests go together; then each group
 * joins the batch its tests overlap most, so a batch's tests stay few.
 * Files no test loads form a batch of their own, with no tests.
 */
export const mutationBatches = (sources: ReadonlyArray<string>, loads: ReadonlyMap<string, ReadonlySet<string>>, max = MAX_BATCHES): Array<{ files: string[]; tests: string[] }> => {
  const groups = new Map<string, { files: string[]; tests: string[] }>()
  for (const file of [...sources].sort()) {
    // In the order the map gives them (fastest first), so a batch runs its quick tests before its slow ones.
    const tests = [...loads].filter(([, files]) => files.has(file)).map(([t]) => t)
    const key = tests.join("\n")
    const g = groups.get(key) ?? { files: [], tests }
    g.files.push(file)
    groups.set(key, g)
  }
  const untested = groups.get("")
  groups.delete("")
  const batches: Array<{ files: string[]; tests: Set<string> }> = []
  for (const g of [...groups.values()].sort((a, b) => b.tests.length - a.tests.length || b.files.length - a.files.length)) {
    if (batches.length < max - (untested ? 1 : 0)) {
      batches.push({ files: [...g.files], tests: new Set(g.tests) })
      continue
    }
    const added = (b: { tests: Set<string> }) => g.tests.filter((t) => !b.tests.has(t)).length
    const best = batches.reduce((x, y) => (added(y) < added(x) ? y : x))
    best.files.push(...g.files)
    for (const t of g.tests) best.tests.add(t)
  }
  return [
    ...batches.map((b) => ({ files: b.files.sort(), tests: [...loads.keys()].filter((t) => b.tests.has(t)) })),
    ...(untested ? [{ files: untested.files, tests: [] }] : []),
  ]
}

export const mutation: GateImpl = (check, ctx) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const inScope = ctx.scope?.filter(isMainSource)
    if (inScope !== undefined && inScope.length === 0) return { command: [], exitCode: 0, runs: [], nothingInScope: "no main source files in scope to mutate" }
    // On changed code only the added lines are mutated: a one-line fix in a big file judges that line, not the file.
    const changedLines = inScope !== undefined && check.scope === "changed"
      ? inScope.flatMap((f) => lineRanges((ctx.facts.addedLines.get(f) ?? []).map((l) => l.line)).map(([a, b]) => `${f}:${a}-${b}`))
      : undefined
    if (changedLines !== undefined && changedLines.length === 0) return { command: [], exitCode: 0, runs: [], nothingInScope: "no changed lines to mutate" }
    const { chain, blocked } = yield* prepared(ctx, "stryker")
    if (blocked) return blocked
    if (!chain.deps.has("@stryker-mutator/core")) return failed(["stryker"], "StrykerJS isn't installed: add @stryker-mutator/core and its test runner plugin")
    const config = STRYKER_CONFIGS.find((c) => ctx.files.includes(c))
    // A config next to the output directories that extends the project's (or
    // Gauntlet's defaults, when it has none), so Gauntlet decides the files, the
    // report location and that no cache is used.
    let importBase: string
    let commandRunner = false
    if (config) {
      const project = path.join(ctx.dir, config)
      importBase = config.endsWith("json") || config === ".strykerrc"
        ? `import base from ${JSON.stringify(project)} with { type: "json" }`
        : `import base from ${JSON.stringify(project)}`
    } else {
      const defaults = strykerDefaults(chain, ctx.files)
      if (typeof defaults === "string") return failed(["stryker"], defaults)
      importBase = `const base = ${JSON.stringify(defaults)}`
      commandRunner = defaults.testRunner === "command"
    }
    const stryker = (name: string, mutate: ReadonlyArray<string> | undefined, tests: ReadonlyArray<string> | undefined) =>
      Effect.gen(function*() {
        const generated = path.join(path.dirname(ctx.outputDir), `gauntlet.stryker.${name}.config.mjs`)
        const overrides = {
          ...(mutate ? { mutate } : {}),
          // bun test stops at the first failing test: a mutant is killed as soon as one test catches it.
          // No tests at all (files no test loads): \`true\`, so every mutant survives without running anything.
          ...(commandRunner
            ? { commandRunner: { command: tests !== undefined && tests.length === 0 ? "true" : ["bun test --bail", ...(tests ?? []).map((t) => shellQuote(`./${t}`))].join(" ") } }
            : {}),
          reporters: ["json"],
          jsonReporter: { fileName: `${ctx.outputDir}/mutation/${name}.json` },
          incremental: false,
          cleanTempDir: "always",
        }
        yield* fs.writeFileString(generated, `${importBase}\nexport default { ...base, ...${JSON.stringify(overrides)} }\n`).pipe(Effect.orElseSucceed(() => undefined))
        // A whole project's mutants can outlast the usual 30 minutes a tool gets.
        return yield* tool(ctx, "stryker", ["run", generated], {}, "4 hours")
      })
    const mutate = changedLines ?? inScope
    const read = (name: string) => reports(ctx, (p) => p === `mutation/${name}.json`).pipe(Effect.map((f) => f[0] ? parseStryker(f[0].content, ctx.dir) : Option.none()))
    // The whole project under bun test (a baseline): in batches, each with only the tests that load its files.
    if (commandRunner && inScope === undefined) {
      const loads = yield* testsLoading(ctx)
      if (Option.isSome(loads)) return yield* wholeProject(ctx, loads.value, stryker, read)
    }
    const subset = commandRunner && inScope !== undefined ? yield* relatedTests(ctx, inScope) : Option.none<ReadonlyArray<string>>()
    const r = yield* stryker("mutation", mutate, Option.getOrUndefined(subset))
    if (r.error) return base(r)
    const first = yield* read("mutation")
    if (Option.isNone(first)) return base(r)
    let mutants = first.value
    // A mutant the selected tests didn't kill runs again against the whole suite, for code a test
    // reaches only through a subprocess, which coverage can't see. When the whole suite can't run
    // under Stryker, the selected tests' verdict stands: no test that loads the file killed it.
    const key = (m: Mutant) => `${m.path}:${m.line}:${m.column ?? 0}:${m.mutator}`
    const survived = mutants.filter((m) => UNDETECTED.has(m.status))
    if (Option.isSome(subset) && survived.length > 0) {
      const again = yield* stryker("confirm", [...new Set(survived.map((m) => `${m.path}:${m.line}-${m.endLine ?? m.line}`))], undefined)
      const confirmed = again.error ? Option.none() : yield* read("confirm")
      // Only survivors the whole suite ran again take its verdict; any it didn't keep theirs.
      const verdict = new Map(Option.getOrElse(confirmed, () => []).map((m) => [key(m), m.status]))
      mutants = mutants.map((m) => UNDETECTED.has(m.status) && verdict.has(key(m)) ? { ...m, status: verdict.get(key(m))! } : m)
    }
    return scored(r, mutants, inScope)
  })

/** The mutation score from Stryker's mutants: overall, per file, and the survivors as findings. */
const scored = (r: ToolRun, mutants: ReadonlyArray<Mutant>, inScope: ReadonlyArray<string> | undefined): GateRun => {
    const counted = mutants.filter((m) => (DETECTED.has(m.status) || UNDETECTED.has(m.status)) && (inScope === undefined || inScope.includes(m.path)))
    if (counted.length === 0) return { ...base(r), nothingInScope: "Stryker generated no mutants for the code in scope" }
    const pct = (ms: typeof counted) => Math.round((ms.filter((m) => DETECTED.has(m.status)).length / ms.length) * 10000) / 100
    const perFile: Record<string, number> = {}
    for (const p of [...new Set(counted.map((m) => m.path))].sort()) perFile[p] = pct(counted.filter((m) => m.path === p))
    const survivors: Run = {
      tool: { driver: { name: "stryker" } },
      results: counted.filter((m) => UNDETECTED.has(m.status)).map((m) => ({
        ruleId: "mutation/survived",
        level: "warning",
        message: { text: `${m.status === "NoCoverage" ? "No test covers" : "No test kills"} a ${m.mutator} mutant` },
        locations: [{ physicalLocation: { artifactLocation: { uri: m.path }, region: { startLine: m.line } } }],
      })),
    }
    return { ...base(r), exitCode: 0, runs: [survivors], metrics: { mutation: { value: pct(counted), unit: "%", higherIsBetter: true, perFile } } }
}

/**
 * Mutating a whole project under bun test: one Stryker run per batch of
 * files, each running only the tests that load them and stopping at the first
 * failure. A baseline has no second pass against the whole suite, so a mutant
 * only a subprocess-launched test would kill counts as survived there.
 */
const wholeProject = (
  ctx: GateContext,
  loads: ReadonlyMap<string, ReadonlySet<string>>,
  stryker: (name: string, mutate: ReadonlyArray<string> | undefined, tests: ReadonlyArray<string> | undefined) => Effect.Effect<ToolRun, never, ProcessRunner | FileSystem.FileSystem | Path.Path>,
  read: (name: string) => Effect.Effect<Option.Option<Mutant[]>, never, never>,
) =>
  Effect.gen(function*() {
    const sources = ctx.files.filter(isMainSource)
    const inSrc = sources.some((f) => f.startsWith("src/")) ? sources.filter((f) => f.startsWith("src/")) : sources
    const batches = mutationBatches(inSrc, loads)
    const mutants: Mutant[] = []
    let last: ToolRun | undefined
    for (const [i, b] of batches.entries()) {
      const r = yield* stryker(`mutation-${i}`, b.files, b.tests)
      last = r
      if (r.error) return base(r)
      const found = yield* read(`mutation-${i}`)
      if (Option.isSome(found)) mutants.push(...found.value)
    }
    return scored(last ?? { command: ["stryker"], exitCode: 0, stdout: "", stderr: "" }, mutants, undefined)
  })

// ---------- coverage ----------

const COMMENT_OR_BLANK = /^\s*($|\/\/|\/\*|\*)/

export const coverage: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const { chain, blocked } = yield* prepared(ctx, "coverage")
    if (blocked) return blocked
    const out = ctx.outputDir
    const scoped = ctx.scope?.filter(isMainSource)
    const runner = Option.getOrUndefined(chain.runner)
    const r: ToolRun = runner === "vitest"
      ? yield* tool(ctx, "vitest", ["run", "--coverage.enabled=true", "--coverage.reporter=lcov", `--coverage.reportsDirectory=${out}/coverage`, ...(scoped ?? []).map((f) => `--coverage.include=${f}`)])
      : runner === "jest"
      ? yield* tool(ctx, "jest", ["--ci", "--coverage", "--coverageReporters=lcov", `--coverageDirectory=${out}/coverage`, ...(scoped ?? []).flatMap((f) => ["--collectCoverageFrom", f])])
      : runner === "bun"
      ? yield* bun(ctx, ["test", "--coverage", "--coverage-reporter=lcov", `--coverage-dir=${out}/coverage`])
      : { command: ["coverage"], exitCode: -1, stdout: "", stderr: "", error: "no test runner found: add vitest or jest, or use bun" }
    if (r.error) return base(r)
    const lcov = (yield* reports(ctx, (p) => p.endsWith("lcov.info")))[0]
    if (!lcov) return { ...base(r), error: runner === "vitest" ? "no lcov report: add @vitest/coverage-v8 (or -istanbul)" : "no lcov report was written" }
    const files = parseLcov(lcov.content, ctx.dir).filter((f) => ctx.scope === undefined || ctx.scope.includes(f.path))
    const perFile: Record<string, number> = {}
    const pct = (covered: number, total: number) => Math.round((covered / total) * 10000) / 100
    for (const f of files) {
      const lines = [...f.lines.values()]
      if (lines.length > 0) perFile[f.path] = pct(lines.filter(Boolean).length, lines.length)
    }
    let covered = 0
    let total = 0
    for (const f of files) {
      const changed = ctx.scope === undefined ? undefined : new Set((ctx.facts.addedLines.get(f.path) ?? []).map((l) => l.line))
      for (const [nr, hit] of f.lines) {
        if (changed && !changed.has(nr)) continue
        total++
        if (hit) covered++
      }
    }
    // A changed file no test loaded is missing from the report; its changed code counts as uncovered.
    for (const p of scoped ?? []) {
      if (files.some((f) => f.path === p)) continue
      const uncovered = (ctx.facts.addedLines.get(p) ?? []).filter((l) => !COMMENT_OR_BLANK.test(l.text)).length
      total += uncovered
      if (uncovered > 0) perFile[p] = 0
    }
    if (total === 0) return { ...base(r), exitCode: 0, nothingInScope: ctx.scope ? "no executable changed lines" : "no executable lines were measured" }
    return { ...base(r), exitCode: 0, metrics: { coverage: { value: pct(covered, total), unit: "%", higherIsBetter: true, perFile } } }
  })

import type { GateContext, GateImpl, GateRun, SuiteImpl, TestSubset } from "@gauntlet/core"
import { globMatches } from "@gauntlet/dsl"
import { prettyCanonicalJson } from "@gauntlet/ir"
import { convertJUnit, decodeLog, type Log, relativeUri, type Result, type Run, SARIF_SCHEMA, SARIF_VERSION } from "@gauntlet/sarif"
import { Effect, FileSystem, Option, Path } from "effect"
import { convertEslintJson, convertJestJson, DETECTED, parseLcov, parseStryker, UNDETECTED } from "./reports.ts"
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

export const mutation: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const inScope = ctx.scope?.filter(isMainSource)
    if (inScope !== undefined && inScope.length === 0) return { command: [], exitCode: 0, runs: [], nothingInScope: "no main source files in scope to mutate" }
    const { chain, blocked } = yield* prepared(ctx, "stryker")
    if (blocked) return blocked
    if (!chain.deps.has("@stryker-mutator/core")) return failed(["stryker"], "StrykerJS isn't installed: add @stryker-mutator/core and its test runner plugin")
    const config = STRYKER_CONFIGS.find((c) => ctx.files.includes(c))
    // A config next to the output directories that extends the project's (or
    // Gauntlet's defaults, when it has none), so Gauntlet decides the files, the
    // report location and that no cache is used.
    const generated = path.join(path.dirname(ctx.outputDir), "gauntlet.stryker.config.mjs")
    let importBase: string
    if (config) {
      const project = path.join(ctx.dir, config)
      importBase = config.endsWith("json") || config === ".strykerrc"
        ? `import base from ${JSON.stringify(project)} with { type: "json" }`
        : `import base from ${JSON.stringify(project)}`
    } else {
      const defaults = strykerDefaults(chain, ctx.files)
      if (typeof defaults === "string") return failed(["stryker"], defaults)
      importBase = `const base = ${JSON.stringify(defaults)}`
    }
    const overrides = {
      ...(inScope ? { mutate: inScope } : {}),
      reporters: ["json"],
      jsonReporter: { fileName: `${ctx.outputDir}/mutation/mutation.json` },
      incremental: false,
      cleanTempDir: "always",
    }
    yield* fs.writeFileString(generated, `${importBase}\nexport default { ...base, ...${JSON.stringify(overrides)} }\n`).pipe(Effect.orElseSucceed(() => undefined))
    const r = yield* tool(ctx, "stryker", ["run", generated])
    if (r.error) return base(r)
    const report = (yield* reports(ctx, (p) => p === "mutation/mutation.json"))[0]
    const mutants = report ? parseStryker(report.content, ctx.dir) : Option.none()
    if (Option.isNone(mutants)) return base(r)
    const counted = mutants.value.filter((m) => (DETECTED.has(m.status) || UNDETECTED.has(m.status)) && (inScope === undefined || inScope.includes(m.path)))
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

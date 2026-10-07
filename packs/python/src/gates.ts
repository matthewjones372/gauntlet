import type { GateContext, GateImpl, GateRun, SuiteImpl, TestSubset } from "@gauntlet/core"
import { globMatches } from "@gauntlet/dsl"
import { prettyCanonicalJson } from "@gauntlet/ir"
import { convertJUnit, decodeLog, type Log, relativeUri, type Result, type Run, SARIF_SCHEMA, SARIF_VERSION } from "@gauntlet/sarif"
import { Effect, FileSystem, Option, Path } from "effect"
import { parseLcov, parseMutmutMeta } from "./reports.ts"
import { runRules } from "./rules.ts"
import { line, nameOf, ofType, parsePython } from "./syntax.ts"
import { declares, ensureInstalled, has, isMainSource, isPython, moduleName, tool, type ToolRun } from "./toolchain.ts"

// The Python pack's gates. Each installs dependencies once per check, runs
// the project's own tool, and reads only what lands in the check's output
// directory (ADR 0012).

const base = (r: ToolRun): GateRun => ({ command: [...r.command], exitCode: r.exitCode, runs: [], ...(r.error ? { error: r.error } : {}) })
const failed = (command: ReadonlyArray<string>, error: string): GateRun => ({ command, exitCode: -1, runs: [], error })

const prepared = (ctx: GateContext, gate: string) =>
  ensureInstalled(ctx).pipe(Effect.map((install) => (Option.isSome(install) ? failed([gate], install.value) : undefined)))

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

const literalPrefix = (glob: string) => glob.split("/").filter((_, i, all) => !all.slice(0, i + 1).some((s) => /[*?[{]/.test(s))).join("/")

/** Where the source code lives: `src` in a src layout, otherwise the repository root. */
const sourceRoot = (ctx: GateContext) => (ctx.files.some((f) => f.startsWith("src/") && f.endsWith(".py")) ? "src" : ".")

// ---------- build: the type checker ----------

export const build: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const blocked = yield* prepared(ctx, "typecheck")
    if (blocked) return blocked
    if (yield* has(ctx, "mypy")) return base(yield* tool(ctx, "mypy", [sourceRoot(ctx)]))
    if (yield* has(ctx, "pyright")) return base(yield* tool(ctx, "pyright", []))
    // Without a type checker, compiling every file is the least evidence that the code loads.
    return base(yield* tool(ctx, "python", ["-m", "compileall", "-q", sourceRoot(ctx)]))
  })

// ---------- suites: pytest (which also runs unittest tests) ----------

/** The test files a subset names: its files, and the modules its test ids (`tests.test_x.test_y`) come from. */
const subsetFiles = (subset: TestSubset, files: ReadonlyArray<string>) => {
  const modules = files.filter((f) => f.endsWith(".py")).map((f) => ({ f, module: f.replace(/\.py$/, "").replaceAll("/", ".") }))
  const fromIds = subset.ids.flatMap((id) => modules.filter((m) => id.startsWith(`${m.module}.`)).map((m) => m.f))
  return [...new Set([...subset.files, ...fromIds])].sort()
}

export const runSuite: SuiteImpl = (suite, ctx, subset) =>
  Effect.gen(function*() {
    const blocked = yield* prepared(ctx, "pytest")
    if (blocked) return blocked
    if (!(yield* has(ctx, "pytest"))) return failed(["pytest"], "pytest isn't installed in the project (it also runs unittest tests)")
    const filter = literalPrefix(suite.location)
    const targets = subset ? subsetFiles(subset, ctx.files) : filter ? [filter] : []
    if (subset && targets.length === 0) return failed(["pytest"], "no test files to run again")
    // Reruns vary string hashing (a real source of order bugs), and pytest-randomly's order when the project has it.
    const randomly = subset !== undefined && (yield* declares(ctx, "pytest-randomly"))
    const r = yield* tool(ctx, "pytest", ["-q", "-p", "no:cacheprovider", `--junitxml=${ctx.outputDir}/junit.xml`, ...(randomly ? ["-p", "randomly", `--randomly-seed=${subset!.seed}`] : []), ...targets],
      subset ? { PYTHONHASHSEED: String(subset.seed % 4294967295) } : {})
    if (r.error) return base(r)
    const xml = yield* reports(ctx, (p) => p.endsWith(".xml"))
    if (xml.length === 0) return base(r)
    const junit = yield* Effect.exit(convertJUnit(suite.name, xml.map((f) => ({ path: f.path, content: f.content }))))
    if (junit._tag === "Failure") return { ...base(r), error: "the JUnit XML couldn't be read" }
    return { ...base(r), runs: [junit.value.run], tests: { counts: junit.value.counts, ids: junit.value.tests.map((t) => t.id) } }
  })

// ---------- lint: ruff, plus the zones' Python rules ----------

export const lint: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const blocked = yield* prepared(ctx, "ruff")
    if (blocked) return blocked
    if (!(yield* has(ctx, "ruff"))) return failed(["ruff"], "ruff isn't installed in the project")
    const r = yield* tool(ctx, "ruff", ["check", "--output-format", "sarif", "-o", `${ctx.outputDir}/ruff.sarif`, "."])
    if (r.error) return base(r)
    const file = (yield* reports(ctx, (p) => p === "ruff.sarif"))[0]
    const log = file ? yield* Effect.option(decodeLog(file.content)) : Option.none()
    if (Option.isNone(log)) return { ...base(r), error: "ruff wrote no SARIF report" }
    const runs = log.value.runs.map((run): Run => ({
      ...run,
      tool: { driver: { ...run.tool.driver, name: "ruff" } },
      results: run.results.map((x) => ({
        ...x,
        ...(x.locations ? { locations: x.locations.map((l) => ({ ...l, physicalLocation: { ...l.physicalLocation, ...(l.physicalLocation?.artifactLocation ? { artifactLocation: { uri: relativeUri(l.physicalLocation.artifactLocation.uri, ctx.dir) } } : {}) } })) } : {}),
      })),
    }))
    const results: Result[] = []
    for (const zone of ctx.ir.zones.filter((z) => z.rules.length > 0)) {
      const files = ctx.files.filter((p) => isPython(p) && zone.globs.some((g) => globMatches(g, p)) && (ctx.scope === undefined || ctx.scope.includes(p)))
      results.push(...runRules(zone.rules, yield* readFiles(ctx, files)))
    }
    const rulesRun: Run = { tool: { driver: { name: "py-rules" } }, results }
    yield* writeSarif(ctx, "py-rules.sarif", rulesRun)
    return { ...base(r), exitCode: 0, runs: [...runs, rulesRun] }
  })

// ---------- arch: import analysis ----------

export const arch: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const sources = yield* readFiles(ctx, ctx.files.filter(isMainSource))
    const belongs = (dotted: string, module: string) => dotted.split(".").includes(module)
    const results: Result[] = []
    for (const rule of ctx.ir.arch) {
      for (const target of rule.mustNotDependOn) {
        for (const f of sources) {
          const own = moduleName(f.path)
          if (!belongs(own, rule.module) || belongs(own, target)) continue
          for (const imp of ofType(parsePython(f.text).rootNode, "import_statement", "import_from_statement")) {
            const names = imp.type === "import_from_statement"
              ? [resolveFrom(own, imp.childForFieldName("module_name")?.text ?? "")]
              : imp.namedChildren.filter((c) => c?.type === "dotted_name" || c?.type === "aliased_import").map((c) => c!.text.split(/\s+as\s+/)[0]!)
            for (const name of names) {
              if (belongs(name, target)) {
                results.push({
                  ruleId: `arch/${rule.module}-must-not-depend-on-${target}`,
                  level: "error",
                  message: { text: `${rule.module} imports ${name}, which belongs to ${target}.` },
                  locations: [{ physicalLocation: { artifactLocation: { uri: f.path }, region: { startLine: line(imp) } } }],
                })
              }
            }
          }
        }
      }
    }
    const run: Run = { tool: { driver: { name: "py-arch" } }, results }
    yield* writeSarif(ctx, "arch.sarif", run)
    return { command: ["gauntlet", "arch"], exitCode: 0, runs: [run] }
  })

/** Resolves `from ..infra import x` against the importing module's package. */
const resolveFrom = (own: string, spec: string): string => {
  const dots = /^\.*/.exec(spec)?.[0].length ?? 0
  if (dots === 0) return spec
  const pkg = own.split(".").slice(0, -dots)
  const rest = spec.slice(dots)
  return [...pkg, ...(rest ? rest.split(".") : [])].join(".")
}

// ---------- mutation: mutmut ----------

export const mutation: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const inScope = ctx.scope?.filter(isMainSource)
    if (inScope !== undefined && inScope.length === 0) return { command: [], exitCode: 0, runs: [], nothingInScope: "no main source files in scope to mutate" }
    const blocked = yield* prepared(ctx, "mutmut")
    if (blocked) return blocked
    if (!(yield* has(ctx, "mutmut"))) return failed(["mutmut"], "mutmut isn't installed in the project")
    // mutmut writes its results into ./mutants. Anything already there (even
    // committed by the change) is removed first, and the fresh results are
    // copied into the output directory, the only place evidence is read from.
    const work = path.join(ctx.dir, "mutants")
    yield* fs.remove(work, { recursive: true, force: true }).pipe(Effect.orElseSucceed(() => undefined))
    const patterns = (inScope ?? []).map((p) => `${moduleName(p)}.*`)
    const r = yield* tool(ctx, "mutmut", ["run", ...patterns])
    if (r.error) return base(r)
    const metas = yield* fs.readDirectory(work, { recursive: true }).pipe(Effect.orElseSucceed(() => [] as string[]))
    for (const m of metas.filter((m) => m.endsWith(".py.meta"))) {
      const text = yield* fs.readFileString(path.join(work, m)).pipe(Effect.option)
      if (Option.isSome(text)) {
        const target = path.join(ctx.outputDir, "mutmut", m)
        yield* fs.makeDirectory(path.dirname(target), { recursive: true }).pipe(Effect.orElseSucceed(() => undefined))
        yield* fs.writeFileString(target, text.value).pipe(Effect.orElseSucceed(() => undefined))
      }
    }
    const files = yield* reports(ctx, (p) => p.startsWith("mutmut/") && p.endsWith(".py.meta"))
    if (files.length === 0) return base(r)
    const mutants = files.flatMap((f) => Option.getOrElse(parseMutmutMeta(f.path.slice("mutmut/".length).replace(/\.meta$/, ""), f.content), () => []))
      .filter((m) => inScope === undefined || inScope.includes(m.path))
    const counted = mutants.filter((m) => m.outcome !== "skipped" && m.outcome !== "other")
    if (counted.length === 0) return { ...base(r), nothingInScope: "mutmut generated no mutants for the code in scope" }
    const detected = (ms: typeof counted) => ms.filter((m) => m.outcome === "killed" || m.outcome === "timeout").length
    const pct = (ms: typeof counted) => Math.round((detected(ms) / ms.length) * 10000) / 100
    const perFile: Record<string, number> = {}
    for (const p of [...new Set(counted.map((m) => m.path))].sort()) perFile[p] = pct(counted.filter((m) => m.path === p))
    // mutmut names a mutant by its function; point survivors at that function's line.
    const sources = new Map((yield* readFiles(ctx, [...new Set(counted.map((m) => m.path))])).map((s) => [s.path, parsePython(s.text).rootNode] as const))
    const lineOf = (p: string, fn: string) => {
      const root = sources.get(p)
      const leaf = fn.split(".").pop()!
      const def = root ? ofType(root, "function_definition").find((d) => nameOf(d) === leaf) : undefined
      return def ? line(def) : 1
    }
    const survivors: Run = {
      tool: { driver: { name: "mutmut" } },
      results: counted.filter((m) => m.outcome === "survived" || m.outcome === "no-tests").map((m) => ({
        ruleId: "mutation/survived",
        level: "warning",
        message: { text: `${m.outcome === "no-tests" ? "No test covers" : "No test kills"} a mutant in ${m.function}` },
        locations: [{ physicalLocation: { artifactLocation: { uri: m.path }, region: { startLine: lineOf(m.path, m.function) } } }],
      })),
    }
    return { ...base(r), exitCode: 0, runs: [survivors], metrics: { mutation: { value: pct(counted), unit: "%", higherIsBetter: true, perFile } } }
  })

// ---------- coverage: coverage.py ----------

const COMMENT_OR_BLANK = /^\s*($|#)/

export const coverage: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const blocked = yield* prepared(ctx, "coverage")
    if (blocked) return blocked
    if (!(yield* has(ctx, "coverage"))) return failed(["coverage"], "coverage.py isn't installed in the project")
    const data = `${ctx.outputDir}/.coverage`
    const run = yield* tool(ctx, "coverage", ["run", `--data-file=${data}`, "-m", "pytest", "-q", "-p", "no:cacheprovider"])
    if (run.error) return base(run)
    const r = yield* tool(ctx, "coverage", ["lcov", `--data-file=${data}`, "-o", `${ctx.outputDir}/lcov.info`])
    const lcov = (yield* reports(ctx, (p) => p === "lcov.info"))[0]
    if (!lcov) return { ...base(r), error: "coverage.py wrote no lcov report" }
    const scoped = ctx.scope?.filter(isMainSource)
    const files = parseLcov(lcov.content, ctx.dir).filter((f) => ctx.scope === undefined || ctx.scope.includes(f.path))
    const pct = (covered: number, total: number) => Math.round((covered / total) * 10000) / 100
    const perFile: Record<string, number> = {}
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
    // A changed file coverage.py didn't measure counts as uncovered, not unmeasured.
    for (const p of scoped ?? []) {
      if (files.some((f) => f.path === p)) continue
      const uncovered = (ctx.facts.addedLines.get(p) ?? []).filter((l) => !COMMENT_OR_BLANK.test(l.text)).length
      total += uncovered
      if (uncovered > 0) perFile[p] = 0
    }
    if (total === 0) return { ...base(r), exitCode: 0, nothingInScope: ctx.scope ? "no executable changed lines" : "no executable lines were measured" }
    return { ...base(r), exitCode: 0, metrics: { coverage: { value: pct(covered, total), unit: "%", higherIsBetter: true, perFile } } }
  })

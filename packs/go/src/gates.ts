import type { GateContext, GateImpl, GateRun, SuiteImpl, TestSubset } from "@gauntlet/core"
import { globMatches } from "@gauntlet/dsl"
import { prettyCanonicalJson } from "@gauntlet/ir"
import { decodeLog, type Log, relativeUri, type Result, type Run, SARIF_SCHEMA, SARIF_VERSION } from "@gauntlet/sarif"
import { Effect, FileSystem, Option, Path } from "effect"
import { convertGoTest, packageRelative, parseCoverProfile, parseGremlins } from "./reports.ts"
import { runRules } from "./rules.ts"
import { importPaths, ofType, parseGo } from "./syntax.ts"
import { ensureModules, exec, goTool, isGo, isMainSource, modulePath, packageDir, type ToolRun } from "./toolchain.ts"

// The Go pack's gates. Each downloads modules once per check, runs the Go
// toolchain or the project's tool in the judged checkout, and reads only what
// lands in the check's output directory (ADR 0012). Tests never come from
// Go's test cache (-count=1).

const base = (r: ToolRun): GateRun => ({ command: [...r.command], exitCode: r.exitCode, runs: [], ...(r.error ? { error: r.error } : {}) })
const failed = (command: ReadonlyArray<string>, error: string): GateRun => ({ command, exitCode: -1, runs: [], error })

const prepared = (ctx: GateContext, gate: string) =>
  ensureModules(ctx).pipe(Effect.map((m) => (Option.isSome(m) ? failed([gate], m.value) : undefined)))

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

const writeOut = (ctx: GateContext, file: string, content: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.writeFileString(path.join(ctx.outputDir, file), content).pipe(Effect.orElseSucceed(() => undefined))
  })

const writeSarif = (ctx: GateContext, file: string, run: Run) =>
  writeOut(ctx, file, prettyCanonicalJson({ version: SARIF_VERSION, $schema: SARIF_SCHEMA, runs: [run] } satisfies Log))

const reports = (ctx: GateContext, test: (path: string) => boolean) => ctx.collect.pipe(Effect.map((files) => files.filter((f) => test(f.path))))

const literalPrefix = (glob: string) => glob.split("/").filter((_, i, all) => !all.slice(0, i + 1).some((s) => /[*?[{]/.test(s))).join("/")

const moduleOf = (ctx: GateContext) => modulePath(ctx).pipe(Effect.map((m) => Option.getOrElse(m, () => "")))

// ---------- build: compile every package and its tests ----------

export const build: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const blocked = yield* prepared(ctx, "go build")
    if (blocked) return blocked
    const compile = yield* exec(ctx, ["go", "build", "./..."])
    if (compile.error || compile.exitCode !== 0) return base(compile)
    // Running no tests still compiles every test file.
    return base(yield* exec(ctx, ["go", "test", "-count=1", "-run", "^$", "./..."]))
  })

// ---------- suites: go test -json ----------

/** The packages and test names a rerun selects: from changed test files, and from failing test ids (`<package>.<Test>`). */
export const subsetTargets = (subset: TestSubset, module: string) => {
  const fromFiles = subset.files.filter(isGo).map(packageDir)
  const tests = subset.ids.flatMap((id) => {
    const m = /^(.+)\.(Test\w*|Fuzz\w*)(\/.*)?$/.exec(id)
    if (!m) return []
    const rel = packageRelative(m[1]!, module)
    return [{ pkg: rel === "" ? "." : `./${rel}`, test: m[2]! }]
  })
  return {
    packages: [...new Set([...fromFiles, ...tests.map((t) => t.pkg)])].sort(),
    // A file subset reruns whole packages; an id subset only the named tests.
    run: fromFiles.length > 0 || tests.length === 0 ? undefined : `^(${[...new Set(tests.map((t) => t.test))].sort().join("|")})$`,
  }
}

export const runSuite: SuiteImpl = (suite, ctx, subset) =>
  Effect.gen(function*() {
    const blocked = yield* prepared(ctx, "go test")
    if (blocked) return blocked
    const module = yield* moduleOf(ctx)
    const prefix = literalPrefix(suite.location)
    const targets = subset ? subsetTargets(subset, module) : { packages: [prefix === "" ? "./..." : `./${prefix}/...`], run: undefined }
    if (targets.packages.length === 0) return failed(["go", "test"], "no test packages to run again")
    const r = yield* exec(ctx, ["go", "test", "-json", "-count=1", ...(subset ? [`-shuffle=${subset.seed}`] : []), ...(targets.run ? ["-run", targets.run] : []), ...targets.packages])
    if (r.error) return base(r)
    yield* writeOut(ctx, "go-test.json", r.stdout)
    const file = (yield* reports(ctx, (p) => p === "go-test.json"))[0]
    if (!file) return base(r)
    const report = convertGoTest(suite.name, file.content, module)
    return { ...base(r), runs: [report.run], tests: { counts: report.counts, ids: report.ids } }
  })

// ---------- lint: golangci-lint, plus the zones' Go rules ----------

export const lint: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const blocked = yield* prepared(ctx, "golangci-lint")
    if (blocked) return blocked
    const bin = yield* goTool(ctx, "golangci-lint")
    if (Option.isNone(bin)) return failed(["golangci-lint"], "golangci-lint isn't installed (go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint, or your package manager)")
    // A cache of its own per check, so no earlier run vouches for this code.
    const cache = path.join(path.dirname(ctx.outputDir), "golangci-cache")
    const r = yield* exec(ctx, [bin.value, "run", `--output.sarif.path=${ctx.outputDir}/golangci.sarif`, "--output.text.path=stderr", "--issues-exit-code=0", "--show-stats=false", "./..."], { GOLANGCI_LINT_CACHE: cache })
    if (r.error) return base(r)
    if (r.exitCode !== 0) return { ...base(r), error: `golangci-lint couldn't run: ${r.stderr.trim().split("\n").at(-1) ?? ""}` }
    const file = (yield* reports(ctx, (p) => p === "golangci.sarif"))[0]
    const log = file ? yield* Effect.option(decodeLog(file.content)) : Option.none()
    if (Option.isNone(log)) return { ...base(r), error: "golangci-lint wrote no SARIF report" }
    const runs = log.value.runs.map((run): Run => ({
      ...run,
      tool: { driver: { ...run.tool.driver, name: "golangci-lint" } },
      results: run.results.map((x) => ({
        ...x,
        ...(x.locations ? { locations: x.locations.map((l) => ({ ...l, physicalLocation: { ...l.physicalLocation, ...(l.physicalLocation?.artifactLocation ? { artifactLocation: { uri: relativeUri(l.physicalLocation.artifactLocation.uri, ctx.dir) } } : {}) } })) } : {}),
      })),
    }))
    const results: Result[] = []
    for (const zone of ctx.ir.zones.filter((z) => z.rules.length > 0)) {
      const files = ctx.files.filter((p) => isMainSource(p) && zone.globs.some((g) => globMatches(g, p)) && (ctx.scope === undefined || ctx.scope.includes(p)))
      results.push(...runRules(zone.rules, yield* readFiles(ctx, files)))
    }
    const rulesRun: Run = { tool: { driver: { name: "go-rules" } }, results }
    yield* writeSarif(ctx, "go-rules.sarif", rulesRun)
    return { ...base(r), exitCode: 0, runs: [...runs, rulesRun] }
  })

// ---------- arch: import analysis ----------

export const arch: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const module = yield* moduleOf(ctx)
    const sources = yield* readFiles(ctx, ctx.files.filter(isMainSource))
    // A package belongs to a module when one of its path segments is the module's name.
    const segments = (rel: string) => rel.split("/")
    const results: Result[] = []
    for (const rule of ctx.ir.arch) {
      for (const target of rule.mustNotDependOn) {
        for (const f of sources) {
          const own = segments(f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "")
          if (!own.includes(rule.module) || own.includes(target)) continue
          for (const imp of importPaths(parseGo(f.text).rootNode)) {
            if (module === "" || !(imp.path === module || imp.path.startsWith(`${module}/`))) continue
            if (segments(packageRelative(imp.path, module)).includes(target)) {
              results.push({
                ruleId: `arch/${rule.module}-must-not-depend-on-${target}`,
                level: "error",
                message: { text: `${rule.module} imports ${imp.path}, which belongs to ${target}.` },
                locations: [{ physicalLocation: { artifactLocation: { uri: f.path }, region: { startLine: imp.line } } }],
              })
            }
          }
        }
      }
    }
    const run: Run = { tool: { driver: { name: "go-arch" } }, results }
    yield* writeSarif(ctx, "arch.sarif", run)
    return { command: ["gauntlet", "arch"], exitCode: 0, runs: [run] }
  })

// ---------- mutation: gremlins ----------

const regexEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export const mutation: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const inScope = ctx.scope?.filter(isMainSource)
    if (inScope !== undefined && inScope.length === 0) return { command: [], exitCode: 0, runs: [], nothingInScope: "no main Go files in scope to mutate" }
    const blocked = yield* prepared(ctx, "gremlins")
    if (blocked) return blocked
    const bin = yield* goTool(ctx, "gremlins")
    if (Option.isNone(bin)) return failed(["gremlins"], "gremlins isn't installed (go install github.com/go-gremlins/gremlins/cmd/gremlins)")
    // Out-of-scope files are excluded so only the changed code is mutated.
    const excluded = inScope === undefined ? [] : ctx.files.filter((p) => isMainSource(p) && !inScope.includes(p)).flatMap((p) => ["-E", `^${regexEscape(p)}$`])
    const r = yield* exec(ctx, [bin.value, "unleash", "--silent", `--output=${ctx.outputDir}/gremlins.json`, ...excluded, "."])
    if (r.error) return base(r)
    const file = (yield* reports(ctx, (p) => p === "gremlins.json"))[0]
    const mutants = file ? Option.getOrElse(parseGremlins(file.content), () => []) : []
    if (!file) return { ...base(r), error: `gremlins wrote no report${r.stderr.trim() ? `: ${r.stderr.trim().split("\n").at(-1)}` : ""}` }
    const counted = mutants.filter((m) => m.outcome !== "other" && (inScope === undefined || inScope.includes(m.path)))
    if (counted.length === 0) return { ...base(r), exitCode: 0, nothingInScope: "gremlins generated no mutants for the code in scope" }
    const detected = (ms: typeof counted) => ms.filter((m) => m.outcome === "killed" || m.outcome === "timeout").length
    const pct = (ms: typeof counted) => Math.round((detected(ms) / ms.length) * 10000) / 100
    const perFile: Record<string, number> = {}
    for (const p of [...new Set(counted.map((m) => m.path))].sort()) perFile[p] = pct(counted.filter((m) => m.path === p))
    const survivors: Run = {
      tool: { driver: { name: "gremlins" } },
      results: counted.filter((m) => m.outcome === "survived" || m.outcome === "not-covered").sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line)).map((m) => ({
        ruleId: "mutation/survived",
        level: "warning",
        message: { text: `${m.outcome === "not-covered" ? "No test covers" : "No test kills"} a ${m.type.toLowerCase().replaceAll("_", " ")} mutant` },
        locations: [{ physicalLocation: { artifactLocation: { uri: m.path }, region: { startLine: m.line } } }],
      })),
    }
    return { ...base(r), exitCode: 0, runs: [survivors], metrics: { mutation: { value: pct(counted), unit: "%", higherIsBetter: true, perFile } } }
  })

// ---------- coverage: go test -coverprofile ----------

const COMMENT_OR_BLANK = /^\s*($|\/\/)/

export const coverage: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const blocked = yield* prepared(ctx, "go test -cover")
    if (blocked) return blocked
    const module = yield* moduleOf(ctx)
    // -coverpkg counts code tested from other packages too.
    const r = yield* exec(ctx, ["go", "test", "-count=1", "-covermode=set", "-coverpkg=./...", `-coverprofile=${ctx.outputDir}/cover.out`, "./..."])
    if (r.error) return base(r)
    const profile = (yield* reports(ctx, (p) => p === "cover.out"))[0]
    if (!profile) return { ...base(r), error: "go test wrote no coverage profile (do the tests compile and pass?)" }
    const scoped = ctx.scope?.filter(isMainSource)
    const files = parseCoverProfile(profile.content, module).filter((f) => ctx.scope === undefined || ctx.scope.includes(f.path))
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
    // A changed file with code the profile doesn't mention counts as uncovered, not unmeasured.
    // Files of only types and constants have no statements, so they're never in a profile.
    const withCode = new Set((yield* readFiles(ctx, (scoped ?? []).filter((p) => !files.some((f) => f.path === p))))
      .filter((f) => ofType(parseGo(f.text).rootNode, "function_declaration", "method_declaration").length > 0).map((f) => f.path))
    for (const p of scoped ?? []) {
      if (files.some((f) => f.path === p) || !withCode.has(p)) continue
      const uncovered = (ctx.facts.addedLines.get(p) ?? []).filter((l) => !COMMENT_OR_BLANK.test(l.text)).length
      total += uncovered
      if (uncovered > 0) perFile[p] = 0
    }
    if (total === 0) return { ...base(r), exitCode: 0, nothingInScope: ctx.scope ? "no executable changed lines" : "no executable lines were measured" }
    return { ...base(r), exitCode: 0, metrics: { coverage: { value: pct(covered, total), unit: "%", higherIsBetter: true, perFile } } }
  })

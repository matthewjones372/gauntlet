import type { GateContext, GateImpl, GateRun, SuiteImpl, TestSubset } from "@gauntlet/core"
import { globMatches } from "@gauntlet/dsl"
import { prettyCanonicalJson } from "@gauntlet/ir"
import { convertJUnit, type Log, type Result, type Run, SARIF_SCHEMA, SARIF_VERSION } from "@gauntlet/sarif"
import { Effect, FileSystem, Option, Path } from "effect"
import { convertScalafix, DETECTED, parseCobertura, parseStryker, UNDETECTED } from "./reports.ts"
import { runRules } from "./rules.ts"
import { line, nameOf, ofType, parseScala } from "./syntax.ts"
import { isMainSource, isScala, isTestFile, packageOf, sbt, scalaString, type ToolRun } from "./toolchain.ts"

// The Scala pack's gates. Each is one sbt invocation in the judged checkout;
// reports are pointed at the check's output directory with `set` commands, or
// copied there from the tool's own location after the run (ADR 0012).

/** Reports the project's own CI wrote (ADR 0024): sbt's JUnit results, and scoverage's Cobertura XML. */
const CI_JUNIT = /(^|\/)target\/test-reports\/[^/]+\.xml$/
const CI_COVERAGE = /(^|\/)target\/scala-[^/]+\/coverage-report\/cobertura\.xml$/
/** Stands in for an sbt run when the CI already ran it. */
const FROM_CI: ToolRun = { command: ["ci"], exitCode: 0, stdout: "", stderr: "" }

const base = (r: ToolRun): GateRun => ({ command: [...r.command], exitCode: r.exitCode, runs: [], ...(r.error ? { error: r.error } : {}) })
const failed = (command: ReadonlyArray<string>, error: string): GateRun => ({ command, exitCode: -1, runs: [], error })

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
    yield* fs.writeFileString(path.join(ctx.outputDir, file), prettyCanonicalJson({ version: SARIF_VERSION, $schema: SARIF_SCHEMA, runs: [run] } satisfies Log)).pipe(Effect.orElseSucceed(() => undefined))
  })

const reports = (ctx: GateContext, test: (path: string) => boolean) => ctx.collect.pipe(Effect.map((files) => files.filter((f) => test(f.path))))

/** sbt's own message when a command or setting key comes from a plugin the build doesn't apply. */
const notAvailable = (r: ToolRun, what: string) => new RegExp(`Not a valid (command|key|project ID): ${what}`).test(`${r.stdout}\n${r.stderr}`)

/** The last sbt error line, for reasons. */
const lastError = (r: ToolRun) => `${r.stdout}\n${r.stderr}`.split("\n").filter((l) => l.startsWith("[error]")).map((l) => l.replace(/^\[error\]\s*/, "")).filter((l) => l !== "" && !/^Total time/.test(l)).at(0) ?? ""

// ---------- build ----------

export const build: GateImpl = (_check, ctx) => sbt(ctx, ["Test/compile"]).pipe(Effect.map(base))

// ---------- suites: sbt test, JUnit XML into the output directory ----------

/** Suite classes a test file declares: `svc.domain.MoneySpec`. */
const suitesIn = (path: string, text: string) => {
  const pkg = packageOf(path)
  return parseScala(text).rootNode.namedChildren.filter((c) => c?.type === "class_definition" || c?.type === "object_definition").map((c) => (pkg ? `${pkg}.${nameOf(c!)}` : nameOf(c!)))
}

/** The suites a rerun names: those in the changed test files, and those whose name starts the failing test ids. */
export const subsetSuites = (subset: TestSubset, testFiles: ReadonlyArray<{ readonly path: string; readonly text: string }>) => {
  const known = testFiles.flatMap((f) => suitesIn(f.path, f.text))
  const fromFiles = testFiles.filter((f) => subset.files.includes(f.path)).flatMap((f) => suitesIn(f.path, f.text))
  const fromIds = subset.ids.flatMap((id) => known.filter((s) => id.startsWith(`${s}.`)).sort((a, b) => b.length - a.length).slice(0, 1))
  return [...new Set([...fromFiles, ...fromIds])].sort()
}

export const runSuite: SuiteImpl = (suite, ctx, subset) =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const junit = path.join(ctx.outputDir, "junit")
    const suites = subset ? subsetSuites(subset, yield* readFiles(ctx, ctx.files.filter(isTestFile))) : []
    if (subset && suites.length === 0) return failed(["sbt", "testOnly"], "no test suites to run again")
    // With withCoverage the same run writes scoverage's report too, for the coverage gate.
    const coverage = ctx.withCoverage && !subset
    const r = ctx.fromCi ? FROM_CI : yield* sbt(ctx, [
      `set every Test / testReportsDirectory := file(${scalaString(junit)})`,
      ...(coverage ? [`set every coverageDataDir := file(${scalaString(path.join(ctx.outputDir, "scoverage"))})`, "coverage"] : []),
      // The frameworks share no shuffle option; reruns vary parallel execution instead.
      ...(subset ? [`set every Test / parallelExecution := ${subset.seed % 2 === 0}`] : []),
      subset ? `testOnly ${suites.join(" ")}` : "test",
      ...(coverage ? ["coverageReport"] : []),
    ])
    if (r.error) return base(r)
    const xml = yield* reports(ctx, (p) => (ctx.fromCi ? CI_JUNIT.test(p) : p.startsWith("junit/") && p.endsWith(".xml")))
    if (xml.length === 0) return { ...base(r), ...(r.exitCode !== 0 ? { error: `sbt test failed before any test ran: ${lastError(r)}` } : {}) }
    const report = yield* Effect.exit(convertJUnit(suite.name, xml.map((f) => ({ path: f.path, content: f.content }))))
    if (report._tag === "Failure") return { ...base(r), error: "the JUnit XML couldn't be read" }
    return { ...base(r), runs: [report.value.run], tests: { counts: report.value.counts, ids: report.value.tests.map((t) => t.id) } }
  })

// ---------- lint: scalafix --check, plus the zones' Scala rules ----------

export const lint: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const r = yield* sbt(ctx, ["scalafixAll --check"])
    if (r.error) return base(r)
    if (notAvailable(r, "scalafixAll")) return { ...base(r), error: "scalafix isn't applied; add the ch.epfl.scala sbt-scalafix plugin and a .scalafix.conf" }
    const output = `${r.stdout}\n${r.stderr}`
    // A failed check is the linter's findings; any other failure means it couldn't check the code.
    if (r.exitCode !== 0 && !/LinterError|ScalafixFailed/.test(output)) return { ...base(r), error: `scalafix couldn't check the code: ${lastError(r)}` }
    yield* fs.writeFileString(path.join(ctx.outputDir, "scalafix.log"), output).pipe(Effect.orElseSucceed(() => undefined))
    const log = (yield* reports(ctx, (p) => p === "scalafix.log"))[0]
    if (!log) return { ...base(r), error: "scalafix wrote no output" }
    const scalafix = convertScalafix(log.content, ctx.dir)
    const results: Result[] = []
    for (const zone of ctx.ir.zones.filter((z) => z.rules.length > 0)) {
      const files = ctx.files.filter((p) => isMainSource(p) && zone.globs.some((g) => globMatches(g, p)) && (ctx.scope === undefined || ctx.scope.includes(p)))
      results.push(...runRules(zone.rules, yield* readFiles(ctx, files)))
    }
    const rulesRun: Run = { tool: { driver: { name: "scala-rules" } }, results }
    yield* writeSarif(ctx, "scalafix.sarif", scalafix)
    yield* writeSarif(ctx, "scala-rules.sarif", rulesRun)
    return { ...base(r), exitCode: 0, runs: [scalafix, rulesRun] }
  })

// ---------- arch: imports ----------

export const arch: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const sources = yield* readFiles(ctx, ctx.files.filter(isMainSource))
    const results: Result[] = []
    for (const rule of ctx.ir.arch) {
      for (const target of rule.mustNotDependOn) {
        for (const f of sources) {
          const own = packageOf(f.path).split(".")
          if (!own.includes(rule.module) || own.includes(target)) continue
          for (const imp of ofType(parseScala(f.text).rootNode, "import_declaration")) {
            const imported = imp.text.replace(/^import\s+/, "").split(/[.{},\s]+/).filter((s) => s !== "")
            if (imported.includes(target)) {
              results.push({
                ruleId: `arch/${rule.module}-must-not-depend-on-${target}`,
                level: "error",
                message: { text: `${rule.module} imports ${imp.text.replace(/^import\s+/, "")}, which belongs to ${target}.` },
                locations: [{ physicalLocation: { artifactLocation: { uri: f.path }, region: { startLine: line(imp) } } }],
              })
            }
          }
        }
      }
    }
    const run: Run = { tool: { driver: { name: "scala-arch" } }, results }
    yield* writeSarif(ctx, "arch.sarif", run)
    return { command: ["gauntlet", "arch"], exitCode: 0, runs: [run] }
  })

// ---------- mutation: Stryker4s ----------

export const mutation: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const inScope = ctx.scope?.filter(isMainSource)
    if (inScope !== undefined && inScope.length === 0) return { command: [], exitCode: 0, runs: [], nothingInScope: "no main Scala files in scope to mutate" }
    // Gauntlet's settings go after the project's (HOCON: later keys win), so its
    // excluded mutators stay but the report, scope and break threshold are Gauntlet's.
    const conf = path.join(ctx.dir, "stryker4s.conf")
    const original = yield* fs.readFileString(conf).pipe(Effect.option)
    const overrides = [
      "stryker4s.reporters = [\"json\"]",
      "stryker4s.thresholds.break = 0",
      ...(inScope ? [`stryker4s.mutate = [${inScope.map(scalaString).join(", ")}]`] : []),
    ].join("\n")
    yield* fs.writeFileString(conf, `${Option.getOrElse(original, () => "")}\n${overrides}\n`).pipe(Effect.orElseSucceed(() => undefined))
    // Reports from earlier runs, even ones the change committed, are removed first.
    const reportDir = path.join(ctx.dir, "target", "stryker4s-report")
    yield* fs.remove(reportDir, { recursive: true, force: true }).pipe(Effect.orElseSucceed(() => undefined))
    const r = yield* sbt(ctx, ["stryker"]).pipe(Effect.ensuring(
      Option.match(original, {
        onNone: () => fs.remove(conf, { force: true }),
        onSome: (text) => fs.writeFileString(conf, text),
      }).pipe(Effect.orElseSucceed(() => undefined)),
    ))
    if (r.error) return base(r)
    if (notAvailable(r, "stryker")) return { ...base(r), error: "Stryker4s isn't applied; add the io.stryker-mutator sbt-stryker4s plugin" }
    const runs = yield* fs.readDirectory(reportDir).pipe(Effect.orElseSucceed(() => [] as string[]))
    const latest = [...runs].sort().at(-1)
    const json = latest ? yield* fs.readFileString(path.join(reportDir, latest, "report.json")).pipe(Effect.option) : Option.none<string>()
    if (Option.isSome(json)) {
      yield* fs.makeDirectory(path.join(ctx.outputDir, "stryker4s"), { recursive: true }).pipe(Effect.orElseSucceed(() => undefined))
      yield* fs.writeFileString(path.join(ctx.outputDir, "stryker4s", "report.json"), json.value).pipe(Effect.orElseSucceed(() => undefined))
    }
    const file = (yield* reports(ctx, (p) => p === "stryker4s/report.json"))[0]
    if (!file) return { ...base(r), error: `Stryker4s wrote no report: ${lastError(r)}` }
    const mutants = Option.getOrElse(parseStryker(file.content, ctx.dir), () => [])
    const counted = mutants.filter((m) => (DETECTED.has(m.status) || UNDETECTED.has(m.status)) && (inScope === undefined || inScope.includes(m.path)))
    if (counted.length === 0) return { ...base(r), exitCode: 0, nothingInScope: "Stryker4s generated no mutants for the code in scope" }
    const pct = (ms: typeof counted) => Math.round((ms.filter((m) => DETECTED.has(m.status)).length / ms.length) * 10000) / 100
    const perFile: Record<string, number> = {}
    for (const p of [...new Set(counted.map((m) => m.path))].sort()) perFile[p] = pct(counted.filter((m) => m.path === p))
    const survivors: Run = {
      tool: { driver: { name: "stryker4s" } },
      results: counted.filter((m) => UNDETECTED.has(m.status)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line)).map((m) => ({
        ruleId: "mutation/survived",
        level: "warning",
        message: { text: `${m.status === "NoCoverage" ? "No test covers" : "No test kills"} a ${m.mutator} mutant` },
        locations: [{ physicalLocation: { artifactLocation: { uri: m.path }, region: { startLine: m.line } } }],
      })),
    }
    return { ...base(r), exitCode: 0, runs: [survivors], metrics: { mutation: { value: pct(counted), unit: "%", higherIsBetter: true, perFile } } }
  })

// ---------- coverage: scoverage ----------

const COMMENT_OR_BLANK = /^\s*($|\/\/|\*|\/\*)/

export const coverage: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const r = ctx.fromCi || ctx.coverageFromSuite ? FROM_CI : yield* sbt(ctx, [`set every coverageDataDir := file(${scalaString(path.join(ctx.outputDir, "scoverage"))})`, "coverage", "test", "coverageReport"])
    if (r.error) return base(r)
    if (notAvailable(r, "coverageDataDir") || notAvailable(r, "coverage")) return { ...base(r), error: "scoverage isn't applied; add the org.scoverage sbt-scoverage plugin" }
    // The CI's run writes one report per module; Gauntlet's own run, one for the build.
    const xmls = yield* reports(ctx, (p) => (ctx.fromCi ? CI_COVERAGE.test(p) : p === "scoverage/coverage-report/cobertura.xml"))
    if (xmls.length === 0) return { ...base(r), error: `scoverage wrote no report (do the tests compile and pass?): ${lastError(r)}` }
    const scoped = ctx.scope?.filter(isMainSource)
    const files = xmls.flatMap((x) => parseCobertura(x.content, ctx.files.filter(isScala))).filter((f) => ctx.scope === undefined || ctx.scope.includes(f.path))
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
    // A changed file with methods the report doesn't mention counts as uncovered, not unmeasured.
    const withCode = new Set((yield* readFiles(ctx, (scoped ?? []).filter((p) => !files.some((f) => f.path === p))))
      .filter((f) => ofType(parseScala(f.text).rootNode, "function_definition").length > 0).map((f) => f.path))
    for (const p of scoped ?? []) {
      if (files.some((f) => f.path === p) || !withCode.has(p)) continue
      const uncovered = (ctx.facts.addedLines.get(p) ?? []).filter((l) => !COMMENT_OR_BLANK.test(l.text)).length
      total += uncovered
      if (uncovered > 0) perFile[p] = 0
    }
    if (total === 0) return { ...base(r), exitCode: 0, nothingInScope: ctx.scope ? "no executable changed lines" : "no executable lines were measured" }
    return { ...base(r), exitCode: 0, metrics: { coverage: { value: pct(covered, total), unit: "%", higherIsBetter: true, perFile } } }
  })

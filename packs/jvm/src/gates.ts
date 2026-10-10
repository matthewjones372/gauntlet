import type { GateContext, GateImpl, GateRun, SuiteImpl, TestSubset } from "@gauntlet/core"
import { globMatches } from "@gauntlet/dsl"
import { prettyCanonicalJson } from "@gauntlet/ir"
import { convertJUnit, decodeLog, type Log, type Result, type Run, renderDetektBaseline, SARIF_SCHEMA, SARIF_VERSION } from "@gauntlet/sarif"
import { Effect, FileSystem, Option, Path } from "effect"
import { gradle, type GradleRun, taskMissing } from "./gradle.ts"
import { runRules } from "./kotlin/rules.ts"
import { isKotlin, line, ofType, parseKotlin } from "./kotlin/syntax.ts"
import { parseCoverage, parseMutations } from "./reports.ts"
import { isMainSource, packageOf, pitestTargets, sourceIndex } from "./sources.ts"

// The JVM pack's gates. Each runs its tool through Gradle (or parses Kotlin
// itself), reads only the reports written into the check's output directory,
// and hands SARIF and metrics to the gate runner, which decides the outcome.

/** Reports the project's own CI wrote (ADR 0024): Gradle's JUnit results, and Kover's or JaCoCo's XML. */
const CI_JUNIT = /(^|\/)build\/test-results\/[^/]+\/[^/]+\.xml$/
const CI_COVERAGE = /(^|\/)build\/reports\/(kover\/(xml\/|project-xml\/)?report|jacoco\/[^/]+\/[^/]+)\.xml$/
/** Stands in for a Gradle run when the CI already ran it. */
const FROM_CI: GradleRun = { command: ["ci"], exitCode: 0, stderr: "" }

const base = (r: GradleRun): GateRun => ({ command: r.command, exitCode: r.exitCode, runs: [], ...(r.error ? { error: r.error } : {}) })

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

/** Writes a SARIF log Gauntlet produced itself into the output directory, so it is part of the proof. */
const writeSarif = (ctx: GateContext, file: string, run: Run) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const log: Log = { version: SARIF_VERSION, $schema: SARIF_SCHEMA, runs: [run] }
    yield* fs.writeFileString(path.join(ctx.outputDir, file), prettyCanonicalJson(log)).pipe(Effect.orElseSucceed(() => undefined))
  })

const reports = (ctx: GateContext, test: (path: string) => boolean) => ctx.collect.pipe(Effect.map((files) => files.filter((f) => test(f.path))))

// ---------- build ----------

export const build: GateImpl = (_check, ctx) => gradle(ctx, ["classes", "testClasses"]).pipe(Effect.map(base))

// ---------- suites ----------

/** Test classes a subset names: from test ids (`svc.FxTest.rounds`) and files (`src/test/kotlin/svc/FxTest.kt`). */
export const testClasses = (subset: TestSubset): string[] => [...new Set([
  ...subset.ids.map((id) => id.slice(0, id.lastIndexOf(".")).replace(/\$.*$/, "")).filter((c) => c !== ""),
  ...subset.files.flatMap((f) => {
    const m = /^(?:.*\/)?src\/[^/]+\/(?:kotlin|java)\/(.+)\.(?:kt|java)$/.exec(f)
    return m ? [m[1]!.replaceAll("/", ".")] : []
  }),
])].sort()

/**
 * The Gradle task a suite location runs: the test task of its source set.
 * `src/test/**` is `test`; `**\/src/test/**` is `test` in every module (an
 * unqualified task); `app/src/test/**` is `:app:test`.
 */
export const suiteTask = (location: string): string | undefined => {
  const m = /^(?:(\*\*)\/|([^*{]+)\/)?src\/([^/*{]+)\//.exec(location)
  if (!m) return undefined
  const [, , module, sourceSet] = m
  return module ? `:${module.replaceAll("/", ":")}:${sourceSet}` : sourceSet
}

export const runSuite: SuiteImpl = (suite, ctx, subset) =>
  Effect.gen(function*() {
    const sourceSet = suiteTask(suite.location)
    if (!sourceSet) return { command: [], exitCode: -1, runs: [], error: `can't map suite '${suite.name}' ("${suite.location}") to a Gradle test task; use src/<sourceSet>/**, **/src/<sourceSet>/** or <module>/src/<sourceSet>/**` }
    // A rerun selects test classes, and JUnit orders classes and methods randomly with the subset's seed.
    const classes = subset ? testClasses(subset) : []
    if (subset && classes.length === 0) return { command: [], exitCode: -1, runs: [], error: "no test classes to run again" }
    // With withCoverage the same run writes coverage too (gauntletCoverage runs after the tests), for the coverage gate.
    const coverage = ctx.withCoverage && !subset ? ["gauntletCoverage"] : []
    const r = ctx.fromCi ? FROM_CI : yield* gradle(ctx, [sourceSet, ...classes.flatMap((c) => ["--tests", c]), ...coverage], subset ? { GAUNTLET_JUNIT_SEED: String(subset.seed) } : {})
    if (!r.error && taskMissing(r.stderr, sourceSet)) return { ...base(r), error: `the build has no '${sourceSet}' test task` }
    const xml = yield* reports(ctx, (p) => (ctx.fromCi ? CI_JUNIT.test(p) : p.startsWith("junit/") && p.endsWith(".xml")))
    if (r.error || xml.length === 0) return base(r)
    const junit = yield* Effect.exit(convertJUnit(suite.name, xml.map((f) => ({ path: f.path, content: f.content }))))
    if (junit._tag === "Failure") return { ...base(r), error: "the JUnit XML couldn't be read" }
    return { ...base(r), runs: [junit.value.run], tests: { counts: junit.value.counts, ids: junit.value.tests.map((t) => t.id) } }
  })

// ---------- lint: detekt plus the zones' Kotlin rules ----------

export const lint: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const env: Record<string, string> = {}
    // detekt's own baseline comes from Gauntlet's legacy set, never the repository's file.
    const legacy = ctx.legacy.filter((e) => e.tool === "detekt")
    if (legacy.length > 0) {
      const file = path.join(path.dirname(ctx.outputDir), "detekt-baseline.xml")
      yield* fs.writeFileString(file, renderDetektBaseline(legacy)).pipe(Effect.orElseSucceed(() => undefined))
      env.GAUNTLET_DETEKT_BASELINE = file
    }
    const r = yield* gradle(ctx, ["detekt"], env)
    if (r.error) return base(r)
    const sarif = yield* reports(ctx, (p) => p.startsWith("detekt/") && p.endsWith(".sarif"))
    if (sarif.length === 0) {
      return taskMissing(r.stderr, "detekt")
        ? { ...base(r), error: "detekt isn't applied; add the dev.detekt Gradle plugin", notSetUp: true }
        : { ...base(r), error: "detekt wrote no report" }
    }
    const runs: Run[] = []
    for (const f of sarif) {
      const log = yield* Effect.option(decodeLog(f.content))
      if (Option.isSome(log)) runs.push(...log.value.runs.map((run) => ({ ...run, tool: { driver: { ...run.tool.driver, name: "detekt" } } })))
    }

    const zonesWithRules = ctx.ir.zones.filter((z) => z.rules.length > 0)
    const results: Result[] = []
    for (const zone of zonesWithRules) {
      const files = ctx.files.filter((p) => isKotlin(p) && zone.globs.some((g) => globMatches(g, p)) && (ctx.scope === undefined || ctx.scope.includes(p)))
      results.push(...runRules(zone.rules, yield* readFiles(ctx, files)))
    }
    const rulesRun: Run = { tool: { driver: { name: "kotlin-rules" } }, results }
    yield* writeSarif(ctx, "kotlin-rules.sarif", rulesRun)
    return { ...base(r), exitCode: 0, runs: [...runs, rulesRun] }
  })

// ---------- arch: import analysis ----------

/**
 * `module a must not depend on b`. A file belongs to a module when a path
 * segment or a segment of its package is the module's name. A violation is
 * an import of a package declared by files of the forbidden module.
 */
export const arch: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const sources = yield* readFiles(ctx, ctx.files.filter((p) => isMainSource(p) && isKotlin(p)))
    const withPackage = sources.map((s) => ({ ...s, pkg: packageOf(s.text) }))
    const belongs = (f: { path: string; pkg: string }, module: string) => f.path.split("/").includes(module) || f.pkg.split(".").includes(module)
    const results: Result[] = []
    for (const rule of ctx.ir.arch) {
      for (const target of rule.mustNotDependOn) {
        const forbidden = [...new Set(withPackage.filter((f) => belongs(f, target)).map((f) => f.pkg).filter((p) => p !== ""))]
        for (const f of withPackage.filter((x) => belongs(x, rule.module) && !belongs(x, target))) {
          for (const imp of ofType(parseKotlin(f.text).rootNode, "import")) {
            const name = imp.text.replace(/^import\s+/, "").replace(/\s+as\s+\w+$/, "").trim()
            if (forbidden.some((p) => name === p || name.startsWith(`${p}.`))) {
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
    const run: Run = { tool: { driver: { name: "kotlin-arch" } }, results }
    yield* writeSarif(ctx, "arch.sarif", run)
    return { command: ["gauntlet", "arch"], exitCode: 0, runs: [run] }
  })

// ---------- mutation: Pitest ----------

export const mutation: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const inScope = ctx.scope?.filter(isMainSource)
    if (inScope !== undefined && inScope.length === 0) {
      return { command: [], exitCode: 0, runs: [], nothingInScope: "no main classes in scope to mutate" }
    }
    const env: Record<string, string> = {}
    if (inScope) env.GAUNTLET_PITEST_TARGETS = (yield* readFiles(ctx, inScope)).flatMap((f) => pitestTargets(f.path, f.text)).join(",")
    const r = yield* gradle(ctx, ["pitest"], env)
    if (r.error) return base(r)
    const xml = yield* reports(ctx, (p) => p.startsWith("pitest/") && p.endsWith("mutations.xml"))
    if (xml.length === 0) {
      return taskMissing(r.stderr, "pitest") ? { ...base(r), error: "Pitest isn't applied; add the info.solidsoft.pitest Gradle plugin" } : base(r)
    }
    const locate = sourceIndex(ctx.files)
    const mutants = xml.flatMap((f) => parseMutations(f.content)).map((m) => {
      const pkg = m.className.includes(".") ? m.className.slice(0, m.className.lastIndexOf(".")).replace(/\./g, "/") : ""
      return { ...m, path: locate(pkg, m.sourceFile) }
    }).filter((m) => inScope === undefined || (m.path !== undefined && inScope.includes(m.path)))
    if (mutants.length === 0) return { ...base(r), nothingInScope: "Pitest generated no mutants for the code in scope" }
    const perFile: Record<string, number> = {}
    for (const p of [...new Set(mutants.flatMap((m) => m.path ?? []))].sort()) {
      const mine = mutants.filter((m) => m.path === p)
      perFile[p] = Math.round((mine.filter((m) => m.detected).length / mine.length) * 10000) / 100
    }
    const score = Math.round((mutants.filter((m) => m.detected).length / mutants.length) * 10000) / 100
    // Survivors, by line, so an agent knows exactly which assertions are missing.
    const survivors: Run = {
      tool: { driver: { name: "pitest" } },
      results: mutants.filter((m) => !m.detected).map((m) => ({
        ruleId: "mutation/survived",
        level: "warning",
        message: { text: `${m.status === "NO_COVERAGE" ? "No test covers" : "No test kills"} a mutant in ${m.className}` },
        ...(m.path ? { locations: [{ physicalLocation: { artifactLocation: { uri: m.path }, region: { startLine: m.line } } }] } : {}),
      })),
    }
    return { ...base(r), runs: [survivors], metrics: { mutation: { value: score, unit: "%", higherIsBetter: true, perFile } } }
  })

// ---------- coverage: the project's Kover, or Kover's agent (Kotlin) or JaCoCo (Java) ----------

export const coverage: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    // The init script defines gauntletCoverage in every JVM module (ADR 0007).
    const r = ctx.fromCi || ctx.coverageFromSuite ? FROM_CI : yield* gradle(ctx, ["test", "gauntletCoverage"])
    if (r.error) return base(r)
    const xml = yield* reports(ctx, (p) => (ctx.fromCi ? CI_COVERAGE.test(p) : (p.startsWith("kover/") || p.startsWith("jacoco/")) && p.endsWith(".xml")))
    if (xml.length === 0) {
      return taskMissing(r.stderr, "gauntletCoverage") ? { ...base(r), error: "no JVM module to measure: coverage needs the java or kotlin plugin" } : base(r)
    }
    const locate = sourceIndex(ctx.files)
    const files = xml.flatMap((f) => parseCoverage(f.content)).flatMap((c) => {
      const p = locate(c.packagePath, c.fileName)
      return p ? [{ path: p, lines: c.lines }] : []
    }).filter((f) => ctx.scope === undefined || ctx.scope.includes(f.path))
    const pct = (covered: number, total: number) => Math.round((covered / total) * 10000) / 100
    const perFile: Record<string, number> = {}
    for (const f of files) {
      const lines = [...f.lines.values()]
      if (lines.length > 0) perFile[f.path] = pct(lines.filter(Boolean).length, lines.length)
    }
    // `on changed` measures the changed lines themselves (PLAN Q6).
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
    if (total === 0) return { ...base(r), nothingInScope: ctx.scope ? "no executable changed lines" : "no executable lines were measured" }
    return { ...base(r), exitCode: 0, metrics: { coverage: { value: pct(covered, total), unit: "%", higherIsBetter: true, perFile } } }
  })

import type { GateContext, GateImpl, GateRun, SuiteImpl, TestSubset } from "@gauntlet/core"
import { compilerWarningsRun, excusedBySelection, failingToolSaid, type Mutant, mutationGateRun, mutationScopeOf, warningsGate } from "@gauntlet/core"
import { availableParallelism } from "node:os"
import { globMatches } from "@gauntlet/dsl"
import { prettyCanonicalJson } from "@gauntlet/ir"
import { convertJUnit, skippedOf, decodeLog, type Log, type Result, type Run, renderDetektBaseline, SARIF_SCHEMA, SARIF_VERSION, type TestMap } from "@gauntlet/sarif"
import { Effect, FileSystem, Option, Path } from "effect"
import { detektDeadCode, enabledDeadCodeRules } from "./deadcode.ts"
import { gradle, type GradleRun, taskMissing } from "./gradle.ts"
import { runRules } from "./kotlin/rules.ts"
import { isKotlin, line, ofType, parseKotlin } from "./kotlin/syntax.ts"
import { parseCoverage, parseMutations, pitestMethodName } from "./reports.ts"
import { FILTER_BYTES, FILTER_CLASS, FILTER_FEATURE } from "./pitest-filter.ts"
import { isMainSource, packageOf, pitestExclusions, pitestLines, pitestTargets, pitestTasks, sourceIndex } from "./sources.ts"
import { includesFor, isSource, testMapOf } from "./test-map.ts"
import { LISTENER_BYTES, LISTENER_CLASS } from "./testmap-listener.ts"

// The JVM pack's gates. Each runs its tool through Gradle (or parses Kotlin
// itself), reads only the reports written into the check's output directory,
// and hands SARIF and metrics to the gate runner, which decides the outcome.

/** Reports the project's own CI wrote (ADR 0024): Gradle's JUnit results, and Kover's or JaCoCo's XML. */
const CI_JUNIT = /(^|\/)build\/test-results\/[^/]+\/[^/]+\.xml$/
const CI_COVERAGE = /(^|\/)build\/reports\/(kover\/(xml\/|project-xml\/)?report|jacoco\/[^/]+\/[^/]+)\.xml$/
/** Stands in for a Gradle run when the CI already ran it. */
const FROM_CI: GradleRun = { command: ["ci"], exitCode: 0, stderr: "" }

const base = (r: GradleRun): GateRun => ({ command: r.command, exitCode: r.exitCode, runs: [], ...(r.error ? { error: r.error } : {}), ...failingToolSaid(r, gradleWentWrong) })

/** Gradle's "What went wrong" block: the rest of its failure text is advice ("Run with --stacktrace"). */
export const gradleWentWrong = (lines: ReadonlyArray<string>) => {
  const start = lines.findIndex((l) => l === "* What went wrong:")
  if (start < 0) return []
  const end = lines.findIndex((l, i) => i > start && /^\* (Try|Exception is|Get more help):?/.test(l))
  return lines.slice(start + 1, end < 0 ? undefined : end).filter((l) => !/^BUILD FAILED/.test(l))
}

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

/** Compiles main and test code at warning level, keeping kotlinc's and javac's warnings for the warnings check (spec 0010). */
export const build: GateImpl = (_check, ctx) =>
  gradle(ctx, ["classes", "testClasses"], {}, { warnings: true }).pipe(Effect.map((r: GradleRun) => {
    const out = `${r.stdout ?? ""}\n${r.stderr}`
    return { ...base(r), runs: [compilerWarningsRun("kotlinc", out, ctx.dir), compilerWarningsRun("javac", out, ctx.dir)] }
  }))

/** Compiler warnings, ratcheted with `warnings ratchet`: the build's, or a compile of its own when no build ran. */
export const warnings: GateImpl = warningsGate((ctx) => build({ kind: "gate", name: "build" } as never, ctx))

// ---------- suites ----------

/** Test classes a subset names: by name, from test ids (`svc.FxTest.rounds`) and from files (`src/test/kotlin/svc/FxTest.kt`). */
export const testClasses = (subset: TestSubset): string[] => [...new Set([
  ...(subset.classes ?? []),
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
    // The tests a change affects (spec 0013) are selected the same way, but run in the usual order.
    const classes = subset ? testClasses(subset) : []
    if (subset && classes.length === 0) return { command: [], exitCode: -1, runs: [], error: "no test classes to run again" }
    // With withCoverage the same run writes coverage too (gauntletCoverage runs after the tests), for the coverage gate.
    const coverage = ctx.withCoverage && (!subset || subset.affected) ? ["gauntletCoverage"] : []
    const env: Record<string, string> = subset?.affected ? { GAUNTLET_SELECTED: "1" } : subset ? { GAUNTLET_JUNIT_SEED: String(subset.seed) } : {}
    const r = ctx.fromCi ? FROM_CI : yield* gradle(ctx, [sourceSet, ...classes.flatMap((c) => ["--tests", c]), ...coverage], env)
    if (!r.error && taskMissing(r.stderr, sourceSet)) return { ...base(r), error: `the build has no '${sourceSet}' test task` }
    const xml = yield* reports(ctx, (p) => (ctx.fromCi ? CI_JUNIT.test(p) : p.startsWith("junit/") && p.endsWith(".xml")))
    if (r.error || xml.length === 0) return base(r)
    const junit = yield* Effect.exit(convertJUnit(suite.name, xml.map((f) => ({ path: f.path, content: f.content }))))
    if (junit._tag === "Failure") return { ...base(r), error: "the JUnit XML couldn't be read" }
    const ids = junit.value.tests.map((t) => t.id)
    const mapped = ctx.recordTestMap && !subset && !ctx.fromCi ? yield* mapTests(ctx, sourceSet, ids) : undefined
    return {
      ...base(r), runs: [junit.value.run], tests: { counts: junit.value.counts, ids, ...skippedOf(junit.value.tests) },
      ...(mapped && "map" in mapped ? { testMap: mapped.map } : mapped ? { testMapMissing: mapped.why } : {}),
    }
  })

/**
 * A baseline's map of what each test class executes (spec 0013): the suite
 * runs once more with JaCoCo's agent and Gauntlet's listener, into its own
 * directory beside the suite's so the suite's proof stays its own. When the
 * map can't be trusted (two test classes ran at once, the listener couldn't
 * read the agent, a test the suite ran has no data) it says why instead.
 */
const mapTests = (ctx: GateContext, sourceSet: string, ids: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const missing = (why: string): { readonly why: string } => ({ why })
    const out = `${ctx.outputDir}-testmap`
    const listener = path.join(path.dirname(ctx.outputDir), "gauntlet-testmap")
    const ready = yield* Effect.exit(Effect.gen(function*() {
      yield* fs.makeDirectory(out, { recursive: true })
      yield* fs.makeDirectory(path.join(listener, "gauntlet"), { recursive: true })
      yield* fs.makeDirectory(path.join(listener, "META-INF/services"), { recursive: true })
      yield* fs.writeFile(path.join(listener, "gauntlet/TestMapListener.class"), Uint8Array.from(atob(LISTENER_BYTES), (c) => c.charCodeAt(0)))
      yield* fs.writeFileString(path.join(listener, "META-INF/services/org.junit.platform.launcher.TestExecutionListener"), `${LISTENER_CLASS}\n`)
    }))
    if (ready._tag === "Failure") return missing("Gauntlet's test listener couldn't be written next to the output directory")
    const sources = yield* readFiles(ctx, ctx.files.filter(isSource))
    const includes = includesFor(sources)
    const r = yield* gradle({ ...ctx, outputDir: out }, [sourceSet], { GAUNTLET_TEST_MAP: listener, ...(includes ? { GAUNTLET_TEST_MAP_INCLUDES: includes } : {}) })
    if (r.error) return missing(`the mapping run of the tests couldn't run: ${r.error}`)
    // Gradle's own last words, for a run that wrote no data: a missing JaCoCo agent, a failed compile.
    const exited = r.exitCode === 0 ? "" : ` (Gradle exited with ${r.exitCode}: ${r.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300)})`
    const written = yield* fs.readDirectory(path.join(out, "testmap"), { recursive: true }).pipe(Effect.orElseSucceed(() => [] as string[]))
    const marker = (name: string) => written.find((f) => path.basename(f) === name)
    const said = (f: string) => fs.readFileString(path.join(out, "testmap", f)).pipe(Effect.orElseSucceed(() => ""), Effect.map((t) => t.trim().slice(0, 300)))
    const overlap = marker("overlap")
    if (overlap !== undefined) return missing(`test classes ran at the same time (${yield* said(overlap)}), so what each executed can't be told apart`)
    const failed = marker("failed")
    if (failed !== undefined) return missing(`the listener couldn't read JaCoCo's data (${yield* said(failed)})`)
    const execs: { testClass: string; bytes: Uint8Array }[] = []
    for (const f of written.filter((w) => w.endsWith(".exec")).sort()) {
      const bytes = yield* fs.readFile(path.join(out, "testmap", f)).pipe(Effect.option)
      if (Option.isNone(bytes)) return missing(`JaCoCo's data in ${path.basename(f)} couldn't be read`)
      execs.push({ testClass: path.basename(f).replace(/(\.\d+)?\.exec$/, ""), bytes: bytes.value })
    }
    const map: TestMap | undefined = testMapOf(execs, sources)
    if (map === undefined) return missing("JaCoCo's data couldn't be read: a file isn't execution data")
    // Every test the suite ran must belong to a mapped class, or selection would leave it out unexcused.
    const covered = new Set(excusedBySelection(ids, Object.keys(map)))
    const unmapped = ids.filter((id) => !covered.has(id))
    if (unmapped.length > 0) return missing(`${unmapped.length} ${unmapped.length === 1 ? "test the suite ran has" : "tests the suite ran have"} no data, such as ${unmapped[0]}${exited}`)
    return { map }
  })

// ---------- lint: detekt plus the zones' Kotlin rules ----------

/** Runs detekt into the output directory and reads its SARIF; or the gate's error when it couldn't. */
const runDetekt = (ctx: GateContext) =>
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
    if (r.error) return { failed: base(r) } as const
    const sarif = yield* reports(ctx, (p) => p.startsWith("detekt/") && p.endsWith(".sarif"))
    if (sarif.length === 0) {
      return {
        failed: taskMissing(r.stderr, "detekt")
          ? { ...base(r), error: "detekt isn't applied; add the dev.detekt Gradle plugin", notSetUp: true as const }
          : { ...base(r), error: "detekt wrote no report" },
      } as const
    }
    const runs: Run[] = []
    const unread: string[] = []
    for (const f of sarif) {
      const log = yield* Effect.option(decodeLog(f.content))
      if (Option.isSome(log)) runs.push(...log.value.runs.map((run) => ({ ...run, tool: { driver: { ...run.tool.driver, name: "detekt" } } })))
      else unread.push(f.path)
    }
    return { r, runs, reports: sarif.map((f) => f.content), unread } as const
  })

export const lint: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const detekt = yield* runDetekt(ctx)
    if ("failed" in detekt) return detekt.failed
    const { r, runs } = detekt

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

// ---------- dead-code: detekt's unused rules ----------

/**
 * Unused private classes, functions and properties, parameters, variables
 * and imports, and unreachable code, from detekt with the project's own
 * configuration (spec 0017 §4): the run lint makes, kept to those rules.
 */
export const deadCode: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const detekt = yield* runDetekt(ctx)
    if ("failed" in detekt) return detekt.failed
    if (detekt.unread.length > 0) return { ...base(detekt.r), error: `detekt's SARIF report couldn't be read: ${detekt.unread[0]}` }
    // A detekt that runs none of its unused rules can't find any: that's not a pass.
    if (enabledDeadCodeRules(detekt.reports)?.length === 0) return { ...base(detekt.r), error: "detekt ran none of its unused rules: turn on UnusedPrivateClass, UnusedPrivateFunction, UnusedPrivateProperty, UnusedParameter, UnusedVariable or UnusedImport in its configuration", notSetUp: true }
    const run = detektDeadCode(detekt.runs)
    yield* writeSarif(ctx, "dead-code.sarif", run)
    return { ...base(detekt.r), exitCode: 0, runs: [run] }
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
    const env: Record<string, string> = { GAUNTLET_PITEST_THREADS: String(availableParallelism()), ...(ctx.recordKillMap ? { GAUNTLET_PITEST_MATRIX: "true" } : {}) }
    // Spec 0019 §4: container fixtures that opt into Testcontainers' reuse share one container across Pitest's JVMs,
    // unless the environment already says otherwise.
    if (process.env.TESTCONTAINERS_REUSE_ENABLE === undefined) env.TESTCONTAINERS_REUSE_ENABLE = "true"
    if (inScope) {
      const sources = yield* readFiles(ctx, inScope)
      env.GAUNTLET_PITEST_TARGETS = sources.flatMap((f) => pitestTargets(f.path, f.text)).join(",")
      const lines = mutationScopeOf(ctx).changedLines
      if (lines) {
        env.GAUNTLET_PITEST_EXCLUDED_METHODS = pitestExclusions(sources, lines).join(",")
        Object.assign(env, yield* changedLinesFilter(ctx, pitestLines(sources, lines)))
      }
    }
    // Spec 0019 §3: only the touched modules' tasks, or the root task when Gradle can't find one of them.
    const tasks = inScope ? pitestTasks(inScope) : []
    const touched = tasks.length > 0 ? yield* gradle(ctx, tasks, env) : undefined
    const r = touched && !(touched.exitCode !== 0 && tasks.some((t) => taskMissing(touched.stderr, t))) ? touched : yield* gradle(ctx, ["pitest"], env)
    if (r.error) return base(r)
    const xml = yield* reports(ctx, (p) => p.startsWith("pitest/") && p.endsWith("mutations.xml"))
    if (xml.length === 0) {
      return taskMissing(r.stderr, "pitest") ? { ...base(r), error: "Pitest isn't applied; add the info.solidsoft.pitest Gradle plugin" } : base(r)
    }
    const locate = sourceIndex(ctx.files)
    const mutants = xml.flatMap((f) => parseMutations(f.content)).map((m): Mutant => {
      const pkg = m.className.includes(".") ? m.className.slice(0, m.className.lastIndexOf(".")).replace(/\./g, "/") : ""
      return {
        path: locate(pkg, m.sourceFile), line: m.line, killed: m.detected, message: `${m.status === "NO_COVERAGE" ? "No test covers" : "No test kills"} a mutant in ${m.className}`,
        ...(m.killingTests ? { killedBy: m.killingTests, coveredBy: [...m.killingTests, ...(m.succeedingTests ?? [])] } : {}),
        ...(m.method !== undefined ? { method: pitestMethodName(m.className, m.method) } : {}),
        ...(m.description !== undefined ? { description: m.description } : {}),
      }
    })
    // Survivors, by line, so an agent knows exactly which assertions are missing.
    return { ...base(r), ...mutationGateRun("pitest", mutants, ctx) }
  })

/**
 * Gauntlet's Pitest filter (spec 0019 §1), beside the check's output directory: its class and ServiceLoader entry,
 * which the init script puts on Pitest's classpath, and the file of lines it keeps.
 */
const changedLinesFilter = (ctx: GateContext, lines: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = path.join(path.dirname(ctx.outputDir), "gauntlet-pitest")
    const file = path.join(path.dirname(ctx.outputDir), "gauntlet-pitest-lines.txt")
    const written = yield* Effect.exit(Effect.gen(function*() {
      yield* fs.makeDirectory(path.join(dir, "gauntlet"), { recursive: true })
      yield* fs.makeDirectory(path.join(dir, "META-INF/services"), { recursive: true })
      yield* fs.writeFile(path.join(dir, "gauntlet/ChangedLines.class"), Uint8Array.from(atob(FILTER_BYTES), (c) => c.charCodeAt(0)))
      yield* fs.writeFileString(path.join(dir, "META-INF/services/org.pitest.mutationtest.build.MutationInterceptorFactory"), `${FILTER_CLASS}\n`)
      yield* fs.writeFileString(file, lines.map((l) => `${l}\n`).join(""))
    }))
    // Without the filter Pitest mutates whole classes, and core's filter by line still scores the same.
    return written._tag === "Success" ? { GAUNTLET_PITEST_FILTER: dir, GAUNTLET_PITEST_FEATURE: `+${FILTER_FEATURE}(file[${file}])` } : {}
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
    const perFileTotal: Record<string, number> = {}
    for (const f of files) {
      const lines = [...f.lines.values()]
      if (lines.length === 0) continue
      perFile[f.path] = pct(lines.filter(Boolean).length, lines.length)
      perFileTotal[f.path] = lines.length
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
    return { ...base(r), exitCode: 0, metrics: { coverage: { value: pct(covered, total), unit: "%", higherIsBetter: true, perFile, perFileTotal } } }
  })

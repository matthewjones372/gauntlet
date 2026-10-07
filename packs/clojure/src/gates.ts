import type { GateContext, GateImpl, GateRun, SuiteImpl, TestSubset } from "@gauntlet/core"
import { globMatches } from "@gauntlet/dsl"
import { prettyCanonicalJson } from "@gauntlet/ir"
import { convertJUnit, type Log, type Result, type Run, SARIF_SCHEMA, SARIF_VERSION } from "@gauntlet/sarif"
import { Effect, FileSystem, Option, Path } from "effect"
import { convertKondo, focusOf, parseLcov, tidyJUnit } from "./reports.ts"
import { runRules } from "./rules.ts"
import { head, nsOf, read } from "./syntax.ts"
import { buildTool, CLOVERAGE, command, isClojure, isMainSource, isTestFile, KAOCHA, nsOfPath, run, sourceRoots, testRoots, type ToolRun } from "./toolchain.ts"

// The Clojure pack's gates. Each runs once in the judged checkout, with the
// project's own build tool and Gauntlet's pinned runners, writing its report
// into the check's output directory (ADR 0012). There is no mutation gate:
// Clojure has no mature mutation tool, so a policy's `mutation` is reported
// not executed (missing evidence) by the gate runner.

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

/** The first line that explains a failure: a syntax error, an exception, or Leiningen's own complaint. */
const reason = (r: ToolRun) =>
  `${r.stderr}\n${r.stdout}`.split("\n").map((l) => l.trim()).find((l) => /Syntax error|Exception|Could not (find|resolve)|Error building classpath|Unable to resolve|^Error:/i.test(l)) ?? ""

/** The project's build tool and whether its deps.edn has a :test alias; or why it can't be run. */
const project = (ctx: GateContext) =>
  Effect.gen(function*() {
    const tool = buildTool(ctx.files)
    if (!tool) return { blocked: failed([], "no deps.edn or project.clj at the repository root") }
    const deps = tool === "deps" ? (yield* readFiles(ctx, ["deps.edn"]))[0]?.text ?? "" : ""
    return { tool, hasTestAlias: /:test\s+\{/.test(deps) }
  })

/** Every namespace the project declares, main and test, from ns forms (or paths, for a file without one). */
const namespaces = (files: ReadonlyArray<{ readonly path: string; readonly text: string }>) =>
  [...new Set(files.map((f) => nsOf(read(f.text))?.name || nsOfPath(f.path)))].sort()

// ---------- build: load every namespace ----------

export const build: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const p = yield* project(ctx)
    if (p.blocked) return p.blocked
    const sources = yield* readFiles(ctx, ctx.files.filter((f) => isMainSource(f) || isTestFile(f)))
    if (sources.length === 0) return failed([], "no Clojure sources to load")
    const r = yield* run(ctx, command(ctx, p.tool, p.hasTestAlias, [], "clojure.main", ["-e", `(doseq [n '[${namespaces(sources).join(" ")}]] (require n))`]))
    // A namespace that doesn't load is a failed build (its exit code), not a tool error.
    return base(r)
  })

// ---------- suites: kaocha with its JUnit plugin ----------

export const runSuite: SuiteImpl = (suite, ctx, subset?: TestSubset) =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const p = yield* project(ctx)
    if (p.blocked) return p.blocked
    const tests = yield* readFiles(ctx, ctx.files.filter(isTestFile))
    const known = namespaces(tests)
    const focus = subset
      ? [...new Set([
        ...tests.filter((t) => subset.files.includes(t.path)).map((t) => nsOf(read(t.text))?.name || nsOfPath(t.path)),
        ...subset.ids.flatMap((id) => Option.toArray(Option.fromUndefinedOr(focusOf(id, known)))),
      ])].sort()
      : []
    if (subset && focus.length === 0) return failed(["kaocha"], "no tests to run again")
    const junit = path.join(ctx.outputDir, "junit.xml")
    const r = yield* run(ctx, command(ctx, p.tool, p.hasTestAlias, KAOCHA, "kaocha.runner", [
      "--no-color",
      // A fixed order normally; reruns shuffle with the seed derived from the head commit.
      ...(subset ? ["--seed", String(subset.seed)] : ["--no-randomize"]),
      "--plugin", "kaocha.plugin/junit-xml", "--junit-xml-file", junit,
      ...focus.flatMap((f) => ["--focus", f]),
    ]))
    if (r.error) return base(r)
    const xml = (yield* reports(ctx, (f) => f === "junit.xml"))[0]
    if (!xml) return { ...base(r), ...(r.exitCode !== 0 ? { error: `kaocha failed before any test ran: ${reason(r)}` } : {}) }
    const report = yield* Effect.exit(convertJUnit(suite.name, [{ path: xml.path, content: tidyJUnit(xml.content) }]))
    if (report._tag === "Failure") return { ...base(r), error: "the JUnit XML couldn't be read" }
    return { ...base(r), runs: [report.value.run], tests: { counts: report.value.counts, ids: report.value.tests.map((t) => t.id) } }
  })

// ---------- lint: clj-kondo, plus the zones' Clojure rules ----------

export const lint: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const roots = [...new Set([...sourceRoots(ctx.files), ...testRoots(ctx.files)])].filter((r) => ctx.files.some((f) => f.startsWith(`${r}/`)))
    const r = yield* run(ctx, ["clj-kondo", "--lint", ...roots, "--config", "{:output {:format :json}}", "--parallel"])
    if (r.error) return { ...base(r), error: "clj-kondo isn't installed (https://github.com/clj-kondo/clj-kondo/blob/master/doc/install.md)" }
    // 0 is clean, 2 warnings, 3 errors; anything else means it couldn't lint.
    if (![0, 2, 3].includes(r.exitCode)) return { ...base(r), error: `clj-kondo couldn't lint the code: ${r.stderr.trim().split("\n")[0] ?? ""}` }
    yield* fs.writeFileString(path.join(ctx.outputDir, "clj-kondo.json"), r.stdout).pipe(Effect.orElseSucceed(() => undefined))
    const file = (yield* reports(ctx, (f) => f === "clj-kondo.json"))[0]
    const kondo = file ? convertKondo(file.content, ctx.dir) : Option.none<Run>()
    if (Option.isNone(kondo)) return { ...base(r), error: "clj-kondo's output couldn't be read" }
    const results: Result[] = []
    for (const zone of ctx.ir.zones.filter((z) => z.rules.length > 0)) {
      const files = ctx.files.filter((p) => isMainSource(p) && zone.globs.some((g) => globMatches(g, p)) && (ctx.scope === undefined || ctx.scope.includes(p)))
      results.push(...runRules(zone.rules, yield* readFiles(ctx, files)))
    }
    const rulesRun: Run = { tool: { driver: { name: "clojure-rules" } }, results }
    yield* writeSarif(ctx, "clj-kondo.sarif", kondo.value)
    yield* writeSarif(ctx, "clojure-rules.sarif", rulesRun)
    return { ...base(r), exitCode: 0, runs: [kondo.value, rulesRun] }
  })

// ---------- arch: ns :require ----------

export const arch: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const sources = yield* readFiles(ctx, ctx.files.filter(isMainSource))
    const results: Result[] = []
    for (const rule of ctx.ir.arch) {
      for (const target of rule.mustNotDependOn) {
        for (const f of sources) {
          const ns = nsOf(read(f.text))
          const own = (ns?.name || nsOfPath(f.path)).split(".")
          if (!own.includes(rule.module) || own.includes(target)) continue
          for (const req of ns?.requires ?? []) {
            if (!req.lib.split(".").includes(target)) continue
            results.push({
              ruleId: `arch/${rule.module}-must-not-depend-on-${target}`,
              level: "error",
              message: { text: `${rule.module} requires ${req.lib}, which belongs to ${target}.` },
              locations: [{ physicalLocation: { artifactLocation: { uri: f.path }, region: { startLine: req.line } } }],
            })
          }
        }
      }
    }
    const run: Run = { tool: { driver: { name: "clojure-arch" } }, results }
    yield* writeSarif(ctx, "arch.sarif", run)
    return { command: ["gauntlet", "arch"], exitCode: 0, runs: [run] }
  })

// ---------- coverage: cloverage ----------

const COMMENT_OR_BLANK = /^\s*($|;)/

export const coverage: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const p = yield* project(ctx)
    if (p.blocked) return p.blocked
    const out = path.join(ctx.outputDir, "coverage")
    const r = yield* run(ctx, command(ctx, p.tool, p.hasTestAlias, CLOVERAGE, "cloverage.coverage", [
      ...sourceRoots(ctx.files).flatMap((s) => ["-p", s]),
      ...testRoots(ctx.files).flatMap((t) => ["-s", t]),
      "--lcov", "--no-html", "--no-text", "-o", out,
    ]))
    if (r.error) return base(r)
    const lcov = (yield* reports(ctx, (f) => f === "coverage/lcov.info"))[0]
    if (!lcov) return { ...base(r), error: `cloverage wrote no lcov report (do the tests load and pass?): ${reason(r)}` }
    const scoped = ctx.scope?.filter(isMainSource)
    const files = parseLcov(lcov.content, ctx.dir).filter((f) => isClojure(f.path) && (ctx.scope === undefined || ctx.scope.includes(f.path)))
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
    // A changed namespace with functions the report doesn't mention counts as uncovered, not unmeasured.
    const withCode = new Set((yield* readFiles(ctx, (scoped ?? []).filter((s) => !files.some((f) => f.path === s))))
      .filter((f) => read(f.text).some((form) => /^defn-?$/.test(head(form)))).map((f) => f.path))
    for (const s of scoped ?? []) {
      if (files.some((f) => f.path === s) || !withCode.has(s)) continue
      const uncovered = (ctx.facts.addedLines.get(s) ?? []).filter((l) => !COMMENT_OR_BLANK.test(l.text)).length
      total += uncovered
      if (uncovered > 0) perFile[s] = 0
    }
    if (total === 0) return { ...base(r), exitCode: 0, nothingInScope: ctx.scope ? "no executable changed lines" : "no executable lines were measured" }
    return { ...base(r), exitCode: 0, metrics: { coverage: { value: pct(covered, total), unit: "%", higherIsBetter: true, perFile } } }
  })

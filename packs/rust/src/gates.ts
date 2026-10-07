import type { GateContext, GateImpl, GateRun, SuiteImpl, TestSubset } from "@gauntlet/core"
import { globMatches } from "@gauntlet/dsl"
import { prettyCanonicalJson } from "@gauntlet/ir"
import { convertJUnit, type Log, type Result, type Run, SARIF_SCHEMA, SARIF_VERSION } from "@gauntlet/sarif"
import { Effect, FileSystem, Option, Path } from "effect"
import { convertClippy, parseLcov, parseMutants } from "./reports.ts"
import { runRules } from "./rules.ts"
import { inTestModule, line, ofType, parseRust } from "./syntax.ts"
import { ensureFetched, exec, hasSubcommand, isMainSource, isRust, isTestFile, locked, modulePath, type ToolRun } from "./toolchain.ts"

// The Rust pack's gates. Each fetches dependencies once per check, runs Cargo
// in the judged checkout, and reads only what lands in the check's output
// directory (ADR 0012).

const base = (r: ToolRun): GateRun => ({ command: [...r.command], exitCode: r.exitCode, runs: [], ...(r.error ? { error: r.error } : {}) })
const failed = (command: ReadonlyArray<string>, error: string): GateRun => ({ command, exitCode: -1, runs: [], error })

const prepared = (ctx: GateContext, gate: string) =>
  ensureFetched(ctx).pipe(Effect.map((m) => (Option.isSome(m) ? failed([gate], m.value) : undefined)))

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

// ---------- build: every target, tests included ----------

export const build: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const blocked = yield* prepared(ctx, "cargo build")
    if (blocked) return blocked
    return base(yield* exec(ctx, ["cargo", "build", "--workspace", "--all-targets", ...locked(ctx)]))
  })

// ---------- suites: cargo-nextest ----------

/**
 * Gauntlet's own nextest configuration, written next to the output
 * directories: JUnit into the output directory, no retries and no fail-fast,
 * whatever the project's .config/nextest.toml says.
 */
const nextestConfig = (ctx: GateContext) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const file = path.join(path.dirname(ctx.outputDir), `${path.basename(ctx.outputDir)}-nextest.toml`)
    yield* fs.writeFileString(file, `[profile.default]\nretries = 0\nfail-fast = false\n\n[profile.default.junit]\npath = ${JSON.stringify(path.join(ctx.outputDir, "junit.xml"))}\n`)
    return file
  })

/** The nextest filter a rerun needs: integration test binaries for files under tests/, module paths for source files, exact names for test ids. */
export const subsetFilter = (subset: TestSubset): string | undefined => {
  const parts = [
    ...subset.files.filter(isTestFile).map((f) => `binary(=${f.split("/").pop()!.replace(/\.rs$/, "")})`),
    ...subset.files.filter((f) => isRust(f) && !isTestFile(f)).map((f) => (modulePath(f) === "" ? "kind(lib)" : `test(/^${modulePath(f).replaceAll("::", "::")}::/)`)),
    ...subset.ids.map((id) => `test(=${id.slice(id.indexOf(".") + 1)})`),
  ]
  return parts.length > 0 ? [...new Set(parts)].sort().join(" | ") : undefined
}

export const runSuite: SuiteImpl = (suite, ctx, subset) =>
  Effect.gen(function*() {
    const blocked = yield* prepared(ctx, "cargo nextest")
    if (blocked) return blocked
    if (!(yield* hasSubcommand(ctx, "nextest"))) return failed(["cargo", "nextest"], "cargo-nextest isn't installed (cargo install --locked cargo-nextest)")
    const filter = subset ? subsetFilter(subset) : undefined
    if (subset && !filter) return failed(["cargo", "nextest"], "no tests to run again")
    const config = yield* Effect.option(nextestConfig(ctx))
    if (Option.isNone(config)) return failed(["cargo", "nextest"], "couldn't write the nextest configuration")
    // nextest runs every test in its own process, so order can't be shuffled; reruns vary the parallelism instead.
    const r = yield* exec(ctx, ["cargo", "nextest", "run", "--workspace", "--no-fail-fast", "--config-file", config.value, ...locked(ctx),
      ...(subset ? [`--test-threads=${(subset.seed % 4) + 1}`] : []), ...(filter ? ["-E", filter] : [])])
    if (r.error) return base(r)
    const xml = yield* reports(ctx, (p) => p.endsWith(".xml"))
    if (xml.length === 0) return base(r)
    const junit = yield* Effect.exit(convertJUnit(suite.name, xml.map((f) => ({ path: f.path, content: f.content }))))
    if (junit._tag === "Failure") return { ...base(r), error: "the JUnit XML couldn't be read" }
    return { ...base(r), runs: [junit.value.run], tests: { counts: junit.value.counts, ids: junit.value.tests.map((t) => t.id) } }
  })

// ---------- lint: clippy, plus the zones' Rust rules ----------

export const lint: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const blocked = yield* prepared(ctx, "cargo clippy")
    if (blocked) return blocked
    const r = yield* exec(ctx, ["cargo", "clippy", "--workspace", "--all-targets", "--message-format=json", ...locked(ctx)])
    if (r.error) return base(r)
    if (r.exitCode !== 0) return { ...base(r), error: `clippy couldn't check the code: ${r.stderr.trim().split("\n").filter((l) => l.startsWith("error")).at(0) ?? r.stderr.trim().split("\n").at(-1) ?? ""}` }
    yield* writeOut(ctx, "clippy.json", r.stdout)
    const file = (yield* reports(ctx, (p) => p === "clippy.json"))[0]
    if (!file) return { ...base(r), error: "clippy wrote no messages" }
    const clippy = convertClippy(file.content, ctx.dir)
    const results: Result[] = []
    for (const zone of ctx.ir.zones.filter((z) => z.rules.length > 0)) {
      const files = ctx.files.filter((p) => isMainSource(p) && zone.globs.some((g) => globMatches(g, p)) && (ctx.scope === undefined || ctx.scope.includes(p)))
      results.push(...runRules(zone.rules, yield* readFiles(ctx, files)))
    }
    const rulesRun: Run = { tool: { driver: { name: "rust-rules" } }, results }
    yield* writeSarif(ctx, "clippy.sarif", clippy)
    yield* writeSarif(ctx, "rust-rules.sarif", rulesRun)
    return { ...base(r), exitCode: 0, runs: [clippy, rulesRun] }
  })

// ---------- arch: use declarations ----------

export const arch: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const sources = yield* readFiles(ctx, ctx.files.filter(isMainSource))
    const results: Result[] = []
    for (const rule of ctx.ir.arch) {
      for (const target of rule.mustNotDependOn) {
        for (const f of sources) {
          const own = modulePath(f.path).split("::")
          if (!own.includes(rule.module) || own.includes(target)) continue
          const root = parseRust(f.text).rootNode
          for (const u of ofType(root, "use_declaration").filter((u) => !inTestModule(u))) {
            // `use crate::infra::ledger` or `use super::super::infra`: a path segment names the target.
            const segments = u.text.replace(/^(pub(\([^)]*\))?\s+)?use\s+/, "").replace(/;$/, "").split(/::|\{|\}|,|\s+/).filter((s) => s !== "")
            if (segments.includes(target)) {
              results.push({
                ruleId: `arch/${rule.module}-must-not-depend-on-${target}`,
                level: "error",
                message: { text: `${rule.module} uses ${u.text.replace(/^(pub(\([^)]*\))?\s+)?use\s+/, "").replace(/;$/, "")}, which belongs to ${target}.` },
                locations: [{ physicalLocation: { artifactLocation: { uri: f.path }, region: { startLine: line(u) } } }],
              })
            }
          }
        }
      }
    }
    const run: Run = { tool: { driver: { name: "rust-arch" } }, results }
    yield* writeSarif(ctx, "arch.sarif", run)
    return { command: ["gauntlet", "arch"], exitCode: 0, runs: [run] }
  })

// ---------- mutation: cargo-mutants ----------

export const mutation: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const inScope = ctx.scope?.filter(isMainSource)
    if (inScope !== undefined && inScope.length === 0) return { command: [], exitCode: 0, runs: [], nothingInScope: "no main Rust files in scope to mutate" }
    const blocked = yield* prepared(ctx, "cargo mutants")
    if (blocked) return blocked
    if (!(yield* hasSubcommand(ctx, "mutants"))) return failed(["cargo", "mutants"], "cargo-mutants isn't installed (cargo install --locked cargo-mutants)")
    // cargo-mutants copies the tree to its own scratch directory and writes mutants.out into the output directory.
    // It builds mutated code, so it never shares a target directory: other gates would test the last mutant.
    const path = yield* Path.Path
    const r = yield* exec(ctx, ["cargo", "mutants", "--no-shuffle", "--output", ctx.outputDir, ...(inScope ?? []).flatMap((p) => ["--file", p])],
      { CARGO_TARGET_DIR: path.join(path.dirname(ctx.outputDir), "cargo-target-mutants") })
    if (r.error) return base(r)
    const file = (yield* reports(ctx, (p) => p === "mutants.out/outcomes.json"))[0]
    if (!file) return { ...base(r), error: `cargo-mutants wrote no outcomes${r.stderr.trim() ? `: ${r.stderr.trim().split("\n").at(-1)}` : ""}` }
    const mutants = Option.getOrElse(parseMutants(file.content), () => [])
    const counted = mutants.filter((m) => m.outcome !== "other" && (inScope === undefined || inScope.includes(m.path)))
    if (counted.length === 0) return { ...base(r), exitCode: 0, nothingInScope: "cargo-mutants generated no mutants for the code in scope" }
    const detected = (ms: typeof counted) => ms.filter((m) => m.outcome === "killed" || m.outcome === "timeout").length
    const pct = (ms: typeof counted) => Math.round((detected(ms) / ms.length) * 10000) / 100
    const perFile: Record<string, number> = {}
    for (const p of [...new Set(counted.map((m) => m.path))].sort()) perFile[p] = pct(counted.filter((m) => m.path === p))
    const survivors: Run = {
      tool: { driver: { name: "cargo-mutants" } },
      results: counted.filter((m) => m.outcome === "survived").sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line)).map((m) => ({
        ruleId: "mutation/survived",
        level: "warning",
        message: { text: `No test kills this mutant: ${m.description}` },
        locations: [{ physicalLocation: { artifactLocation: { uri: m.path }, region: { startLine: m.line } } }],
      })),
    }
    return { ...base(r), exitCode: 0, runs: [survivors], metrics: { mutation: { value: pct(counted), unit: "%", higherIsBetter: true, perFile } } }
  })

// ---------- coverage: cargo-llvm-cov ----------

const COMMENT_OR_BLANK = /^\s*($|\/\/)/

export const coverage: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const blocked = yield* prepared(ctx, "cargo llvm-cov")
    if (blocked) return blocked
    if (!(yield* hasSubcommand(ctx, "llvm-cov"))) return failed(["cargo", "llvm-cov"], "cargo-llvm-cov isn't installed (cargo install --locked cargo-llvm-cov, and rustup component add llvm-tools-preview)")
    const r = yield* exec(ctx, ["cargo", "llvm-cov", "--workspace", "--lcov", "--output-path", `${ctx.outputDir}/lcov.info`, ...locked(ctx)])
    if (r.error) return base(r)
    const lcov = (yield* reports(ctx, (p) => p === "lcov.info"))[0]
    if (!lcov) return { ...base(r), error: `cargo-llvm-cov wrote no lcov report (do the tests compile and pass?)` }
    const scoped = ctx.scope?.filter(isMainSource)
    const files = parseLcov(lcov.content, ctx.dir).filter((f) => isMainSource(f.path) && (ctx.scope === undefined || ctx.scope.includes(f.path)))
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
    // A changed file with functions the report doesn't mention counts as uncovered, not unmeasured.
    const withCode = new Set((yield* readFiles(ctx, (scoped ?? []).filter((p) => !files.some((f) => f.path === p))))
      .filter((f) => ofType(parseRust(f.text).rootNode, "function_item").some((fn) => !inTestModule(fn))).map((f) => f.path))
    for (const p of scoped ?? []) {
      if (files.some((f) => f.path === p) || !withCode.has(p)) continue
      const uncovered = (ctx.facts.addedLines.get(p) ?? []).filter((l) => !COMMENT_OR_BLANK.test(l.text)).length
      total += uncovered
      if (uncovered > 0) perFile[p] = 0
    }
    if (total === 0) return { ...base(r), exitCode: 0, nothingInScope: ctx.scope ? "no executable changed lines" : "no executable lines were measured" }
    return { ...base(r), exitCode: 0, metrics: { coverage: { value: pct(covered, total), unit: "%", higherIsBetter: true, perFile } } }
  })

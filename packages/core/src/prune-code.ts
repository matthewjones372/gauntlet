import { globMatches } from "@gauntlet/dsl"
import type { PolicyIR } from "@gauntlet/ir"
import type { Baseline } from "@gauntlet/sarif"
import { Effect, FileSystem, Option, Path } from "effect"
import { Git } from "./git.ts"
import { testPathMatcher } from "./integrity.ts"
import { PackRegistry } from "./pack-registry.ts"
import { holdoutsOf } from "./workspace.ts"

// `gauntlet prune code` (spec 0017 §5): code that could go, with why for
// each. Two sources, both read without running anything: the `dead-code`
// gate's findings the baseline recorded, and source files no test ran (the
// baseline's test map, spec 0013) whose public names nothing in the project
// mentions. It's a list for the owner: it never deletes and never affects a check.

/** A name a source file declares for other code to use. */
export interface Declared {
  readonly name: string
  readonly line: number
  /** What it is, in the language's words: `function`, `class`, `method`, `property`. */
  readonly kind: string
  /** The class or object it's a member of; it's listed only when that is named somewhere. */
  readonly in?: string
}

/** A source file as a pack reads it for `prune code`. */
export interface SurveyedSource {
  /** Its public declarations (functions, classes, methods), from the pack's grammar; empty when the pack reads files whole. */
  readonly declared: ReadonlyArray<Declared>
  /**
   * Why it's never listed: something outside the project's code may start it
   * (a `main`, a framework annotation, a route file), the map can't see it
   * run, or it couldn't be read.
   */
  readonly leftOut?: string
}

/** A pack's reader of its main source files, for `gauntlet prune code`. */
export interface CodeSurveyor {
  /** Whether the path is main source the pack's test map names when a test runs it. */
  readonly reads: (path: string) => boolean
  readonly survey: (path: string, text: string) => SurveyedSource
}

export interface DeadCodeFinding {
  readonly path: string
  readonly line?: number
  readonly rule: string
  readonly tool: string
  readonly message: string
}

export interface UnusedCode {
  readonly path: string
  /** The declaration, when one is listed rather than the whole file. */
  readonly name?: string
  /** `file`, or the declaration's kind. */
  readonly kind: string
  readonly line?: number
  readonly why: string
}

export interface PruneCodeReport {
  /** The dead-code gate's findings at the baseline, or why there are none to read. */
  readonly deadCode: { readonly commit: string; readonly findings: ReadonlyArray<DeadCodeFinding> } | { readonly missing: string }
  /** Code no test ran that nothing names, or why it can't be told. */
  readonly unused:
    | {
      readonly commit: string
      /** Main source files the map covers that no test ran. */
      readonly notRun: number
      readonly candidates: ReadonlyArray<UnusedCode>
      /** Files no test ran that are never listed, with why. */
      readonly leftOut: ReadonlyArray<{ readonly path: string; readonly why: string }>
    }
    | { readonly missing: string }
}

const WORD = /[A-Za-z_$][\w$]*/g

/** The names other files reach a file by: its name without the extension, and an index file's folder. */
export const moduleNames = (path: string): string[] => {
  const parts = path.split("/")
  const stem = parts[parts.length - 1]!.replace(/\.[^.]+$/, "")
  const folder = parts[parts.length - 2]
  return ["index", "mod", "__init__"].includes(stem) && folder !== undefined ? [folder] : [stem]
}

/**
 * What's listed from the source files no test ran: a file when no other file
 * names it or anything it declares; otherwise each declaration nothing in the
 * project names (again in its own file, or anywhere else). `files` is every
 * file read for names, the candidates' own among them. A textual search: a
 * name in a comment, a string or another language's file counts as a use, so
 * it only ever leaves things out.
 */
export const unusedCode = (
  notRun: ReadonlyArray<{ readonly path: string; readonly survey: SurveyedSource }>,
  files: ReadonlyArray<{ readonly path: string; readonly text: string }>,
): { readonly candidates: ReadonlyArray<UnusedCode>; readonly leftOut: ReadonlyArray<{ readonly path: string; readonly why: string }> } => {
  const judged = notRun.filter((f) => f.survey.leftOut === undefined)
  const words = new Set<string>()
  const phrases = new Set<string>()
  for (const f of judged) {
    for (const d of f.survey.declared) words.add(d.name)
    for (const n of moduleNames(f.path)) (/^[A-Za-z_$][\w$]*$/.test(n) ? words : phrases).add(n)
  }
  // name -> path -> occurrences
  const seen = new Map<string, Map<string, number>>()
  const note = (name: string, path: string, n: number) => {
    const at = seen.get(name) ?? new Map<string, number>()
    at.set(path, (at.get(path) ?? 0) + n)
    seen.set(name, at)
  }
  for (const { path, text } of files) {
    for (const m of text.matchAll(WORD)) if (words.has(m[0])) note(m[0], path, 1)
    for (const p of phrases) if (text.includes(p)) note(p, path, 1)
  }
  const elsewhere = (name: string, path: string) => [...(seen.get(name) ?? [])].some(([p, n]) => p !== path && n > 0)
  const within = (name: string, path: string) => seen.get(name)?.get(path) ?? 0

  const candidates: UnusedCode[] = []
  for (const { path, survey } of [...judged].sort((a, b) => a.path.localeCompare(b.path))) {
    const named = moduleNames(path).some((n) => elsewhere(n, path))
    const unused = survey.declared.filter((d) => !elsewhere(d.name, path) && within(d.name, path) <= 1)
    if (!named && unused.length === survey.declared.length) {
      candidates.push({ path, kind: "file", why: survey.declared.length > 0 ? "no test ran it, and no other file names it or anything it declares" : "no test ran it, and no other file names it" })
      continue
    }
    const listed = new Set(unused.map((d) => d.name))
    for (const d of [...unused].sort((a, b) => a.line - b.line)) {
      if (d.in !== undefined && listed.has(d.in)) continue
      candidates.push({ path, name: d.in !== undefined ? `${d.in}.${d.name}` : d.name, kind: d.kind, line: d.line, why: "no test ran its file, and nothing in the project names it" })
    }
  }
  const leftOut = notRun.flatMap((f) => (f.survey.leftOut !== undefined ? [{ path: f.path, why: f.survey.leftOut }] : [])).sort((a, b) => a.path.localeCompare(b.path))
  return { candidates, leftOut }
}

const DEAD_CODE_RULE = /^dead-code(\/|$)/

/** The dead-code findings a baseline recorded, in path and line order, once each. */
export const deadCodeFindings = (results: Baseline["results"]): DeadCodeFinding[] => {
  const found = new Map<string, DeadCodeFinding>()
  for (const [tool, rs] of Object.entries(results)) {
    for (const r of rs) {
      if (!r.ruleId || !DEAD_CODE_RULE.test(r.ruleId)) continue
      const loc = r.locations?.[0]?.physicalLocation
      const path = loc?.artifactLocation?.uri
      if (path === undefined) continue
      const line = loc?.region?.startLine
      const f: DeadCodeFinding = { path, ...(line !== undefined ? { line } : {}), rule: r.ruleId, tool, message: r.message.text ?? "" }
      found.set(`${f.path}\0${f.line ?? 0}\0${f.rule}\0${f.message}`, f)
    }
  }
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0) || a.rule.localeCompare(b.rule))
}

const NO_BASELINE = "there's no baseline at HEAD: record one with `gauntlet baseline`"
const NO_GATE = "the policy has no dead-code gate: add `dead-code ratchet` (or `dead-code advise`) to a tier, then record its findings with `gauntlet baseline --update`"
const NOT_RECORDED = "the baseline records none, and it was recorded with another policy: if the dead-code gate is new, record its findings with `gauntlet baseline --update`"
const NO_TEST_MAP = "the baseline records no map of what the tests execute: mark a suite `affected` (spec 0013) and record it with `gauntlet baseline --update`"
const NO_TEST_MAP_RECORDED = "the baseline records no map of what the tests execute: record it with `gauntlet baseline --update`, which says why when a build can't"
const MAX_BYTES = 1_000_000

/** The folder of the policy's builds that holds a path: the longest one, "." when none does. */
const buildOf = (dirs: ReadonlyArray<string>, path: string) =>
  [...dirs].filter((d) => d === "." || path.startsWith(`${d}/`)).sort((a, b) => b.length - a.length)[0] ?? "."

/**
 * Reads the baseline at HEAD and the working copy for `gauntlet prune code`.
 * Nothing runs: the dead-code findings and the test map are the baseline's,
 * so they describe the commit it was recorded at.
 */
export const surveyCode = (repo: string, ir: PolicyIR, irHash: string, recorded: Baseline | undefined) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const git = yield* Git
    const registry = yield* PackRegistry
    const working = yield* git.listWorkingFiles(repo)
    const present = new Set(working)

    const hasGate = ir.gates.some((t) => t.checks.some((c) => c.kind === "gate" && c.name === "dead-code"))
    const deadCode: PruneCodeReport["deadCode"] = !hasGate
      ? { missing: NO_GATE }
      : !recorded
      ? { missing: NO_BASELINE }
      : (() => {
        // A finding in a file that's gone since is already dealt with.
        const findings = deadCodeFindings(recorded.results).filter((f) => present.has(f.path))
        return findings.length === 0 && recorded.irHash !== irHash ? { missing: NOT_RECORDED } : { commit: recorded.commit, findings }
      })()

    const packs = registry.packs.filter((p) => ir.packs.includes(p.spec.name) && p.surveyCode !== undefined)
    let unused: PruneCodeReport["unused"]
    if (packs.length === 0) unused = { missing: `the policy's packs (${ir.packs.join(", ")}) don't map what each test runs yet: TypeScript and the JVM do` }
    else if (!recorded) unused = { missing: NO_BASELINE }
    else if (!recorded.testMap) unused = { missing: ir.suites.some((s) => s.kind === "suite" && s.affected === true) ? NO_TEST_MAP_RECORDED : NO_TEST_MAP }
    else {
      const ran = new Set(Object.values(recorded.testMap).flat())
      const atRecording = new Set(yield* git.listTree(repo, recorded.commit))
      const isTestPath = testPathMatcher(ir)
      const holdouts = holdoutsOf(ir).flatMap((h) => h.globs)
      const read = (file: string) =>
        fs.stat(path.join(repo, file)).pipe(
          Effect.flatMap((s) => (Number(s.size) > MAX_BYTES ? Effect.succeed(Option.none<string>()) : fs.readFileString(path.join(repo, file)).pipe(Effect.map(Option.some)))),
          Effect.orElseSucceed(() => Option.none<string>()),
        )
      const notRun: { path: string; survey: SurveyedSource }[] = []
      for (const pack of packs) {
        const surveyor = pack.surveyCode!
        const dirs = ir.builds?.filter((b) => b.pack === pack.spec.name).map((b) => b.dir) ?? ["."]
        // Only builds whose tests the map covers: a build it has no file of wasn't mapped.
        const mapped = new Set([...ran].filter(surveyor.reads).map((f) => buildOf(dirs, f)))
        for (const file of working) {
          if (!surveyor.reads(file) || ran.has(file) || isTestPath(file) || !atRecording.has(file)) continue
          if (!mapped.has(buildOf(dirs, file)) || holdouts.some((g) => globMatches(g, file))) continue
          const text = yield* read(file)
          if (Option.isSome(text)) notRun.push({ path: file, survey: surveyor.survey(file, text.value) })
        }
      }
      const texts: { path: string; text: string }[] = []
      for (const file of working) {
        // The baseline names every file; Gauntlet's own state isn't the project's code.
        if (file.startsWith(".gauntlet/")) continue
        const text = yield* read(file)
        if (Option.isSome(text) && !text.value.includes("\u0000")) texts.push({ path: file, text: text.value })
      }
      unused = { commit: recorded.commit, notRun: notRun.length, ...unusedCode(notRun, texts) }
    }
    return { deadCode, unused } satisfies PruneCodeReport
  })

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

export const renderPruneCode = (r: PruneCodeReport): string => {
  const lines: string[] = []
  if ("missing" in r.deadCode) lines.push(`No dead-code findings to list: ${r.deadCode.missing}.`, "")
  else if (r.deadCode.findings.length === 0) lines.push(`The dead-code gate found nothing when the baseline was recorded at ${r.deadCode.commit.slice(0, 12)}.`, "")
  else {
    lines.push(`Dead code the dead-code gate found, as recorded at ${r.deadCode.commit.slice(0, 12)} (${r.deadCode.findings.length}):`)
    for (const f of r.deadCode.findings) lines.push(`  ${f.path}${f.line !== undefined ? `:${f.line}` : ""} ${f.rule}: ${f.tool} reports ${f.message.replace(/\.$/, "")}.`)
    lines.push("")
  }
  if ("missing" in r.unused) lines.push(`No code no test runs to list: ${r.unused.missing}.`, "")
  else {
    const u = r.unused
    const from = `from the map of what the tests executed at ${u.commit.slice(0, 12)}`
    if (u.notRun === 0) lines.push(`Every source file the map covers ran in some test (${from}).`, "")
    else if (u.candidates.length === 0) lines.push(`${plural(u.notRun, "source file")} no test ran (${from}); each is named somewhere else, and so is everything it declares${u.leftOut.length > 0 ? `, or may be started from outside the code` : ""}.`, "")
    else {
      lines.push(`Code no test ran and nothing in the project names (${u.candidates.length}; ${from}):`)
      for (const c of u.candidates) lines.push(c.kind === "file" ? `  ${c.path}: ${c.why}.` : `  ${c.path}:${c.line} ${c.kind} ${c.name}: ${c.why}.`)
      lines.push("")
    }
    if (u.leftOut.length > 0) lines.push(`Left out ${plural(u.leftOut.length, "file")} no test ran that something outside the code may start (an entry point, a framework's convention); --json lists them with why.`, "")
  }
  lines.push(
    "This is a list: Gauntlet hasn't changed anything, and it affects no check. Code reached by reflection, dependency injection, a framework or an outside caller isn't seen, so check each before removing it.",
    "Removing it is an ordinary change, judged like any other (spec 0017).",
  )
  return `${lines.join("\n").trimEnd()}\n`
}

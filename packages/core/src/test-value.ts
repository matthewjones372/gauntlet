import { globMatches } from "@gauntlet/dsl"
import type { PolicyIR } from "@gauntlet/ir"
import { Effect, FileSystem, Option, Path } from "effect"
import { Git } from "./git.ts"
import { testPathMatcher } from "./integrity.ts"
import { PackRegistry } from "./pack-registry.ts"
import { holdoutsOf } from "./workspace.ts"

// `gauntlet prune tests` (spec 0016): tests that add no value. It reads the
// test sources the packs know how to parse and lists tests that can't fail
// and tests that repeat another word for word. It's a list for the owner: it
// never deletes anything and never affects a check.

/** One test as a pack reads it from its source. */
export interface SurveyedTest {
  readonly name: string
  readonly line: number
  /** Assertions in its body, counted as the integrity detectors count them. */
  readonly assertions: number
  /** How many of those can't fail (`assertTrue(true)`, `expect(x).toBe(x)`). */
  readonly tautologies: number
  /** Counted by the `property tests` ratchet: it checks inputs nobody wrote down, so it's never listed. */
  readonly property: boolean
  /** Names of the functions it calls, so an assertion in a helper of the same file counts. */
  readonly calls: ReadonlyArray<string>
  /** The class, module or `describe` it's in: tests in different ones can share a body and still differ in setup. */
  readonly scope: string
  /** Its source without its name, comments or whitespace (see `normalisedBody`). */
  readonly body: string
}

export interface SurveyedFile {
  readonly tests: ReadonlyArray<SurveyedTest>
  /** Functions in the file that aren't tests and assert something. */
  readonly assertingHelpers: ReadonlyArray<string>
}

/** A pack's reader of its test files. */
export interface TestSurveyor {
  /** Whether the path is one of the pack's test files; `isTestPath` says whether the policy counts it as a test. */
  readonly reads: (path: string, isTestPath: boolean) => boolean
  readonly survey: (path: string, text: string) => SurveyedFile
}

export interface Span {
  readonly start: number
  readonly end: number
}

/**
 * A test's source with its name and comments cut out and whitespace removed,
 * so two tests that differ only in name, comments or layout compare equal.
 * Literals stay: two tests that check different examples aren't duplicates.
 */
export const normalisedBody = (text: string, test: Span, cut: ReadonlyArray<Span>): string => {
  let out = ""
  let at = test.start
  for (const c of [...cut].filter((c) => c.start >= test.start && c.end <= test.end).sort((a, b) => a.start - b.start)) {
    if (c.start < at) continue
    out += text.slice(at, c.start)
    at = c.end
  }
  return (out + text.slice(at, test.end)).replace(/\s+/g, "")
}

export interface PruneCandidate {
  readonly path: string
  readonly name: string
  readonly line: number
  readonly why: string
}

export interface DuplicateSet {
  readonly path: string
  /** The first test keeps; the rest repeat it. */
  readonly tests: ReadonlyArray<{ readonly name: string; readonly line: number }>
}

export interface PruneReport {
  readonly files: number
  readonly tests: number
  /** Tests with no assertion that can fail. */
  readonly testsNothing: ReadonlyArray<PruneCandidate>
  /** Tests whose source is the same as another's in the same file and scope. */
  readonly duplicates: ReadonlyArray<DuplicateSet>
}

const testsNothingWhy = (t: SurveyedTest, helpers: ReadonlySet<string>): string | undefined => {
  if (t.property) return undefined
  if (t.assertions - t.tautologies > 0) return undefined
  if (t.calls.some((c) => helpers.has(c))) return undefined
  return t.assertions === 0
    ? "it has no assertions, so it can't fail on a wrong result"
    : `its ${t.assertions === 1 ? "only assertion can't" : `${t.assertions} assertions can't`} fail`
}

/** What `gauntlet prune tests` lists, from the surveyed files. */
export const pruneCandidates = (files: ReadonlyArray<{ readonly path: string; readonly survey: SurveyedFile }>): PruneReport => {
  const testsNothing: PruneCandidate[] = []
  const duplicates: DuplicateSet[] = []
  for (const { path, survey } of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const helpers = new Set(survey.assertingHelpers)
    const groups = new Map<string, SurveyedTest[]>()
    for (const t of survey.tests) {
      const why = testsNothingWhy(t, helpers)
      if (why !== undefined) {
        testsNothing.push({ path, name: t.name, line: t.line, why })
        continue
      }
      // A property test can be the same as another and still try different inputs each run.
      if (t.property || t.body === "") continue
      const key = `${t.scope}\u0000${t.body}`
      groups.set(key, [...(groups.get(key) ?? []), t])
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue
      duplicates.push({ path, tests: [...group].sort((a, b) => a.line - b.line).map((t) => ({ name: t.name, line: t.line })) })
    }
  }
  return {
    files: files.length,
    tests: files.reduce((n, f) => n + f.survey.tests.length, 0),
    testsNothing,
    duplicates: duplicates.sort((a, b) => a.path.localeCompare(b.path) || a.tests[0]!.line - b.tests[0]!.line),
  }
}

/** Surveys every test file in the working copy with the policy's packs. Holdouts are left out (spec 0016 §4). */
export const surveyTests = (repo: string, ir: PolicyIR) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const registry = yield* PackRegistry
    const surveyors = registry.packs.filter((p) => ir.packs.includes(p.spec.name)).flatMap((p) => (p.surveyTests ? [p.surveyTests] : []))
    const isTestPath = testPathMatcher(ir)
    const holdouts = holdoutsOf(ir).flatMap((h) => h.globs)
    const files: { path: string; survey: SurveyedFile }[] = []
    for (const file of yield* (yield* Git).listWorkingFiles(repo)) {
      const surveyor = surveyors.find((s) => s.reads(file, isTestPath(file)))
      if (!surveyor || holdouts.some((g) => globMatches(g, file))) continue
      const text = yield* fs.readFileString(path.join(repo, file)).pipe(Effect.option)
      if (Option.isSome(text)) files.push({ path: file, survey: surveyor.survey(file, text.value) })
    }
    return pruneCandidates(files)
  })

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

export const renderPruneTests = (r: PruneReport): string => {
  const lines = [`Read ${plural(r.tests, "test")} in ${plural(r.files, "file")}.`, ""]
  if (r.testsNothing.length === 0 && r.duplicates.length === 0) lines.push("Nothing to prune: every test asserts something that can fail, and none repeats another.", "")
  if (r.testsNothing.length > 0) {
    lines.push(`Tests that test nothing (${r.testsNothing.length}):`)
    for (const c of r.testsNothing) lines.push(`  ${c.path}:${c.line} ${c.name}: ${c.why}.`)
    lines.push("")
  }
  if (r.duplicates.length > 0) {
    lines.push(`Tests that repeat another word for word (${r.duplicates.length} ${r.duplicates.length === 1 ? "set" : "sets"}):`)
    for (const d of r.duplicates) {
      const [keep, ...rest] = d.tests
      lines.push(`  ${d.path}:${keep!.line} ${keep!.name}, repeated by ${rest.map((t) => `${t.name} (line ${t.line})`).join(", ")}.`)
    }
    lines.push("")
  }
  lines.push(
    "This is a list: Gauntlet hasn't changed anything. An assertion in a helper from another file isn't seen, so check each test before removing it.",
    "Removing a test is still a deleted-tests forbid until removals can be proven (spec 0016).",
  )
  return `${lines.join("\n").trimEnd()}\n`
}

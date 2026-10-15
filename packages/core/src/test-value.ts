import { globMatches } from "@gauntlet/dsl"
import type { PolicyIR } from "@gauntlet/ir"
import type { KillMap } from "@gauntlet/sarif"
import { Effect, FileSystem, Option, Path } from "effect"
import { Git } from "./git.ts"
import { testPathMatcher } from "./integrity.ts"
import { PackRegistry } from "./pack-registry.ts"
import { holdoutsOf } from "./workspace.ts"

// `gauntlet prune tests` (spec 0016): tests that add no value. It reads the
// test sources the packs know how to parse and lists tests that can't fail
// and tests that repeat another word for word; from the baseline's kill map,
// tests that kill no mutant and tests whose every kill another test makes.
// It's a list for the owner: it never deletes anything and never affects a check.

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
  /** What the baseline's kill map says, or why there's none to read. */
  readonly mutation?: MutationFindings | { readonly missing: string }
}

/** Tests named as the mutation tool names them. */
export interface MutationFindings {
  /** The commit the kill map was recorded at. */
  readonly commit: string
  readonly mutants: number
  readonly tests: number
  /** Tests that reach mutants and kill none of them. */
  readonly killsNothing: ReadonlyArray<{ readonly test: string; readonly reached: number }>
  /**
   * Tests whose every kill a kept test also makes. Taken together: removing
   * all of them leaves every mutant the suite killed still killed.
   */
  readonly alreadyKilled: ReadonlyArray<{ readonly test: string; readonly killed: number; readonly by: ReadonlyArray<string> }>
}

/** Why a test can't fail on a wrong result, or undefined when it can (shared with the scenarios check, spec 0012). */
export const testsNothingWhy = (t: SurveyedTest, helpers: ReadonlySet<string>): string | undefined => {
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

const BY_SHOWN = 3

/**
 * What the kill map says. Tests are kept greedily, the ones that kill most
 * first, and a test is listed when the tests kept before it already kill all
 * it kills, so the listed tests can go together. \`keep\` names tests never
 * listed (property tests): they're kept first, and their kills count.
 */
export const mutationCandidates = (map: KillMap, commit: string, keep: (test: string) => boolean = () => false): MutationFindings => {
  const entries = Object.entries(map.tests)
  const killsNothing = entries
    .filter(([name, t]) => t.killed.length === 0 && t.reached > 0 && !keep(name))
    .map(([test, t]) => ({ test, reached: t.reached }))
    .sort((a, b) => a.test.localeCompare(b.test))
  const order = entries
    .filter(([, t]) => t.killed.length > 0)
    .sort(([a, x], [b, y]) => Number(keep(b)) - Number(keep(a)) || y.killed.length - x.killed.length || a.localeCompare(b))
  const keeper = new Map<number, string>()
  const alreadyKilled: { test: string; killed: number; by: string[] }[] = []
  for (const [name, t] of order) {
    if (!keep(name) && t.killed.every((m) => keeper.has(m))) {
      alreadyKilled.push({ test: name, killed: new Set(t.killed).size, by: [...new Set(t.killed.map((m) => keeper.get(m)!))].slice(0, BY_SHOWN) })
      continue
    }
    for (const m of t.killed) if (!keeper.has(m)) keeper.set(m, name)
  }
  return { commit, mutants: map.mutants.length, tests: entries.length, killsNothing, alreadyKilled: alreadyKilled.sort((a, b) => a.test.localeCompare(b.test)) }
}

/** Whether a test the mutation tool names is one of the property tests the survey found (by its name, at the end of the tool's). */
const namedAmong = (names: ReadonlyArray<string>) => (test: string) => names.some((n) => test === n || test.endsWith(`.${n}`) || test.endsWith(` ${n}`) || test.endsWith(`/${n}`))

const NO_KILL_MAP = "the baseline records no kill map: record one with `gauntlet baseline` and a mutation gate whose tool reports which tests kill each mutant (Pitest, or StrykerJS with Vitest or Jest)"

/**
 * Surveys every test file in the working copy with the policy's packs, and
 * reads the baseline's kill map when there is one. Holdouts are left out (spec 0016 §4).
 */
export const surveyTests = (repo: string, ir: PolicyIR, recorded?: { readonly commit: string; readonly killMap?: KillMap }) =>
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
    const properties = files.flatMap((f) => f.survey.tests.filter((t) => t.property).map((t) => t.name))
    const mutation = recorded?.killMap
      ? mutationCandidates(recorded.killMap, recorded.commit, namedAmong(properties))
      : { missing: recorded ? NO_KILL_MAP : "there's no baseline at HEAD: record one with `gauntlet baseline`" }
    return { ...pruneCandidates(files), mutation }
  })

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

const renderMutation = (m: NonNullable<PruneReport["mutation"]>): string[] => {
  if ("missing" in m) return [`No mutation results: ${m.missing}.`, ""]
  const lines = [`From the mutation results recorded at ${m.commit.slice(0, 12)}: ${plural(m.mutants, "mutant")}, ${plural(m.tests, "test")}.`, ""]
  if (m.killsNothing.length === 0 && m.alreadyKilled.length === 0) lines.push("Every test kills a mutant no other test kills.", "")
  if (m.killsNothing.length > 0) {
    lines.push(`Tests that kill no mutant (${m.killsNothing.length}):`)
    for (const t of m.killsNothing) lines.push(`  ${t.test}: reaches ${plural(t.reached, "mutant")} and kills none.`)
    lines.push("")
  }
  if (m.alreadyKilled.length > 0) {
    lines.push(`Tests whose every kill another test makes (${m.alreadyKilled.length}; removing them all still kills every mutant):`)
    for (const t of m.alreadyKilled) lines.push(`  ${t.test}: ${t.killed === 1 ? "its mutant is" : `its ${t.killed} mutants are`} also killed by ${t.by.join(", ")}.`)
    lines.push("")
  }
  return lines
}

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
  if (r.mutation) lines.push(...renderMutation(r.mutation))
  lines.push(
    "This is a list: Gauntlet hasn't changed anything. An assertion in a helper from another file isn't seen, so check each test before removing it.",
    "Removing a test is still a deleted-tests forbid until removals can be proven (spec 0016).",
  )
  return `${lines.join("\n").trimEnd()}\n`
}

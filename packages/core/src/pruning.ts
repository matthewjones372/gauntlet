import type { KillMap } from "@gauntlet/sarif"
import type { DiffFacts } from "./diff-facts.ts"

// Spec 0016 §3: a change that only removes tests can go through when the tests
// that stay still kill every mutant the removed ones killed. This reads the
// baseline's kill map for that; a mutation run on the change confirms it.

/** A test id without its parameter list: Gradle's `svc.FxTest.converts()` and Pitest's `svc.FxTest.converts` are one test. */
export const sameTest = (id: string) => id.replace(/\([^()]*\)$/, "")

/**
 * The tests a change removes, when it only removes tests: it changes nothing
 * but test files, and tests that ran at base no longer run. Undefined for any
 * other change, or when the tests that ran aren't known by name.
 */
export const removedTests = (
  facts: Pick<DiffFacts, "files">,
  isTestPath: (path: string) => boolean,
  baseTestIds: ReadonlyArray<string> | undefined,
  headTestIds: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> | undefined => {
  if (facts.files.length === 0 || baseTestIds === undefined || headTestIds === undefined) return undefined
  if (!facts.files.every((f) => isTestPath(f.path) && (f.oldPath === undefined || isTestPath(f.oldPath)))) return undefined
  const now = new Set(headTestIds)
  const removed = baseTestIds.filter((id) => !now.has(id))
  return removed.length > 0 ? removed : undefined
}

export type PruningVerdict =
  | { readonly kind: "keeps-every-kill"; readonly removed: ReadonlyArray<string>; readonly mutants: ReadonlyArray<{ readonly path: string; readonly line: number }> }
  | { readonly kind: "loses-kills"; readonly removed: ReadonlyArray<string>; readonly lost: ReadonlyArray<{ readonly path: string; readonly line: number }> }
  | { readonly kind: "unproven"; readonly removed: ReadonlyArray<string>; readonly why: string }

const SHOWN = 5
const list = (xs: ReadonlyArray<string>) => (xs.length > SHOWN ? `${xs.slice(0, SHOWN).join(", ")} and ${xs.length - SHOWN} more` : xs.join(", "))

/**
 * What the kill map says about removing these tests: every mutant they killed
 * is still killed by a test that stays, or which ones aren't. A removed test the
 * map doesn't name can't be judged, so the removal isn't proven.
 */
export const pruningVerdict = (removed: ReadonlyArray<string>, killMap: KillMap | undefined): PruningVerdict => {
  if (!killMap) return { kind: "unproven", removed, why: "the baseline records no kill map (a mutation gate whose tool names each mutant's killers, recorded with `gauntlet baseline`)" }
  const named = new Map(Object.keys(killMap.tests).map((k) => [sameTest(k), k]))
  const unnamed = removed.filter((r) => !named.has(sameTest(r)))
  if (unnamed.length > 0) return { kind: "unproven", removed, why: `the baseline's kill map doesn't name ${list(unnamed)}` }
  const gone = new Set(removed.map((r) => named.get(sameTest(r))!))
  const keptKills = new Set(Object.entries(killMap.tests).filter(([name]) => !gone.has(name)).flatMap(([, t]) => t.killed))
  const theirs = [...new Set([...gone].flatMap((name) => killMap.tests[name]!.killed))].sort((a, b) => a - b)
  const at = (i: number) => killMap.mutants[i]!
  const lost = theirs.filter((i) => !keptKills.has(i))
  return lost.length > 0 ? { kind: "loses-kills", removed, lost: lost.map(at) } : { kind: "keeps-every-kill", removed, mutants: theirs.map(at) }
}

/** The verdict as a sentence for the report. */
export const describePruning = (v: PruningVerdict): string => {
  const tests = `${v.removed.length === 1 ? "test" : "tests"} ${list(v.removed)}`
  switch (v.kind) {
    case "keeps-every-kill":
      return `Removing ${tests} keeps every kill: in the baseline's kill map, tests that stay kill all ${v.mutants.length} of their mutants. It stays forbidden until a mutation run on the change confirms it (spec 0016).`
    case "loses-kills":
      return `Removing ${tests} loses kills: no test that stays kills the ${v.lost.length === 1 ? "mutant" : `${v.lost.length} mutants`} at ${list(v.lost.map((m) => `${m.path}:${m.line}`))}.`
    case "unproven":
      return `Whether removing ${tests} loses kills can't be told: ${v.why}.`
  }
}

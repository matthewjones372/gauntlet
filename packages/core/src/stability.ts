import { globMatches } from "@gauntlet/dsl"
import type { Quarantine } from "@gauntlet/ir"
import type { Result } from "@gauntlet/sarif"
import { Effect } from "effect"
import type { DiffFacts } from "./diff-facts.ts"
import type { GateRun, TestSubset } from "./gate.ts"

// Flaky tests (M15). A failed test is run again on its own: if it passes it's
// flaky, not fixed. New and changed test files run REPEATS more times with
// different seeds: any test that both passes and fails is a new flaky test,
// which blocks. Quarantined tests (an owner's dated exception in the policy)
// still run; until the date their failure doesn't fail the suite. Seeds come
// from the judged commit and "today" from its date, so a run never depends on
// the clock.

export const REPEATS = 3

export interface TestFailure {
  readonly id: string
  readonly file?: string
  readonly text: string
}

/** Failing tests in a suite run, from the SARIF the pack produced. */
export const failuresOf = (run: GateRun): TestFailure[] =>
  run.runs.flatMap((r) => r.results).filter((x: Result) => x.ruleId === "test/failed" || x.ruleId === "test/errored").map((x) => {
    const loc = x.locations?.[0]
    const id = loc?.logicalLocations?.[0]?.fullyQualifiedName ?? x.message.text.split(": ")[0]!
    const file = loc?.physicalLocation?.artifactLocation?.uri
    return { id, ...(file ? { file } : {}), text: x.message.text.split("\n")[0]!.slice(0, 300) }
  })

/** A deterministic seed per run, from the judged commit. */
export const seedFor = (head: string, run: number) => ((Number.parseInt(head.slice(0, 8), 16) || 0) + run) >>> 0

export interface Stability {
  /** Failing tests that passed when run again alone. */
  readonly rerunFlaky: ReadonlyArray<string>
  /**
   * Failing tests from a run that measured coverage that passed when run again
   * alone without it: slowed by the instrumentation (a timing test), not flaky.
   */
  readonly slowedByCoverage: ReadonlyArray<string>
  /** Tests in new or changed test files that both passed and failed across the repeated runs. */
  readonly newFlaky: ReadonlyArray<string>
  /** Failures excused by a quarantine that still holds. */
  readonly quarantined: ReadonlyArray<string>
  /** Failures that count: not flaky on rerun and not quarantined. */
  readonly failures: ReadonlyArray<TestFailure>
  /** Quarantines that would have excused a failure but have expired. */
  readonly expired: ReadonlyArray<Quarantine>
  /** Notes for the report, such as reruns not being possible. */
  readonly notes: ReadonlyArray<string>
  /** Failures that count but also fail with the change's files as the base has them: already failing before it. */
  readonly failingOnBase: ReadonlyArray<string>
}

export interface StabilityInput<R> {
  readonly suite: { readonly name: string; readonly location: string }
  readonly main: GateRun
  readonly facts: DiffFacts
  readonly quarantine: ReadonlyArray<Quarantine>
  /** The judged commit's date, YYYY-MM-DD. */
  readonly today: string
  /** Runs part of the suite again, or undefined when the pack can't. Reruns never measure coverage. */
  readonly rerun?: (subset: TestSubset, label: string) => Effect.Effect<GateRun, never, R>
  /** The main run measured coverage in the same run as the tests. */
  readonly measuredCoverage?: boolean
  /** Every file in the judged checkout, to find a failing test's file when the report doesn't say (vitest names tests after their file). */
  readonly files?: ReadonlyArray<string>
  /** Runs part of the suite again with the change's files as the base has them, or undefined when that can't be done. */
  readonly onBase?: (subset: TestSubset, label: string) => Effect.Effect<GateRun, never, R>
}

/**
 * The ids of the tests a run reports, matched with or without a build's
 * prefix: with several builds a run names its tests `<folder>:<id>` (ADR
 * 0022), while a failure names the test alone.
 */
const testsIn = (ids: Iterable<string>) => {
  const all = new Set(ids)
  const bare = new Set([...all].map((id) => id.slice(id.indexOf(":") + 1)))
  return { has: (id: string) => all.has(id) || bare.has(id) }
}

const passedIn = (run: GateRun) => {
  const failed = new Set(failuresOf(run).map((f) => f.id))
  return testsIn((run.tests?.ids ?? []).filter((id) => !failed.has(id) && !failed.has(id.slice(id.indexOf(":") + 1))))
}

export const assessStability = <R>(input: StabilityInput<R>) =>
  Effect.gen(function*() {
    const notes: string[] = []
    const failures = failuresOf(input.main)
    const rerunFlaky = new Set<string>()
    const slowedByCoverage = new Set<string>()
    const fileOf = (f: TestFailure) => f.file ?? (input.files ?? []).filter((p) => f.id.startsWith(`${p}.`) || f.id.startsWith(`${p} `)).sort((a, b) => b.length - a.length)[0]
    const subsetOf = (fs: ReadonlyArray<TestFailure>): TestSubset => ({
      files: [...new Set(fs.flatMap((f) => { const file = fileOf(f); return file ? [file] : [] }))].sort(),
      ids: fs.map((f) => f.id).sort(),
      seed: seedFor(input.facts.head, 0),
    })
    if (failures.length > 0 && input.rerun) {
      const again = yield* input.rerun(subsetOf(failures), "rerun")
      const passed = passedIn(again)
      for (const f of failures) if (passed.has(f.id)) (input.measuredCoverage ? slowedByCoverage : rerunFlaky).add(f.id)
    } else if (failures.length > 0) {
      notes.push("failed tests weren't run again: the pack can't run single tests")
    }

    // New and changed test files, run again with different seeds.
    const changed = input.facts.files
      .filter((f) => f.status !== "deleted" && globMatches(input.suite.location, f.path))
      .map((f) => f.path).sort()
    const newFlaky = new Set<string>()
    if (changed.length > 0 && input.rerun) {
      const seen = new Map<string, Set<"pass" | "fail">>()
      const note = (run: GateRun) => {
        const failed = new Set(failuresOf(run).map((f) => f.id))
        for (const id of run.tests?.ids ?? []) {
          const s = seen.get(id) ?? new Set()
          s.add(failed.has(id) ? "fail" : "pass")
          seen.set(id, s)
        }
      }
      const repeats: GateRun[] = []
      for (let i = 1; i <= REPEATS; i++) repeats.push(yield* input.rerun({ files: changed, ids: [], seed: seedFor(input.facts.head, i) }, `repeat-${i}`))
      const repeated = new Set(repeats.flatMap((r) => r.tests?.ids ?? []))
      // A run that measured coverage isn't compared with repeats that don't: a timing test would look flaky.
      if (!input.measuredCoverage) note(input.main)
      repeats.forEach(note)
      for (const [id, outcomes] of seen) if (repeated.has(id) && outcomes.size > 1) newFlaky.add(id)
    } else if (changed.length > 0) {
      notes.push(`new and changed tests weren't repeated to look for flakiness: the pack can't run single tests`)
    }

    const active = (q: Quarantine) => q.until >= input.today
    const remaining = failures.filter((f) => !rerunFlaky.has(f.id) && !slowedByCoverage.has(f.id))
    const quarantined = remaining.filter((f) => input.quarantine.some((q) => q.test === f.id && active(q))).map((f) => f.id)
    const expired = input.quarantine.filter((q) => !active(q) && remaining.some((f) => f.id === q.test))
    const counting = remaining.filter((f) => !quarantined.includes(f.id)).sort((a, b) => (a.id < b.id ? -1 : 1))

    // Failures that count, run again with the change's files as the base has them. A test
    // that ran there and failed was failing before the change; one that didn't run (new, or
    // gone from the base) or passed is the change's.
    const failingOnBase = new Set<string>()
    if (counting.length > 0 && input.onBase) {
      const onBase = yield* input.onBase(subsetOf(counting), "base")
      if (onBase.error === undefined) {
        const failed = new Set(failuresOf(onBase).map((f) => f.id))
        const ran = testsIn(onBase.tests?.ids ?? [])
        for (const f of counting) if (ran.has(f.id) && failed.has(f.id)) failingOnBase.add(f.id)
      }
    }
    return {
      rerunFlaky: [...rerunFlaky].sort(),
      slowedByCoverage: [...slowedByCoverage].sort(),
      newFlaky: [...newFlaky].sort(),
      quarantined: quarantined.sort(),
      failures: counting,
      expired,
      notes,
      failingOnBase: [...failingOnBase].sort(),
    } satisfies Stability
  })

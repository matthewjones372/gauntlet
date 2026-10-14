import { describe, expect, test } from "bun:test"
import { compareMetrics, type Metric, valueWithout } from "../src/index.ts"

// Spec 0017 §3: a project-wide ratchet is judged against the base's value for
// the code that's left. Removed code doesn't hold the bar up.

/** A coverage metric worked out as the packs do: lines hit over lines measured, from [hit, measured] per file. */
const coverage = (files: Record<string, [number, number]>, withTotals = true): Metric => {
  const pct = (hit: number, total: number) => Math.round((hit / total) * 10000) / 100
  const all = Object.values(files)
  return {
    value: pct(all.reduce((a, [h]) => a + h, 0), all.reduce((a, [, t]) => a + t, 0)),
    unit: "%",
    higherIsBetter: true,
    perFile: Object.fromEntries(Object.entries(files).map(([f, [h, t]]) => [f, pct(h, t)])),
    ...(withTotals ? { perFileTotal: Object.fromEntries(Object.entries(files).map(([f, [, t]]) => [f, t])) } : {}),
  }
}

const overall = (c: ReturnType<typeof compareMetrics>) => c.deltas.find((d) => d.file === undefined)!

describe("a whole-project ratchet when the change removes code", () => {
  // Well.ts is fully covered and Poor.ts half: 75% over 200 lines.
  const base = { coverage: coverage({ "src/Well.ts": [100, 100], "src/Poor.ts": [50, 100] }) }

  test("deleting a well-covered file is not a regression", () => {
    const head = { coverage: coverage({ "src/Poor.ts": [50, 100] }) }
    // Today's comparison: 75 to 50.
    expect(compareMetrics(base, head).regressions.map((r) => r.file ?? "total")).toEqual(["total"])
    const c = compareMetrics(base, head, { removed: ["src/Well.ts"] })
    expect(c.regressions).toEqual([])
    expect(overall(c)).toMatchObject({ base: 50, head: 50, delta: 0 })
    expect(overall(c).note).toBe("50 is the base's 75 without the code this change removes (src/Well.ts)")
  })

  test("deleting a poorly covered file is fine too: the value goes up", () => {
    const head = { coverage: coverage({ "src/Well.ts": [100, 100] }) }
    const c = compareMetrics(base, head, { removed: ["src/Poor.ts"] })
    expect(c.regressions).toEqual([])
    expect(overall(c)).toMatchObject({ base: 100, head: 100 })
  })

  test("a genuine drop in a file that's left still fails", () => {
    const head = { coverage: coverage({ "src/Poor.ts": [40, 100] }) }
    const c = compareMetrics(base, head, { removed: ["src/Well.ts"] })
    expect(c.regressions.map((r) => `${r.file ?? "total"}:${r.base}->${r.head}`)).toEqual(["total:50->40", "src/Poor.ts:50->40"])
  })

  test("a drop hidden by removing poorly covered code still fails against what's left", () => {
    // Poor.ts goes, which would lift the value to 100; Well.ts drops to 90. Today 90 beats 75 and passes.
    const head = { coverage: coverage({ "src/Well.ts": [90, 100] }) }
    expect(compareMetrics(base, head).deltas.find((d) => d.file === undefined)?.regressed).toBe(false)
    const c = compareMetrics(base, head, { removed: ["src/Poor.ts"] })
    expect(c.regressions.map((r) => `${r.file ?? "total"}:${r.base}->${r.head}`)).toEqual(["total:100->90", "src/Well.ts:100->90"])
  })

  test("a deleted file the baseline never measured changes nothing", () => {
    const head = { coverage: coverage({ "src/Well.ts": [100, 100], "src/Poor.ts": [50, 100] }) }
    const c = compareMetrics(base, head, { removed: ["src/Constants.ts"] })
    expect(overall(c)).toEqual({ metric: "coverage", base: 75, head: 75, delta: 0, regressed: false })
  })

  test("a renamed file keeps its base value under its new path", () => {
    // Old.ts is 90% of 10 lines, Rest.ts 100% of 90: 99% overall.
    const was = { coverage: coverage({ "src/Old.ts": [9, 10], "src/Rest.ts": [90, 90] }) }
    const now = { coverage: coverage({ "src/New.ts": [9, 10], "src/Rest.ts": [90, 90] }) }
    // Today the renamed file is new to the baseline, so it's held to the overall 99%.
    expect(compareMetrics(was, now).regressions.map((r) => r.file)).toEqual(["src/New.ts"])
    const renames = new Map([["src/Old.ts", "src/New.ts"]])
    expect(compareMetrics(was, now, { renames }).regressions).toEqual([])
    const worse = { coverage: coverage({ "src/New.ts": [8, 10], "src/Rest.ts": [90, 90] }) }
    expect(compareMetrics(was, worse, { renames }).regressions.map((r) => `${r.file ?? "total"}:${r.base}->${r.head}`)).toEqual(["total:99->98", "src/New.ts:90->80"])
  })

  test("without per-file totals the comparison is today's, and a drop says it may come from the removed code", () => {
    const older = { coverage: coverage({ "src/Well.ts": [100, 100], "src/Poor.ts": [50, 100] }, false) }
    const head = { coverage: coverage({ "src/Poor.ts": [50, 100] }, false) }
    const c = compareMetrics(older, head, { removed: ["src/Well.ts"] })
    expect(c.regressions.map((r) => `${r.file ?? "total"}:${r.base}->${r.head}`)).toEqual(["total:75->50"])
    expect(c.regressions[0]!.note).toContain("this change removes src/Well.ts")
    expect(c.regressions[0]!.note).toContain("the drop may come from the removed code")
    expect(c.regressions[0]!.note).toContain("`gauntlet baseline --update --allow-lower`")
    // No drop, no note.
    const rose = { coverage: coverage({ "src/Well.ts": [100, 100] }, false) }
    expect(overall(compareMetrics(older, rose, { removed: ["src/Poor.ts"] })).note).toBeUndefined()
  })

  test("a baseline with no per-file values at all gets the note too", () => {
    const bare: Metric = { value: 75, unit: "%", higherIsBetter: true }
    const c = compareMetrics({ coverage: bare }, { coverage: { value: 50, unit: "%", higherIsBetter: true } }, { removed: ["src/Well.ts"] })
    expect(c.regressions[0]?.note).toContain("this change removes src/Well.ts")
  })

  test("per-file values that don't give back the recorded value aren't trusted", () => {
    // The recorded 80 isn't what the files add up to (75): how it was worked out isn't known.
    const odd = { coverage: { ...base.coverage, value: 80 } }
    expect(valueWithout(odd.coverage, ["src/Well.ts"])).toBeUndefined()
    const c = compareMetrics(odd, { coverage: coverage({ "src/Poor.ts": [50, 100] }) }, { removed: ["src/Well.ts"] })
    expect(c.regressions.map((r) => `${r.file ?? "total"}:${r.base}->${r.head}`)).toEqual(["total:80->50"])
    expect(c.regressions[0]!.note).toContain("the drop may come from the removed code")
  })

  test("with several builds the value is the worst build's, worked out again per build", () => {
    // Build a is 100% of 100 lines; build b is Y.ts and Z.ts, 150 of 200 lines, 75%. Recorded as the worst build's, 75.
    const m: Metric = { ...coverage({ "a/X.ts": [100, 100], "b/Y.ts": [50, 100], "b/Z.ts": [100, 100] }), value: 75 }
    const groupOf = (p: string) => p.split("/")[0]!
    // Without Z.ts, build b is 50%. Taken as one build the files give 83.33, not the recorded 75, so they aren't trusted.
    expect(valueWithout(m, ["b/Z.ts"], groupOf)).toBe(50)
    expect(valueWithout(m, ["b/Z.ts"])).toBeUndefined()
  })

  test("a mutation ratchet is judged the same way", () => {
    const mutation = (files: Record<string, [number, number]>): Metric => ({ ...coverage(files) })
    const base = { mutation: mutation({ "src/Fx.kt": [9, 10], "src/Rates.kt": [1, 10] }) }
    const head = { mutation: mutation({ "src/Rates.kt": [1, 10] }) }
    expect(compareMetrics(base, head).regressions).toHaveLength(1)
    expect(compareMetrics(base, head, { removed: ["src/Fx.kt"] }).regressions).toEqual([])
  })

  test("a changed-lines comparison is untouched", () => {
    const head = { coverage: coverage({ "src/Poor.ts": [50, 100] }) }
    const options = { removed: ["src/Well.ts"], renames: new Map([["src/Poor.ts", "src/Poorer.ts"]]) }
    expect(compareMetrics(base, head, { scoped: true, ...options })).toEqual(compareMetrics(base, head, { scoped: true }))
    const unscopedValue = { coverage: { value: 50, unit: "%" as const, higherIsBetter: true } }
    expect(compareMetrics(base, unscopedValue, { scoped: true, ...options })).toEqual(compareMetrics(base, unscopedValue, { scoped: true }))
  })
})

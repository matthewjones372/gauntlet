import { describe, expect, test } from "bun:test"
import { type Metric, updateMetrics } from "../src/index.ts"

// Issue #163: recording the baseline again after a change made the coverage
// tool measure a module it didn't before. Its files were refused as if they
// had dropped from the project's total to their own value.

const pct = (value: number, perFile?: Record<string, number>): Metric => ({ value, unit: "%", higherIsBetter: true, ...(perFile ? { perFile } : {}) })

describe("updateMetrics with files measured for the first time", () => {
  test("a file the baseline never measured is recorded as it is, not held to the project's value", () => {
    const u = updateMetrics(
      { coverage: pct(92.86, { "app/A.kt": 92.86 }) },
      { coverage: pct(93, { "app/A.kt": 93, "registry/Registry.kt": 0 }) },
      false,
    )
    expect(u.lowered).toEqual([])
    expect(u.metrics.coverage?.perFile).toEqual({ "app/A.kt": 93, "registry/Registry.kt": 0 })
  })

  test("a baseline with no per-file values takes them all as first measurements", () => {
    const u = updateMetrics({ coverage: pct(80) }, { coverage: pct(81, { "A.kt": 40 }) }, false)
    expect(u.lowered).toEqual([])
    expect(u.metrics.coverage?.value).toBe(81)
  })

  test("a file the baseline measured is still held to its own value", () => {
    const u = updateMetrics(
      { coverage: pct(80, { "A.kt": 90 }) },
      { coverage: pct(80, { "A.kt": 85, "New.kt": 10 }) },
      false,
    )
    expect(u.lowered.map((d) => `${d.file}:${d.base}->${d.head}`)).toEqual(["A.kt:90->85"])
    expect(u.metrics.coverage?.perFile).toEqual({ "A.kt": 90 })
  })

  test("a project value pulled down only by files measured for the first time is taken", () => {
    const u = updateMetrics(
      { coverage: withTotals(90, { "A.kt": [90, 100] }) },
      { coverage: withTotals(60, { "A.kt": [90, 100], "B.kt": [0, 50] }) },
      false,
    )
    expect(u.lowered).toEqual([])
    expect(u.metrics.coverage?.value).toBe(60)
  })

  test("a project value that drops in the files the baseline measured is still refused", () => {
    const u = updateMetrics(
      { coverage: withTotals(90, { "A.kt": [90, 100] }) },
      { coverage: withTotals(53.33, { "A.kt": [80, 100], "B.kt": [0, 50] }) },
      false,
    )
    expect(u.lowered.map((d) => `${d.file ?? "(project)"}:${d.base}->${d.head}`)).toEqual(["(project):90->80", "A.kt:90->80"])
    expect(u.metrics.coverage?.value).toBe(90)
  })

  test("without per-file totals the project value is compared as recorded", () => {
    const u = updateMetrics({ coverage: pct(90, { "A.kt": 90 }) }, { coverage: pct(60, { "A.kt": 90, "B.kt": 0 }) }, false)
    expect(u.lowered.map((d) => d.file ?? "(project)")).toEqual(["(project)"])
    expect(u.metrics.coverage?.value).toBe(90)
  })
})

/** A percentage with each file's value and what it's out of (lines measured). */
function withTotals(value: number, files: Record<string, readonly [number, number]>): Metric {
  return {
    ...pct(value, Object.fromEntries(Object.entries(files).map(([f, [v]]) => [f, v]))),
    perFileTotal: Object.fromEntries(Object.entries(files).map(([f, [, t]]) => [f, t])),
  }
}

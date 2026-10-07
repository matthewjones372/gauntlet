import { describe, expect, test } from "bun:test"
import { compareMetrics, type Metric, updateMetrics } from "../src/index.ts"

const pct = (value: number, perFile?: Record<string, number>): Metric => ({ value, unit: "%", higherIsBetter: true, ...(perFile ? { perFile } : {}) })
const count = (value: number): Metric => ({ value, unit: "count", higherIsBetter: false })

describe("compareMetrics", () => {
  test("a drop in a higher-is-better metric is a regression", () => {
    expect(compareMetrics({ mutation: pct(80) }, { mutation: pct(79.5) }).regressions.map((r) => r.metric)).toEqual(["mutation"])
    expect(compareMetrics({ mutation: pct(80) }, { mutation: pct(80) }).regressions).toEqual([])
  })

  test("a rise in a lower-is-better metric is a regression", () => {
    expect(compareMetrics({ skipped: count(2) }, { skipped: count(3) }).regressions).toHaveLength(1)
    expect(compareMetrics({ skipped: count(2) }, { skipped: count(1) }).regressions).toEqual([])
  })

  test("float noise is not a regression", () => {
    expect(compareMetrics({ coverage: pct(0.3) }, { coverage: pct(0.1 + 0.2) }).regressions).toEqual([])
  })

  test("per-file values are compared per file, and new files against the overall baseline", () => {
    const c = compareMetrics(
      { mutation: pct(80, { "A.kt": 90 }) },
      { mutation: pct(85, { "A.kt": 85, "New.kt": 70 }) },
    )
    expect(c.regressions.map((r) => `${r.file}:${r.base}->${r.head}`)).toEqual(["A.kt:90->85", "New.kt:80->70"])
  })

  test("a value measured only over the changed files is compared per file, not with the project's total", () => {
    // The project averages 88.7%; Money.kt was 84.4% and rose to 85.3%.
    const base = { mutation: pct(88.68, { "Money.kt": 84.38, "Outcome.kt": 100 }) }
    const head = { mutation: pct(85.29, { "Money.kt": 85.29 }) }
    expect(compareMetrics(base, head, { scoped: true }).regressions).toEqual([])
    expect(compareMetrics(base, head).regressions.map((r) => r.file ?? "total")).toEqual(["total"])
    expect(compareMetrics(base, { mutation: pct(80, { "Money.kt": 80 }) }, { scoped: true }).regressions.map((r) => r.file)).toEqual(["Money.kt"])
  })

  test("a metric the change didn't produce is missing evidence", () => {
    expect(compareMetrics({ mutation: pct(80), coverage: pct(70) }, { coverage: pct(71) }).missing).toEqual(["mutation"])
  })
})

describe("updateMetrics", () => {
  test("improvements are taken and worse values refused", () => {
    const u = updateMetrics({ mutation: pct(80), coverage: pct(70) }, { mutation: pct(85), coverage: pct(60) }, false)
    expect(u.metrics.mutation?.value).toBe(85)
    expect(u.metrics.coverage?.value).toBe(70)
    expect(u.lowered.map((d) => d.metric)).toEqual(["coverage"])
  })

  test("allowLower takes the worse value and still reports it", () => {
    const u = updateMetrics({ coverage: pct(70) }, { coverage: pct(60) }, true)
    expect(u.metrics.coverage?.value).toBe(60)
    expect(u.lowered).toHaveLength(1)
  })

  test("metrics not recorded this time are kept", () => {
    expect(updateMetrics({ mutation: pct(80) }, {}, true).metrics.mutation?.value).toBe(80)
  })
})

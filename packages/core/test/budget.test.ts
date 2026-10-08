import { describe, expect, test } from "bun:test"
import type { Budget } from "@gauntlet/ir"
import { judgeBudget, parseBudgetResults } from "../src/index.ts"

// Spec 0006: a budget's command writes measurements, in Gauntlet's own format,
// hyperfine's or k6's, and Gauntlet holds them to the budget's thresholds.

const budget = (thresholds: Budget["thresholds"]): Budget => ({ name: "ingest", command: "./perf.sh {json}", thresholds })
const t = (metric: string, op: string, value: number, unit?: string, more: { aggregate?: string; vsBaseline?: boolean } = {}) =>
  ({ metric, op, value: { value, ...(unit ? { unit } : {}) }, vsBaseline: more.vsBaseline ?? false, ...(more.aggregate ? { aggregate: more.aggregate } : {}) }) as Budget["thresholds"][number]

describe("reading a budget's results", () => {
  test("Gauntlet's own format, with series", () => {
    expect(parseBudgetResults(JSON.stringify({ p99: 48, errors: 0.02, series: { "GET /a": { p99: 40 }, "GET /b": { p99: 60 } } }))).toEqual({
      overall: { p99: 48, errors: 0.02 },
      series: { "GET /a": { p99: 40 }, "GET /b": { p99: 60 } },
    })
  })

  test("hyperfine's seconds become milliseconds, per command", () => {
    const r = parseBudgetResults(JSON.stringify({ results: [{ command: "./tool parse", mean: 0.25, median: 0.24, min: 0.2, max: 0.3 }] }))
    expect(r?.series["./tool parse"]).toEqual({ mean: 250, p50: 240, min: 200, max: 300 })
    expect(r?.overall.mean).toBe(250)
  })

  test("k6's summary: durations, failures as a percentage, requests a second", () => {
    const r = parseBudgetResults(JSON.stringify({ metrics: { http_req_duration: { avg: 20, med: 18, "p(95)": 40, max: 90 }, http_req_failed: { value: 0.001 }, http_reqs: { rate: 1200 } } }))
    expect(r?.overall).toEqual({ mean: 20, p50: 18, p95: 40, max: 90, errors: 0.1, throughput: 1200 })
  })

  test("not JSON is unreadable", () => {
    expect(parseBudgetResults("p99=48")).toBeUndefined()
  })
})

describe("judging a budget", () => {
  const results = { overall: { p99: 48, errors: 0.2, throughput: 900 }, series: { a: { p99: 40 }, b: { p99: 70 } } }

  test("limits in the policy's units: 50ms, 0.1%, rps", () => {
    expect(judgeBudget(budget([t("p99", "<", 50, "ms")]), results, {}).status).toBe("passed")
    expect(judgeBudget(budget([t("p99", "<", 0.04, "s")]), results, {}).reason).toBe("p99 48ms doesn't meet < 40ms")
    expect(judgeBudget(budget([t("errors", "<", 0.1, "%")]), results, {}).reason).toBe("errors 0.2% doesn't meet < 0.1%")
    expect(judgeBudget(budget([t("throughput", ">", 1000, "rps")]), results, {}).reason).toBe("throughput 900 rps doesn't meet > 1000 rps")
  })

  test("an aggregate over the series", () => {
    expect(judgeBudget(budget([t("p99", "<", 60, "ms", { aggregate: "max" })]), results, {}).reason).toBe("max(p99) 70ms doesn't meet < 60ms")
  })

  test("vs baseline: how much worse than the recorded value, and missing evidence without one", () => {
    const recorded = { "budget/ingest/p99": { value: 40, unit: "ms" as const, higherIsBetter: false }, "budget/ingest/throughput": { value: 1000, unit: "count" as const, higherIsBetter: true } }
    expect(judgeBudget(budget([t("p99", "<", 25, "%", { vsBaseline: true })]), results, recorded).status).toBe("passed")
    expect(judgeBudget(budget([t("regression", "<", 5, "%", { vsBaseline: true })]), results, recorded).reason)
      .toBe("p99 got 20% worse than the baseline (40ms to 48ms), over the 5% allowed; throughput got 10% worse than the baseline (1000 rps to 900 rps), over the 5% allowed")
    const none = judgeBudget(budget([t("p99", "<", 5, "%", { vsBaseline: true })]), results, {})
    expect(none.status).toBe("not-executed")
    expect(none.reason).toContain("run gauntlet baseline")
  })

  test("what was measured is kept, to be recorded in the baseline", () => {
    expect(Object.keys(judgeBudget(budget([]), results, {}).metrics).sort()).toEqual(["budget/ingest/errors", "budget/ingest/p99", "budget/ingest/throughput"])
  })
})

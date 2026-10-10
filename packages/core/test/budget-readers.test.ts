import { describe, expect, test } from "bun:test"
import type { Budget } from "@gauntlet/ir"
import { judgeBudget, parseBudgetResults } from "../src/budget.ts"

// Spec 0007, stage 1: budgets read a Proofload run document and Gatling's
// stats.json as they are. A load generator that fell behind its schedule
// measured itself, not the service: that run is not executed.

const proofloadRun = (over: object = {}) => JSON.stringify({
  schema: "proofload/run/1",
  density: "summary",
  durationUnit: "nanoseconds",
  verdict: "met",
  schedule: { kept: true, lostGround: false },
  count: 2000,
  ok: 1990,
  failed: 10,
  steps: [
    { name: "browse", count: 1000, failed: 0, p50: 12_000_000, p99: 48_000_000 },
    { name: "place order", count: 1000, failed: 10, p50: 30_000_000, p99: 240_000_000 },
  ],
  ...over,
})

const gatlingStats = JSON.stringify({
  type: "GROUP",
  name: "All Requests",
  stats: {
    name: "All Requests",
    numberOfRequests: { total: 400, ok: 396, ko: 4 },
    minResponseTime: { total: 3 }, maxResponseTime: { total: 910 }, meanResponseTime: { total: 41 },
    percentiles1: { total: 22 }, percentiles2: { total: 40 }, percentiles3: { total: 120 }, percentiles4: { total: 300 },
    meanNumberOfRequestsPerSecond: { total: 66.7 },
  },
  contents: {
    "req_get-products": {
      type: "REQUEST", name: "GET /products",
      stats: { name: "GET /products", numberOfRequests: { total: 200, ok: 200, ko: 0 }, percentiles1: { total: 10 }, percentiles3: { total: 40 }, percentiles4: { total: 80 }, meanNumberOfRequestsPerSecond: { total: 33.3 } },
    },
    "group_checkout": {
      type: "GROUP", name: "checkout",
      contents: {
        "req_post-orders": {
          type: "REQUEST", name: "POST /orders",
          stats: { name: "POST /orders", numberOfRequests: { total: 200, ok: 196, ko: 4 }, percentiles1: { total: 35 }, percentiles3: { total: 200 }, percentiles4: { total: 420 }, meanNumberOfRequestsPerSecond: { total: 33.3 } },
        },
      },
    },
  },
})

const budget = (thresholds: Budget["thresholds"]): Budget => ({ name: "checkout", command: "x {json}", thresholds }) as unknown as Budget
const lt = (metric: string, value: number, unit?: string, aggregate?: string) =>
  ({ metric, op: "<", value: { value, ...(unit ? { unit } : {}) }, vsBaseline: false, ...(aggregate ? { aggregate } : {}) }) as unknown as Budget["thresholds"][number]

describe("a Proofload run document", () => {
  test("each step is a series, in milliseconds, with its error rate; the run's errors overall", () => {
    const r = parseBudgetResults(proofloadRun())!
    expect(r.series).toEqual({ browse: { p50: 12, p99: 48, errors: 0 }, "place order": { p50: 30, p99: 240, errors: 1 } })
    expect(r.overall).toEqual({ errors: 0.5 })
    expect(r.untrusted).toBeUndefined()
  })

  test("a budget holds the slowest step to its limit", () => {
    const r = parseBudgetResults(proofloadRun())!
    expect(judgeBudget(budget([lt("p99", 200, "ms", "max")]), r, {})).toMatchObject({ status: "failed", reason: "max(p99) 240ms doesn't meet < 200ms" })
    expect(judgeBudget(budget([lt("p99", 300, "ms", "max"), lt("errors", 1)]), r, {}).status).toBe("passed")
  })

  test("a generator that fell behind makes the run not executed, whatever it measured", () => {
    for (const run of [proofloadRun({ verdict: "behind" }), proofloadRun({ schedule: { kept: false } })]) {
      const r = parseBudgetResults(run)!
      expect(judgeBudget(budget([lt("p99", 10_000, "ms", "max")]), r, {})).toEqual({
        status: "not-executed",
        reason: "the load generator fell behind its schedule, so the numbers describe the generator, not the service",
        metrics: {},
      })
    }
  })

  test("a single step is the whole run", () => {
    const r = parseBudgetResults(proofloadRun({ count: 10, failed: 0, steps: [{ name: "pay", count: 10, failed: 0, p50: 5_000_000, p99: 9_000_000 }] }))!
    expect(r.overall).toEqual({ p50: 5, p99: 9, errors: 0 })
  })
})

describe("Gatling's stats.json", () => {
  test("every request, in groups too, is a series; the whole run is overall", () => {
    const r = parseBudgetResults(gatlingStats)!
    expect(r.overall).toEqual({ p50: 22, p95: 120, p99: 300, mean: 41, min: 3, max: 910, errors: 1, throughput: 66.7 })
    expect(Object.keys(r.series).sort()).toEqual(["GET /products", "POST /orders"])
    expect(r.series["POST /orders"]).toEqual({ p50: 35, p95: 200, p99: 420, errors: 2, throughput: 33.3 })
  })

  test("a budget holds the run, or its slowest request", () => {
    const r = parseBudgetResults(gatlingStats)!
    expect(judgeBudget(budget([lt("p99", 350, "ms")]), r, {}).status).toBe("passed")
    expect(judgeBudget(budget([lt("p99", 350, "ms", "max")]), r, {})).toMatchObject({ status: "failed", reason: "max(p99) 420ms doesn't meet < 350ms" })
  })
})

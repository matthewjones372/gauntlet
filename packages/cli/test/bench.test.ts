import { describe, expect, test } from "bun:test"
import { measure, RUNS, summarise } from "../../../scripts/bench.ts"

// Gauntlet's own performance budgets run scripts/bench.ts. Each measurement
// runs the real thing and reports times a budget can hold to limits.

describe("Gauntlet's own benchmark", () => {
  test("summarises timings as Gauntlet's budget JSON", () => {
    expect(summarise([30, 10, 20, 40, 50])).toEqual({ p50: 30, p95: 50, max: 50, mean: 30 })
    expect(summarise([12.345])).toEqual({ p50: 12.3, p95: 12.3, max: 12.3, mean: 12.3 })
  })

  test("measures each thing once per run", async () => {
    for (const what of Object.keys(RUNS) as (keyof typeof RUNS)[]) {
      const times = await measure(what, 1)
      expect(times).toHaveLength(1)
      expect(times[0]!).toBeGreaterThan(0)
    }
  }, 60_000)
})

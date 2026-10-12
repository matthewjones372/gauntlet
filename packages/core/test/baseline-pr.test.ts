import { describe, expect, test } from "bun:test"
import { type Baseline, emptyBaseline } from "@gauntlet/sarif"
import { judgedBaseline, loweredReason, onlyBaseline } from "../src/index.ts"

// What a baseline-only change is judged against (spec 0015): the base's
// baseline, with only the values the brought one lowers taken from it.

const baseline = (metrics: Baseline["metrics"], testIds: string[] = []): Baseline => ({ ...emptyBaseline("c", "h", "v"), metrics, testIds })

describe("onlyBaseline", () => {
  test("the baseline alone, added or modified", () => {
    expect(onlyBaseline([{ path: ".gauntlet/baseline.sarif", status: "modified" }])).toBe(true)
    expect(onlyBaseline([{ path: ".gauntlet/baseline.sarif", status: "added" }])).toBe(true)
  })

  test("anything else is judged as before", () => {
    expect(onlyBaseline([{ path: ".gauntlet/baseline.sarif", status: "modified" }, { path: "src/a.ts", status: "modified" }])).toBe(false)
    expect(onlyBaseline([{ path: ".gauntlet/baseline.sarif", status: "deleted" }])).toBe(false)
    expect(onlyBaseline([{ path: ".gauntlet/baseline.sarif", status: "renamed", oldPath: "src/a.sarif" }])).toBe(false)
    expect(onlyBaseline([{ path: ".gauntlet/policy.gx", status: "modified" }])).toBe(false)
    expect(onlyBaseline([])).toBe(false)
  })
})

describe("judgedBaseline", () => {
  test("takes what's lowered, overall and per file, and keeps what's raised", () => {
    const base = baseline({
      coverage: { value: 90, unit: "%", higherIsBetter: true, perFile: { "a.ts": 80, "b.ts": 95 } },
      mutation: { value: 70, unit: "%", higherIsBetter: true },
      warnings: { value: 3, unit: "count", higherIsBetter: false },
    })
    const brought = baseline({
      coverage: { value: 85, unit: "%", higherIsBetter: true, perFile: { "a.ts": 90, "b.ts": 60, "c.ts": 50 } },
      mutation: { value: 75, unit: "%", higherIsBetter: true },
      warnings: { value: 5, unit: "count", higherIsBetter: false },
      lint: { value: 0, unit: "count", higherIsBetter: false },
    })
    const { baseline: judged, lowered } = judgedBaseline(base, brought)
    expect(judged.metrics.coverage).toEqual({ value: 85, unit: "%", higherIsBetter: true, perFile: { "a.ts": 80, "b.ts": 60, "c.ts": 50 } })
    expect(judged.metrics.mutation!.value).toBe(70)
    expect(judged.metrics.warnings!.value).toBe(5)
    expect(judged.metrics.lint).toBeUndefined()
    expect(lowered).toEqual([
      { metric: "coverage", base: 90, head: 85 },
      { metric: "coverage", file: "b.ts", base: 95, head: 60 },
      { metric: "coverage", file: "c.ts", base: 90, head: 50 },
      { metric: "warnings", base: 3, head: 5 },
    ])
  })

  test("lowering the executed tests brings the test ids it counts", () => {
    const tests = (n: number, ids: string[]) => baseline({ "integrity/executed-tests": { value: n, unit: "count", higherIsBetter: true } }, ids)
    expect(judgedBaseline(tests(3, ["a", "b", "c"]), tests(2, ["a", "b"])).baseline.testIds).toEqual(["a", "b"])
    expect(judgedBaseline(tests(3, ["a", "b", "c"]), tests(3, ["a", "b"])).baseline.testIds).toEqual(["a", "b", "c"])
  })

  test("nothing lowered, nothing taken", () => {
    const base = baseline({ coverage: { value: 90, unit: "%", higherIsBetter: true } })
    expect(judgedBaseline(base, baseline({}))).toEqual({ baseline: base, lowered: [] })
  })
})

test("the reason names at most five values", () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ metric: "coverage", file: `f${i}.ts`, base: 90, head: 80 }))
  expect(loweredReason(many)).toContain("coverage for f4.ts (90 to 80), and 2 more.")
})

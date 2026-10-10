import { describe, expect, test } from "bun:test"
import { compilePolicy } from "../src/index.ts"
import { installed } from "./fixtures/catalog.ts"

// A budget's limit can hold the worst (or best, average, total) of a load
// test's endpoints. `max` is also a keyword elsewhere, so it once couldn't be
// written here at all.

const thresholds = (line: string) => {
  const r = compilePolicy({ file: ".gauntlet/policy.gx", text: `gauntlet "x"\nuse jvm\nowners @p\nbudget api {\n  command "run {json}"\n  ${line}\n}\ngates { perf { budget api } }\n` }, installed)
  if (r._tag !== "Compiled") throw new Error(JSON.stringify(r))
  return r.compiled.ir.budgets[0]!.thresholds
}

describe("a budget's aggregates", () => {
  test("max, min, avg and sum each hold a field across the series", () => {
    for (const aggregate of ["max", "min", "avg", "sum"]) {
      expect(thresholds(`${aggregate}(p99) < 200ms`)[0]).toMatchObject({ aggregate, metric: "p99", op: "<" })
    }
  })
})

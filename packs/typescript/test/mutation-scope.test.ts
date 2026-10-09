import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { lineRanges } from "../src/gates.ts"
import { parseStryker } from "../src/reports.ts"

// Mutation on changed code mutates the added lines only, and a mutant is told
// apart from others on its line, so a second run can confirm survivors exactly.

describe("mutation on changed lines", () => {
  test("added lines become Stryker's line ranges", () => {
    expect(lineRanges([7, 3, 4, 5, 9, 10, 4])).toEqual([[3, 5], [7, 7], [9, 10]])
    expect(lineRanges([])).toEqual([])
  })

  test("a mutant's column and end line are read when Stryker gives them", () => {
    const json = JSON.stringify({
      files: { "/repo/src/fx.ts": { mutants: [{ status: "Survived", mutatorName: "ConditionalExpression", location: { start: { line: 4, column: 9 }, end: { line: 6, column: 2 } } }] } },
    })
    expect(Option.getOrThrow(parseStryker(json, "/repo"))).toEqual([{ path: "src/fx.ts", line: 4, column: 9, endLine: 6, status: "Survived", mutator: "ConditionalExpression" }])
  })
})

describe("a whole project's mutation in batches", () => {
  const loads = new Map([
    ["src/a.test.ts", new Set(["src/a.ts", "src/shared.ts"])],
    ["src/b.test.ts", new Set(["src/b.ts", "src/shared.ts"])],
  ])

  test("files with the same tests go together, and files no test loads get no tests", async () => {
    const { mutationBatches } = await import("../src/gates.ts")
    expect(mutationBatches(["src/a.ts", "src/b.ts", "src/shared.ts", "src/lonely.ts"], loads)).toEqual([
      { files: ["src/shared.ts"], tests: ["src/a.test.ts", "src/b.test.ts"] },
      { files: ["src/a.ts"], tests: ["src/a.test.ts"] },
      { files: ["src/b.ts"], tests: ["src/b.test.ts"] },
      { files: ["src/lonely.ts"], tests: [] },
    ])
  })

  test("past the batch limit, a group joins the batch whose tests it shares most", async () => {
    const { mutationBatches } = await import("../src/gates.ts")
    expect(mutationBatches(["src/a.ts", "src/b.ts", "src/shared.ts"], loads, 1)).toEqual([
      { files: ["src/a.ts", "src/b.ts", "src/shared.ts"], tests: ["src/a.test.ts", "src/b.test.ts"] },
    ])
  })
})

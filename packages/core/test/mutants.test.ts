import { describe, expect, test } from "bun:test"
import { type Mutant, mutationResult } from "../src/mutants.ts"

// Spec 0011: every pack's mutation gate scores through one helper, and with
// `on changed` only mutants on the changed lines count.

const m = (path: string, line: number, killed: boolean): Mutant => ({ path, line, killed, message: killed ? "killed" : `No test kills a mutant at ${line}` })

const mutants = [
  m("src/A.kt", 3, true), m("src/A.kt", 3, false), m("src/A.kt", 10, false), m("src/A.kt", 11, true),
  m("src/B.kt", 5, true), m("src/C.kt", 1, false),
]

describe("mutation result", () => {
  test("the whole project: every mutant counts, scored per file and overall", () => {
    const r = mutationResult("pitest", mutants, {})
    expect(r.lineScoped).toBe(false)
    expect(r.metrics?.mutation).toEqual({ value: 50, unit: "%", higherIsBetter: true, perFile: { "src/A.kt": 50, "src/B.kt": 100, "src/C.kt": 0 }, perFileTotal: { "src/A.kt": 4, "src/B.kt": 1, "src/C.kt": 1 } })
    expect(r.runs[0]!.results.map((x) => `${x.locations![0]!.physicalLocation!.artifactLocation!.uri}:${x.locations![0]!.physicalLocation!.region!.startLine}`))
      .toEqual(["src/A.kt:3", "src/A.kt:10", "src/C.kt:1"])
  })

  test("a scope of files keeps only their mutants", () => {
    const r = mutationResult("pitest", mutants, { scope: ["src/B.kt"] })
    expect(r.metrics?.mutation?.value).toBe(100)
    expect(r.runs[0]!.results).toEqual([])
  })

  test("changed lines keep only the mutants on them, and say the score is theirs", () => {
    const r = mutationResult("pitest", mutants, {
      scope: ["src/A.kt", "src/B.kt"],
      changedLines: new Map([["src/A.kt", new Set([3, 4])], ["src/B.kt", new Set([9])]]),
    })
    expect(r.lineScoped).toBe(true)
    expect(r.metrics?.mutation).toEqual({ value: 50, unit: "%", higherIsBetter: true, perFile: { "src/A.kt": 50 }, perFileTotal: { "src/A.kt": 2 } })
    expect(r.runs[0]!.results.map((x) => x.message.text)).toEqual(["No test kills a mutant at 3"])
  })

  test("no mutant on a changed line is nothing in scope, not a made-up score", () => {
    const r = mutationResult("pitest", mutants, { changedLines: new Map([["src/A.kt", new Set([99])]]) })
    expect(r.nothingInScope).toBe("pitest generated no mutants on the changed lines")
    expect(r.metrics).toBeUndefined()
  })

  test("a mutant the tool places only within a span counts when a changed line is inside it", () => {
    const fn: Mutant = { path: "app.py", line: 10, endLine: 20, killed: false, message: "No test kills a mutant in total" }
    expect(mutationResult("mutmut", [fn], { changedLines: new Map([["app.py", new Set([15])]]) }).metrics?.mutation?.value).toBe(0)
    expect(mutationResult("mutmut", [fn], { changedLines: new Map([["app.py", new Set([21])]]) }).nothingInScope).toBeDefined()
  })

  test("survivors are findings named by tool, ordered by file and line", () => {
    const r = mutationResult("gremlins", [m("b.go", 2, false), m("a.go", 9, false), m("a.go", 1, false)], {})
    expect(r.runs[0]!.tool.driver.name).toBe("gremlins")
    expect(r.runs[0]!.results.map((x) => `${x.ruleId} ${x.locations![0]!.physicalLocation!.artifactLocation!.uri}:${x.locations![0]!.physicalLocation!.region!.startLine}`))
      .toEqual(["mutation/survived a.go:1", "mutation/survived a.go:9", "mutation/survived b.go:2"])
  })
})

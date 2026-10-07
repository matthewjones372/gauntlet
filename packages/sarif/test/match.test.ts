import { describe, expect, test } from "bun:test"
import { compareWithBaseline, fingerprint, type Result, type SymbolLocator } from "../src/index.ts"

// A finding of rule `money/float` on a line, in a file given as text.
const finding = (path: string, line: number, ruleId = "money/float"): Result => ({
  ruleId,
  message: { text: "floating point used for money" },
  locations: [{ physicalLocation: { artifactLocation: { uri: path }, region: { startLine: line } } }],
})

const lines = (text: string) => text.split("\n")

// Kotlin-ish locator: the nearest `fun name(` above the line.
const locate: SymbolLocator = (_path, ls, line) => {
  for (let i = line - 1; i >= 0; i--) {
    const m = /fun (\w+)\(/.exec(ls[i] ?? "")
    if (m) return m[1]
  }
  return undefined
}

const fp = (files: Record<string, string>, results: Result[], withSymbols = true) =>
  fingerprint(results, (p) => (files[p] === undefined ? undefined : lines(files[p]!)), withSymbols ? { locate } : {})

const original = [
  "package money",
  "",
  "class Fx {",
  "  fun convert(amount: Long): Long {",
  "    val rate: Double = 1.1",
  "    return (amount * rate).toLong()",
  "  }",
  "}",
].join("\n")

const statesOf = (c: ReturnType<typeof compareWithBaseline>) => c.results.map((r) => `${r.baselineState}:${r.properties?.gauntlet?.match ?? "-"}`)

describe("baseline matching", () => {
  const base = fp({ "Fx.kt": original }, [finding("Fx.kt", 5)])

  test("a grandfathered finding survives an unrelated line shift", () => {
    const shifted = ["// licence header", "// more header", "", original].join("\n")
    const head = fp({ "Fx.kt": shifted }, [finding("Fx.kt", 8)])
    const c = compareWithBaseline(base, head)
    expect(statesOf(c)).toEqual(["unchanged:context"])
    expect(c.absent).toEqual([])
  })

  test("an edit next to the finding keeps it grandfathered as updated", () => {
    const edited = original.replace("    return (amount * rate).toLong()", "    val result = (amount * rate).toLong()\n    return result")
    const head = fp({ "Fx.kt": edited }, [finding("Fx.kt", 5)])
    expect(statesOf(compareWithBaseline(base, head))).toEqual(["updated:symbol"])
  })

  test("without a symbol, unchanged line text still matches as updated", () => {
    const baseNoSym = fp({ "Fx.kt": original }, [finding("Fx.kt", 5)], false)
    const edited = original.replace("class Fx {", "class Fx(private val log: Logger) {")
    const head = fp({ "Fx.kt": edited }, [finding("Fx.kt", 5)], false)
    expect(statesOf(compareWithBaseline(baseNoSym, head))).toEqual(["updated:line"])
  })

  test("without a symbol, rewriting the offending line makes it new", () => {
    const baseNoSym = fp({ "Fx.kt": original }, [finding("Fx.kt", 5)], false)
    const edited = original.replace("val rate: Double = 1.1", "val rate: Float = 1.1f")
    const head = fp({ "Fx.kt": edited }, [finding("Fx.kt", 5)], false)
    const c = compareWithBaseline(baseNoSym, head)
    expect(statesOf(c)).toEqual(["new:-"])
    expect(c.absent).toHaveLength(1)
  })

  test("a second finding of the same rule is new even where one was grandfathered", () => {
    const more = original.replace("    val rate: Double = 1.1", "    val rate: Double = 1.1\n    val fee: Double = 0.2")
    const head = fp({ "Fx.kt": more }, [finding("Fx.kt", 5), finding("Fx.kt", 6)])
    const c = compareWithBaseline(base, head)
    expect(c.results.filter((r) => r.baselineState === "new")).toHaveLength(1)
    expect(c.results.filter((r) => r.baselineState !== "new")).toHaveLength(1)
  })

  test("a different rule on the same line is new", () => {
    const head = fp({ "Fx.kt": original }, [finding("Fx.kt", 5, "style/magic-number")])
    expect(statesOf(compareWithBaseline(base, head))).toEqual(["new:-"])
  })

  test("findings follow a renamed file", () => {
    const head = fp({ "money/FxConverter.kt": original }, [finding("money/FxConverter.kt", 5)])
    expect(statesOf(compareWithBaseline(base, head, { renames: new Map([["Fx.kt", "money/FxConverter.kt"]]) }))).toEqual(["unchanged:context"])
    const unmapped = compareWithBaseline(base, head)
    expect(statesOf(unmapped)).toEqual(["new:-"])
    expect(unmapped.absent).toHaveLength(1)
  })

  test("a fixed finding is absent", () => {
    const c = compareWithBaseline(base, [])
    expect(c.absent.map((r) => r.baselineState)).toEqual(["absent"])
  })

  test("output order doesn't depend on input order", () => {
    const head = fp({ "Fx.kt": original, "B.kt": "x\nval d: Double = 1.0" }, [finding("Fx.kt", 5), finding("B.kt", 2)])
    expect(compareWithBaseline(base, [...head].reverse())).toEqual(compareWithBaseline(base, head))
  })
})

describe("per-file count fallback", () => {
  const noLocation = (path: string, n: number): Result[] =>
    Array.from({ length: n }, (_, i) => ({ ruleId: "dup/block", message: { text: `duplicate ${i}` }, locations: [{ physicalLocation: { artifactLocation: { uri: path } } }] }))

  test("a rising count makes every result in that file new", () => {
    const c = compareWithBaseline(noLocation("A.kt", 2), noLocation("A.kt", 3))
    expect(c.results.map((r) => r.baselineState)).toEqual(["new", "new", "new"])
  })

  test("the same or a lower count is unchanged, and the drop is absent", () => {
    expect(compareWithBaseline(noLocation("A.kt", 2), noLocation("A.kt", 2)).results.map((r) => r.baselineState)).toEqual(["unchanged", "unchanged"])
    const lower = compareWithBaseline(noLocation("A.kt", 2), noLocation("A.kt", 1))
    expect(lower.results.map((r) => r.baselineState)).toEqual(["unchanged"])
    expect(lower.absent).toHaveLength(1)
  })

  test("counts are per file", () => {
    const c = compareWithBaseline(noLocation("A.kt", 2), [...noLocation("A.kt", 1), ...noLocation("B.kt", 1)])
    expect(c.results.map((r) => `${r.locations?.[0]?.physicalLocation?.artifactLocation?.uri}:${r.baselineState}`)).toEqual(["A.kt:unchanged", "B.kt:new"])
  })

  test("a tool flagged as unstable is compared by counts even with fingerprints", () => {
    const base = fp({ "Fx.kt": original }, [finding("Fx.kt", 5)])
    const head = fp({ "Fx.kt": original.replace("1.1", "1.2") }, [finding("Fx.kt", 5)], false)
    expect(compareWithBaseline(base, head, { unstableLocations: true }).results.map((r) => r.baselineState)).toEqual(["unchanged"])
  })
})

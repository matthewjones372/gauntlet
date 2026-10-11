import type { Baseline } from "@gauntlet/sarif"
import { describe, expect, test } from "bun:test"
import { renderBaselineSummary, summarizeBaseline } from "../src/baseline-summary.ts"
import { compiled } from "./fixtures.ts"

// `gauntlet explain baseline`: what a repository's baseline holds, so the bar
// each change is held to is visible rather than buried in a SARIF file.

const POLICY = `gauntlet "bank"
use jvm in "svc", "lib", "checks"
owners @p
gates {
  verify { coverage ratchet >= 80% on changed }
  money  { mutation >= 60% on changed }
}
`

const finding = (ruleId: string, uri: string) => ({
  ruleId, message: { text: ruleId }, locations: [{ physicalLocation: { artifactLocation: { uri } } }],
})

const baseline: Baseline = {
  commit: "33df360ea5a454e8ec56bb45a6143930f083cd51",
  irHash: "h",
  gauntletVersion: "0.1.0-rc.22",
  metrics: {
    coverage: {
      value: 58.45, unit: "%", higherIsBetter: true,
      perFile: { "svc/A.kt": 0, "svc/B.kt": 95, "svc/C.kt": 40, "lib/D.kt": 100, "lib/E.kt": 79.9 },
    },
    "integrity/executed-tests": { value: 242, unit: "count", higherIsBetter: true },
  },
  legacy: [],
  testIds: ["t1", "t2", "t3"],
  results: {
    detekt: [
      finding("detekt.style.MaxLineLength", "svc/A.kt"),
      finding("detekt.style.MaxLineLength", "svc/A.kt"),
      finding("detekt.style.MaxLineLength", "lib/D.kt"),
      finding("detekt.style.MagicNumber", "svc/A.kt"),
    ],
    "kotlin-arch": [],
  },
}

const { ir } = compiled(POLICY)

describe("baseline summary", () => {
  test("says where the baseline was recorded and how many tests it knows", () => {
    const s = summarizeBaseline(baseline, ir)
    expect(s.commit).toBe("33df360ea5a4")
    expect(s.gauntletVersion).toBe("0.1.0-rc.22")
    expect(s.tests).toBe(3)
  })

  test("counts grandfathered findings by tool and rule, most first, and leaves out tools with none", () => {
    const s = summarizeBaseline(baseline, ir)
    expect(s.findings).toEqual([{
      tool: "detekt", total: 4,
      rules: [{ rule: "detekt.style.MaxLineLength", count: 3 }, { rule: "detekt.style.MagicNumber", count: 1 }],
      files: [{ path: "svc/A.kt", count: 3 }, { path: "lib/D.kt", count: 1 }],
    }])
  })

  test("names the lowest files of a per-file metric, and how many sit below the policy's floor", () => {
    const coverage = summarizeBaseline(baseline, ir, { lowest: 2 }).metrics.find((m) => m.name === "coverage")!
    expect(coverage.value).toBe(58.45)
    expect(coverage.files).toBe(5)
    expect(coverage.lowest).toEqual([{ path: "svc/A.kt", value: 0 }, { path: "svc/C.kt", value: 40 }])
    expect(coverage.floor).toEqual({ value: 80, scope: "changed", below: 3 })
  })

  test("warns when the whole project sits below the floor changed code must meet", () => {
    const s = summarizeBaseline(baseline, ir)
    expect(s.warnings).toContain(
      "coverage is 58.45% across the project, below the 80% changed code must meet: 3 of 5 files are under it.",
    )
  })

  test("warns about a build with no per-file value recorded, so its files are held to nothing", () => {
    expect(summarizeBaseline(baseline, ir).warnings).toContain(
      "coverage has no value for any file in checks: changes there are held only to the policy's floor.",
    )
  })

  test("a metric the policy sets no floor for is listed without one", () => {
    const tests = summarizeBaseline(baseline, ir).metrics.find((m) => m.name === "integrity/executed-tests")!
    expect(tests).toEqual({ name: "integrity/executed-tests", value: 242, unit: "count", higherIsBetter: true })
  })

  test("renders as plain text a person can read", () => {
    const text = renderBaselineSummary(summarizeBaseline(baseline, ir, { lowest: 2 }))
    expect(text).toContain("Recorded at 33df360ea5a4 by Gauntlet 0.1.0-rc.22; 3 tests ran there.")
    expect(text).toContain("coverage: 58.45% (5 files; 3 below the 80% floor on changed code)")
    expect(text).toContain("  lowest:\n    0%     svc/A.kt\n    40%    svc/C.kt")
    expect(text).toContain("detekt: 4 grandfathered findings")
    expect(text).toContain("  detekt.style.MaxLineLength 3")
    expect(text).toContain("  most in:\n    3      svc/A.kt\n    1      lib/D.kt")
    expect(text).toContain("Warnings:")
  })

  test("a baseline with nothing grandfathered says so", () => {
    const clean: Baseline = { ...baseline, results: {}, metrics: {} }
    expect(renderBaselineSummary(summarizeBaseline(clean, ir))).toContain("No grandfathered findings.")
  })
})

import { describe, expect, test } from "bun:test"
import type { Result } from "@gauntlet/sarif"
import { deadCodeFindings, moduleNames, renderPruneCode, unusedCode } from "../src/index.ts"

// Spec 0017 §5: `gauntlet prune code` lists dead-code findings and code no
// test ran that nothing in the project names. It only lists.

const finding = (ruleId: string, uri: string, line: number, text: string): Result => ({
  ruleId, level: "warning", message: { text }, locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: line } } }],
})

describe("deadCodeFindings", () => {
  test("keeps dead-code rules from every tool, once each, in path and line order", () => {
    const found = deadCodeFindings({
      knip: [finding("dead-code/unused-export", "src/b.ts", 3, "unused export: x"), finding("dead-code/unused-file", "src/a.ts", 1, "unused file")],
      detekt: [finding("UnusedPrivateMember", "src/main/kotlin/A.kt", 2, "lint, not dead-code"), finding("dead-code/unused-private-function", "src/main/kotlin/A.kt", 9, "unused private function f")],
      rustc: [finding("dead-code/unused-function", "src/a.ts", 1, "unused file"), finding("dead-code/unused-function", "src/a.ts", 1, "unused file")],
    })
    expect(found.map((f) => `${f.tool} ${f.path}:${f.line} ${f.rule}`)).toEqual([
      "knip src/a.ts:1 dead-code/unused-file",
      "rustc src/a.ts:1 dead-code/unused-function",
      "knip src/b.ts:3 dead-code/unused-export",
      "detekt src/main/kotlin/A.kt:9 dead-code/unused-private-function",
    ])
  })
})

describe("moduleNames", () => {
  test("a file by its name; an index file by its folder", () => {
    expect(moduleNames("src/fx/rates.ts")).toEqual(["rates"])
    expect(moduleNames("src/fx/index.ts")).toEqual(["fx"])
    expect(moduleNames("src/money-utils.ts")).toEqual(["money-utils"])
  })
})

describe("unusedCode", () => {
  const declared = (...names: string[]) => names.map((name, i) => ({ name, line: i + 1, kind: "function" }))

  test("a file nothing names, nor anything it declares, is listed whole", () => {
    const r = unusedCode(
      [{ path: "src/legacy.ts", survey: { declared: declared("oldRate") } }],
      [{ path: "src/legacy.ts", text: "export function oldRate() {}" }, { path: "src/money.ts", text: "export const add = 1" }],
    )
    expect(r.candidates).toEqual([{ path: "src/legacy.ts", kind: "file", why: "no test ran it, and no other file names it or anything it declares" }])
  })

  test("in a file something names, only what nothing names is listed", () => {
    const r = unusedCode(
      [{ path: "src/rates.ts", survey: { declared: declared("usedRate", "forgotten", "helper", "caller") } }],
      [
        { path: "src/rates.ts", text: "export const usedRate = 1\nexport function forgotten() {}\nexport function helper() {}\nexport function caller() { helper() }" },
        { path: "src/money.ts", text: "import { usedRate } from \"./rates\"\nimport { caller } from \"./rates\"" },
      ],
    )
    expect(r.candidates).toEqual([{ path: "src/rates.ts", name: "forgotten", kind: "function", line: 2, why: "no test ran its file, and nothing in the project names it" }])
  })

  test("a file whose name another file mentions isn't listed whole", () => {
    const r = unusedCode(
      [{ path: "src/money-utils.ts", survey: { declared: [] } }],
      [{ path: "src/money-utils.ts", text: "" }, { path: "src/app.ts", text: "import \"./money-utils\"" }],
    )
    expect(r.candidates).toEqual([])
  })

  test("a member is listed under its class, and not again when the class is", () => {
    const members = [{ name: "Fx", line: 1, kind: "class" }, { name: "convert", line: 2, kind: "method", in: "Fx" }, { name: "unused", line: 3, kind: "method", in: "Fx" }]
    const named = unusedCode(
      [{ path: "src/fx.ts", survey: { declared: members } }],
      [{ path: "src/fx.ts", text: "class Fx { convert() {} unused() {} }" }, { path: "src/use.ts", text: "new Fx().convert()" }],
    )
    expect(named.candidates.map((c) => c.name)).toEqual(["Fx.unused"])
    const unnamed = unusedCode(
      [{ path: "src/fx.ts", survey: { declared: [...members, { name: "Other", line: 5, kind: "class" }] } }],
      [{ path: "src/fx.ts", text: "class Fx { convert() {} unused() {} } class Other {}" }, { path: "src/use.ts", text: "new Other()" }],
    )
    expect(unnamed.candidates.map((c) => c.name)).toEqual(["Fx"])
  })

  test("a file left out is never listed, and says why", () => {
    const r = unusedCode([{ path: "src/start.ts", survey: { declared: [], leftOut: "it runs code when it's loaded" } }], [{ path: "src/start.ts", text: "main()" }])
    expect(r.candidates).toEqual([])
    expect(r.leftOut).toEqual([{ path: "src/start.ts", why: "it runs code when it's loaded" }])
  })
})

describe("renderPruneCode", () => {
  test("lists both kinds with why, and says it changed nothing", () => {
    const text = renderPruneCode({
      deadCode: { commit: "c0ffee1234567890", findings: [{ path: "src/money.ts", line: 4, rule: "dead-code/unused-export", tool: "knip", message: "unused export: legacyAdd" }] },
      unused: {
        commit: "c0ffee1234567890", notRun: 3,
        candidates: [
          { path: "src/legacy.ts", kind: "file", why: "no test ran it, and no other file names it or anything it declares" },
          { path: "src/rates.ts", name: "forgotten", kind: "function", line: 2, why: "no test ran its file, and nothing in the project names it" },
        ],
        leftOut: [{ path: "src/start.ts", why: "it runs code when it's loaded" }],
      },
    })
    expect(text).toContain("Dead code the dead-code gate found, as recorded at c0ffee123456 (1):\n  src/money.ts:4 dead-code/unused-export: knip reports unused export: legacyAdd.")
    expect(text).toContain("Code no test ran and nothing in the project names (2; from the map of what the tests executed at c0ffee123456):")
    expect(text).toContain("  src/legacy.ts: no test ran it, and no other file names it or anything it declares.")
    expect(text).toContain("  src/rates.ts:2 function forgotten: no test ran its file, and nothing in the project names it.")
    expect(text).toContain("Left out 1 file no test ran")
    expect(text).toContain("Gauntlet hasn't changed anything, and it affects no check.")
  })

  test("says why there's nothing to read", () => {
    const text = renderPruneCode({ deadCode: { missing: "the policy has no dead-code gate" }, unused: { missing: "the baseline records no map" } })
    expect(text).toContain("No dead-code findings to list: the policy has no dead-code gate.")
    expect(text).toContain("No code no test runs to list: the baseline records no map.")
  })

  test("says when the gate found nothing and every file ran", () => {
    const text = renderPruneCode({ deadCode: { commit: "c0ffee1234567890", findings: [] }, unused: { commit: "c0ffee1234567890", notRun: 0, candidates: [], leftOut: [] } })
    expect(text).toContain("The dead-code gate found nothing when the baseline was recorded at c0ffee123456.")
    expect(text).toContain("Every source file the map covers ran in some test")
  })
})

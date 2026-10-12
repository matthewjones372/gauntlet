import { describe, expect, test } from "bun:test"
import { compilePolicy, formatDiagnostics } from "../src/index.ts"
import { installed } from "./fixtures/catalog.ts"

// `only tests changed`: a review condition that holds when every changed file is a test.

const policy = (review: string, extra = "") => `gauntlet "svc"
use jvm
owners @platform
protect { tests "src/test/**" }
suites { unit "src/test/**" }
gates { verify { unit } }
${extra}review {
${review}
}
`
const compile = (text: string) => compilePolicy({ file: ".gauntlet/policy.gx", text }, installed)

describe("only tests changed", () => {
  test("compiles to its own fact condition in a review rule", () => {
    const r = compile(policy("  owner when zone touched\n  auto when only tests changed and no zone touched and all gates pass"))
    if (r._tag === "Invalid") throw new Error(formatDiagnostics(r.diagnostics, ""))
    const rule = r.compiled.ir.review.find((x) => x.tier === "auto")
    expect(rule?.conditions.map((c) => c.kind).sort()).toEqual(["all-gates-pass", "no-zone-touched", "only-tests-changed"])
    expect(rule?.conditions.find((c) => c.kind === "only-tests-changed")).toEqual({ kind: "only-tests-changed" })
  })

  test("works inside a predicate", () => {
    const r = compile(policy("  auto when tests_only and all gates pass", "predicate tests_only = only tests changed and no zone touched\n"))
    if (r._tag === "Invalid") throw new Error(formatDiagnostics(r.diagnostics, ""))
    expect(r.compiled.ir.predicates.map((p) => [p.name, p.conditions.map((c) => c.kind).sort()])).toEqual([["tests_only", ["no-zone-touched", "only-tests-changed"]]])
  })

  test("is offered for a near miss", () => {
    const r = compile(policy("  auto when only test changed"))
    expect(r._tag).toBe("Invalid")
    if (r._tag !== "Invalid") return
    const d = r.diagnostics.find((x) => x.code === "unknown-condition")
    expect(d?.message).toBe("Unknown condition 'only test changed'.")
    expect(d?.expected).toContain("'only tests changed'")
  })

  test("an auto rule that also needs a protected change still can never win", () => {
    const r = compile(policy("  auto when only tests changed and protected changed"))
    expect(r._tag).toBe("Invalid")
    if (r._tag !== "Invalid") return
    expect(r.diagnostics.map((d) => d.code)).toContain("rule-never-wins")
  })

  test("a predicate named `only` still parses", () => {
    const r = compile(policy("  auto when only and all gates pass", "predicate only = diff < 10 lines\n"))
    if (r._tag === "Invalid") throw new Error(formatDiagnostics(r.diagnostics, ""))
    expect(r.compiled.ir.review[0]?.conditions).toContainEqual({ kind: "predicate", name: "only" })
  })
})

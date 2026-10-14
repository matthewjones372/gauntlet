import { describe, expect, test } from "bun:test"
import { compilePolicy, formatDiagnostics, POLICY_REFERENCE } from "../src/index.ts"
import { installed } from "./fixtures/catalog.ts"

// `code removed` (spec 0017 §2): a review condition that holds when the change
// only deletes main code and removes no test.

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

describe("code removed", () => {
  test("compiles to its own fact condition in a review rule", () => {
    const r = compile(policy("  owner when zone touched\n  auto when code removed and no zone touched and all gates pass"))
    if (r._tag === "Invalid") throw new Error(formatDiagnostics(r.diagnostics, ""))
    const rule = r.compiled.ir.review.find((x) => x.tier === "auto")
    expect(rule?.conditions.map((c) => c.kind).sort()).toEqual(["all-gates-pass", "code-removed", "no-zone-touched"])
    expect(rule?.conditions.find((c) => c.kind === "code-removed")).toEqual({ kind: "code-removed" })
  })

  test("works inside a predicate", () => {
    const r = compile(policy("  auto when pruned and all gates pass", "predicate pruned = code removed and no zone touched\n"))
    if (r._tag === "Invalid") throw new Error(formatDiagnostics(r.diagnostics, ""))
    expect(r.compiled.ir.predicates.map((p) => [p.name, p.conditions.map((c) => c.kind).sort()])).toEqual([["pruned", ["code-removed", "no-zone-touched"]]])
  })

  test("is offered for a near miss", () => {
    const r = compile(policy("  auto when codes removed"))
    expect(r._tag).toBe("Invalid")
    if (r._tag !== "Invalid") return
    const d = r.diagnostics.find((x) => x.code === "unknown-condition")
    expect(d?.message).toBe("Unknown condition 'codes removed'.")
    expect(d?.expected).toContain("'code removed'")
  })

  test("`removed` and `code` still work as names", () => {
    const r = compile(policy("  auto when removed and code", "predicate removed = diff < 10 lines\npredicate code = no zone touched\n"))
    if (r._tag === "Invalid") throw new Error(formatDiagnostics(r.diagnostics, ""))
    expect(r.compiled.ir.review[0]?.conditions).toContainEqual({ kind: "predicate", name: "removed" })
    expect(r.compiled.ir.review[0]?.conditions).toContainEqual({ kind: "predicate", name: "code" })
  })

  test("the agents' grammar reference lists it", () => {
    expect(POLICY_REFERENCE).toContain("code removed")
  })
})

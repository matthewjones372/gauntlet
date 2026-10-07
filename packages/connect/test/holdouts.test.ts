import { describe, expect, test } from "bun:test"
import { compilePolicy } from "@gauntlet/dsl"
import { goSpec } from "@gauntlet/pack-go"
import { denyRules, github } from "../src/index.ts"

// ADR 0019: holdouts run only in the evidence job and are out of the agent's reach.

const ir = (suites: string) => {
  const r = compilePolicy({ file: ".gauntlet/policy.gx", text: `gauntlet "x"\nuse go\nowners @p\nprotect { tests "**/*_test.go" }\nsuites {\n${suites}\n}\ngates { verify { unit } behaviour { acceptance } }\n` }, [goSpec])
  if (r._tag === "Invalid") throw new Error("policy doesn't compile")
  return r.compiled.ir
}
const WITH = ir(`  unit "**/*_test.go"\n  holdout "acceptance" paths "**/*_holdout_test.go" ci only`)
const WITHOUT = ir(`  unit "**/*_test.go"\n  holdout "acceptance" ci only`)
const workflow = (policy: typeof WITH) => github({ mode: "repo", ir: policy, files: ["go.mod"], gauntletVersion: "0.1.0", downloadUrl: "https://example.invalid/gauntlet" })[0]!.content

describe("holdouts in connect", () => {
  test("only the evidence job passes --holdouts, and only when a holdout names its files", () => {
    const w = workflow(WITH)
    expect(w.match(/--holdouts/g)?.length).toBe(1)
    expect(w).toContain(`check --policy-ref "$BASE" --head "$HEAD" --out gauntlet-out --no-record --holdouts`)
    expect(workflow(WITHOUT)).not.toContain("--holdouts")
  })

  test("Claude Code can't read, search or edit holdout files", () => {
    const rules = denyRules(WITH, [])
    for (const tool of ["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]) expect(rules).toContain(`${tool}(**/*_holdout_test.go)`)
    expect(denyRules(WITHOUT, []).some((r) => r.startsWith("Read("))).toBe(false)
  })
})

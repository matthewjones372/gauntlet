import { describe, expect, test } from "bun:test"
import { compilePolicy, POLICY_REFERENCE } from "../src/index.ts"
import { installed } from "./fixtures/catalog.ts"

describe("the policy reference for agents", () => {
  test("its example blocks compile together", () => {
    const blocks = POLICY_REFERENCE.slice(POLICY_REFERENCE.indexOf("\n\n") + 2, POLICY_REFERENCE.indexOf("\n\nReview conditions:"))
    const r = compilePolicy({ file: "p.gx", text: `gauntlet "reference"\nuse jvm\nowners @platform\n${blocks}\n` }, installed)
    expect(r._tag === "Invalid" ? r.diagnostics.map((d) => d.message) : []).toEqual([])
  })
})

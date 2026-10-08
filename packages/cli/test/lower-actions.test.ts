import { describe, expect, test } from "bun:test"
import { lowerActions } from "../src/app.ts"

// When recording the baseline would lower it, Gauntlet says what to do, fixing first.

describe("what to do when the baseline would get worse", () => {
  test("coverage: add tests first; accepting the lower value comes last and isn't recommended", () => {
    expect(lowerActions(["coverage"], false)).toEqual([
      "What you can do:",
      "  1. Add tests for the code whose coverage dropped. Commit it to trunk and run this again. (recommended)",
      "  2. Accept the lower values: gauntlet baseline --update --allow-lower",
      "     Not recommended: from then on the ratchet holds changes only to the lower values,",
      "     and the commit changes .gauntlet/, so it needs an owner's review.",
    ])
  })

  test("other metrics and new findings each get their own fix", () => {
    const lines = lowerActions(["coverage", "mutation", "mutation"], true)
    expect(lines).toContain("  2. Restore what made mutation worse. Commit it to trunk and run this again.")
    expect(lines).toContain("  3. Fix the new findings. Commit it to trunk and run this again.")
    expect(lines.some((l) => l.startsWith("  4. Accept the lower values"))).toBe(true)
  })
})

import { describe, expect, test } from "bun:test"
import { firstRunExplained } from "../src/app.ts"

// The first baseline says what it means, and how to get from failing to enforced.

describe("after the first baseline", () => {
  test("says what's grandfathered, what can't get worse, and how to switch to enforce", () => {
    const text = firstRunExplained("shadow", false)
    expect(text).toContain("The baseline is today's state of your project.")
    expect(text).toContain("a change can't make them worse")
    expect(text).toContain("Switch to mode enforce")
    expect(text).not.toContain("gauntlet baseline --update")
  })

  test("a failing project gets the order: fix, record again, then enforce", () => {
    const text = firstRunExplained("shadow", true)
    expect(text).toContain("  1. Fix them (Claude Code can: /gauntlet-fix).")
    expect(text).toContain("  2. Record the baseline again, so it starts clean: gauntlet baseline --update")
    expect(text).toContain("  3. Then enforce it")
  })
})

import { describe, expect, test } from "bun:test"
import { selftestConcurrency } from "../src/index.ts"

// Selftest fixtures are full checks, run a few at a time by core count.

describe("selftest concurrency", () => {
  test("three on four cores or more, two below", () => {
    expect(selftestConcurrency(4, undefined)).toBe(3)
    expect(selftestConcurrency(16, undefined)).toBe(3)
    expect(selftestConcurrency(2, undefined)).toBe(2)
  })

  test("GAUNTLET_SELFTEST_CONCURRENCY overrides it, if it's a positive whole number", () => {
    expect(selftestConcurrency(4, "1")).toBe(1)
    expect(selftestConcurrency(2, "6")).toBe(6)
    expect(selftestConcurrency(4, "0")).toBe(3)
    expect(selftestConcurrency(4, "lots")).toBe(3)
  })
})

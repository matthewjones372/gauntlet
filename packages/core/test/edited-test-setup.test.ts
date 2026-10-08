import { describe, expect, test } from "bun:test"
import { EXPECT } from "../src/selftest.ts"

// Edited tests run as edited (ADR 0021), so test setup that stops tests
// running counts as caught only when the change also blocks.

const report = (o: { nominated: boolean; executed: number; blocks: boolean }) => ({
  checks: [{ tests: { executed: o.executed } }],
  decision: { wouldBlock: o.blocks, nominations: o.nominated ? [{ rule: "protected-changed" }] : [] },
}) as never
const control = report({ nominated: false, executed: 4, blocks: false })
const verdict = (o: Parameters<typeof report>[0]) => EXPECT["edited-test-setup"](report(o), control).caught

describe("the edited-test-setup fixture", () => {
  test("caught: reviewed with every test running, or blocked when fewer run", () => {
    expect(verdict({ nominated: true, executed: 4, blocks: false })).toBe(true)
    expect(verdict({ nominated: true, executed: 1, blocks: true })).toBe(true)
  })

  test("missed: fewer tests run and nothing blocks, or no review at all", () => {
    expect(verdict({ nominated: true, executed: 1, blocks: false })).toBe(false)
    expect(verdict({ nominated: false, executed: 4, blocks: false })).toBe(false)
  })
})

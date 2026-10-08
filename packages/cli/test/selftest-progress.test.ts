import { afterEach, describe, expect, test } from "bun:test"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { renderSelftestText, type SelftestResult } from "../../core/src/selftest.ts"
import { baseRepo, cli } from "./harness.ts"

// A selftest is many full checks; it says what it's doing as it goes, and in a
// terminal the result is an aligned list rather than a Markdown table.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

describe("selftest progress", () => {
  test("the control, then each fixture as it starts and finishes, counted", async () => {
    const s = baseRepo()
    repos.push(s.r)
    s.r.git("checkout", "-q", "main")
    const b = await cli(["baseline", "--repo", s.r.dir, "--trunk", "main"])
    if (b.code !== 0) throw new Error(b.err)
    s.r.commit("baseline")
    const res = await cli(["selftest", "--repo", s.r.dir, "--only", "lowered-threshold,edited-baseline"])
    expect(res.err).toContain("Checking an empty change first (the control)")
    expect(res.err).toMatch(/ {2}control: \w+, \d+ tests ran \(\d+(ms|s)\)/)
    expect(res.err).toContain("Running 2 tamper fixtures, two at a time")
    expect(res.err).toContain("  running lowered-threshold...")
    expect(res.err).toMatch(/ {2}caught {2}(lowered-threshold|edited-baseline) \(owner, \d+(ms|s)\) {2}\[1\/2\]/)
    expect(res.err).toContain("[2/2]")
  }, 120000)
})

describe("selftest in a terminal", () => {
  const result = (caught: boolean): SelftestResult => ({
    base: "0123456789abcdef",
    control: { tier: "auto", wouldBlock: false, executed: 634, reasons: [] },
    fixtures: [
      { fixture: "deleted-test", description: "the change deletes the test \"a very long name\"", tier: "review", caught: true, why: "caught by a deleted-tests forbid" },
      { fixture: "added-suppression", description: "the change adds a // @ts-ignore", tier: caught ? "review" : "auto", caught, why: caught ? "caught by a new-suppressions forbid" : "expected a new-suppressions forbid" },
    ],
    notApplicable: [],
    passed: caught,
  })

  test("one aligned line per fixture, no table, descriptions only for misses", () => {
    expect(renderSelftestText(result(true))).toBe([
      "Gauntlet selftest at 0123456789ab",
      "",
      "Control (an empty change): auto, 634 tests ran.",
      "",
      "  caught  deleted-test       review  a deleted-tests forbid",
      "  caught  added-suppression  review  a new-suppressions forbid",
      "",
      "All 2 tamperings were caught.",
      "",
    ].join("\n"))
    const missed = renderSelftestText(result(false))
    expect(missed).toContain("  MISSED  added-suppression  auto    expected a new-suppressions forbid\n")
    expect(missed).toContain("the change adds a // @ts-ignore")
    expect(missed).toContain("1 of 2 tamperings were caught.")
    expect(missed).not.toContain("|")
  })
})

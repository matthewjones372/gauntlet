import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { MUTATION_COST, MUTATION_WHAT, SLOW_MUTATION_MS } from "@gauntlet/core"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { firstRunExplained } from "../src/app.ts"
import { slowMutationNote } from "../src/output.ts"
import { baseRepo, cli } from "./harness.ts"

// People meeting mutation testing for the first time are told what it is, why
// it makes checks take longer, and how to keep it quick: when setup finishes,
// in a report with a mutation check, and when a mutation run was slow.

describe("mutation testing explained", () => {
  test("setup explains it when the policy runs it, and only then", () => {
    expect(firstRunExplained("shadow", false, true)).toContain(`The policy runs mutation testing. ${MUTATION_WHAT} ${MUTATION_COST}`)
    expect(firstRunExplained("shadow", false)).not.toContain("The policy runs mutation testing")
  })

  test("a slow mutation run says why and how to speed it up; a quick one, or another check, says nothing", () => {
    expect(slowMutationNote("mutation", SLOW_MUTATION_MS + 5_000)).toContain("Mutation testing took 3m 05s. It runs your tests once for every bug it makes")
    expect(slowMutationNote("mutation", SLOW_MUTATION_MS - 1)).toBe("")
    expect(slowMutationNote("unit", SLOW_MUTATION_MS * 10)).toBe("")
  })

  test("a report without a mutation check has no explainer", async () => {
    const s = baseRepo()
    const repos: TempRepo[] = [s.r]
    try {
      s.r.write({ "src/main/App.kt": "class App { fun x() = 1 }\n" })
      s.r.commit("change")
      const out = join(s.r.dir, "out")
      await cli(["check", "--repo", s.r.dir, "--base", s.base, "--out", out, "--no-record"])
      expect(readFileSync(join(out, "gauntlet-report.md"), "utf8")).not.toContain("What's mutation testing")
    } finally {
      repos.forEach((r) => r.cleanup())
    }
  })
})

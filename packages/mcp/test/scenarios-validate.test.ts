import { afterEach, describe, expect, test } from "bun:test"
import { baseRepo, POLICY } from "../../cli/test/harness.ts"
import { scriptPack } from "../../core/test/script-pack.ts"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { session } from "./client.ts"

// Spec 0012 §1: the MCP validate tool checks the policy's scenario files too,
// so an agent drafting a policy with scenarios hears about a missing id.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

describe("MCP validate with scenarios", () => {
  test("a scenario without an id makes the policy invalid; with ids it's valid", async () => {
    const { r } = baseRepo()
    repos.push(r)
    const policy = POLICY.replace(`suites { unit "src/test/**" }`, `suites { unit "src/test/**" }\nscenarios "specs/*.feature"`)
    r.write({ ".gauntlet/policy.gx": policy, "specs/fx.feature": "Feature: FX\n  Scenario: no id\n    Given x\n" })
    const bad = await session([{ name: "validate" }], { repo: r.dir, packs: [scriptPack] })
    expect(bad.tool(0).value.valid).toBe(false)
    expect(bad.tool(0).value.diagnostics).toContain("specs/fx.feature:2:3  error[scenario-without-id]")

    r.write({ "specs/fx.feature": "Feature: FX\n  @FX-1\n  Scenario: has an id\n    Given x\n" })
    const good = await session([{ name: "validate" }], { repo: r.dir, packs: [scriptPack] })
    expect(good.tool(0).value.valid).toBe(true)
    expect(good.tool(0).value.diagnostics).not.toContain("error[")
  })
})

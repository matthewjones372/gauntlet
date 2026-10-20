import { describe, expect, test } from "bun:test"
import { compilePolicy } from "@gauntlet/dsl"
import { jvmSpec } from "@gauntlet/pack-jvm"
import { looseningsBetween } from "../src/index.ts"

// Spec 0020 §8: a blocking mutation gate over its budget isn't run, so a new or
// lower budget skips more changes. On an `advise` gate it blocks nothing either way.

const policy = (gate: string) => `gauntlet "svc"
use jvm
mode enforce
owners @platform
suites { unit "src/test/**" }
gates { verify { unit, ${gate} } }
`
const ir = (text: string) => {
  const r = compilePolicy({ file: ".gauntlet/policy.gx", text }, [jvmSpec])
  if (r._tag === "Invalid") throw new Error(r.diagnostics.map((d) => d.message).join("\n"))
  return r.compiled.ir
}
const between = (before: string, after: string) => looseningsBetween(ir(policy(before)), ir(policy(after))).map((l) => l.what)

describe("mutant budgets and loosening", () => {
  test("a new budget on a blocking gate is a loosening", () => {
    expect(between("mutation >= 60% on changed", "mutation >= 60% on changed max 150 mutants"))
      .toEqual(["gate mutation gets a budget of 150 mutants: a change over it isn't mutated"])
  })

  test("a lower budget loosens, a higher one doesn't", () => {
    expect(between("mutation >= 60% on changed max 300 mutants", "mutation >= 60% on changed max 150 mutants"))
      .toEqual(["gate mutation budget falls from 300 to 150 mutants: a change over it isn't mutated"])
    expect(between("mutation >= 60% on changed max 150 mutants", "mutation >= 60% on changed max 300 mutants")).toEqual([])
    expect(between("mutation >= 60% on changed max 150 mutants", "mutation >= 60% on changed")).toEqual([])
  })

  test("a budget on an advise gate is no loosening", () => {
    expect(between("mutation advise on changed", "mutation advise on changed max 50 mutants")).toEqual([])
  })
})

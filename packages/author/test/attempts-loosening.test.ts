import { describe, expect, test } from "bun:test"
import { compilePolicy } from "@gauntlet/dsl"
import { jvmSpec } from "@gauntlet/pack-jvm"
import { looseningsBetween } from "../src/index.ts"

// Raising an attempt limit gives an agent more blocked stops before an
// exhausted exit, so it loosens the policy (ADR 0026); lowering one tightens.

const BASE = `gauntlet "svc"
use jvm
mode enforce
owners @platform
suites { unit "src/test/**" }
gates { verify { unit } }
`

const ir = (text: string) => {
  const r = compilePolicy({ file: ".gauntlet/policy.gx", text }, [jvmSpec])
  if (r._tag === "Invalid") throw new Error(r.diagnostics.map((d) => d.message).join("\n"))
  return r.compiled.ir
}
const between = (before: string, after: string) => looseningsBetween(ir(BASE + before), ir(BASE + after)).map((l) => l.what)

describe("attempt limits and loosening", () => {
  test("raising either limit above the default is a loosening", () => {
    expect(between("", "attempts { unchanged 5 }")).toEqual(["the unchanged attempts limit rises from 3 to 5"])
    expect(between("", "attempts { total 20 }")).toEqual(["the total attempts limit rises from 8 to 20"])
  })

  test("raising a stated limit, or removing a lower one, is a loosening", () => {
    expect(between("attempts { unchanged 2, total 4 }", "attempts { unchanged 2, total 6 }")).toEqual(["the total attempts limit rises from 4 to 6"])
    expect(between("attempts { unchanged 2, total 4 }", "")).toEqual([
      "the unchanged attempts limit rises from 2 to 3",
      "the total attempts limit rises from 4 to 8",
    ])
  })

  test("lowering a limit, or stating the default, isn't", () => {
    expect(between("", "attempts { unchanged 1, total 2 }")).toEqual([])
    expect(between("", "attempts { unchanged 3, total 8 }")).toEqual([])
    expect(between("attempts { total 10 }", "attempts { total 9 }")).toEqual([])
  })
})

import { describe, expect, test } from "bun:test"
import { attemptLimits } from "@gauntlet/ir"
import { compilePolicy } from "../src/index.ts"
import { installed } from "./fixtures/catalog.ts"

// `attempts { unchanged 3, total 8 }`: how many blocked stops the agent hooks
// allow before an exhausted exit (ADR 0026). Without it the defaults apply and
// the policy (and its hash) is as before.

const compile = (extra: string) =>
  compilePolicy({ file: ".gauntlet/policy.gx", text: `gauntlet "x"\nuse jvm\nowners @p\ngates { fast { lint } }\n${extra}\n` }, installed)
const codes = (extra: string) => {
  const r = compile(extra)
  return r._tag === "Invalid" ? r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code) : []
}

describe("attempts", () => {
  test("states either limit, and the other keeps its default", () => {
    const both = compile("attempts { unchanged 2, total 5 }")
    expect(both._tag === "Compiled" && both.compiled.ir.attempts).toEqual({ unchanged: 2, total: 5 })
    const one = compile("attempts {\n  total 12\n}")
    expect(one._tag === "Compiled" && one.compiled.ir.attempts).toEqual({ total: 12 })
    expect(one._tag === "Compiled" && attemptLimits(one.compiled.ir)).toEqual({ unchanged: 3, total: 12 })
  })

  test("a policy without it gets the defaults, and its hash doesn't change", () => {
    const r = compile("")
    expect(r._tag === "Compiled" && "attempts" in r.compiled.ir).toBe(false)
    expect(r._tag === "Compiled" && attemptLimits(r.compiled.ir)).toEqual({ unchanged: 3, total: 8 })
    const empty = compile("attempts { }")
    expect(empty._tag === "Compiled" && empty.compiled.hash).toBe(r._tag === "Compiled" ? r.compiled.hash : "")
  })

  test("only whole numbers from 1, known limits, once each, and reachable", () => {
    expect(codes("attempts { unchanged 0 }")).toEqual(["wrong-attempt-limit"])
    expect(codes("attempts { unchanged 2.5 }")).toEqual(["wrong-attempt-limit"])
    expect(codes("attempts { unchnged 3 }")).toEqual(["unknown-attempt-limit"])
    expect(codes("attempts { total 9 total 10 }")).toEqual(["duplicate-attempt-limit"])
    expect(codes("attempts { unchanged 5, total 4 }")).toEqual(["unreachable-attempt-limit"])
    // The default unchanged limit (3) can't be above a stated total either.
    expect(codes("attempts { total 2 }")).toEqual(["unreachable-attempt-limit"])
    expect(codes("attempts { unchanged 1 }\nattempts { total 4 }")).toEqual(["duplicate-block"])
  })

  test("attempts still works as a name", () => {
    expect(compile(`predicate attempts = diff < 10 lines\nreview { auto when attempts }`)._tag).toBe("Compiled")
  })
})

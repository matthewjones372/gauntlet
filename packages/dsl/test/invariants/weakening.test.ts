import { describe, expect, test } from "bun:test"
import { DEFAULT_INTEGRITY } from "@gauntlet/ir"
import { compilePolicy } from "../../src/index.ts"
import { installed } from "../fixtures/catalog.ts"

// Design test: can a policy author (or an agent editing the policy) weaken a
// guarantee the compiler is responsible for? Each case must fail to weaken.

const compile = (text: string) => compilePolicy({ file: ".gauntlet/policy.gx", text }, installed)
const head = `gauntlet "x"\nuse jvm\nowners @p\ngates { fast { build } }\n`

describe("a policy cannot weaken compiler guarantees", () => {
  test(".gauntlet/** stays protected when the policy protects nothing", () => {
    const r = compile(head)
    if (r._tag !== "Compiled") throw new Error("expected success")
    expect(r.compiled.ir.protect).toContainEqual({ group: "gauntlet", kind: "gauntlet", globs: [".gauntlet/**"] })
  })

  test("a protect group cannot claim the reserved 'gauntlet' name", () => {
    expect(compile(`${head}protect { gauntlet "src/**" }\n`)._tag).toBe("Invalid")
  })

  test("listing a subset of integrity checks keeps every default", () => {
    const r = compile(`${head}integrity {\n  flag env branching\n}\n`)
    if (r._tag !== "Compiled") throw new Error("expected success")
    expect([...r.compiled.ir.integrity.forbid].sort()).toEqual([...DEFAULT_INTEGRITY.forbid].sort())
    expect([...r.compiled.ir.integrity.ratchet].sort()).toEqual([...DEFAULT_INTEGRITY.ratchet].sort())
    expect([...r.compiled.ir.integrity.flag].sort()).toEqual([...DEFAULT_INTEGRITY.flag].sort())
  })

  test("there is no syntax to switch an integrity check off", () => {
    expect(compile(`${head}integrity {\n  allow new skips\n}\n`)._tag).toBe("Invalid")
    expect(compile(`${head}integrity {\n  forbid no new skips\n}\n`)._tag).toBe("Invalid")
  })

  test("llm review cannot be a required gate", () => {
    expect(compile(`gauntlet "x"\nuse jvm\nowners @p\ngates { fast { build, llm review x3 } }\n`)._tag).toBe("Invalid")
  })

  test("advisory alone cannot stand in for gates", () => {
    expect(compile(`gauntlet "x"\nuse jvm\nowners @p\ngates { advisory { llm review x3 } }\n`)._tag).toBe("Invalid")
  })

  test("an auto rule cannot depend on facts that always nominate review", () => {
    for (const fact of ["evidence missing", "protected changed"]) {
      expect(compile(`${head}review {\n  auto when ${fact}\n}\n`)._tag).toBe("Invalid")
    }
  })

  test("holdouts must be CI only", () => {
    expect(compile(`${head}suites { holdout "h" }\n`)._tag).toBe("Invalid")
  })

  test("imports cannot read a pre-existing file instead of running a command", () => {
    expect(compile(`${head}import scan { command "cat results.sarif" }\n`)._tag).toBe("Invalid")
  })
})

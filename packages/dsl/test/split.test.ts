import { describe, expect, test } from "bun:test"
import { compilePolicy } from "../src/index.ts"
import { installed } from "./fixtures/catalog.ts"

// `split when diff > n lines` sets how big a change spread over several parts
// must be before the report suggests stacked pull requests. Without it the
// policy (and its hash) is as before.

const compile = (extra: string) =>
  compilePolicy({ file: ".gauntlet/policy.gx", text: `gauntlet "x"\nuse jvm\nowners @p\ngates { fast { lint } }\n${extra}\n` }, installed)

describe("split when diff > n lines", () => {
  test("sets the size, as the smallest change that gets the suggestion", () => {
    const r = compile("split when diff > 600 lines")
    expect(r._tag === "Compiled" && r.compiled.ir.split).toEqual({ lines: 601 })
    const at = compile("split when diff >= 600 lines")
    expect(at._tag === "Compiled" && at.compiled.ir.split).toEqual({ lines: 600 })
  })

  test("a policy without it has none, so its hash doesn't change", () => {
    const r = compile("")
    expect(r._tag === "Compiled" && "split" in r.compiled.ir).toBe(false)
  })

  test("only counts lines, and only above a size", () => {
    expect(compile("split when diff > 600 files")._tag).toBe("Invalid")
    expect(compile("split when diff < 600 lines")._tag).toBe("Invalid")
  })

  test("split still works as a name", () => {
    expect(compile(`predicate split = diff < 10 lines\nreview { auto when split }`)._tag).toBe("Compiled")
  })
})

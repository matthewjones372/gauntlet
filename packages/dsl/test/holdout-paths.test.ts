import { describe, expect, test } from "bun:test"
import { compilePolicy } from "../src/index.ts"
import { installed } from "./fixtures/catalog.ts"

// ADR 0019: a holdout may name its files with `paths`.

const compile = (suites: string) =>
  compilePolicy({ file: ".gauntlet/policy.gx", text: `gauntlet "x"\nuse jvm\nowners @p\nsuites {\n${suites}\n}\ngates { verify { h } }\n` }, installed)

describe("holdout paths", () => {
  test("paths compile to the holdout's globs, with an info saying where it runs", () => {
    const r = compile(`  holdout "h" paths "src/holdout/**", "src/accept/" ci only`)
    if (r._tag !== "Compiled") throw new Error("expected success")
    expect(r.compiled.ir.suites).toEqual([{ kind: "holdout", name: "h", ciOnly: true, globs: ["src/holdout/**", "src/accept/**"] }])
    expect(r.compiled.diagnostics.map((d) => d.code)).toContain("holdout-ci-only")
  })

  test("without paths the holdout is unchanged: no globs key, still pending", () => {
    const r = compile(`  holdout "h" ci only`)
    if (r._tag !== "Compiled") throw new Error("expected success")
    expect(r.compiled.ir.suites).toEqual([{ kind: "holdout", name: "h", ciOnly: true }])
    expect(r.compiled.diagnostics.map((d) => d.code)).toContain("not-executed-in-v1")
  })

  test("an invalid glob is an error", () => {
    expect(compile(`  holdout "h" paths "/abs/**" ci only`)._tag).toBe("Invalid")
  })

  test("paths don't excuse a missing `ci only`", () => {
    expect(compile(`  holdout "h" paths "src/holdout/**"`)._tag).toBe("Invalid")
  })
})

import { describe, expect, test } from "bun:test"
import { behaviourUnchanged, withoutComments } from "../src/index.ts"

// ADR 0023: a change to comments or documentation only has nothing to build.
// Narrow on purpose: a comment tools read counts as code.

describe("withoutComments", () => {
  test("drops line and block comments, keeps strings that look like comments", () => {
    expect(withoutComments("A.kt", "val a = 1 // one\n/* two */ val b = \"// not a comment\"")).toBe(`val a = 1 val b = "// not a comment"`)
    expect(withoutComments("a.py", "x = 1  # set x\ns = '# kept'")).toBe("x = 1 s = '# kept'")
    expect(withoutComments("A.scala", "/* outer /* nested */ still comment */ val x = 1")).toBe("val x = 1")
  })

  test("a regex literal with slashes isn't a comment", () => {
    expect(withoutComments("a.ts", "const re = /a\\/\\/b/ // tidy")).toBe("const re = /a\\/\\/b/")
  })

  test("a comment tools act on, or a language it doesn't know, counts as code", () => {
    expect(withoutComments("a.ts", "// @ts-expect-error\nconst x: number = 'a'")).toBeUndefined()
    expect(withoutComments("main.go", "//go:build linux\npackage main")).toBeUndefined()
    expect(withoutComments("A.scala", "val x = 1 // scalafix:ok")).toBeUndefined()
    expect(withoutComments("a.rb", "# hello")).toBeUndefined()
  })
})

describe("behaviourUnchanged", () => {
  const files = (base: Record<string, string>, head: Record<string, string>) => (side: "base" | "head", p: string) => Promise.resolve((side === "base" ? base : head)[p])

  test("only comments or docs changed", async () => {
    expect(await behaviourUnchanged([{ path: "Z.scala", status: "modified" }, { path: "README.md", status: "modified" }],
      files({ "Z.scala": "// old note\nobject Z" }, { "Z.scala": "// a clearer note\nobject Z" }))).toBe(true)
  })

  test("any code changed, a file added or deleted, or nothing changed at all, needs building", async () => {
    expect(await behaviourUnchanged([{ path: "Z.scala", status: "modified" }], files({ "Z.scala": "object Z" }, { "Z.scala": "object Y" }))).toBe(false)
    expect(await behaviourUnchanged([{ path: "New.scala", status: "added" }], files({}, { "New.scala": "// only a comment" }))).toBe(false)
    expect(await behaviourUnchanged([], files({}, {}))).toBe(false)
  })
})

import { describe, expect, test } from "bun:test"
import { parseProjectFixture } from "../src/index.ts"

describe("project fixture headers", () => {
  test("Expect and Description come from the text before the diff", () => {
    expect(parseProjectFixture("x", "Description: adds a skip\nExpect: finding new-skips\n\ndiff --git a/a b/a\n")).toEqual({ description: "adds a skip", expect: { kind: "finding", check: "new-skips" } })
    expect(parseProjectFixture("x", "Expect: tier >= owner\ndiff --git a/a b/a\n").expect).toEqual({ kind: "tier", atLeast: "owner" })
    expect(parseProjectFixture("lowers-coverage", "diff --git a/a b/a\n")).toEqual({ description: "lowers-coverage", expect: { kind: "blocked" } })
  })

  test("headers inside the diff don't count", () => {
    expect(parseProjectFixture("x", "diff --git a/a b/a\n+Expect: tier >= owner\n").expect).toEqual({ kind: "blocked" })
  })
})

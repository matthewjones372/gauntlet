import { describe, expect, test } from "bun:test"
import { parseAddedLines, parseNameStatus, parseNumstat } from "../src/index.ts"

describe("git output parsing", () => {
  test("numstat with a rename and a binary file", () => {
    const out = ["3\t1\tsrc/A.kt", "2\t0\t", "old/B.kt", "new/B.kt", "-\t-\timg.png", ""].join("\0")
    expect([...parseNumstat(out)]).toEqual([
      ["src/A.kt", { added: 3, removed: 1 }],
      ["new/B.kt", { added: 2, removed: 0 }],
      ["img.png", { added: 0, removed: 0 }],
    ])
  })

  test("added lines carry their head line numbers", () => {
    const out = [
      "diff --git a/src/A.kt b/src/A.kt",
      "--- a/src/A.kt",
      "+++ b/src/A.kt",
      "@@ -3,0 +4,2 @@ class A",
      "+  val x = 1",
      "+  val y = 2",
      "@@ -10 +12 @@",
      "-  old",
      "+  new",
      "diff --git a/gone.kt b/gone.kt",
      "--- a/gone.kt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
    ].join("\n")
    expect([...parseAddedLines(out)]).toEqual([
      ["src/A.kt", [{ line: 4, text: "  val x = 1" }, { line: 5, text: "  val y = 2" }, { line: 12, text: "  new" }]],
    ])
  })

  test("name-status with a copy keeps only the new file", () => {
    expect(parseNameStatus(["C100", "a.kt", "b.kt", "M", "c.kt", ""].join("\0"))).toEqual([
      { status: "added", path: "b.kt" },
      { status: "modified", path: "c.kt" },
    ])
  })
})

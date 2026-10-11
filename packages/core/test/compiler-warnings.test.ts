import { describe, expect, test } from "bun:test"
import { compilerWarningsRun, isCompilerWarnings, parseCompilerWarnings } from "../src/compiler-warnings.ts"

// Compiler warnings read from a build's output (spec 0010), in each
// compiler's own format, with paths relative to the checkout.

const DIR = "/work/checkout"

describe("compiler warnings", () => {
  test("kotlinc", () => {
    expect(parseCompilerWarnings(`> Task :compileKotlin\nw: file://${DIR}/src/main/kotlin/Fx.kt:16:38 Unchecked cast of 'Any' to 'List<String>'.\n`, DIR))
      .toEqual([{ path: "src/main/kotlin/Fx.kt", line: 16, column: 38, message: "Unchecked cast of 'Any' to 'List<String>'." }])
  })

  test("javac, with its lint category", () => {
    expect(parseCompilerWarnings(`${DIR}/src/main/java/Fx.java:12: warning: [unchecked] unchecked cast\n        return (List<String>) x;\n`, DIR))
      .toEqual([{ path: "src/main/java/Fx.java", line: 12, message: "unchecked cast", category: "unchecked" }])
  })

  test("scalac 2 through sbt", () => {
    expect(parseCompilerWarnings(`[warn] ${DIR}/src/main/scala/Fx.scala:5:15: private val rate in object Fx is never used\n[warn] one warning found\n`, DIR))
      .toEqual([{ path: "src/main/scala/Fx.scala", line: 5, column: 15, message: "private val rate in object Fx is never used" }])
  })

  test("scalac 3 through sbt: the message from the lines after the header, without the code quoted or its caret", () => {
    const out = [
      `[warn] -- [E198] Unused Symbol Warning: ${DIR}/src/main/scala/Fx.scala:5:8 -----------`,
      "[warn] 5 |    val unused = 1",
      "[warn]   |        ^^^^^^",
      "[warn]   |        unused local definition",
      "[warn] one warning found",
    ].join("\n")
    expect(parseCompilerWarnings(out, DIR)).toEqual([{ path: "src/main/scala/Fx.scala", line: 5, column: 8, message: "unused local definition" }])
  })

  test("colour codes, files outside the checkout and the same warning twice", () => {
    const out = [
      `\x1b[33mw: file://${DIR}/src/A.kt:1:1 Deprecated\x1b[0m`,
      "w: file:///elsewhere/B.kt:2:2 Not ours",
      `w: file://${DIR}/src/A.kt:1:1 Deprecated`,
      "BUILD SUCCESSFUL",
    ].join("\n")
    expect(parseCompilerWarnings(out, DIR)).toEqual([{ path: "src/A.kt", line: 1, column: 1, message: "Deprecated" }])
  })

  test("a SARIF run per compiler, recognised as compiler warnings", () => {
    const run = compilerWarningsRun("javac", `${DIR}/src/Fx.java:3: warning: [rawtypes] found raw type: List\n`, DIR)
    expect(isCompilerWarnings(run)).toBe(true)
    expect(isCompilerWarnings({ tool: { driver: { name: "detekt" } }, results: [] } as never)).toBe(false)
    expect(run.results).toEqual([{
      ruleId: "compiler/warning/rawtypes",
      level: "warning",
      message: { text: "found raw type: List" },
      locations: [{ physicalLocation: { artifactLocation: { uri: "src/Fx.java" }, region: { startLine: 3 } } }],
    }] as never)
  })

  test("one build's output read for each compiler finds each warning once, under its own compiler", () => {
    const out = `w: file://${DIR}/src/A.kt:1:1 Unchecked cast\n${DIR}/src/B.java:2: warning: [unchecked] unchecked call\n`
    expect(parseCompilerWarnings(out, DIR, "kotlinc").map((w) => w.path)).toEqual(["src/A.kt"])
    expect(parseCompilerWarnings(out, DIR, "javac").map((w) => w.path)).toEqual(["src/B.java"])
    expect(parseCompilerWarnings(out, DIR, "scalac")).toEqual([])
  })
})

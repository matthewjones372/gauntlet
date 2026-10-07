import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { parseDependencies } from "../src/dependencies.ts"
import { convertEslintJson, convertJestJson, parseLcov, parseStryker } from "../src/reports.ts"
import { enclosingSymbol, parseTs, stripLineComment } from "../src/syntax.ts"
import { isMainSource, isTestFile, packageManager, testRunner } from "../src/toolchain.ts"

describe("toolchain", () => {
  test("package manager from the lockfile", () => {
    expect(packageManager(["bun.lock"])).toBe("bun")
    expect(packageManager(["pnpm-lock.yaml"])).toBe("pnpm")
    expect(packageManager(["package-lock.json"])).toBe("npm")
  })
  test("test runner from dependencies", () => {
    expect(testRunner(new Set(["vitest"]), "npm")).toEqual(Option.some("vitest"))
    expect(testRunner(new Set(["jest"]), "bun")).toEqual(Option.some("jest"))
    expect(testRunner(new Set(), "bun")).toEqual(Option.some("bun"))
    expect(testRunner(new Set(), "npm")).toEqual(Option.none())
  })
  test("main source and test files", () => {
    expect(isTestFile("src/fx.test.ts")).toBe(true)
    expect(isTestFile("src/__tests__/fx.ts")).toBe(true)
    expect(isMainSource("src/fx.ts")).toBe(true)
    expect(isMainSource("vitest.config.ts")).toBe(false)
    expect(isMainSource("src/types.d.ts")).toBe(false)
    expect(isMainSource("node_modules/x/index.js")).toBe(false)
  })
})

describe("report parsers", () => {
  test("lcov, with absolute paths made relative", () => {
    const lcov = "TN:\nSF:/repo/src/fx.ts\nDA:1,3\nDA:2,0\nend_of_record\nSF:src/b.ts\nDA:5,1\nend_of_record\n"
    expect(parseLcov(lcov, "/repo").map((f) => [f.path, [...f.lines]])).toEqual([["src/fx.ts", [[1, true], [2, false]]], ["src/b.ts", [[5, true]]]])
  })
  test("jest JSON counts from test entries", () => {
    const json = JSON.stringify({ numTotalTests: 99, testResults: [{ name: "/repo/test/a.test.ts", assertionResults: [
      { fullName: "a works", status: "passed" }, { fullName: "a fails", status: "failed", failureMessages: ["Expected 1\nstack"] }, { fullName: "a later", status: "pending" },
    ] }] })
    const r = Option.getOrThrow(convertJestJson("unit", json, "/repo"))
    expect(r.counts).toEqual({ executed: 2, passed: 1, failed: 1, errored: 0, skipped: 1 })
    expect(r.run.results[0]?.message.text).toBe("a fails: Expected 1")
  })
  test("Stryker mutants", () => {
    const json = JSON.stringify({ files: { "src/fx.ts": { mutants: [{ status: "Killed", mutatorName: "ArithmeticOperator", location: { start: { line: 4 } } }, { status: "Survived", location: { start: { line: 5 } } }] } } })
    expect(Option.getOrThrow(parseStryker(json, "/repo")).map((m) => `${m.path}:${m.line}:${m.status}`)).toEqual(["src/fx.ts:4:Killed", "src/fx.ts:5:Survived"])
  })
  test("eslint JSON as SARIF", () => {
    const json = JSON.stringify([{ filePath: "/repo/src/a.ts", messages: [{ ruleId: "eqeqeq", message: "Use ===", line: 3, severity: 2 }] }])
    const run = Option.getOrThrow(convertEslintJson(json, "/repo"))
    expect(run.results.map((r) => `${r.ruleId}:${r.locations?.[0]?.physicalLocation?.artifactLocation?.uri}:${r.level}`)).toEqual(["eqeqeq:src/a.ts:error"])
  })
})

describe("dependencies and symbols", () => {
  test("package.json dependencies of every kind", () => {
    expect(parseDependencies("package.json", JSON.stringify({ dependencies: { effect: "4.0.1" }, devDependencies: { vitest: "^5" } }))).toEqual(["effect@4.0.1", "vitest@^5"])
    expect(parseDependencies("package.json", "{ not json")).toEqual([])
  })
  test("enclosing symbol and comment stripping", () => {
    const tree = parseTs("a.ts", "export class Fx {\n  convert() {\n    return 1\n  }\n}\nexport const rate = () => {\n  return 2\n}\n")
    expect(enclosingSymbol(tree, 3)).toBe("Fx.convert")
    expect(enclosingSymbol(tree, 7)).toBe("rate")
    expect(stripLineComment(`const u = "http://x" // note`)).toBe(`const u = "http://x" `)
    expect(stripLineComment("const t = `a // b` // c")).toBe("const t = `a // b` ")
  })
})

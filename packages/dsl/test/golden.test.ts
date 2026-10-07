import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { compilePolicy, type Diagnostic, formatDiagnostics } from "../src/index.ts"
import { installed } from "./fixtures/catalog.ts"
import { expectGolden } from "./golden.ts"

const root = join(import.meta.dir, "..", "..", "..")
const validDir = join(root, "examples", "policies", "valid")
const invalidDir = join(import.meta.dir, "cases", "invalid")
const goldenDir = join(import.meta.dir, "golden")
const FILE = ".gauntlet/policy.gx"

const gx = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".gx")).sort()

const expectWellFormed = (d: Diagnostic, text: string) => {
  expect(d.message.trim()).not.toBe("")
  expect(d.expected.trim()).not.toBe("")
  expect(d.fix.trim()).not.toBe("")
  const lines = text.split(/\r?\n/).length
  expect(d.span.line).toBeGreaterThanOrEqual(1)
  expect(d.span.line).toBeLessThanOrEqual(lines)
  expect(d.span.column).toBeGreaterThanOrEqual(1)
}

describe("valid policies compile to golden IR", () => {
  for (const name of gx(validDir)) {
    test(name, () => {
      const text = readFileSync(join(validDir, name), "utf8")
      const result = compilePolicy({ file: FILE, text }, installed)
      if (result._tag === "Invalid") throw new Error(formatDiagnostics(result.diagnostics, text))
      const { ir, hash, sourceMap, diagnostics } = result.compiled
      for (const d of diagnostics) expectWellFormed(d, text)
      const base = join(goldenDir, "valid", name.replace(/\.gx$/, ""))
      expectGolden(`${base}.ir.json`, `${JSON.stringify({ hash, ir }, null, 2)}\n`)
      expectGolden(`${base}.sourcemap.json`, `${JSON.stringify(sourceMap, null, 2)}\n`)
      expectGolden(`${base}.diagnostics.txt`, `${formatDiagnostics(diagnostics, text)}\n`)
    })
  }
})

describe("invalid policies produce golden diagnostics", () => {
  const cases = gx(invalidDir)
  test("there are at least 40 cases", () => expect(cases.length).toBeGreaterThanOrEqual(40))
  for (const name of cases) {
    test(name, () => {
      const text = readFileSync(join(invalidDir, name), "utf8")
      const result = compilePolicy({ file: FILE, text }, installed)
      expect(result._tag).toBe("Invalid")
      const diagnostics = result._tag === "Invalid" ? result.diagnostics : []
      expect(diagnostics.some((d) => d.severity === "error")).toBe(true)
      for (const d of diagnostics) expectWellFormed(d, text)
      expectGolden(join(goldenDir, "invalid", name.replace(/\.gx$/, ".txt")), `${formatDiagnostics(diagnostics, text)}\n`)
    })
  }
})

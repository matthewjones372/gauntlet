import { describe, expect, test } from "bun:test"
import { runRules } from "../src/rules.ts"

const lines = (rule: string, text: string) => runRules([rule], [{ path: "a.ts", text }]).map((r) => r.locations?.[0]?.physicalLocation?.region?.startLine)

describe("TypeScript rules", () => {
  test("no-floating-money", () => {
    expect(lines("ts.no-floating-money", "const price: number = 1\nconst count: number = 2\nfunction f(fee: number, n: number) {}\nconst total: bigint = 1n")).toEqual([1, 3])
  })
  test("no-let flags let and var, not const", () => {
    expect(lines("ts.no-let", "let a = 1\nconst b = 2\nvar c = 3")).toEqual([1, 3])
  })
  test("no-throw, no-any, no-non-null-assertion", () => {
    expect(lines("ts.no-throw", "function f() {\n  throw new Error('x')\n}")).toEqual([2])
    expect(lines("ts.no-any", "const a: any = 1\nconst b: unknown = 2")).toEqual([1])
    expect(lines("ts.no-non-null-assertion", "const n = x!.length\nconst m = x?.length")).toEqual([1])
  })
  test("no-array-mutation flags in-place methods only", () => {
    expect(lines("ts.no-array-mutation", "xs.push(1)\nconst ys = xs.map((x) => x)\nxs.sort()\nconst zs = [...xs].toSorted()")).toEqual([1, 3])
  })
})

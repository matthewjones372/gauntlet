import { describe, expect, test } from "bun:test"
import { compilePolicy } from "../src/index.ts"
import { installed } from "./fixtures/catalog.ts"

// `unit "src/test/**" affected`: a check runs the tests a change affects (spec 0013).

const compile = (suites: string, extra = "") =>
  compilePolicy({ file: ".gauntlet/policy.gx", text: `gauntlet "x"\nuse jvm\nowners @p\n${extra}suites {\n  ${suites}\n}\ngates { verify { unit } }\n` }, installed)
const compiled = (suites: string, extra = "") => {
  const r = compile(suites, extra)
  if (r._tag !== "Compiled") throw new Error(JSON.stringify(r))
  return r.compiled
}

describe("an affected suite", () => {
  test("affected marks the suite", () => {
    expect(compiled(`unit "src/test/**" affected`).ir.suites).toEqual([{ kind: "suite", name: "unit", location: "src/test/**", affected: true }])
  })

  test("without it the suite and the policy's hash are as before", () => {
    const plain = compiled(`unit "src/test/**"`)
    expect(plain.ir.suites).toEqual([{ kind: "suite", name: "unit", location: "src/test/**" }])
    expect(compiled(`unit "src/test/**" affected`).hash).not.toBe(plain.hash)
  })

  test("affected still works as a name", () => {
    expect(compile(`unit "src/test/**"`, `zone affected { paths "src/**" }\n`)._tag).toBe("Compiled")
  })
})

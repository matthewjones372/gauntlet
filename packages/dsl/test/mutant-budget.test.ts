import { describe, expect, test } from "bun:test"
import { compilePolicy } from "../src/index.ts"
import { installed } from "./fixtures/catalog.ts"

// Spec 0020 §1: a mutation gate scoped to the change takes a budget,
// `max <n> mutants`. Without it the IR, and the policy's hash, are as before.

const compile = (gates: string) =>
  compilePolicy({ file: ".gauntlet/policy.gx", text: `gauntlet "x"\nuse jvm\nowners @p\ngates { verify { ${gates} } }\n` }, installed)
const checks = (gates: string) => {
  const r = compile(gates)
  if (r._tag === "Invalid") throw new Error(r.diagnostics.map((d) => d.message).join("\n"))
  return r.compiled.ir.gates[0]!.checks
}
const codes = (gates: string) => {
  const r = compile(gates)
  return r._tag === "Invalid" ? r.diagnostics.map((d) => d.code) : []
}

describe("max <n> mutants", () => {
  test("compiles to the gate's max, with advise or a threshold, and before a zone", () => {
    expect(checks("mutation advise on changed max 150 mutants")).toEqual([{ kind: "gate", name: "mutation", ratchet: false, advise: true, scope: "changed", max: 150 }])
    expect(checks("mutation >= 60% on changed max 300 mutants")[0]).toMatchObject({ max: 300, threshold: { op: ">=", value: { value: 60, unit: "%" } } })
  })

  test("a gate without it has no max", () => {
    expect(checks("mutation advise on changed")[0]).not.toHaveProperty("max")
  })

  test("only the mutation gate takes it, only on changed, and only as a whole number of mutants", () => {
    expect(codes("lint max 150 mutants")).toContain("max-not-mutation")
    expect(codes("mutation advise max 150 mutants")).toContain("max-needs-changed")
    expect(codes("mutation advise on all max 150 mutants")).toContain("max-needs-changed")
    expect(codes("mutation advise on changed max 150 lines")).toContain("wrong-mutant-budget")
    expect(codes("mutation advise on changed max 150")).toContain("wrong-mutant-budget")
    expect(codes("mutation advise on changed max 1.5 mutants")).toContain("wrong-mutant-budget")
    expect(codes("mutation advise on changed max 0 mutants")).toContain("wrong-mutant-budget")
  })
})

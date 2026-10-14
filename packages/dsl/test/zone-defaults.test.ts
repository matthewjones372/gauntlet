import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { compilePolicy, formatDiagnostics } from "../src/index.ts"
import { installed } from "./fixtures/catalog.ts"
import { expectGolden } from "./golden.ts"

// Spec 0009 §1: checks every zone gets unless its own gates say otherwise, so a
// zone added later is covered the moment it's added; and a warning for a zone
// that gets nothing but an owner's review.

const FILE = ".gauntlet/policy.gx"
const HEAD = `gauntlet "x"\nuse jvm\nowners @platform\nsuites { unit "src/test/**" }\n`

const compile = (body: string) => compilePolicy({ file: FILE, text: `${HEAD}${body}` }, installed)
const compiled = (body: string) => {
  const r = compile(body)
  if (r._tag !== "Compiled") throw new Error(formatDiagnostics(r.diagnostics, `${HEAD}${body}`))
  return r.compiled
}
const errors = (body: string) => {
  const r = compile(body)
  return r._tag === "Invalid" ? r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code) : []
}
/** Each zone's gates, as `tier: check` lines. */
const zoneGates = (body: string) =>
  compiled(body).ir.gates.flatMap((t) => t.checks.flatMap((c) =>
    c.kind === "gate" && c.zone !== undefined
      ? [`${t.name}: ${c.name}${c.threshold ? ` ${c.threshold.op} ${c.threshold.value.value}${c.threshold.value.unit ?? ""}` : ""}${c.ratchet ? " ratchet" : ""} on ${c.scope} in zone ${c.zone}${c.zoneDefault ? " (default)" : ""}`]
      : []))

const ZONES = `zone money { paths "src/money/**" owner @pay }\nzone billing { paths "src/billing/**" owner @bill }\n`
const DEFAULTS = `zones {\n  coverage >= 90% on changed\n  mutation >= 60% on changed\n}\n`

describe("zone defaults", () => {
  test("a policy with a zones block compiles to golden IR", () => {
    const text = `${HEAD}${ZONES}${DEFAULTS}gates {\n  fast { build }\n  verify { unit, coverage ratchet, coverage >= 95% on changed in zone money }\n  advisory { llm review x2 }\n}\n`
    const r = compilePolicy({ file: FILE, text }, installed)
    if (r._tag !== "Compiled") throw new Error(formatDiagnostics(r.diagnostics, text))
    const base = join(import.meta.dir, "golden", "zone-defaults", "two-zones")
    expectGolden(`${base}.ir.json`, `${JSON.stringify({ hash: r.compiled.hash, ir: r.compiled.ir }, null, 2)}\n`)
    expectGolden(`${base}.sourcemap.json`, `${JSON.stringify(r.compiled.sourceMap, null, 2)}\n`)
    expectGolden(`${base}.diagnostics.txt`, `${formatDiagnostics(r.compiled.diagnostics, text)}\n`)
  })

  test("every zone gets each default; a zone's own gate for a check replaces that default only", () => {
    expect(zoneGates(`${ZONES}${DEFAULTS}gates {\n  fast { build }\n  verify { unit, coverage ratchet, coverage >= 95% on changed in zone money }\n}\n`).sort()).toEqual([
      "verify: coverage >= 90% on changed in zone billing (default)",
      "verify: coverage >= 95% on changed in zone money",
      "verify: mutation >= 60% on changed in zone billing (default)",
      "verify: mutation >= 60% on changed in zone money (default)",
    ])
  })

  test("a default goes into the first tier that runs that gate, else the last required tier", () => {
    const gates = zoneGates(`zone money { paths "src/money/**" owner @pay }\n${DEFAULTS}gates {\n  fast { build, coverage ratchet }\n  verify { unit }\n  advisory { llm review x2 }\n}\n`)
    expect(gates.sort()).toEqual([
      "fast: coverage >= 90% on changed in zone money (default)",
      "verify: mutation >= 60% on changed in zone money (default)",
    ])
  })

  test("a zone added later is covered the moment it's added", () => {
    const before = `zone money { paths "src/money/**" owner @pay }\n`
    const gates = `gates { verify { unit } }\n`
    expect(zoneGates(`${before}${DEFAULTS}${gates}`).filter((g) => g.includes("refunds"))).toEqual([])
    expect(zoneGates(`${before}zone refunds { paths "src/refunds/**" owner @pay }\n${DEFAULTS}${gates}`).filter((g) => g.includes("refunds")).sort()).toEqual([
      "verify: coverage >= 90% on changed in zone refunds (default)",
      "verify: mutation >= 60% on changed in zone refunds (default)",
    ])
  })

  test("the defaults are kept in the IR, and a policy without the block has none", () => {
    const withBlock = compiled(`${ZONES}${DEFAULTS}gates { verify { unit } }\n`).ir
    expect(withBlock.zoneDefaults?.map((c) => c.name)).toEqual(["coverage", "mutation"])
    const without = compiled(`zone money { paths "src/money/**" owner @pay rule kotlin.no-floating-money }\ngates { verify { unit } }\n`).ir
    expect("zoneDefaults" in without).toBe(false)
    expect(without.gates.flatMap((t) => t.checks).some((c) => c.kind === "gate" && c.zoneDefault === true)).toBe(false)
  })

  test("defaults with no zones add nothing", () => {
    expect(zoneGates(`${DEFAULTS}gates { verify { unit } }\n`)).toEqual([])
  })

  test("a zone default must be a gate that can run in a zone, for every zone, once", () => {
    const zone = `zone money { paths "src/money/**" owner @pay }\n`
    const gates = `gates { verify { unit } }\n`
    expect(errors(`${zone}zones { unit }\n${gates}`)).toEqual(["zone-default-suite"])
    expect(errors(`${zone}zones { coverage >= 90% in zone money }\n${gates}`)).toEqual(["zone-default-in-zone"])
    expect(errors(`${zone}zones { coverage >= 90%, coverage ratchet }\n${gates}`)).toEqual(["duplicate-zone-default"])
    expect(errors(`${zone}zones { arch }\n${gates}`)).toEqual(["not-zone-scopable"])
    expect(errors(`${zone}zones { coverag >= 90% }\n${gates}`)).toEqual(["unknown-gate"])
    expect(errors(`${zone}zones { coverage >= 90 }\n${gates}`)).toEqual(["wrong-unit"])
    expect(errors(`${zone}zones { coverage >= 90% }\n`)).toEqual(["zone-defaults-without-gates"])
    expect(errors(`${zone}zones { coverage >= 90% }\ngates { advisory { llm review x2 } }\n`)).toContain("zone-defaults-without-gates")
    expect(errors(`${zone}zones { coverage >= 90% }\nzones { mutation >= 60% }\n${gates}`)).toEqual(["duplicate-block"])
  })

  test("`on fail` can name a check that only zone defaults run", () => {
    expect(compile(`zone money { paths "src/money/**" owner @pay }\n${DEFAULTS}gates { verify { unit } }\non fail coverage { fix "Test the zone's changed lines." }\n`)._tag).toBe("Compiled")
  })

  test("zones is still a word inside an integrity list and a stack layer", () => {
    expect(compile(`gates { verify { unit } }\nstack { layer wiring { touches zones } }\n`)._tag).toBe("Compiled")
  })
})

describe("a gate limited to a zone is a check of its own", () => {
  test("coverage and coverage in a zone are not duplicates", () => {
    const r = compiled(`zone money { paths "src/money/**" owner @pay }\ngates { verify { unit, coverage ratchet, coverage >= 90% on changed in zone money } }\n`)
    expect(r.diagnostics.filter((d) => d.code === "duplicate-check")).toEqual([])
  })

  test("the same gate twice for one zone still is", () => {
    const r = compiled(`zone money { paths "src/money/**" owner @pay }\ngates { verify { unit, coverage >= 90% in zone money } more { coverage ratchet in zone money } }\n`)
    expect(r.diagnostics.filter((d) => d.code === "duplicate-check").map((d) => d.message)).toEqual([
      "'coverage in zone money' already runs in tier 'verify' (line 6).",
    ])
  })
})

describe("a zone that only gets an owner's review", () => {
  const warnings = (body: string) => compiled(body).diagnostics.filter((d) => d.code === "zone-only-review")

  test("is warned about, by name", () => {
    const found = warnings(`zone billing { paths "src/billing/**" owner @bill }\ngates { verify { unit } }\n`)
    expect(found.map((d) => [d.severity, d.message, d.span.line])).toEqual([
      ["warning", "Zone 'billing' only gets an owner's review; add checks or zone defaults.", 5],
    ])
  })

  test("not when the policy has zone defaults", () => {
    expect(warnings(`zone billing { paths "src/billing/**" owner @bill }\n${DEFAULTS}gates { verify { unit } }\n`)).toEqual([])
  })

  test("not when the zone has a gate, a rule or a budget of its own", () => {
    expect(warnings(`zone billing { paths "src/billing/**" owner @bill }\ngates { verify { unit, coverage >= 80% in zone billing } }\n`)).toEqual([])
    expect(warnings(`zone billing { paths "src/billing/**" owner @bill rule kotlin.no-floating-money }\ngates { verify { unit } }\n`)).toEqual([])
    expect(warnings(`zone billing { paths "src/billing/**" owner @bill }\nbudget load { command "./load.sh {json}" when zone billing touched p99 < 200ms }\ngates { verify { unit } perf { budget load } }\n`)).toEqual([])
  })

  test("only zones without checks are named", () => {
    const found = warnings(`zone money { paths "src/money/**" owner @pay }\nzone billing { paths "src/billing/**" owner @bill }\ngates { verify { unit, coverage >= 90% in zone money } }\n`)
    expect(found.map((d) => d.message)).toEqual(["Zone 'billing' only gets an owner's review; add checks or zone defaults."])
  })

  test("not on a policy with errors, whose errors come first", () => {
    const r = compile(`zone billing { paths "src/billing/**" owner @bill }\ngates { verify { unit, coverage >= 90% in zone biling } }\n`)
    expect(r._tag).toBe("Invalid")
    expect(r._tag === "Invalid" ? r.diagnostics.map((d) => d.code) : []).toEqual(["unknown-zone"])
  })
})

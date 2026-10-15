import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { compilePolicy, formatDiagnostics } from "../src/index.ts"
import { installed } from "./fixtures/catalog.ts"
import { expectGolden } from "./golden.ts"

// Spec 0012 §1, §2: `scenarios "<glob>"` names the scenario files, which are
// protected as a group of their own, and `scenarios` in a gate tier judges them.

const FILE = ".gauntlet/policy.gx"
const HEAD = `gauntlet "x"\nuse jvm\nmode enforce\nowners @platform\nsuites { unit "src/test/**" }\n`

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
const notes = (body: string) => compiled(body).diagnostics.map((d) => `${d.severity}:${d.code}`)

const SCENARIOS = `scenarios "specs/**/*.feature"\n`

describe("scenarios in the policy", () => {
  test("a policy with scenarios compiles to golden IR", () => {
    const text = `${HEAD}${SCENARIOS}gates {\n  verify { unit, mutation advise on changed }\n  behaviour { scenarios }\n}\n`
    const r = compilePolicy({ file: FILE, text }, installed)
    expect(r._tag === "Compiled" ? "Compiled" : formatDiagnostics(r.diagnostics, text)).toBe("Compiled")
    if (r._tag !== "Compiled") return
    const base = join(import.meta.dir, "golden", "scenarios", "behaviour-tier")
    expectGolden(`${base}.ir.json`, `${JSON.stringify({ hash: r.compiled.hash, ir: r.compiled.ir }, null, 2)}\n`)
    expectGolden(`${base}.sourcemap.json`, `${JSON.stringify(r.compiled.sourceMap, null, 2)}\n`)
    expectGolden(`${base}.diagnostics.txt`, `${formatDiagnostics(r.compiled.diagnostics, text)}\n`)
  })

  test("the scenario files are kept, and protected as the scenarios group", () => {
    const ir = compiled(`${SCENARIOS}gates { verify { unit }\n behaviour { scenarios } }\n`).ir
    expect(ir.scenarios).toEqual(["specs/**/*.feature"])
    expect(ir.protect.find((g) => g.group === "scenarios")).toEqual({ group: "scenarios", kind: "scenarios", globs: ["specs/**/*.feature"] })
  })

  test("`scenarios` and `scenarios advise` compile to the scenarios check", () => {
    const checks = (tier: string) => compiled(`${SCENARIOS}gates { verify { unit }\n behaviour { ${tier} } }\n`).ir.gates[1]!.checks
    expect(checks("scenarios")).toEqual([{ kind: "scenarios" }])
    expect(checks("scenarios advise")).toEqual([{ kind: "scenarios", advise: true }])
  })

  test("a policy without scenarios keeps its shape, so its hash doesn't move", () => {
    const ir = compiled(`gates { verify { unit } }\n`).ir
    expect("scenarios" in ir).toBe(false)
    expect(ir.protect.map((g) => g.group)).toEqual(["gauntlet"])
  })

  test("several globs, with or without commas", () => {
    expect(compiled(`scenarios "specs/**/*.feature", "docs/acceptance/*.feature"\ngates { verify { unit, scenarios } }\n`).ir.scenarios)
      .toEqual(["docs/acceptance/*.feature", "specs/**/*.feature"])
  })

  test("the check takes no ratchet, threshold, scope or zone", () => {
    expect(errors(`${SCENARIOS}gates { verify { unit, scenarios ratchet } }\n`)).toEqual(["scenarios-with-modifiers"])
    expect(errors(`${SCENARIOS}gates { verify { unit, scenarios on changed } }\n`)).toEqual(["scenarios-with-modifiers"])
    expect(errors(`${SCENARIOS}zone money { paths "src/money/**" owner @pay }\ngates { verify { unit, scenarios in zone money } }\n`)).toEqual(["scenarios-with-modifiers"])
  })

  test("the check needs scenario files to judge", () => {
    expect(errors(`gates { verify { unit, scenarios } }\n`)).toEqual(["scenarios-without-files"])
  })

  test("it can't be a zone default or sit in the advisory tier", () => {
    expect(errors(`${SCENARIOS}zone money { paths "src/money/**" owner @pay }\nzones { scenarios }\ngates { verify { unit, scenarios } }\n`)).toEqual(["zone-default-scenarios"])
    expect(errors(`${SCENARIOS}gates { verify { unit }\n advisory { scenarios } }\n`)).toEqual(["deterministic-check-in-advisory"])
  })

  test("a protect group can't take the scenarios group's name: it's a keyword", () => {
    expect(errors(`${SCENARIOS}protect { scenarios "docs/**" }\ngates { verify { unit, scenarios } }\n`).length).toBe(1)
  })

  test("`scenarios` appears once", () => {
    expect(errors(`${SCENARIOS}${SCENARIOS}gates { verify { unit, scenarios } }\n`)).toEqual(["duplicate-block"])
  })

  test("it says when the tests or the mutation gate run after the check", () => {
    expect(notes(`${SCENARIOS}gates {\n  behaviour { scenarios }\n  verify { unit, mutation advise on changed }\n}\n`))
      .toEqual(["warning:scenarios-before-mutation", "warning:scenarios-before-tests"])
  })

  test("without a mutation gate, it says no scenario can be proven", () => {
    expect(notes(`${SCENARIOS}gates { verify { unit, scenarios } }\n`)).toEqual(["info:scenarios-without-mutation"])
  })

  test("scenario files nothing judges are protected, and it says so", () => {
    expect(notes(`${SCENARIOS}gates { verify { unit } }\n`)).toEqual(["info:scenarios-not-judged"])
  })

  test("on fail can name the scenarios check", () => {
    const ir = compiled(`${SCENARIOS}gates { verify { unit, scenarios } }\non fail scenarios { fix "Change the code to do what the scenario says, not the scenario." }\n`).ir
    expect(ir.remediation).toEqual([{ gate: "scenarios", fix: "Change the code to do what the scenario says, not the scenario." }])
  })
})

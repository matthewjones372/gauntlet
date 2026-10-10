import { describe, expect, test } from "bun:test"
import { compilePolicy } from "../src/index.ts"
import { installed } from "./fixtures/catalog.ts"

// A budget can run only for a change that touches some code, and read the
// file its tool writes when it can't write to {json} (spec 0007).

const compile = (items: string, zones = `zone payments { paths "src/payments/**" }\n`) =>
  compilePolicy({ file: ".gauntlet/policy.gx", text: `gauntlet "x"\nuse jvm\nowners @p\n${zones}budget load {\n  command "./gradlew gatlingRun"\n  ${items}\n  p99 < 200ms\n}\ngates { perf { budget load } }\n` }, installed)
const budget = (items: string) => {
  const r = compile(items)
  if (r._tag !== "Compiled") throw new Error(JSON.stringify(r))
  return r.compiled.ir.budgets[0]!
}

describe("a budget's when and reads", () => {
  test("when zone, or when a path, is touched", () => {
    expect(budget("when zone payments touched").when).toEqual({ zone: "payments" })
    expect(budget(`when "load/**" touched`).when).toEqual({ glob: "load/**" })
  })

  test("reads names the tool's own file", () => {
    expect(budget(`reads "build/reports/gatling/*/js/stats.json"`).reads).toBe("build/reports/gatling/*/js/stats.json")
  })

  test("without them, the budget is as before", () => {
    const b = budget("")
    expect("when" in b || "reads" in b).toBe(false)
  })

  test("an unknown zone, a path outside the repository or two whens are errors", () => {
    expect(compile("when zone ledger touched")._tag).toBe("Invalid")
    expect(compile(`reads "../elsewhere/stats.json"`)._tag).toBe("Invalid")
    expect(compile(`when zone payments touched\n  when "load/**" touched`)._tag).toBe("Invalid")
  })

  test("reads still works as a name", () => {
    expect(compilePolicy({ file: ".gauntlet/policy.gx", text: `gauntlet "x"\nuse jvm\nowners @p\nzone reads { paths "src/**" }\ngates { fast { lint } }\n` }, installed)._tag).toBe("Compiled")
  })
})

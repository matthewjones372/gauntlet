import { describe, expect, test } from "bun:test"
import { compilePolicy } from "@gauntlet/dsl"
import { installed } from "../../dsl/test/fixtures/catalog.ts"
import { checkText, describeChanges } from "../src/apply.ts"

// What `gauntlet apply` lists before it writes a policy.

const ir = (body: string) => {
  const r = compilePolicy({ file: ".gauntlet/policy.gx", text: `gauntlet "svc"\nuse jvm\nowners @p\n${body}` }, installed)
  if (r._tag !== "Compiled") throw new Error("doesn't compile")
  return r.compiled.ir
}

describe("describeChanges", () => {
  test("zones and layer rules: new, changed and removed", () => {
    const before = ir(`zone money { paths "src/money/**" owner @pay }\nzone auth { paths "src/auth/**" }\narch { module domain must not depend on infra }\n`)
    const after = ir(`zone money { paths "src/money/**", "src/fx/**" owner @pay rule kotlin.no-floating-money }\nzone audit { paths "src/audit/**" }\narch { module domain must not depend on infra, web }\n`)
    expect(describeChanges(after, before)).toEqual([
      "New zone audit: src/audit/**; no owner",
      "Changed zone money: src/fx/**, src/money/**; owner @pay; rules kotlin.no-floating-money",
      "Removed zone auth",
      "Layer rule: domain must not depend on infra, web",
      "Loosens: zone auth removed",
    ])
  })

  test("checks read as policy text", () => {
    expect(checkText({ kind: "budget", budget: "api" })).toBe("budget api")
    expect(checkText({ kind: "llm-review", reviews: 3 })).toBe("llm review 3")
    expect(checkText({ kind: "holdout", name: "acceptance" })).toBe("acceptance")
  })
})

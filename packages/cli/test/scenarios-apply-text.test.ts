import { describe, expect, test } from "bun:test"
import { compilePolicy } from "@gauntlet/dsl"
import { jvmSpec } from "@gauntlet/pack-jvm"
import { describeChanges } from "../src/apply.ts"

// Spec 0012: what `gauntlet apply` says a policy with scenarios checks.

const ir = (gates: string) => {
  const r = compilePolicy({ file: ".gauntlet/policy.gx", text: `gauntlet "x"\nuse jvm\nowners @p\nsuites { unit "src/test/**" }\nscenarios "specs/*.feature"\ngates { ${gates} }\n` }, [jvmSpec])
  if (r._tag === "Invalid") throw new Error(r.diagnostics.map((d) => d.message).join("\n"))
  return r.compiled.ir
}

describe("apply's summary with scenarios", () => {
  test("names the check, and whether it only advises", () => {
    expect(describeChanges(ir("verify { unit, scenarios }"))).toContain("Checks (verify): scenarios, unit")
    expect(describeChanges(ir("verify { unit, scenarios advise }"), ir("verify { unit, scenarios }"))).toContain("Checks (verify): scenarios advise, unit")
  })
})

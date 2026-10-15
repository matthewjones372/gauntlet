import { describe, expect, test } from "bun:test"
import { compilePolicy } from "@gauntlet/dsl"
import { jvmSpec } from "@gauntlet/pack-jvm"
import { looseningsBetween } from "../src/index.ts"

// Spec 0012: scenarios that stop blocking, or scenario files that stop being
// protected, loosen the policy, and the authoring agent must say so.

const BASE = `gauntlet "svc"
use jvm
mode enforce
owners @platform
suites { unit "src/test/**" }
`

const ir = (text: string) => {
  const r = compilePolicy({ file: ".gauntlet/policy.gx", text }, [jvmSpec])
  if (r._tag === "Invalid") throw new Error(r.diagnostics.map((d) => d.message).join("\n"))
  return r.compiled.ir
}
const between = (before: string, after: string) => looseningsBetween(ir(BASE + before), ir(BASE + after)).map((l) => l.what)

describe("scenarios and loosening", () => {
  test("scenarios that only advise no longer block", () => {
    expect(between(`scenarios "specs/*.feature"\ngates { verify { unit, scenarios } }`, `scenarios "specs/*.feature"\ngates { verify { unit, scenarios advise } }`))
      .toEqual(["scenarios only advises: a scenario's verdict no longer blocks"])
  })

  test("removing the check, or the scenario files, loosens; adding them doesn't", () => {
    expect(between(`scenarios "specs/*.feature"\ngates { verify { unit, scenarios } }`, `scenarios "specs/*.feature"\ngates { verify { unit } }`))
      .toEqual(["scenarios is no longer a required gate"])
    expect(between(`scenarios "specs/*.feature"\ngates { verify { unit } }`, `gates { verify { unit } }`))
      .toEqual([`"specs/*.feature" is no longer protected as scenarios`])
    expect(between(`gates { verify { unit } }`, `scenarios "specs/*.feature"\ngates { verify { unit, scenarios } }`)).toEqual([])
  })
})

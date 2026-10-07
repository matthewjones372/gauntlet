import { describe, expect, test } from "bun:test"
import { compilePolicy } from "@gauntlet/dsl"
import { jvmSpec } from "@gauntlet/pack-jvm"
import { looseningsBetween } from "../src/index.ts"

const BASE = `gauntlet "svc"
use jvm
mode enforce
owners @platform, @leads
protect {
  tests  "src/test/**"
  config "*.gradle.kts"
}
zone money {
  paths "src/money/**", "src/fx/**"
  owner @payments
  rule kotlin.no-floating-money, kotlin.no-var
}
arch { module domain must not depend on infra, web }
suites { unit "src/test/**" }
gates {
  fast   { build, lint ratchet, arch }
  verify { unit, coverage >= 90%, mutation ratchet >= 80% on changed }
}
predicate small = diff < 150 lines and no zone touched
review {
  owner  when zone touched
  review when protected changed
  auto   when small and all gates pass
}
`

const ir = (text: string) => {
  const r = compilePolicy({ file: ".gauntlet/policy.gx", text }, [jvmSpec])
  if (r._tag === "Invalid") throw new Error(r.diagnostics.map((d) => d.message).join("\n"))
  return r.compiled.ir
}
const loosen = (edit: (t: string) => string) => looseningsBetween(ir(BASE), ir(edit(BASE))).map((l) => l.what)

describe("looseningsBetween", () => {
  test("nothing changed, or only tightened, is not loosening", () => {
    expect(loosen((t) => t)).toEqual([])
    expect(loosen((t) => t.replace("coverage >= 90%", "coverage >= 95%").replace(`"src/test/**"\n  config`, `"src/test/**", "src/it/**"\n  config`))).toEqual([])
    expect(loosen((t) => t.replace("diff < 150 lines", "diff < 100 lines"))).toEqual(["predicate small, which an auto or skim rule uses, changes"])
  })

  const cases: ReadonlyArray<[string, (t: string) => string, string]> = [
    ["mode", (t) => t.replace("mode enforce", "mode shadow"), "mode goes from enforce to shadow"],
    ["owner", (t) => t.replace("owners @platform, @leads", "owners @platform"), "policy owner @leads removed"],
    ["protection", (t) => t.replace(`  config "*.gradle.kts"\n`, ""), `"*.gradle.kts" is no longer protected as config`],
    ["zone path", (t) => t.replace(`"src/money/**", "src/fx/**"`, `"src/money/**"`), `zone money no longer covers "src/fx/**"`],
    ["zone owner", (t) => t.replace("  owner @payments\n", ""), "zone money loses owner @payments"],
    ["zone rule", (t) => t.replace(", kotlin.no-var", ""), "zone money drops rule kotlin.no-var"],
    ["arch", (t) => t.replace("infra, web", "infra"), "arch rule removed: domain must not depend on web"],
    ["gate", (t) => t.replace("build, lint ratchet, arch", "build, arch"), "gate lint is no longer a required gate"],
    ["ratchet", (t) => t.replace("lint ratchet", "lint"), "gate lint is no longer a ratchet"],
    ["threshold", (t) => t.replace("coverage >= 90%", "coverage >= 80%"), "gate coverage threshold changes from >= 90% to >= 80%"],
    ["threshold removed", (t) => t.replace("coverage >= 90%", "coverage"), "gate coverage loses its threshold (>= 90%)"],
    ["scope", (t) => t.replace("coverage >= 90%", "coverage >= 90% on changed"), "gate coverage now only measures changed code"],
    ["review rule", (t) => t.replace("  review when protected changed\n", ""), "review rule removed: review when protected-changed"],
    ["lenient rule", (t) => t.replace("  auto   when small", "  skim   when diff < 20 lines\n  auto   when small"), "new lenient review rule: skim when diff < 20 lines"],
    ["suite", (t) => t.replace(`suites { unit "src/test/**" }`, `suites { unit "src/test/unit/**" }`), "suite unit removed or changed"],
  ]
  for (const [name, edit, expected] of cases) {
    test(`flags: ${name}`, () => expect(loosen(edit)).toContain(expected))
  }
})

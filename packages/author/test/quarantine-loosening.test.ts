import { describe, expect, test } from "bun:test"
import { compilePolicy } from "@gauntlet/dsl"
import { jvmSpec } from "@gauntlet/pack-jvm"
import { looseningsBetween } from "../src/index.ts"

const ir = (quarantine: string) => {
  const r = compilePolicy({ file: ".gauntlet/policy.gx", text: `gauntlet "svc"\nuse jvm\nowners @p\ngates { fast { build } }\n${quarantine}` }, [jvmSpec])
  if (r._tag === "Invalid") throw new Error(r.diagnostics.map((d) => d.message).join("\n"))
  return r.compiled.ir
}
const q = (until: string) => `quarantine {\n  "svc.FxTest.rounding" until ${until} owner @payments\n}\n`

describe("quarantines and loosening", () => {
  test("quarantining a test, or extending its date, loosens; ending it early doesn't", () => {
    expect(looseningsBetween(ir(""), ir(q("2026-11-01"))).map((l) => l.what)).toEqual(["svc.FxTest.rounding is quarantined until 2026-11-01"])
    expect(looseningsBetween(ir(q("2026-11-01")), ir(q("2026-12-01"))).map((l) => l.what)).toEqual(["the quarantine of svc.FxTest.rounding is extended from 2026-11-01 to 2026-12-01"])
    expect(looseningsBetween(ir(q("2026-11-01")), ir(q("2026-10-01")))).toEqual([])
    expect(looseningsBetween(ir(q("2026-11-01")), ir(""))).toEqual([])
  })
})

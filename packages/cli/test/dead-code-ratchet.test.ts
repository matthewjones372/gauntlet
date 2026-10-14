import { afterEach, describe, expect, test } from "bun:test"
import { goPack } from "@gauntlet/pack-go"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, FileSystem, Option, Path } from "effect"
import { type GateImpl, type Pack } from "../../core/src/index.ts"
import { scriptPack } from "../../core/test/script-pack.ts"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { parseDeadcode } from "../../../packs/go/src/deadcode.ts"
import { cli } from "./harness.ts"

// Spec 0017 §4 end to end: dead code ratcheted like lint findings and compiler
// warnings. The baseline records today's; a change that adds some fails and
// names it; a finding that only moves isn't new. A stand-in for deadcode
// prints the repository's deadcode.json, read by the Go pack's parser and
// fingerprinted with the Go pack's locator, as the real gate's would be.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const deadcode: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const json = yield* fs.readFileString(path.join(ctx.dir, "deadcode.json")).pipe(Effect.orDie)
    yield* fs.writeFileString(path.join(ctx.outputDir, "deadcode.json"), json).pipe(Effect.orDie)
    return { command: ["deadcode", "-test", "-json", "./..."], exitCode: 0, runs: [Option.getOrThrow(parseDeadcode(json, ctx.dir))] }
  })
const pack: Pack = {
  ...scriptPack,
  spec: { ...scriptPack.spec, gates: [...scriptPack.spec.gates, { name: "dead-code", description: "dead code", produces: "violations", units: [], higherIsBetter: false, scopable: true, zoneScopable: true }] },
  gates: { ...scriptPack.gates, "dead-code": deadcode },
  ...(goPack.locate ? { locate: goPack.locate } : {}),
  ...(goPack.normalise ? { normalise: goPack.normalise } : {}),
}

const policy = (gates: string) => `gauntlet "svc"\nuse jvm\nmode enforce\nowners @p\ngates { fast { ${gates} } }\nreview { auto when all gates pass }\n`

const MONEY = "package money\n\n// Add adds.\nfunc Add(a, b int64) int64 { return a + b }\n\n// Sub is never called.\nfunc Sub(a, b int64) int64 { return a - b }\n"
const report = (funcs: ReadonlyArray<{ name: string; line: number }>) =>
  JSON.stringify([{ Name: "money", Path: "example.com/svc/money", Funcs: funcs.map((f) => ({ Name: f.name, Position: { File: "money/money.go", Line: f.line, Col: 6 }, Generated: false, Marker: false })) }])

const setup = (gates: string) => {
  const r = new TempRepo()
  repos.push(r)
  r.write({ ".gauntlet/policy.gx": policy(gates), "go.mod": "module example.com/svc\n\ngo 1.22\n", "money/money.go": MONEY, "deadcode.json": report([{ name: "Sub", line: 7 }]) })
  r.commit("some old dead code")
  return r
}
const check = async (r: TempRepo, base: string) => {
  const out = join(r.dir, "out")
  const res = await cli(["check", "--repo", r.dir, "--base", base, "--out", out, "--no-record"], [pack])
  const json = JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8"))
  return { res, deadCode: json.checks.find((c: { check: string }) => c.check === "dead-code"), violations: json.violations, advice: json.advice }
}
const baselined = async (gates: string) => {
  const r = setup(gates)
  expect((await cli(["baseline", "--repo", r.dir, "--trunk", "main"], [pack])).code).toBe(0)
  const base = r.commit("baseline")
  r.git("checkout", "-q", "-b", "change")
  return { r, base }
}

describe("a dead-code ratchet", () => {
  test("today's dead code is grandfathered: a change that adds none passes", async () => {
    const { r, base } = await baselined("dead-code ratchet")
    r.write({ "money/types.go": "package money\n\ntype Money struct{ Minor int64 }\n" })
    r.commit("no new dead code")
    const { deadCode } = await check(r, base)
    expect(deadCode.status).toBe("passed")
  })

  test("a change that adds dead code fails, and names it", async () => {
    const { r, base } = await baselined("dead-code ratchet")
    r.write({
      "money/money.go": `${MONEY}\nfunc helper() int { return 1 }\n`,
      "deadcode.json": report([{ name: "Sub", line: 7 }, { name: "helper", line: 9 }]),
    })
    r.commit("an unused helper")
    const { deadCode, violations } = await check(r, base)
    expect(deadCode.status).toBe("failed")
    expect(deadCode.reason).toBe("1 new finding not in the baseline")
    expect(violations).toEqual([{ check: "dead-code", ruleId: "dead-code/unreachable-func", message: "unreachable func: helper", path: "money/money.go", line: 9 }])
  })

  test("dead code that only moved down the file isn't new", async () => {
    const { r, base } = await baselined("dead-code ratchet")
    r.write({
      "money/money.go": MONEY.replace("package money\n", "package money\n\nimport \"fmt\"\n\nvar _ = fmt.Sprint\n"),
      "deadcode.json": report([{ name: "Sub", line: 11 }]),
    })
    r.commit("lines above the old dead code")
    const { deadCode } = await check(r, base)
    expect(deadCode.status).toBe("passed")
  })

  test("with old dead code moved and new dead code added, only the new is named: they're matched by fingerprint, not counted", async () => {
    const { r, base } = await baselined("dead-code ratchet")
    r.write({
      "money/money.go": `${MONEY.replace("package money\n", "package money\n\nimport \"fmt\"\n\nvar _ = fmt.Sprint\n")}\nfunc helper() int { return 1 }\n`,
      "deadcode.json": report([{ name: "Sub", line: 11 }, { name: "helper", line: 13 }]),
    })
    r.commit("moved, and an unused helper")
    const { deadCode, violations } = await check(r, base)
    expect(deadCode.status).toBe("failed")
    expect(violations).toEqual([{ check: "dead-code", ruleId: "dead-code/unreachable-func", message: "unreachable func: helper", path: "money/money.go", line: 13 }])
  })

  test("`dead-code advise` reports dead code without blocking", async () => {
    const { r, base } = await baselined("dead-code advise")
    r.write({ "money/types.go": "package money\n" })
    r.commit("a change")
    const { deadCode, violations, advice } = await check(r, base)
    expect(deadCode.status).toBe("passed")
    expect(deadCode.reason).toBe("1 finding, reported without blocking")
    expect(violations).toEqual([])
    expect(advice).toEqual([{ check: "dead-code", ruleId: "dead-code/unreachable-func", message: "unreachable func: Sub", path: "money/money.go", line: 7 }])
  })
})

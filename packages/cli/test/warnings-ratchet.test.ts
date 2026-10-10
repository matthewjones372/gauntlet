import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { compilerWarningsRun, type GateImpl, type Pack, ProcessRunner, warningsGate } from "../../core/src/index.ts"
import { scriptPack } from "../../core/test/script-pack.ts"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { cli } from "./harness.ts"

// Spec 0010 end to end: compiler warnings ratcheted like lint findings. The
// baseline records today's; a change that adds one fails and names it; the
// warnings check reads the build's own output, or compiles itself when no
// build ran. A stand-in compiler prints kotlinc's format from warnings.txt.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

// The build: "compiles", printing each line of warnings.txt as a kotlinc warning.
const compile: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const r = yield* (yield* ProcessRunner).run({ command: "sh", args: ["-c", `sed "s#^#w: file://$PWD/#" warnings.txt`], cwd: ctx.dir }).pipe(Effect.orDie)
    return { command: ["compile"], exitCode: r.exitCode, runs: [compilerWarningsRun("kotlinc", r.stdout, ctx.dir)] }
  })
const pack: Pack = {
  ...scriptPack,
  spec: { ...scriptPack.spec, gates: [...scriptPack.spec.gates, { name: "warnings", description: "compiler warnings", produces: "violations", units: [], higherIsBetter: false, scopable: true, zoneScopable: true }] },
  gates: { ...scriptPack.gates, build: compile, warnings: warningsGate((ctx) => compile({ kind: "gate", name: "build" } as never, ctx)) },
}

const policy = (gates: string) => `gauntlet "svc"\nuse jvm\nmode enforce\nowners @p\ngates { fast { ${gates} } }\nreview { auto when all gates pass }\n`

const setup = (gates: string) => {
  const r = new TempRepo()
  repos.push(r)
  r.write({
    ".gauntlet/policy.gx": policy(gates),
    "src/main/App.kt": "class App {\n  val x = y as List<String>\n}\n",
    "warnings.txt": "src/main/App.kt:2:11 Unchecked cast of 'Any' to 'List<String>'.\n",
  })
  r.commit("an old warning")
  return r
}
const check = async (r: TempRepo, base: string) => {
  const out = join(r.dir, "out")
  const res = await cli(["check", "--repo", r.dir, "--base", base, "--out", out, "--no-record"], [pack])
  const report = JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8"))
  return { res, warnings: report.checks.find((c: { check: string }) => c.check === "warnings"), violations: report.violations }
}
const baselined = async (gates: string) => {
  const r = setup(gates)
  expect((await cli(["baseline", "--repo", r.dir, "--trunk", "main"], [pack])).code).toBe(0)
  const base = r.commit("baseline")
  r.git("checkout", "-q", "-b", "change")
  return { r, base }
}

describe("a compiler warnings ratchet", () => {
  test("today's warnings are grandfathered: a change that adds none passes", async () => {
    const { r, base } = await baselined("build, warnings ratchet")
    r.write({ "src/main/Other.kt": "class Other\n" })
    r.commit("no new warning")
    const { warnings } = await check(r, base)
    expect(warnings.status).toBe("passed")
    expect(warnings.proof.command).toEqual(["(the build check's compiler output)"])
  })

  test("a change that adds one fails, and names it", async () => {
    const { r, base } = await baselined("build, warnings ratchet")
    r.write({
      "src/main/Rate.kt": "class Rate {\n  @Deprecated(\"x\") fun old() = 1\n  fun now() = old()\n}\n",
      "warnings.txt": "src/main/App.kt:2:11 Unchecked cast of 'Any' to 'List<String>'.\nsrc/main/Rate.kt:3:15 'fun old(): Int' is deprecated. x.\n",
    })
    r.commit("a new warning")
    const { warnings, violations } = await check(r, base)
    expect(warnings.status).toBe("failed")
    expect(warnings.reason).toBe("1 new finding not in the baseline")
    expect(violations).toEqual([{ check: "warnings", ruleId: "compiler/warning", message: "'fun old(): Int' is deprecated. x.", path: "src/main/Rate.kt", line: 3 }])
  })

  test("without a build check, the warnings check compiles itself", async () => {
    const { r, base } = await baselined("warnings ratchet")
    r.write({ "src/main/Other.kt": "class Other\n" })
    r.commit("no new warning")
    const { warnings } = await check(r, base)
    expect(warnings.status).toBe("passed")
    expect(warnings.proof.command).toEqual(["compile"])
  })
})

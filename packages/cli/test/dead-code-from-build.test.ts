import { afterEach, describe, expect, test } from "bun:test"
import { scalaPack } from "@gauntlet/pack-scala"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { compilerWarningsRun, type GateImpl, type Pack, ProcessRunner } from "../../core/src/index.ts"
import { scriptPack } from "../../core/test/script-pack.ts"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { cli } from "./harness.ts"

// Spec 0017 §4 for a compiler's unused warnings: the dead-code check reads
// the build's own compile, as the warnings check does (an incremental compile
// only warns about what it recompiles), and ratchets them by fingerprint. A
// stand-in for sbt prints scalac 2's format from warnings.txt; the dead-code
// check is the Scala pack's.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

// The build: "compiles", printing each line of warnings.txt as an sbt [warn] line.
const compile: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const r = yield* (yield* ProcessRunner).run({ command: "sh", args: ["-c", `sed "s#^#[warn] $PWD/#" warnings.txt`], cwd: ctx.dir }).pipe(Effect.orDie)
    return { command: ["compile"], exitCode: r.exitCode, runs: [compilerWarningsRun("scalac", r.stdout, ctx.dir)] }
  })
const pack: Pack = {
  ...scriptPack,
  spec: { ...scriptPack.spec, gates: [...scriptPack.spec.gates, { name: "dead-code", description: "dead code", produces: "violations", units: [], higherIsBetter: false, scopable: true, zoneScopable: true }] },
  gates: { ...scriptPack.gates, build: compile, "dead-code": scalaPack.gates["dead-code"]! },
  ...(scalaPack.locate ? { locate: scalaPack.locate } : {}),
  ...(scalaPack.normalise ? { normalise: scalaPack.normalise } : {}),
}

const policy = (gates: string) => `gauntlet "svc"\nuse jvm\nmode enforce\nowners @p\ngates { fast { ${gates} } }\nreview { auto when all gates pass }\n`

const MONEY = "package svc\n\nobject Money {\n  private val rate = 3\n  def add(a: Long, b: Long): Long = a + b\n}\n"

const setup = (gates: string) => {
  const r = new TempRepo()
  repos.push(r)
  r.write({
    ".gauntlet/policy.gx": policy(gates),
    "build.sbt": "scalaVersion := \"2.13.17\"\nscalacOptions += \"-Wunused:all\"\n",
    "src/main/scala/svc/Money.scala": MONEY,
    "warnings.txt": "src/main/scala/svc/Money.scala:4:15: private val rate in object Money is never used\n",
  })
  r.commit("some old dead code")
  return r
}
const check = async (r: TempRepo, base: string) => {
  const out = join(r.dir, "out")
  await cli(["check", "--repo", r.dir, "--base", base, "--out", out, "--no-record"], [pack])
  const report = JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8"))
  return { deadCode: report.checks.find((c: { check: string }) => c.check === "dead-code"), violations: report.violations }
}
const baselined = async (gates: string) => {
  const r = setup(gates)
  expect((await cli(["baseline", "--repo", r.dir, "--trunk", "main"], [pack])).code).toBe(0)
  const base = r.commit("baseline")
  r.git("checkout", "-q", "-b", "change")
  return { r, base }
}

describe("a dead-code ratchet over scalac's unused warnings", () => {
  test("reads the build's compile, and grandfathers today's", async () => {
    const { r, base } = await baselined("build, dead-code ratchet")
    r.write({ "src/main/scala/svc/Other.scala": "package svc\n\nobject Other\n" })
    r.commit("no new dead code")
    const { deadCode } = await check(r, base)
    expect(deadCode.status).toBe("passed")
    expect(deadCode.proof.command).toEqual(["(the build check's compiler output)"])
  })

  test("a change that adds an unused private fails, and names it; a deprecation isn't dead code", async () => {
    const { r, base } = await baselined("build, dead-code ratchet")
    r.write({
      "src/main/scala/svc/Money.scala": MONEY.replace("}\n", "  private def helper(x: Int): Int = x + 1\n}\n"),
      "warnings.txt": [
        "src/main/scala/svc/Money.scala:4:15: private val rate in object Money is never used",
        "src/main/scala/svc/Money.scala:6:15: private method helper in object Money is never used",
        "src/main/scala/svc/Money.scala:5:7: method old in object Money is deprecated (since 1.0): use add",
      ].join("\n") + "\n",
    })
    r.commit("an unused helper")
    const { deadCode, violations } = await check(r, base)
    expect(deadCode.status).toBe("failed")
    expect(violations).toEqual([{ check: "dead-code", ruleId: "dead-code/unused-private", message: "private method helper in object Money is never used", path: "src/main/scala/svc/Money.scala", line: 6 }])
  })
})

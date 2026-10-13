import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { type GateContext, ProcessRunner, type RunRequest } from "@gauntlet/core"
import { Effect, Layer } from "effect"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { mutation } from "../src/gates.ts"
import { parseMutations, pitestTestName } from "../src/reports.ts"

// Spec 0016: recording a baseline turns on Pitest's full mutation matrix, and
// the gate reads every test that killed each mutant into the kill map.

const MATRIX = `<?xml version="1.0" encoding="UTF-8"?>
<mutations>
<mutation detected='true' status='KILLED' numberOfTestsRun='2'><sourceFile>Fx.kt</sourceFile><mutatedClass>svc.Fx</mutatedClass><mutatedMethod>convert</mutatedMethod><lineNumber>5</lineNumber><mutator>MATH</mutator><killingTests>svc.FxTest.[engine:junit-jupiter]/[class:svc.FxTest]/[method:converts()]|svc.FxTest.[engine:junit-jupiter]/[class:svc.FxTest]/[method:rounds()]</killingTests><succeedingTests>svc.MoneyTest.[engine:junit-jupiter]/[class:svc.MoneyTest]/[method:adds()]</succeedingTests><description>x</description></mutation>
<mutation detected='false' status='SURVIVED' numberOfTestsRun='1'><sourceFile>Fx.kt</sourceFile><mutatedClass>svc.Fx</mutatedClass><mutatedMethod>convert</mutatedMethod><lineNumber>7</lineNumber><mutator>NEGATE</mutator><killingTests/><succeedingTests>svc.FxTest.[engine:junit-jupiter]/[class:svc.FxTest]/[method:converts()]</succeedingTests><description>y</description></mutation>
</mutations>`

const FIRST_KILLER = `<?xml version="1.0" encoding="UTF-8"?>
<mutations>
<mutation detected='true' status='KILLED' numberOfTestsRun='1'><sourceFile>Fx.kt</sourceFile><mutatedClass>svc.Fx</mutatedClass><mutatedMethod>convert</mutatedMethod><lineNumber>5</lineNumber><mutator>MATH</mutator><killingTest>svc.FxTest.[engine:junit-jupiter]/[class:svc.FxTest]/[method:converts()]</killingTest><description>x</description></mutation>
</mutations>`

describe("pitestTestName", () => {
  test("JUnit 5, nested classes and parameterised tests", () => {
    expect(pitestTestName("svc.FxTest.[engine:junit-jupiter]/[class:svc.FxTest]/[method:converts()]")).toBe("svc.FxTest.converts")
    expect(pitestTestName("svc.FxTest.[engine:junit-jupiter]/[class:svc.FxTest]/[nested-class:Rounding]/[method:halves(int)]")).toBe("svc.FxTest.Rounding.halves")
    expect(pitestTestName("svc.FxTest.[engine:junit-jupiter]/[class:svc.FxTest]/[test-template:positive(int)]/[test-template-invocation:#1]")).toBe("svc.FxTest.positive")
    expect(pitestTestName("svc.FxTest.[engine:junit-jupiter]/[class:svc.FxTest]/[method:rounds up()]")).toBe("svc.FxTest.rounds up")
  })

  test("Kotest and JUnit 4", () => {
    expect(pitestTestName("svc.FxSpec.[engine:kotest]/[spec:svc.FxSpec]/[test:converting]/[test:rounds half up]")).toBe("svc.FxSpec.converting.rounds half up")
    expect(pitestTestName("svc.FxTest.converts(svc.FxTest)")).toBe("svc.FxTest.converts")
    expect(pitestTestName("plain")).toBe("plain")
  })
})

describe("parseMutations", () => {
  test("reads every killer and the tests that ran a mutant without killing it, with the full matrix", () => {
    const [killed, survived] = parseMutations(MATRIX)
    expect(killed!.killingTests).toEqual(["svc.FxTest.converts", "svc.FxTest.rounds"])
    expect(killed!.succeedingTests).toEqual(["svc.MoneyTest.adds"])
    expect(survived!.killingTests).toEqual([])
    expect(survived!.succeedingTests).toEqual(["svc.FxTest.converts"])
  })

  test("names no killers without the matrix: Pitest names only the first", () => {
    expect(parseMutations(FIRST_KILLER)[0]!.killingTests).toBeUndefined()
  })
})

/** A checkout and a Gradle whose pitest task writes this report. */
const pitest = (report: string) => {
  const dir = mkdtempSync(join(tmpdir(), "gauntlet-pitest-"))
  for (const p of ["gradlew", "src/main/kotlin/svc/Fx.kt", "src/test/kotlin/svc/FxTest.kt"]) {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), "")
  }
  const out = join(mkdtempSync(join(tmpdir(), "gauntlet-out-")), "0-mutation")
  mkdirSync(out)
  const calls: RunRequest[] = []
  const runner = Layer.succeed(ProcessRunner, {
    run: (r) => Effect.sync(() => {
      calls.push(r)
      const target = join(r.env!.GAUNTLET_OUT!, "pitest/root/mutations.xml")
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, report)
      return { exitCode: 0, stdout: "", stderr: "" }
    }),
  })
  const ctx: GateContext = {
    dir, outputDir: out,
    collect: Effect.sync(() => readdirSync(out, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => ({ path: join(e.parentPath, e.name).slice(out.length + 1), content: readFileSync(join(e.parentPath, e.name), "utf8") }))),
    ir: { zones: [], arch: [] } as never,
    facts: { addedLines: new Map() } as never,
    files: ["src/main/kotlin/svc/Fx.kt", "src/test/kotlin/svc/FxTest.kt"],
    legacy: [],
  }
  const run = (c: GateContext) => Effect.runPromise(mutation({ kind: "gate", name: "mutation" } as never, c).pipe(Effect.provide(Layer.mergeAll(runner, BunServices.layer))))
  return { ctx, calls, run }
}

describe("the Pitest gate and the kill map", () => {
  test("recording a baseline asks for the full matrix, and the gate hands on the kill map", async () => {
    const p = pitest(MATRIX)
    const r = await p.run({ ...p.ctx, recordKillMap: true })
    expect(p.calls[0]!.env!.GAUNTLET_PITEST_MATRIX).toBe("true")
    expect(r.killMap).toEqual({
      mutants: [{ path: "src/main/kotlin/svc/Fx.kt", line: 5 }, { path: "src/main/kotlin/svc/Fx.kt", line: 7 }],
      tests: {
        "svc.FxTest.converts": { killed: [0], reached: 2 },
        "svc.FxTest.rounds": { killed: [0], reached: 1 },
        "svc.MoneyTest.adds": { killed: [], reached: 1 },
      },
    })
  })

  test("a check doesn't ask for it, and a report without the matrix gives no kill map", async () => {
    const p = pitest(FIRST_KILLER)
    const r = await p.run(p.ctx)
    expect(p.calls[0]!.env!.GAUNTLET_PITEST_MATRIX).toBeUndefined()
    expect(r.killMap).toBeUndefined()
  })
})

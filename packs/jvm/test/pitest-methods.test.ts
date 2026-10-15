import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { type GateContext, ProcessRunner } from "@gauntlet/core"
import { Effect, Layer } from "effect"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { mutation } from "../src/gates.ts"
import { parseMutations, pitestMethodName } from "../src/reports.ts"

// Spec 0017 §1: the methods each test ran, from Pitest's full mutation matrix:
// every mutant names its method, and every test that ran it.

const FX = "src/main/kotlin/svc/Fx.kt"
const test5 = (method: string) => `svc.FxTest.[engine:junit-jupiter]/[class:svc.FxTest]/[method:${method}()]`

const MATRIX = `<?xml version="1.0" encoding="UTF-8"?>
<mutations>
<mutation detected='true' status='KILLED' numberOfTestsRun='1'><sourceFile>Fx.kt</sourceFile><mutatedClass>svc.Fx</mutatedClass><mutatedMethod>fee</mutatedMethod><methodDescription>(I)I</methodDescription><lineNumber>5</lineNumber><mutator>MATH</mutator><killingTests>${test5("feeRoundsUp")}</killingTests><succeedingTests>${test5("converts")}</succeedingTests><description>x</description></mutation>
<mutation detected='false' status='SURVIVED' numberOfTestsRun='1'><sourceFile>Fx.kt</sourceFile><mutatedClass>svc.FxKt</mutatedClass><mutatedMethod>lambda$convert$0</mutatedMethod><methodDescription>(I)I</methodDescription><lineNumber>9</lineNumber><mutator>NEGATE</mutator><killingTests/><succeedingTests>${test5("converts")}</succeedingTests><description>y</description></mutation>
</mutations>`

describe("a mutated method by its source-level name", () => {
  test("a class's method, and a Kotlin file's function without the facade's Kt", () => {
    expect(pitestMethodName("svc.Fx", "fee")).toBe("Fx.fee")
    expect(pitestMethodName("svc.FxKt", "fee")).toBe("Fx.fee")
    expect(pitestMethodName("Kt", "fee")).toBe("Kt.fee")
  })

  test("nested classes after their outer one", () => {
    expect(pitestMethodName("svc.Fx$Companion", "of")).toBe("Fx.Companion.of")
    expect(pitestMethodName("svc.Fx$Rates$Table", "get")).toBe("Fx.Rates.Table.get")
  })

  test("lambdas, default-argument stubs, accessors and mangled names are their method's", () => {
    expect(pitestMethodName("svc.Fx", "lambda$fee$0")).toBe("Fx.fee")
    expect(pitestMethodName("svc.Fx", "fee$lambda$0")).toBe("Fx.fee")
    expect(pitestMethodName("svc.Fx", "fee$default")).toBe("Fx.fee")
    expect(pitestMethodName("svc.Fx", "access$fee")).toBe("Fx.fee")
    expect(pitestMethodName("svc.Fx", "fee-7Zm2rWU")).toBe("Fx.fee")
  })

  test("a local or anonymous class's code is its enclosing method's", () => {
    expect(pitestMethodName("svc.Fx$fee$1", "invoke")).toBe("Fx.fee")
    expect(pitestMethodName("svc.Fx$1", "run")).toBe("Fx.run")
  })

  test("constructors and static initialisers keep their JVM names", () => {
    expect(pitestMethodName("svc.Fx", "<init>")).toBe("Fx.<init>")
    expect(pitestMethodName("svc.Fx", "<clinit>")).toBe("Fx.<clinit>")
  })
})

describe("parseMutations", () => {
  test("reads the method each mutant is in", () => {
    expect(parseMutations(MATRIX).map((m) => m.method)).toEqual(["fee", "lambda$convert$0"])
  })

  test("a mutant without one has none", () => {
    const xml = "<mutations><mutation detected='true' status='KILLED'><sourceFile>Fx.kt</sourceFile><mutatedClass>svc.Fx</mutatedClass><lineNumber>5</lineNumber></mutation></mutations>"
    expect(parseMutations(xml)[0]!.method).toBeUndefined()
  })
})

describe("the Pitest gate and the methods each test ran", () => {
  test("recording a baseline hands on, per test, the methods it reached", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gauntlet-pitest-"))
    for (const p of ["gradlew", FX, "src/test/kotlin/svc/FxTest.kt"]) {
      mkdirSync(dirname(join(dir, p)), { recursive: true })
      writeFileSync(join(dir, p), "")
    }
    const out = join(mkdtempSync(join(tmpdir(), "gauntlet-out-")), "0-mutation")
    mkdirSync(out)
    const runner = Layer.succeed(ProcessRunner, {
      run: (r) => Effect.sync(() => {
        const target = join(r.env!.GAUNTLET_OUT!, "pitest/root/mutations.xml")
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, MATRIX)
        return { exitCode: 0, stdout: "", stderr: "" }
      }),
    })
    const ctx: GateContext = {
      dir, outputDir: out, recordKillMap: true,
      collect: Effect.sync(() => readdirSync(out, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => ({ path: join(e.parentPath, e.name).slice(out.length + 1), content: readFileSync(join(e.parentPath, e.name), "utf8") }))),
      ir: { zones: [], arch: [] } as never,
      facts: { addedLines: new Map() } as never,
      files: [FX, "src/test/kotlin/svc/FxTest.kt"],
      legacy: [],
    }
    const r = await Effect.runPromise(mutation({ kind: "gate", name: "mutation" } as never, ctx).pipe(Effect.provide(Layer.mergeAll(runner, BunServices.layer))))
    expect(r.methodMap).toEqual({
      "svc.FxTest.converts": [`${FX}#Fx.convert`, `${FX}#Fx.fee`],
      "svc.FxTest.feeRoundsUp": [`${FX}#Fx.fee`],
    })
  })
})

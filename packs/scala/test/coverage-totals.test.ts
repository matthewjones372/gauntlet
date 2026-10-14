import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fakeGate } from "../../../packages/core/test/fake-gate.ts"
import { coverage } from "../src/gates.ts"

// Spec 0017 §3: the coverage gate records what each file's value is out of, so
// the baseline's project value can be worked out again without removed files.
// The CI's scoverage report stands in for running sbt (ADR 0024).

const GATE = { kind: "gate", name: "coverage", ratchet: false, scope: "all" } as never
const COBERTURA = `<?xml version="1.0"?>
<coverage line-rate="0.75"><sources><source>/work/calc/src/main/scala</source></sources><packages><package name="calc"><classes>
<class name="calc.Calc" filename="calc/Calc.scala" line-rate="0.75"><lines><line number="3" hits="1"/><line number="4" hits="1"/><line number="5" hits="0"/><line number="6" hits="1"/></lines></class>
</classes></package></packages></coverage>
`
const NEW = "package calc\n\n// Subtracts.\nobject Sub { def sub(a: Int, b: Int) = a - b }\n"

const fromCi = () => {
  const g = fakeGate({
    "calc/src/main/scala/calc/Calc.scala": "package calc\n\nobject Calc {\n  def add(a: Int, b: Int) = a + b\n  def neg(a: Int) = -a\n  def id(a: Int) = a\n}\n",
    "calc/src/main/scala/calc/Sub.scala": NEW,
  })
  const report = join(g.ctx.outputDir, "calc/target/scala-3.8.4/coverage-report/cobertura.xml")
  mkdirSync(dirname(report), { recursive: true })
  writeFileSync(report, COBERTURA)
  return { ...g, ctx: { ...g.ctx, fromCi: true } }
}

describe("Scala coverage", () => {
  test("the whole project records the lines each file's value is out of", async () => {
    const g = fromCi()
    const r = await g.run(coverage(GATE, g.ctx))
    expect(r.metrics?.coverage).toMatchObject({ value: 75, perFile: { "calc/src/main/scala/calc/Calc.scala": 75 }, perFileTotal: { "calc/src/main/scala/calc/Calc.scala": 4 } })
  })

  test("a changed file with methods the report doesn't mention is out of its changed lines of code", async () => {
    const g = fromCi()
    const path = "calc/src/main/scala/calc/Sub.scala"
    const added = NEW.split("\n").slice(0, 4).map((text, i) => ({ line: i + 1, text }))
    const ctx = { ...g.ctx, scope: [path], facts: { addedLines: new Map([[path, added]]) } as never }
    const r = await g.run(coverage(GATE, ctx))
    expect(r.metrics?.coverage).toMatchObject({ value: 0, perFile: { [path]: 0 }, perFileTotal: { [path]: 2 } })
  })
})

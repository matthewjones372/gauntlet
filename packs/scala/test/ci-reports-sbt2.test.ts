import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fakeGate } from "../../../packages/core/test/fake-gate.ts"
import { coverage, runSuite } from "../src/gates.ts"

// The project's own CI reports (ADR 0024) where sbt 2 writes them: under
// target/out/jvm/scala-<version>/<module>/, not target/test-reports/ and
// target/scala-<version>/ as sbt 1 does. Both layouts are read.

const JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="calc.CalcSpec" tests="1" failures="0" errors="0" skipped="0"><testcase classname="calc.CalcSpec" name="adds"/></testsuite>
`
const COBERTURA = `<?xml version="1.0"?>
<coverage line-rate="1.0"><sources><source>/work/calc/src/main/scala</source></sources><packages><package name="calc"><classes>
<class name="calc.Calc" filename="calc/Calc.scala" line-rate="1.0"><lines><line number="3" hits="1"/></lines></class>
</classes></package></packages></coverage>
`

const fromCi = (reports: Record<string, string>) => {
  const g = fakeGate({ "calc/src/main/scala/calc/Calc.scala": "package calc\n\nobject Calc { def add(a: Int, b: Int) = a + b }\n" })
  for (const [p, text] of Object.entries(reports)) {
    mkdirSync(dirname(join(g.ctx.outputDir, p)), { recursive: true })
    writeFileSync(join(g.ctx.outputDir, p), text)
  }
  return { ...g, ctx: { ...g.ctx, fromCi: true } }
}

describe("CI reports from sbt 2", () => {
  test("test results under target/out are read", async () => {
    const g = fromCi({ "bank-checks/target/out/jvm/scala-3.8.4/calc/test-reports/TEST-calc.CalcSpec.xml": JUNIT })
    const r = await g.run(runSuite({ name: "unit", location: "**" }, g.ctx))
    expect(r.tests?.counts.executed).toBe(1)
  })

  test("sbt 1's test results are still read", async () => {
    const g = fromCi({ "calc/target/test-reports/TEST-calc.CalcSpec.xml": JUNIT })
    expect((await g.run(runSuite({ name: "unit", location: "**" }, g.ctx))).tests?.counts.executed).toBe(1)
  })

  test("coverage under target/out is read", async () => {
    const g = fromCi({ "bank-checks/target/out/jvm/scala-3.8.4/calc/coverage-report/cobertura.xml": COBERTURA })
    const r = await g.run(coverage({ kind: "gate", name: "coverage", ratchet: false, scope: "all" } as never, g.ctx))
    expect(r.error).toBeUndefined()
    expect(r.metrics?.coverage?.value).toBe(100)
  })
})

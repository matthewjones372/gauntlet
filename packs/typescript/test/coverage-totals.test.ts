import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fakeGate } from "../../../packages/core/test/fake-gate.ts"
import { coverage } from "../src/gates.ts"

// Spec 0017 §3: the coverage gate records what each file's value is out of, so
// the baseline's project value can be worked out again without removed files.
// bun is a stand-in: the lcov report is written before the gate reads it.

const GATE = { kind: "gate", name: "coverage" } as never
const LCOV = "SF:src/fx.ts\nDA:1,1\nDA:2,1\nDA:3,0\nDA:4,1\nend_of_record\nSF:src/rates.ts\nDA:1,0\nDA:2,1\nend_of_record\n"

const project = () => {
  const g = fakeGate({
    "package.json": "{}", "bun.lock": "",
    "src/fx.ts": "a\nb\nc\nd\n", "src/rates.ts": "x\ny\n", "src/new.ts": "// new\nexport const z = 1\nexport const w = 2\n",
  })
  mkdirSync(join(g.ctx.outputDir, "coverage"))
  writeFileSync(join(g.ctx.outputDir, "coverage", "lcov.info"), LCOV)
  return g
}

describe("TypeScript coverage", () => {
  test("the whole project records each file's value and the lines it's out of", async () => {
    const g = project()
    const r = await g.run(coverage(GATE, g.ctx))
    expect(r.metrics?.coverage).toEqual({
      value: 66.67,
      unit: "%",
      higherIsBetter: true,
      perFile: { "src/fx.ts": 75, "src/rates.ts": 50 },
      perFileTotal: { "src/fx.ts": 4, "src/rates.ts": 2 },
    })
  })

  test("a changed file no test loaded is out of its changed lines of code", async () => {
    const g = project()
    const added = [{ line: 1, text: "// new" }, { line: 2, text: "export const z = 1" }, { line: 3, text: "export const w = 2" }]
    const ctx = { ...g.ctx, scope: ["src/new.ts"], facts: { addedLines: new Map([["src/new.ts", added]]) } as never }
    const r = await g.run(coverage(GATE, ctx))
    expect(r.metrics?.coverage).toMatchObject({ value: 0, perFile: { "src/new.ts": 0 }, perFileTotal: { "src/new.ts": 2 } })
  })
})

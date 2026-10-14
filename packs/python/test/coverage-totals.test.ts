import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { fakeGate } from "../../../packages/core/test/fake-gate.ts"
import { coverage } from "../src/gates.ts"

// Spec 0017 §3: the coverage gate records what each file's value is out of, so
// the baseline's project value can be worked out again without removed files.
// coverage.py is a stand-in: the lcov report is written before the gate reads it.

const GATE = { kind: "gate", name: "coverage" } as never
const LCOV = "SF:src/svc/fx.py\nDA:1,1\nDA:2,1\nDA:3,0\nDA:4,1\nend_of_record\nSF:src/svc/rates.py\nDA:1,0\nDA:2,1\nend_of_record\n"

const project = () => {
  const g = fakeGate({
    "uv.lock": "", ".venv/bin/coverage": "", "pyproject.toml": "[project]\nname = \"svc\"\n",
    "src/svc/fx.py": "a = 1\nb = 2\nc = 3\nd = 4\n", "src/svc/rates.py": "x = 1\ny = 2\n", "src/svc/new.py": "# new\nz = 1\nw = 2\n",
  })
  writeFileSync(join(g.ctx.outputDir, "lcov.info"), LCOV)
  return g
}

describe("Python coverage", () => {
  test("the whole project records each file's value and the lines it's out of", async () => {
    const g = project()
    const r = await g.run(coverage(GATE, g.ctx))
    expect(r.metrics?.coverage).toEqual({
      value: 66.67,
      unit: "%",
      higherIsBetter: true,
      perFile: { "src/svc/fx.py": 75, "src/svc/rates.py": 50 },
      perFileTotal: { "src/svc/fx.py": 4, "src/svc/rates.py": 2 },
    })
  })

  test("a changed file coverage.py didn't measure is out of its changed lines of code", async () => {
    const g = project()
    const added = [{ line: 1, text: "# new" }, { line: 2, text: "z = 1" }, { line: 3, text: "w = 2" }]
    const ctx = { ...g.ctx, scope: ["src/svc/new.py"], facts: { addedLines: new Map([["src/svc/new.py", added]]) } as never }
    const r = await g.run(coverage(GATE, ctx))
    expect(r.metrics?.coverage).toMatchObject({ value: 0, perFile: { "src/svc/new.py": 0 }, perFileTotal: { "src/svc/new.py": 2 } })
  })
})

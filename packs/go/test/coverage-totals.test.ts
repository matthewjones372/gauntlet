import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { fakeGate } from "../../../packages/core/test/fake-gate.ts"
import { coverage } from "../src/gates.ts"

// Spec 0017 §3: the coverage gate records what each file's value is out of, so
// the baseline's project value can be worked out again without removed files.
// go test is a stand-in: the profile is written before the gate reads it.

const GATE = { kind: "gate", name: "coverage" } as never
const NEW = "package money\n\n// Sub subtracts.\nfunc Sub(a, b int64) int64 { return a - b }\n"

const project = () => {
  const g = fakeGate({
    "go.mod": "module example.com/svc\n\ngo 1.27\n",
    "money/money.go": "package money\n\nfunc Add(a, b int64) int64 { return a + b }\n",
    "money/sub.go": NEW,
  })
  writeFileSync(join(g.ctx.outputDir, "cover.out"), "mode: set\nexample.com/svc/money/money.go:3.40,3.56 1 1\n")
  return g
}

describe("Go coverage", () => {
  test("the whole project records the lines each file's value is out of", async () => {
    const g = project()
    const r = await g.run(coverage(GATE, g.ctx))
    expect(r.metrics?.coverage).toMatchObject({ value: 100, perFile: { "money/money.go": 100 }, perFileTotal: { "money/money.go": 1 } })
  })

  test("a changed file with code the profile doesn't mention is out of its changed lines of code", async () => {
    const g = project()
    const added = NEW.split("\n").slice(0, 4).map((text, i) => ({ line: i + 1, text }))
    const ctx = { ...g.ctx, scope: ["money/sub.go"], facts: { addedLines: new Map([["money/sub.go", added]]) } as never }
    const r = await g.run(coverage(GATE, ctx))
    // The package clause and the function count; the blank line and the comment don't.
    expect(r.metrics?.coverage).toMatchObject({ value: 0, perFile: { "money/sub.go": 0 }, perFileTotal: { "money/sub.go": 2 } })
  })
})

import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { fakeGate } from "../../../packages/core/test/fake-gate.ts"
import { coverage } from "../src/gates.ts"

// Spec 0017 §3: the coverage gate records what each file's value is out of, so
// the baseline's project value can be worked out again without removed files.
// cargo-llvm-cov is a stand-in: the lcov report is written before the gate reads it.

const GATE = { kind: "gate", name: "coverage" } as never
const NEW = "// Subtracts.\npub fn sub(a: i64, b: i64) -> i64 {\n    a - b\n}\n"

const project = () => {
  const g = fakeGate({
    "Cargo.toml": "[package]\nname = \"svc\"\nversion = \"0.1.0\"\n",
    "src/lib.rs": "pub fn add(a: i64, b: i64) -> i64 {\n    a + b\n}\n",
    "src/sub.rs": NEW,
  })
  writeFileSync(join(g.ctx.outputDir, "lcov.info"), "SF:src/lib.rs\nDA:1,1\nDA:2,1\nDA:3,0\nend_of_record\n")
  return g
}

describe("Rust coverage", () => {
  test("the whole project records the lines each file's value is out of", async () => {
    const g = project()
    const r = await g.run(coverage(GATE, g.ctx))
    expect(r.metrics?.coverage).toMatchObject({ value: 66.67, perFile: { "src/lib.rs": 66.67 }, perFileTotal: { "src/lib.rs": 3 } })
  })

  test("a changed file with functions the report doesn't mention is out of its changed lines of code", async () => {
    const g = project()
    const added = NEW.split("\n").slice(0, 4).map((text, i) => ({ line: i + 1, text }))
    const ctx = { ...g.ctx, scope: ["src/sub.rs"], facts: { addedLines: new Map([["src/sub.rs", added]]) } as never }
    const r = await g.run(coverage(GATE, ctx))
    expect(r.metrics?.coverage).toMatchObject({ value: 0, perFile: { "src/sub.rs": 0 }, perFileTotal: { "src/sub.rs": 3 } })
  })
})

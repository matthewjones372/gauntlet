import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fakeGate } from "../../../packages/core/test/fake-gate.ts"
import { coverage } from "../src/gates.ts"
import { project } from "./sources.ts"

// Spec 0017 §3: the coverage gate records what each file's value is out of, so
// the baseline's project value can be worked out again without removed files.
// cloverage is a stand-in: the lcov report is written before the gate reads it.

const GATE = { kind: "gate", name: "coverage", ratchet: false, scope: "all" } as never
const NEW = "(ns svc.domain.tax)\n\n; Rounds up.\n(defn tax [n] (* n 2))\n"

const service = () => {
  const g = fakeGate({ ...project("clojure-service"), "src/svc/domain/tax.clj": NEW })
  mkdirSync(join(g.ctx.outputDir, "coverage"), { recursive: true })
  writeFileSync(join(g.ctx.outputDir, "coverage", "lcov.info"), "TN:\nSF:src/svc/domain/money.clj\nDA:1,1\nDA:6,1\nDA:9,0\nend_of_record\n")
  return g
}

describe("Clojure coverage", () => {
  test("the whole project records the lines each file's value is out of", async () => {
    const g = service()
    const r = await g.run(coverage(GATE, g.ctx))
    expect(r.metrics?.coverage).toMatchObject({ value: 66.67, perFile: { "src/svc/domain/money.clj": 66.67 }, perFileTotal: { "src/svc/domain/money.clj": 3 } })
  })

  test("a changed namespace with functions the report doesn't mention is out of its changed lines of code", async () => {
    const g = service()
    const added = NEW.split("\n").slice(0, 4).map((text, i) => ({ line: i + 1, text }))
    const ctx = { ...g.ctx, scope: ["src/svc/domain/tax.clj"], facts: { addedLines: new Map([["src/svc/domain/tax.clj", added]]) } as never }
    const r = await g.run(coverage(GATE, ctx))
    expect(r.metrics?.coverage).toMatchObject({ value: 0, perFile: { "src/svc/domain/tax.clj": 0 }, perFileTotal: { "src/svc/domain/tax.clj": 2 } })
  })
})

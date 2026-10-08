import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { fakeGate } from "../../../packages/core/test/fake-gate.ts"
import { lint } from "../src/gates.ts"

// Biome's infos are suggestions it never fails on (some, like useLiteralKeys,
// contradict TypeScript settings); only its warnings and errors are findings.

const result = (level: string, rule: string) => ({
  ruleId: rule,
  level,
  message: { text: rule },
  locations: [{ physicalLocation: { artifactLocation: { uri: "src/a.ts" }, region: { startLine: 1 } } }],
})

describe("Biome findings", () => {
  test("infos aren't counted; warnings and errors are", async () => {
    const g = fakeGate({ "package.json": JSON.stringify({ devDependencies: { "@biomejs/biome": "2" } }), "bun.lock": "", "node_modules/.bin/biome": "", "src/a.ts": "export const a = 1\n" })
    writeFileSync(join(g.ctx.outputDir, "biome.sarif"), JSON.stringify({
      version: "2.1.0",
      runs: [{ tool: { driver: { name: "Biome" } }, results: [result("note", "lint/complexity/useLiteralKeys"), result("warning", "lint/style/x"), result("error", "lint/suspicious/y")] }],
    }))
    const r = await g.run(lint({ kind: "gate", name: "lint", ratchet: true, scope: "all" }, g.ctx))
    expect(r.runs.flatMap((run) => run.results.map((x) => x.ruleId))).toEqual(["lint/style/x", "lint/suspicious/y"])
  })
})

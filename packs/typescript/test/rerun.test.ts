import { describe, expect, test } from "bun:test"
import { fakeGate } from "../../../packages/core/test/fake-gate.ts"
import { runSuite } from "../src/gates.ts"

const SUITE = { name: "unit", location: "test/**" }
const subset = { files: ["test/a.test.ts"], ids: [], seed: 7 }

describe("TypeScript reruns", () => {
  test("bun reruns the files shuffled with the seed", async () => {
    const g = fakeGate({ "package.json": "{}", "bun.lock": "", "test/a.test.ts": "" })
    await g.run(runSuite(SUITE, g.ctx, subset))
    expect(g.calls.at(-1)!.args.slice(0, 4)).toEqual(["test", "test/a.test.ts", "--randomize", "--seed=7"])
  })

  test("vitest and jest use their own shuffle and seed flags", async () => {
    const v = fakeGate({ "package.json": JSON.stringify({ devDependencies: { vitest: "5" } }), "bun.lock": "", "node_modules/.bin/vitest": "", "test/a.test.ts": "" })
    await v.run(runSuite(SUITE, v.ctx, subset))
    expect(v.calls.at(-1)!.args).toEqual(expect.arrayContaining(["test/a.test.ts", "--sequence.shuffle", "--sequence.seed=7"]))
    const j = fakeGate({ "package.json": JSON.stringify({ devDependencies: { jest: "30" } }), "bun.lock": "", "node_modules/.bin/jest": "", "test/a.test.ts": "" })
    await j.run(runSuite(SUITE, j.ctx, subset))
    expect(j.calls.at(-1)!.args).toEqual(expect.arrayContaining(["--testPathPatterns", "test/a\\.test\\.ts", "--randomize", "--seed=7"]))
  })

  test("a rerun with no files to run says so instead of running everything", async () => {
    const g = fakeGate({ "package.json": "{}", "bun.lock": "" })
    expect((await g.run(runSuite(SUITE, g.ctx, { files: [], ids: ["x"], seed: 1 }))).error).toBe("no test files to run again")
  })
})

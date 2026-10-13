import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cpSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { cli } from "../../../packages/cli/test/harness.ts"
import { TempRepo } from "../../../packages/core/test/temp-repo.ts"
import { typescriptPack } from "../src/index.ts"

// M15 end to end with real vitest: a new test that depends on test order
// fails a shuffled rerun and is caught; a new deterministic test never is.
// Opt in with GAUNTLET_E2E=1; CI always runs it.

const E2E = process.env.GAUNTLET_E2E === "1"
const FIXTURE = join(import.meta.dir, "..", "..", "..", "examples", "fixtures", "ts-service")
const TIMEOUT = 10 * 60 * 1000

let repo: TempRepo
let base = ""

const check = async (name: string, files: Record<string, string>) => {
  repo.git("checkout", "-q", "-B", name, base)
  repo.write(files)
  repo.commit(name)
  const out = join(repo.dir, ".git", `out-${name}`)
  const res = await cli(["check", "--repo", repo.dir, "--policy-ref", base, "--out", out, "--no-record"], [typescriptPack])
  const report = JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8"))
  return { code: res.code, unit: report.checks.find((c: { check: string }) => c.check === "unit") }
}

describe.skipIf(!E2E)("flaky tests with real vitest", () => {
  beforeAll(async () => {
    repo = new TempRepo()
    cpSync(FIXTURE, repo.dir, { recursive: true, filter: (src) => !/\/(node_modules|coverage|reports|\.stryker-tmp)(\/|$)/.test(src) })
    repo.commit("trunk")
    const recorded = await cli(["baseline", "--repo", repo.dir, "--trunk", "main"], [typescriptPack])
    if (recorded.code !== 0) throw new Error(`baseline failed: ${recorded.err}\n${recorded.out}`)
    base = repo.commit("baseline")
  }, TIMEOUT)

  afterAll(() => repo?.cleanup())

  test("a new test that only passes in file order is caught on its first appearance", async () => {
    const r = await check("order", {
      "test/domain/steps.test.ts": `import { expect, it } from "vitest"

const seen: number[] = []
for (const n of [1, 2, 3, 4, 5, 6]) {
  it(\`step \${n}\`, () => {
    seen.push(n)
    expect(seen).toEqual(Array.from({ length: n }, (_, i) => i + 1))
  })
}
`,
    })
    expect(r.unit.status).toBe("failed")
    expect(r.unit.reason).toMatch(/new or changed tests? (is|are) flaky: passed and failed across 4 runs/)
    expect(r.unit.flaky.length).toBeGreaterThan(0)
    expect(r.code).toBe(1)
  }, TIMEOUT)

  test("a new deterministic test passes every shuffled run", async () => {
    const r = await check("steady", {
      "test/domain/steady.test.ts": `import { expect, it } from "vitest"\n\nit("adds", () => expect(1 + 1).toBe(2))\nit("multiplies", () => expect(2 * 3).toBe(6))\n`,
    })
    expect(r.unit.status).toBe("passed")
    expect(r.unit.flaky).toBeUndefined()
  }, TIMEOUT)
})

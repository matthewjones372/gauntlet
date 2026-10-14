import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cpSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cli } from "../../../packages/cli/test/harness.ts"
import { TempRepo } from "../../../packages/core/test/temp-repo.ts"
import { typescriptPack } from "../src/index.ts"

// Running the tests a change affects (spec 0013), end to end against real
// Vitest and v8 coverage on examples/fixtures/ts-service. Opt in with
// GAUNTLET_E2E=1, like the pack's other end-to-end tests; CI always runs it.

const E2E = process.env.GAUNTLET_E2E === "1"
const FIXTURE = join(import.meta.dir, "..", "..", "..", "examples", "fixtures", "ts-service")
const TIMEOUT = 10 * 60 * 1000

const POLICY = `gauntlet "ts-service"
use typescript
mode enforce
owners @platform

protect {
  tests "test/**"
}

suites { unit "test/**" affected }

integrity { ratchet executed tests }

gates {
  fast   { build }
  verify { unit }
}

review {
  review when protected changed
  auto   when all gates pass
}
`

let repo: TempRepo
let base = ""
let recorded = ""
const ts = (args: string[]) => cli(args, [typescriptPack])
const read = (p: string) => readFileSync(join(FIXTURE, p), "utf8")

const check = async (name: string, files: Record<string, string>) => {
  repo.git("checkout", "-q", "-B", name, base)
  repo.write(files)
  repo.commit(name)
  const out = join(repo.dir, ".git", `out-${name}`)
  await ts(["check", "--repo", repo.dir, "--policy-ref", base, "--out", out, "--no-record"])
  const report = JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8"))
  const unit = report.checks.find((c: { check: string }) => c.check === "unit")
  return { report, unit, findings: report.integrity.findings.map((f: { check: string; kind: string }) => `${f.kind} ${f.check}`) }
}

const FX = "src/settlement/fx.ts"
const fxChanged = () => ({ [FX]: read(FX).replace("/ 10_000n", "/ 10000n") })

describe.skipIf(!E2E)("an affected TypeScript suite end to end (real Vitest)", () => {
  beforeAll(async () => {
    repo = new TempRepo()
    cpSync(FIXTURE, repo.dir, { recursive: true, filter: (src) => !/\/(node_modules|coverage|reports|\.stryker-tmp)(\/|$)/.test(src) })
    writeFileSync(join(repo.dir, ".gauntlet", "policy.gx"), POLICY)
    repo.commit("trunk")
    const baseline = await ts(["baseline", "--repo", repo.dir, "--trunk", "main"])
    if (baseline.code !== 0) throw new Error(`baseline failed: ${baseline.err}`)
    recorded = `${baseline.out}\n${baseline.err}`
    base = repo.commit("baseline")
  }, TIMEOUT)

  afterAll(() => repo?.cleanup())

  test("the baseline maps what each test file loaded", () => {
    const meta = JSON.parse(readFileSync(join(repo.dir, ".gauntlet", "baseline.sarif"), "utf8")).runs[0].properties.gauntlet
    if (meta.testMap === undefined) throw new Error(`no test map was recorded:\n${recorded}`)
    const files = (test: string) => meta.testMap.tests[test].map((i: number) => meta.testMap.files[i])
    expect(files("test/domain/money.test.ts")).toEqual(["src/domain/money.ts", "test/domain/money.test.ts"])
    expect(files("test/settlement/fx.test.ts")).toEqual(["src/domain/money.ts", "src/settlement/fx.ts", "test/settlement/fx.test.ts"])
  })

  test("a change to fx runs its test file alone, and the tests left out aren't missing", async () => {
    const r = await check("fx", fxChanged())
    expect(r.unit.status).toBe("passed")
    expect(r.unit.selection).toMatchObject({ ran: 1, of: 4, deselected: ["test/domain/money.test.ts"] })
    expect(r.findings).toEqual([])
    expect(r.report.decision.tier).toBe("auto")
  }, TIMEOUT)

  test("a change to code no test loaded runs every test, and says why", async () => {
    const r = await check("ledger", { "src/infra/ledger.ts": read("src/infra/ledger.ts").replace("a.currency == b.currency", "a.currency === b.currency") })
    expect(r.unit.selection).toMatchObject({ ran: 4, of: 4 })
    expect(r.unit.selection.why[0]).toContain("src/infra/ledger.ts")
  }, TIMEOUT)

  test("a test removed from a test file left out by the change is still caught", async () => {
    const money = read("test/domain/money.test.ts")
    const r = await check("dropped", {
      ...fxChanged(),
      "test/domain/money.test.ts": money.slice(0, money.indexOf(`  it("knows when positive"`)) + "})\n",
    })
    expect(r.findings).toContain("forbid deleted-tests")
  }, TIMEOUT)
})

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cpSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cli } from "../../../packages/cli/test/harness.ts"
import { TempRepo } from "../../../packages/core/test/temp-repo.ts"
import { jvmPack } from "../src/index.ts"

// Spec 0016 against real Gradle and Pitest on examples/fixtures/kotlin-service:
// recording a baseline turns on Pitest's full mutation matrix, the baseline
// keeps which tests killed which mutants, and `prune tests` reads it.
// Opt in with GAUNTLET_E2E=1; CI always runs it.

const E2E = process.env.GAUNTLET_E2E === "1"
const FIXTURE = join(import.meta.dir, "..", "..", "..", "examples", "fixtures", "kotlin-service")
const TIMEOUT = 15 * 60 * 1000

const POLICY = `gauntlet "kotlin-service"
use jvm
mode enforce
owners @platform
suites { unit "src/test/**" }
gates { verify { mutation >= 10% } }
`

let repo: TempRepo
const jvm = (args: string[]) => cli(args, [jvmPack])

describe.skipIf(!E2E)("Pitest kill map (real Gradle)", () => {
  beforeAll(async () => {
    repo = new TempRepo()
    cpSync(FIXTURE, repo.dir, { recursive: true, filter: (src) => !/\/(build|\.gradle|\.kotlin)(\/|$)/.test(src) })
    writeFileSync(join(repo.dir, ".gauntlet", "policy.gx"), POLICY)
    repo.commit("trunk")
    const recorded = await jvm(["baseline", "--repo", repo.dir, "--trunk", "main"])
    if (recorded.code !== 0) throw new Error(`baseline failed: ${recorded.err}`)
    repo.commit("baseline")
  }, TIMEOUT)

  afterAll(() => repo?.cleanup())

  test("the baseline records which tests killed which mutants", () => {
    const meta = JSON.parse(readFileSync(join(repo.dir, ".gauntlet", "baseline.sarif"), "utf8")).runs[0].properties.gauntlet
    const map = meta.killMap as { mutants: { path: string; line: number }[]; tests: Record<string, { killed: number[]; reached: number }> }
    expect(map.mutants.some((m) => m.path === "src/main/kotlin/svc/domain/Money.kt")).toBe(true)
    expect(Object.keys(map.tests)).toEqual(expect.arrayContaining(["svc.domain.MoneyTest.adds", "svc.settlement.FxTest.converts"]))
    expect(map.tests["svc.domain.MoneyTest.adds"]!.killed.length).toBeGreaterThan(0)
  })

  test("prune tests reads it", async () => {
    const res = await jvm(["prune", "tests", "--repo", repo.dir, "--json"])
    const found = JSON.parse(res.out)
    expect(found.mutation.missing).toBeUndefined()
    expect(found.mutation.tests).toBeGreaterThanOrEqual(4)
  })
})

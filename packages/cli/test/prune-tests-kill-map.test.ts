import { afterEach, describe, expect, test } from "bun:test"
import { emptyBaseline, encodeBaseline, type KillMap } from "@gauntlet/sarif"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { INSTALLED_PACKS } from "../src/packs.ts"
import { cli } from "./harness.ts"

// Spec 0016 stage 2: `gauntlet prune tests` reads the kill map the baseline
// at HEAD recorded, and never lists a property test.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const POLICY = `gauntlet "svc"
use go
mode enforce
owners @platform
suites { unit "**/*_test.go" }
gates { verify { unit } }
`

const FILES = {
  ".gauntlet/policy.gx": POLICY,
  "go.mod": "module example.com/svc\n\ngo 1.25\n",
  "fx/fx.go": "package fx\n\nfunc Convert(minor int64, rateBp int64) int64 { return minor * rateBp / 10000 }\n",
  "fx/fx_test.go": `package fx

import "testing"

func TestRates(t *testing.T) {
	if Convert(100, 9200) != 92 { t.Fatal("wrong") }
}

func TestRound(t *testing.T) {
	if Convert(1, 9200) != 0 { t.Fatal("wrong") }
}

func FuzzConvert(f *testing.F) { f.Fuzz(func(t *testing.T, n int64) { Convert(n, 10000) }) }
`,
}

const KILLS: KillMap = {
  mutants: [{ path: "fx/fx.go", line: 3 }, { path: "fx/fx.go", line: 3 }],
  tests: {
    "fx.TestRates": { killed: [0, 1], reached: 2 },
    "fx.TestRound": { killed: [1], reached: 2 },
    "fx.TestIdle": { killed: [], reached: 1 },
    "fx.FuzzConvert": { killed: [], reached: 2 },
  },
}

const repo = (killMap?: KillMap) => {
  const r = new TempRepo().write(FILES)
  repos.push(r)
  const first = r.commit("start")
  r.write({ ".gauntlet/baseline.sarif": encodeBaseline({ ...emptyBaseline(first, "f".repeat(64), "0.0.0"), ...(killMap ? { killMap } : {}) }) })
  r.commit("baseline")
  return { r, first }
}

describe("gauntlet prune tests with a kill map", () => {
  test("lists tests that kill nothing and tests whose every kill another makes, leaving property tests out", async () => {
    const { r, first } = repo(KILLS)
    const res = await cli(["prune", "tests", "--repo", r.dir], [...INSTALLED_PACKS])
    expect(res.code).toBe(0)
    expect(res.out).toContain(`From the mutation results recorded at ${first.slice(0, 12)}: 2 mutants, 4 tests.`)
    expect(res.out).toContain("  fx.TestIdle: reaches 1 mutant and kills none.")
    expect(res.out).toContain("  fx.TestRound: its mutant is also killed by fx.TestRates.")
    expect(res.out).not.toContain("FuzzConvert")
  })

  test("--json carries the same findings", async () => {
    const { r } = repo(KILLS)
    const found = JSON.parse((await cli(["prune", "tests", "--repo", r.dir, "--json"], [...INSTALLED_PACKS])).out)
    expect(found.mutation.killsNothing).toEqual([{ test: "fx.TestIdle", reached: 1 }])
    expect(found.mutation.alreadyKilled).toEqual([{ test: "fx.TestRound", killed: 1, by: ["fx.TestRates"] }])
  })

  test("says why there's nothing to read when the baseline has no kill map, or there's no baseline", async () => {
    const { r } = repo()
    expect((await cli(["prune", "tests", "--repo", r.dir], [...INSTALLED_PACKS])).out).toContain("No mutation results: the baseline records no kill map")
    const bare = new TempRepo().write(FILES)
    repos.push(bare)
    bare.commit("start")
    expect((await cli(["prune", "tests", "--repo", bare.dir], [...INSTALLED_PACKS])).out).toContain("No mutation results: there's no baseline at HEAD")
  })
})

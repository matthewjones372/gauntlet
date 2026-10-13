import { afterEach, describe, expect, test } from "bun:test"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { INSTALLED_PACKS } from "../src/packs.ts"
import { cli } from "./harness.ts"

// Spec 0016: `gauntlet prune tests` lists tests that test nothing or repeat
// another, from the working copy. It changes nothing, and holdouts stay hidden.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const POLICY = `gauntlet "svc"
use go
mode enforce
owners @platform
suites {
  unit "**/*_test.go"
  holdout "acceptance" paths "**/*_holdout_test.go" ci only
}
gates { verify { unit } }
`

const FILES = {
  ".gauntlet/policy.gx": POLICY,
  "go.mod": "module example.com/svc\n\ngo 1.25\n",
  "fx/fx.go": "package fx\n\nfunc Convert(minor int64, rateBp int64) int64 { return minor * rateBp / 10000 }\n",
  "fx/fx_test.go": `package fx

import "testing"

func TestRuns(t *testing.T) {
	Convert(100, 9200)
}

func TestA(t *testing.T) {
	if Convert(100, 9200) != 92 { t.Fatal("wrong") }
}

func TestB(t *testing.T) {
	if Convert(100, 9200) != 92 { t.Fatal("wrong") }
}
`,
  "fx/fx_holdout_test.go": "package fx\n\nimport \"testing\"\n\nfunc TestHidden(t *testing.T) {\n\tConvert(1, 1)\n}\n",
}

const repo = () => {
  const r = new TempRepo().write(FILES)
  r.git("add", "-A")
  repos.push(r)
  return r
}

describe("gauntlet prune tests", () => {
  test("lists tests that test nothing and tests that repeat another, and leaves holdouts out", async () => {
    const r = repo()
    const res = await cli(["prune", "tests", "--repo", r.dir], [...INSTALLED_PACKS])
    expect(res.code).toBe(0)
    expect(res.out).toContain("Read 3 tests in 1 file.")
    expect(res.out).toContain("fx/fx_test.go:5 TestRuns: it has no assertions, so it can't fail on a wrong result.")
    expect(res.out).toContain("fx/fx_test.go:9 TestA, repeated by TestB (line 13).")
    expect(res.out).not.toContain("TestHidden")
    expect(r.git("status", "--porcelain")).toBe("A  .gauntlet/policy.gx\nA  fx/fx.go\nA  fx/fx_holdout_test.go\nA  fx/fx_test.go\nA  go.mod")
  })

  test("--json gives the same list", async () => {
    const r = repo()
    const res = await cli(["prune", "tests", "--repo", r.dir, "--json"], [...INSTALLED_PACKS])
    const found = JSON.parse(res.out)
    expect(found.testsNothing.map((c: { name: string }) => c.name)).toEqual(["TestRuns"])
    expect(found.duplicates).toEqual([{ path: "fx/fx_test.go", tests: [{ name: "TestA", line: 9 }, { name: "TestB", line: 13 }] }])
  })

  test("a repository without a policy is an error", async () => {
    const r = new TempRepo()
    repos.push(r)
    const res = await cli(["prune", "tests", "--repo", r.dir], [...INSTALLED_PACKS])
    expect(res.code).toBe(2)
    expect(res.err).toContain("No policy found")
  })
})

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cpSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { cli } from "../../../packages/cli/test/harness.ts"
import { TempRepo } from "../../../packages/core/test/temp-repo.ts"
import { goPack } from "../src/index.ts"

// Spec 0001 end to end with the real Go toolchain and the go-service fixture:
// no baseline, no setup beyond the policy. Opt in with GAUNTLET_E2E=1.

const E2E = process.env.GAUNTLET_E2E === "1"
const FIXTURE = join(import.meta.dir, "..", "..", "..", "examples", "fixtures", "go-service")
const TIMEOUT = 5 * 60 * 1000
const read = (p: string) => readFileSync(join(FIXTURE, p), "utf8")

describe.skipIf(!E2E)("gauntlet check --protect-only (real Go)", () => {
  let repo: TempRepo
  let base = ""
  beforeAll(() => {
    repo = new TempRepo()
    cpSync(FIXTURE, repo.dir, { recursive: true })
    base = repo.commit("trunk")
  })
  afterAll(() => repo?.cleanup())

  const check = async (name: string, files: Record<string, string>) => {
    repo.git("checkout", "-q", "-B", name, base)
    repo.write(files)
    repo.commit(name)
    const out = join(repo.dir, ".git", `out-${name}`)
    const res = await cli(["check", "--repo", repo.dir, "--base", base, "--protect-only", "--out", out, "--no-record"], [goPack])
    return { code: res.code, report: JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8")) }
  }

  test("a clean, tested change passes, with no baseline", async () => {
    const r = await check("clean", {
      "domain/money.go": `${read("domain/money.go")}\n// IsZero reports whether the amount is zero.\nfunc (m Money) IsZero() bool { return m.Minor == 0 }\n`,
      "domain/zero_test.go": "package domain\n\nimport \"testing\"\n\nfunc TestIsZero(t *testing.T) {\n\tif !(Money{}).IsZero() {\n\t\tt.Error(\"zero money isn't zero\")\n\t}\n}\n",
    })
    expect(r.report.decision).toMatchObject({ scope: "protect-only", blocking: false })
    expect(r.report.checks.map((c: { check: string }) => c.check)).not.toContain("mutation")
    expect(r.code).toBe(0)
  }, TIMEOUT)

  test("removing a protected test's assertion fails: the original test runs and the weakening is forbidden", async () => {
    const r = await check("weakened", {
      "settlement/fx.go": read("settlement/fx.go").replace("/ 10_000", "/ 1_000"),
      "settlement/fx_test.go": read("settlement/fx_test.go").replace(`t.Errorf("got %v", got)`, "_ = got"),
    })
    expect(r.report.decision).toMatchObject({ scope: "protect-only", blocking: true })
    expect(r.report.checks.find((c: { check: string }) => c.check === "unit")).toMatchObject({ status: "failed" })
    expect(r.report.integrity.findings.map((f: { check: string }) => f.check)).toContain("weakened-assertions")
    expect(r.code).toBe(1)
  }, TIMEOUT)
})

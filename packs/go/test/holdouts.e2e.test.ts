import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cpSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { cli } from "../../../packages/cli/test/harness.ts"
import { TempRepo } from "../../../packages/core/test/temp-repo.ts"
import { goPack } from "../src/index.ts"

// Spec 0003 end to end with the real Go toolchain and the go-service fixture:
// a holdout test committed at base, run only with `check --holdouts`.
// Opt in with GAUNTLET_E2E=1.

const E2E = process.env.GAUNTLET_E2E === "1"
const FIXTURE = join(import.meta.dir, "..", "..", "..", "examples", "fixtures", "go-service")
const TIMEOUT = 5 * 60 * 1000
const read = (p: string) => readFileSync(join(FIXTURE, p), "utf8")

const POLICY = `gauntlet "go-service"
use go
mode enforce
owners @platform

protect {
  tests "**/*_test.go"
}

suites {
  unit    "**/*_test.go"
  holdout "acceptance" paths "**/*_holdout_test.go" ci only
}

gates {
  verify    { unit }
  behaviour { acceptance }
}
`

// The agent never sees this test. Its message must never reach a report.
const HOLDOUT = `package settlement

import (
	"testing"

	"example.com/svc/domain"
)

func TestConvertsAnyRate(t *testing.T) {
	if got := Convert(domain.Money{Minor: 200, Currency: "EUR"}, 15_000, "USD"); got.Minor != 300 {
		t.Errorf("SECRET-HOLDOUT-DETAIL got %v", got)
	}
}
`

// Passes the visible test (100 at 11 000 basis points is 110) and nothing else.
const OVERFIT = read("settlement/fx.go").replace("amount.Minor * rateBasisPoints / 10_000", "amount.Minor + amount.Minor/10")

describe.skipIf(!E2E)("holdouts (real Go)", () => {
  let repo: TempRepo
  let base = ""
  beforeAll(() => {
    repo = new TempRepo()
    cpSync(FIXTURE, repo.dir, { recursive: true })
    repo.write({ ".gauntlet/policy.gx": POLICY, "settlement/fx_holdout_test.go": HOLDOUT })
    base = repo.commit("trunk")
  })
  afterAll(() => repo?.cleanup())

  const check = async (name: string, files: Record<string, string>, flags: string[], remove: string[] = []) => {
    repo.git("checkout", "-q", "-B", name, base)
    repo.write(files)
    for (const p of remove) repo.git("rm", "-q", p)
    repo.commit(name)
    const out = join(repo.dir, ".git", `out-${name}`)
    const res = await cli(["check", "--repo", repo.dir, "--base", base, "--out", out, "--no-record", ...flags], [goPack])
    const json = readFileSync(join(out, "gauntlet-report.json"), "utf8")
    return { code: res.code, json, report: JSON.parse(json), markdown: readFileSync(join(out, "gauntlet-report.md"), "utf8") }
  }
  const acceptance = (r: { report: { checks: Array<{ check: string }> } }) => r.report.checks.find((c) => c.check === "acceptance")

  test("without --holdouts the holdout is pending and its test never runs", async () => {
    const r = await check("local", { "settlement/fx.go": OVERFIT }, [])
    expect(r.report.checks.find((c: { check: string }) => c.check === "unit")).toMatchObject({ status: "passed" })
    expect(acceptance(r)).toMatchObject({ status: "not-executed" })
    expect((acceptance(r) as unknown as { reason: string }).reason).toContain("holdout pending")
    expect(r.json).not.toContain("TestConvertsAnyRate")
  }, TIMEOUT)

  test("with --holdouts an unchanged behaviour passes the holdout", async () => {
    const r = await check("clean", { "settlement/fx.go": `${read("settlement/fx.go")}\n// Rates are in basis points.\n` }, ["--holdouts"])
    expect(acceptance(r)).toMatchObject({ status: "passed" })
    expect(r.report.checks.find((c: { check: string }) => c.check === "unit")).toMatchObject({ status: "passed" })
  }, TIMEOUT)

  test("an overfit change passes the visible suite and fails as a holdout gap, naming only the test", async () => {
    const r = await check("overfit", { "settlement/fx.go": OVERFIT }, ["--holdouts"])
    expect(r.report.checks.find((c: { check: string }) => c.check === "unit")).toMatchObject({ status: "passed" })
    expect(acceptance(r)).toMatchObject({ status: "failed", holdoutGap: true })
    expect((acceptance(r) as unknown as { reason: string }).reason).toStartWith("holdout gap")
    expect((acceptance(r) as unknown as { failures: string[] }).failures).toEqual([expect.stringContaining("TestConvertsAnyRate")])
    expect(r.json).not.toContain("SECRET-HOLDOUT-DETAIL")
    expect(r.markdown).not.toContain("SECRET-HOLDOUT-DETAIL")
    expect(r.code).toBe(1)
  }, TIMEOUT)

  test("deleting the holdout at head doesn't stop it: it runs from base, and the deletion is forbidden", async () => {
    const r = await check("deleted", { "settlement/fx.go": OVERFIT }, ["--holdouts"], ["settlement/fx_holdout_test.go"])
    expect(acceptance(r)).toMatchObject({ status: "failed", holdoutGap: true })
    expect(r.report.decision.nominations.map((n: { reason: string }) => n.reason).join("\n")).toContain("settlement/fx_holdout_test.go is protected (holdout acceptance)")
    expect(r.report.integrity.findings.map((f: { check: string }) => f.check)).toContain("deleted-tests")
  }, TIMEOUT)
})

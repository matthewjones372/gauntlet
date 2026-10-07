import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli, POLICY } from "./harness.ts"

// `gauntlet check --protect-only` (spec 0001), with the harness's scripted
// tools: the base commit's policy, pass or fail, enforced even in shadow mode.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const shadowRepo = () => {
  const s = baseRepo()
  repos.push(s.r)
  // The base policy is in shadow mode: a normal check never blocks.
  s.r.git("checkout", "-q", "main")
  s.r.write({ ".gauntlet/policy.gx": POLICY.replace("mode enforce", "mode shadow") })
  const base = s.r.commit("shadow mode")
  s.r.git("checkout", "-q", "-B", "feature", base)
  return { r: s.r, base }
}
const report = (dir: string) => JSON.parse(readFileSync(join(dir, "gauntlet-report.json"), "utf8"))

describe("gauntlet check --protect-only", () => {
  test("a change that breaks a test fails, even though the policy says shadow; a normal check doesn't block", async () => {
    const { r, base } = shadowRepo()
    r.write({ "src/main/behaviour.txt": "broken add\n" })
    r.commit("break add")
    const out = join(r.dir, ".git", "po")
    const res = await cli(["check", "--repo", r.dir, "--base", base, "--protect-only", "--out", out, "--no-record"])
    expect(res.code).toBe(1)
    const rep = report(out)
    expect(rep.decision).toMatchObject({ scope: "protect-only", blocking: true, mode: "enforce" })
    expect(res.out).toContain("## Gauntlet protect-only: failed")
    expect(res.out).toContain("Gates: ")
    const normal = await cli(["check", "--repo", r.dir, "--base", base, "--out", join(r.dir, ".git", "normal"), "--no-record"])
    expect(normal.code).toBe(0)
    expect(report(join(r.dir, ".git", "normal")).decision.scope).toBeUndefined()
  })

  test("only the boundary runs: lint ratchet and the zone's review are left out", async () => {
    const { r, base } = shadowRepo()
    r.write({ "src/money/Fx.kt": "class Fx { val rate = 2 }\n" })
    r.commit("touch the money zone")
    const out = join(r.dir, ".git", "po")
    const res = await cli(["check", "--repo", r.dir, "--base", base, "--protect-only", "--out", out, "--no-record"])
    const rep = report(out)
    expect(rep.checks.map((c: { check: string }) => c.check).sort()).toEqual(["build", "coverage", "unit"])
    expect(rep.decision.nominations.map((n: { tier: string }) => n.tier)).not.toContain("owner")
    expect(res.code).toBe(0)
  })

  test("the policy comes from the base, even when the change loosens it", async () => {
    const { r, base } = shadowRepo()
    r.write({ ".gauntlet/policy.gx": POLICY.replace("mode enforce", "mode shadow").replace("verify { unit, coverage >= 80% }", "verify { coverage >= 80% }"), "src/main/behaviour.txt": "broken add\n" })
    r.commit("drop the unit suite and break add")
    const out = join(r.dir, ".git", "po")
    await cli(["check", "--repo", r.dir, "--base", base, "--protect-only", "--out", out, "--no-record"])
    const rep = report(out)
    expect(rep.policy.origin).toBe("base")
    expect(rep.checks.find((c: { check: string }) => c.check === "unit")?.status).toBe("failed")
  })

  test("can't be combined with --working-tree", async () => {
    const { r } = shadowRepo()
    const res = await cli(["check", "--repo", r.dir, "--protect-only", "--working-tree"])
    expect(res.code).toBe(2)
    expect(res.err).toContain("can't be combined")
  })
})

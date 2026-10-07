import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { INSTALLED_PACKS } from "../src/packs.ts"
import { cli } from "./harness.ts"

// The three-step start: `gauntlet setup`, `/gauntlet-setup` in Claude Code
// (simulated by writing its proposal), and `gauntlet apply`.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const GO = {
  "go.mod": "module example.com/svc\n\ngo 1.25\n",
  "settlement/fx.go": "package settlement\n\nfunc Convert(minor int64, rateBp int64) int64 {\n\treturn minor * rateBp / 10000\n}\n",
  "settlement/fx_test.go": "package settlement\n\nimport \"testing\"\n\nfunc TestConvert(t *testing.T) {\n\tif Convert(100, 9200) != 92 {\n\t\tt.Fatal(\"wrong\")\n\t}\n}\n",
}

const project = (extra: Record<string, string> = {}) => {
  const r = new TempRepo()
  repos.push(r)
  r.write({ ...GO, ...extra })
  r.commit("existing project")
  return r
}
const gauntlet = (r: TempRepo, ...args: string[]) => cli([...args, "--repo", r.dir], [...INSTALLED_PACKS])
const read = (r: TempRepo, p: string) => readFileSync(join(r.dir, p), "utf8")
const subjects = (r: TempRepo) => r.git("log", "--format=%s").trim().split("\n")

describe("gauntlet setup", () => {
  test("drafts the policy, connects Claude Code with /gauntlet-setup, and keeps the project's own instructions", async () => {
    const r = project({ "CLAUDE.md": "# My project\n\nRun make lint first.\n" })
    const res = await gauntlet(r, "setup")
    expect(res.code).toBe(0)
    expect(read(r, ".gauntlet/policy.gx")).toContain("mode shadow")
    expect(read(r, ".claude/commands/gauntlet-setup.md")).toContain("one at a time")
    expect(read(r, "CLAUDE.md")).toStartWith("# My project\n\nRun make lint first.\n")
    expect(res.out).toContain("type /gauntlet-setup")
    expect((await gauntlet(r, "setup")).out).toContain("already exists; keeping it")
  })
})

describe("gauntlet apply", () => {
  test("with no proposal, commits the draft and the baseline; a second run changes nothing", async () => {
    const r = project()
    await gauntlet(r, "setup")
    const res = await gauntlet(r, "apply")
    expect(res.code).toBe(0)
    expect(subjects(r).slice(0, 2)).toEqual(["Record Gauntlet baseline", "Add Gauntlet"])
    expect(existsSync(join(r.dir, ".gauntlet/baseline.sarif"))).toBe(true)
    expect(res.out).not.toContain("Commit it.")
    const again = await gauntlet(r, "apply")
    expect(again.out).toContain("is already recorded")
    expect(subjects(r)[0]).toBe("Record Gauntlet baseline")
    expect(r.git("status", "--porcelain").trim()).toBe("")
  })

  test("a proposal is shown before it's applied, with what loosens it marked, then removed", async () => {
    const r = project()
    await gauntlet(r, "setup")
    const draft = read(r, ".gauntlet/policy.gx")
    writeFileSync(join(r.dir, "gauntlet.proposal.gx"), draft.replace("// owners @your-team // who approves owner-tier changes and edits to this policy", "owners @alice").replace(">= 80%", ">= 70%"))
    const res = await gauntlet(r, "apply")
    expect(res.code).toBe(0)
    expect(res.out).toContain("This will be applied to .gauntlet/policy.gx:")
    expect(res.out).toContain("  - Owners: @alice")
    expect(res.out).toContain("  - Loosens: gate coverage threshold changes from >= 80% to >= 70%")
    expect(read(r, ".gauntlet/policy.gx")).toContain("owners @alice")
    expect(existsSync(join(r.dir, "gauntlet.proposal.gx"))).toBe(false)
  })

  test("an invalid proposal changes and commits nothing", async () => {
    const r = project()
    await gauntlet(r, "setup")
    const before = subjects(r)
    writeFileSync(join(r.dir, "gauntlet.proposal.gx"), "zone broken {\n")
    const res = await gauntlet(r, "apply")
    expect(res.code).toBe(2)
    expect(res.err).toContain("isn't a valid policy, so nothing was changed")
    expect(subjects(r)).toEqual(before)
    expect(existsSync(join(r.dir, ".gauntlet/baseline.sarif"))).toBe(false)
  })

  test("--dry-run shows the changes and touches nothing", async () => {
    const r = project()
    await gauntlet(r, "setup")
    writeFileSync(join(r.dir, "gauntlet.proposal.gx"), read(r, ".gauntlet/policy.gx").replace("mode shadow", "mode enforce"))
    const res = await gauntlet(r, "apply", "--dry-run")
    expect(res.out).toContain("Mode: enforce (failing changes are blocked)")
    expect(read(r, ".gauntlet/policy.gx")).toContain("mode shadow")
    expect(existsSync(join(r.dir, "gauntlet.proposal.gx"))).toBe(true)
  })
})

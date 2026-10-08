import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { withoutGauntletHooks } from "../src/app.ts"
import { INSTALLED_PACKS } from "../src/packs.ts"
import { cli } from "./harness.ts"

// Gauntlet's Claude Code hooks stay off until setup finishes, so a half-set-up
// project can't trap the agent in a loop; the project's own hooks are kept.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))
const IDENTITY = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" }
const saved = Object.fromEntries(Object.keys(IDENTITY).map((k) => [k, process.env[k]]))
beforeAll(() => Object.assign(process.env, IDENTITY))
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]
  else process.env[k] = v
})

const own = { matcher: "Bash", hooks: [{ type: "command", command: "bun tools/guard.ts" }] }

describe("Gauntlet's hooks during setup", () => {
  test("setup leaves them off and keeps the project's own; apply switches them on", async () => {
    const r = new TempRepo()
    repos.push(r)
    r.write({
      ".claude/settings.json": JSON.stringify({ hooks: { PreToolUse: [own] } }),
      "go.mod": "module example.com/svc\n\ngo 1.21\n",
      "a.go": "package svc\n\nfunc A() int { return 1 }\n",
      "a_test.go": "package svc\n\nimport \"testing\"\n\nfunc TestA(t *testing.T) {\n\tif A() != 1 {\n\t\tt.Fatal(\"no\")\n\t}\n}\n",
    })
    r.commit("project")
    await cli(["setup", "--repo", r.dir], [...INSTALLED_PACKS])
    const during = readFileSync(join(r.dir, ".claude/settings.json"), "utf8")
    expect(during).not.toContain("gauntlet hook")
    expect(during).toContain("bun tools/guard.ts")
    await cli(["apply", "--repo", r.dir], [...INSTALLED_PACKS])
    const after = readFileSync(join(r.dir, ".claude/settings.json"), "utf8")
    expect(after).toContain("gauntlet hook stop")
    expect(after).toContain("gauntlet hook pre-tool-use")
    expect(after).toContain("bun tools/guard.ts")
    expect(r.git("status", "--porcelain").trim()).toBe("")
  }, 60_000)

  test("removing them keeps everything else in the file", () => {
    const settings = JSON.stringify({ permissions: { deny: ["Edit(.gauntlet/**)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "gauntlet hook stop" }] }], PreToolUse: [own] } })
    expect(JSON.parse(withoutGauntletHooks(settings))).toEqual({ permissions: { deny: ["Edit(.gauntlet/**)"] }, hooks: { PreToolUse: [own] } })
  })
})

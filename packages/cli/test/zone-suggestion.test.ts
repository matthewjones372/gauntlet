import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { INSTALLED_PACKS } from "../src/packs.ts"
import { cli } from "./harness.ts"

// After setup, a change that adds a sensitive-looking area no zone covers gets
// a note suggesting the policy be reviewed. It never changes the decision.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

// `gauntlet apply` commits as the person running it; CI runners have no git identity, so the tests give it one.
const IDENTITY = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" }
const saved = Object.fromEntries(Object.keys(IDENTITY).map((k) => [k, process.env[k]]))
beforeAll(() => Object.assign(process.env, IDENTITY))
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]
  else process.env[k] = v
})

const GO = {
  "go.mod": "module example.com/svc\n\ngo 1.25\n",
  "settlement/fx.go": "package settlement\n\nfunc Convert(minor int64, rateBp int64) int64 {\n\treturn minor * rateBp / 10000\n}\n",
  "settlement/fx_test.go": "package settlement\n\nimport \"testing\"\n\nfunc TestConvert(t *testing.T) {\n\tif Convert(100, 9200) != 92 {\n\t\tt.Fatal(\"wrong\")\n\t}\n}\n",
}
const gauntlet = (r: TempRepo, ...args: string[]) => cli([...args, "--repo", r.dir], [...INSTALLED_PACKS])

const appliedProject = async () => {
  const r = new TempRepo()
  repos.push(r)
  r.write(GO)
  r.commit("existing project")
  await gauntlet(r, "setup", "--owner", "@alice")
  await gauntlet(r, "apply")
  return { r, base: r.git("rev-parse", "HEAD").trim() }
}

const notesAfter = async (r: TempRepo, base: string, files: Record<string, string>) => {
  r.git("checkout", "-q", "-b", `change-${Object.keys(files)[0]!.split("/")[0]}`)
  r.write(files)
  r.commit("change")
  const out = join(r.dir, ".git", "out")
  await gauntlet(r, "check", "--base", base, "--out", out, "--no-record")
  return JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8")).policy.notes as string[]
}

describe("a new area that may need a zone", () => {
  test("a change adding billing/ is told it isn't in a zone, and how to protect it", async () => {
    const { r, base } = await appliedProject()
    const notes = await notesAfter(r, base, { "billing/total.go": "package billing\n\nfunc Total(a, b int64) int64 {\n\treturn a + b\n}\n" })
    expect(notes).toContain("This change adds billing/**, which looks like payments, billing and money code but isn't in a zone. To protect it, run /gauntlet-setup in Claude Code (or add a zone to .gauntlet/policy.gx).")
  })

  test("files added inside an existing zone get no note", async () => {
    const { r, base } = await appliedProject()
    const notes = await notesAfter(r, base, { "settlement/rates.go": "package settlement\n\nconst Basis = 10000\n" })
    expect(notes.filter((n) => n.includes("/gauntlet-setup"))).toEqual([])
  })
})

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { INSTALLED_PACKS } from "../src/packs.ts"
import { cli } from "./harness.ts"

// Setup on a project that already finished it says so, instead of walking through steps 2 and 3.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))
const IDENTITY = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" }
const saved = Object.fromEntries(Object.keys(IDENTITY).map((k) => [k, process.env[k]]))
beforeAll(() => Object.assign(process.env, IDENTITY))
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]
  else process.env[k] = v
})

describe("setup after setup", () => {
  test("says Gauntlet is set up and how to change the policy", async () => {
    const r = new TempRepo()
    repos.push(r)
    r.write({ "go.mod": "module example.com/svc\n\ngo 1.21\n", "a.go": "package svc\n\nfunc A() int { return 1 }\n", "a_test.go": "package svc\n\nimport \"testing\"\n\nfunc TestA(t *testing.T) {\n\tif A() != 1 {\n\t\tt.Fatal(\"no\")\n\t}\n}\n" })
    r.commit("project")
    await cli(["setup", "--repo", r.dir], [...INSTALLED_PACKS])
    await cli(["apply", "--repo", r.dir], [...INSTALLED_PACKS])
    const again = await cli(["setup", "--repo", r.dir], [...INSTALLED_PACKS])
    expect(again.out).toContain("Gauntlet is already set up here")
    expect(again.out).toContain("/gauntlet-setup")
    expect(again.out).not.toContain("Step 2 of 3")
    expect(again.out).not.toContain("gauntlet apply")
  }, 60_000)
})

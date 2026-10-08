import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { INSTALLED_PACKS } from "../src/packs.ts"
import { cli } from "./harness.ts"

// Setting up a missing tool often means a new protected file (project/plugins.sbt,
// a linter config). The agent can't write it, so it goes in the changes patch,
// and the baseline is recorded again for the gates the tool lets run.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))
const IDENTITY = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" }
const saved = Object.fromEntries(Object.keys(IDENTITY).map((k) => [k, process.env[k]]))
beforeAll(() => Object.assign(process.env, IDENTITY))
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]
  else process.env[k] = v
})

const project = () => {
  const r = new TempRepo()
  repos.push(r)
  r.write({ "go.mod": "module example.com/svc\n\ngo 1.21\n", "a.go": "package svc\n\nfunc A() int { return 1 }\n", "a_test.go": "package svc\n\nimport \"testing\"\n\nfunc TestA(t *testing.T) {\n\tif A() != 1 {\n\t\tt.Fatal(\"no\")\n\t}\n}\n" })
  r.commit("project")
  return r
}
const NEW_FILE = `diff --git a/.golangci.yml b/.golangci.yml
new file mode 100644
--- /dev/null
+++ b/.golangci.yml
@@ -0,0 +1,2 @@
+linters:
+  default: standard
`

describe("a tool set up through the changes patch", () => {
  test("creates the new file, and after a baseline the baseline is recorded again", async () => {
    const r = project()
    await cli(["setup", "--repo", r.dir], [...INSTALLED_PACKS])
    await cli(["apply", "--repo", r.dir], [...INSTALLED_PACKS])
    writeFileSync(join(r.dir, "gauntlet.changes.patch"), NEW_FILE)
    const res = await cli(["apply", "--repo", r.dir], [...INSTALLED_PACKS])
    expect(readFileSync(join(r.dir, ".golangci.yml"), "utf8")).toContain("default: standard")
    expect(res.out).toContain("the baseline is recorded again for the gates they let run")
    expect(r.git("log", "--format=%s").trim().split("\n")).toContain("Changes to protected files for Gauntlet's first baseline")
  }, 120_000)

  test("with no patch, an applied project's baseline stays as it is", async () => {
    const r = project()
    await cli(["setup", "--repo", r.dir], [...INSTALLED_PACKS])
    await cli(["apply", "--repo", r.dir], [...INSTALLED_PACKS])
    const res = await cli(["apply", "--repo", r.dir], [...INSTALLED_PACKS])
    expect(res.out).toContain("is already recorded for this policy")
  }, 120_000)
})

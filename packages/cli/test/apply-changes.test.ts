import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { INSTALLED_PACKS } from "../src/packs.ts"
import { cli } from "./harness.ts"

// Changes to protected files the agent can't make itself go in a patch the
// person agrees to; gauntlet apply shows it, applies it and commits it apart.

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
const PATCH = `diff --git a/go.mod b/go.mod
--- a/go.mod
+++ b/go.mod
@@ -1,3 +1,3 @@
 module example.com/svc
 
-go 1.21
+go 1.22
`

describe("gauntlet apply with a changes patch", () => {
  test("shows it, applies it and commits it on its own before the policy", async () => {
    const r = project()
    await cli(["setup", "--repo", r.dir], [...INSTALLED_PACKS])
    writeFileSync(join(r.dir, "gauntlet.changes.patch"), PATCH)
    const res = await cli(["apply", "--repo", r.dir], [...INSTALLED_PACKS])
    expect(res.out).toContain("These changes to protected files will be applied:")
    expect(res.out).toContain("+go 1.22")
    expect(readFileSync(join(r.dir, "go.mod"), "utf8")).toContain("go 1.22")
    expect(existsSync(join(r.dir, "gauntlet.changes.patch"))).toBe(false)
    expect(r.git("log", "--format=%s").trim().split("\n")).toContain("Changes to protected files for Gauntlet's first baseline")
  }, 60_000)

  test("a patch to .gauntlet/ is refused, and nothing changes", async () => {
    const r = project()
    await cli(["setup", "--repo", r.dir], [...INSTALLED_PACKS])
    writeFileSync(join(r.dir, "gauntlet.changes.patch"), "diff --git a/.gauntlet/policy.gx b/.gauntlet/policy.gx\n--- a/.gauntlet/policy.gx\n+++ b/.gauntlet/policy.gx\n@@ -1 +1 @@\n-x\n+y\n")
    const res = await cli(["apply", "--repo", r.dir], [...INSTALLED_PACKS])
    expect(res.code).toBe(2)
    expect(res.err).toContain("changes only through the policy proposal")
  }, 60_000)

  test("a patch that doesn't apply changes nothing", async () => {
    const r = project()
    await cli(["setup", "--repo", r.dir], [...INSTALLED_PACKS])
    writeFileSync(join(r.dir, "gauntlet.changes.patch"), PATCH.replace("-go 1.21", "-go 1.19"))
    const res = await cli(["apply", "--repo", r.dir], [...INSTALLED_PACKS])
    expect(res.code).toBe(2)
    expect(res.err).toContain("doesn't apply cleanly")
    expect(readFileSync(join(r.dir, "go.mod"), "utf8")).toContain("go 1.21")
  }, 60_000)
})

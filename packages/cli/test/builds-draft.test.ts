import { afterEach, describe, expect, test } from "bun:test"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { INSTALLED_PACKS } from "../src/packs.ts"
import { cli } from "./harness.ts"

// ADR 0022: setup drafts one policy for builds in folders, with paths from
// the root and a gate only when every build that runs it has its tool.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const goBuild = (dir: string, lint: boolean) => ({
  [`${dir}/go.mod`]: `module example.com/${dir}\n\ngo 1.21\n`,
  [`${dir}/a.go`]: "package svc\n\nfunc A() int { return 1 }\n",
  [`${dir}/a_test.go`]: "package svc\n\nimport \"testing\"\n\nfunc TestA(t *testing.T) {}\n",
  ...(lint ? { [`${dir}/.golangci.yml`]: "version: \"2\"\n" } : {}),
})

describe("a draft for builds in folders", () => {
  test("names each folder, protects paths under it, and leaves out a gate one build has no tool for", async () => {
    const r = new TempRepo()
    repos.push(r)
    r.write({ "README.md": "two services\n", ...goBuild("api", true), ...goBuild("worker", false) })
    r.commit("two Go builds")
    const res = await cli(["init", "--repo", r.dir, "--template", "--dry-run", "--owner", "@platform"], [...INSTALLED_PACKS])
    expect(res.code).toBe(0)
    expect(res.out).toContain(`use go in "api", "worker"`)
    expect(res.out).toContain(`"api/**/*_test.go"`)
    expect(res.out).not.toContain("lint ratchet")
    expect(res.out).toContain("In worker: Add a .golangci.yml (golangci-lint v2) to gate lint.")
    expect(res.out).toContain("lint runs in every build, so it's left out until worker has its tool set up too.")
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { cpSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expectGolden } from "../../core/test/golden-file.ts"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { INSTALLED_PACKS } from "../src/packs.ts"
import { cli } from "./harness.ts"

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

describe("gauntlet init on a Go module", () => {
  test("drafts a valid shadow-mode policy from the Go pack's defaults", async () => {
    const r = new TempRepo()
    repos.push(r)
    cpSync(join(import.meta.dir, "..", "..", "..", "examples", "fixtures", "go-service"), r.dir, { recursive: true, filter: (src) => !/\/\.gauntlet(\/|$)/.test(src) })
    r.commit("project")
    const res = await cli(["init", "--repo", r.dir, "--name", "go-service", "--owner", "@platform"], [...INSTALLED_PACKS])
    expect(res.code).toBe(0)
    const policy = readFileSync(join(r.dir, ".gauntlet", "policy.gx"), "utf8")
    expectGolden(join(import.meta.dir, "golden", "init-go-service.gx"), policy)
    expect(policy).toContain("use go")
    expect(policy).toContain("fast   { build, lint ratchet, arch }")
    expect(policy).toContain("verify { unit, coverage ratchet >= 80% on changed, mutation ratchet >= 60% on changed }")
    expect((await cli(["validate", "--repo", r.dir], [...INSTALLED_PACKS])).code).toBe(0)
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { cpSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expectGolden } from "../../core/test/golden-file.ts"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { INSTALLED_PACKS } from "../src/packs.ts"
import { cli } from "./harness.ts"

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

describe("gauntlet init on a Cargo project", () => {
  test("drafts a valid shadow-mode policy from the Rust pack's defaults", async () => {
    const r = new TempRepo()
    repos.push(r)
    cpSync(join(import.meta.dir, "..", "..", "..", "examples", "fixtures", "rust-service"), r.dir, { recursive: true, filter: (src) => !/\/(\.gauntlet|target)(\/|$)/.test(src) })
    r.commit("project")
    const res = await cli(["init", "--repo", r.dir, "--name", "rust-service", "--owner", "@platform"], [...INSTALLED_PACKS])
    expect(res.code).toBe(0)
    const policy = readFileSync(join(r.dir, ".gauntlet", "policy.gx"), "utf8")
    expectGolden(join(import.meta.dir, "golden", "init-rust-service.gx"), policy)
    expect(policy).toContain("use rust")
    expect(policy).toContain("fast   { build, lint ratchet, arch }")
    expect(res.out).toContain("Install cargo-mutants and add a .cargo/mutants.toml to gate mutation.")
    expect((await cli(["validate", "--repo", r.dir], [...INSTALLED_PACKS])).code).toBe(0)
  })
})

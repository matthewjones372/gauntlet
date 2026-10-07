import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { project } from "../../../packs/clojure/test/sources.ts"
import { expectGolden } from "../../core/test/golden-file.ts"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { INSTALLED_PACKS } from "../src/packs.ts"
import { cli } from "./harness.ts"

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

describe("gauntlet init on a Clojure project", () => {
  test("drafts a valid shadow-mode policy from the Clojure pack's defaults, without mutation", async () => {
    const r = new TempRepo()
    repos.push(r)
    r.write(project("clojure-service"))
    r.commit("project")
    const res = await cli(["init", "--repo", r.dir, "--name", "clojure-service", "--owner", "@platform"], [...INSTALLED_PACKS])
    expect(res.code).toBe(0)
    const policy = readFileSync(join(r.dir, ".gauntlet", "policy.gx"), "utf8")
    expectGolden(join(import.meta.dir, "golden", "init-clojure-service.gx"), policy)
    expect(policy).toContain("use clojure")
    expect(policy).toContain("verify { unit, coverage ratchet >= 80% on changed }")
    expect(policy).not.toContain("mutation")
    expect(res.out).toContain("Clojure has no mature mutation tool")
    expect((await cli(["validate", "--repo", r.dir], [...INSTALLED_PACKS])).code).toBe(0)
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expectGolden } from "../../core/test/golden-file.ts"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { SOURCES } from "../../../packs/scala/test/sources.ts"
import { INSTALLED_PACKS } from "../src/packs.ts"
import { cli } from "./harness.ts"

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

describe("gauntlet init on a sbt build", () => {
  test("drafts a valid shadow-mode policy from the Scala pack's defaults", async () => {
    const r = new TempRepo()
    repos.push(r)
    r.write(Object.fromEntries(Object.entries(SOURCES).filter(([p]) => p.startsWith("scala-service/")).map(([p, t]) => [p.slice("scala-service/".length), t])))
    r.commit("project")
    const res = await cli(["init", "--repo", r.dir, "--name", "scala-service", "--owner", "@platform"], [...INSTALLED_PACKS])
    expect(res.code).toBe(0)
    const policy = readFileSync(join(r.dir, ".gauntlet", "policy.gx"), "utf8")
    expectGolden(join(import.meta.dir, "golden", "init-scala-service.gx"), policy)
    expect(policy).toContain("use scala")
    expect(policy).toContain("fast   { build, lint ratchet }")
    expect((await cli(["validate", "--repo", r.dir], [...INSTALLED_PACKS])).code).toBe(0)
  })
})

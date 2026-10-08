import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli } from "./harness.ts"

// The Stop hook can fire many times on the same tree; the same tree is judged once.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

describe("check --working-tree on an unchanged tree", () => {
  test("gives the same report again without running the gates", async () => {
    const s = baseRepo()
    repos.push(s.r)
    writeFileSync(join(s.r.dir, "src/main/behaviour.txt"), "broken round\n")
    const out = join(s.r.dir, ".git", "out-tree")
    const first = await cli(["check", "--repo", s.r.dir, "--base", s.base, "--working-tree", "--json", "--out", out])
    const second = await cli(["check", "--repo", s.r.dir, "--base", s.base, "--working-tree", "--json", "--out", out])
    expect(second.code).toBe(first.code)
    expect(JSON.parse(second.out)).toEqual(JSON.parse(first.out))
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { nothingToJudge } from "../src/index.ts"
import { CoreTest } from "./layers.ts"
import { TempRepo } from "./temp-repo.ts"

// Spec 0005: the Stop hook has nothing to judge when only Gauntlet's setup files changed.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))
const judge = (r: TempRepo) => Effect.runPromise(nothingToJudge(r.dir).pipe(Effect.provide(CoreTest)))

describe("nothing to judge", () => {
  test("setup files only, or nothing at all, against the main branch", async () => {
    const r = new TempRepo()
    repos.push(r)
    r.write({ "src/A.kt": "class A" })
    r.commit("base")
    expect(await judge(r)).toBe(true)
    writeFileSync(join(r.dir, "gauntlet.proposal.gx"), "x")
    expect(await judge(r)).toBe(true)
    writeFileSync(join(r.dir, "src/A.kt"), "class B")
    expect(await judge(r)).toBe(false)
  })

  test("without a main branch to compare with, the check runs", async () => {
    const r = new TempRepo()
    repos.push(r)
    r.write({ "src/A.kt": "class A" })
    r.commit("base")
    r.git("branch", "-m", "trunk")
    expect(await judge(r)).toBe(false)
  })
})

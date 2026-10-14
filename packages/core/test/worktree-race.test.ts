import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Git } from "../src/index.ts"
import { CoreTest } from "./layers.ts"
import { TempRepo } from "./temp-repo.ts"

// selftest runs its fixtures side by side, each in its own worktree. Removing
// the last worktree deletes .git/worktrees, so an add running at the same
// moment used to fail with "could not create directory of
// '.git/worktrees/work'". Worktrees are now added and removed one at a time.

const repos: TempRepo[] = []
const dirs: string[] = []
afterEach(() => {
  repos.splice(0).forEach((r) => r.cleanup())
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

describe("worktrees added and removed side by side", () => {
  test("every add and remove succeeds, however they interleave", async () => {
    const r = new TempRepo()
    repos.push(r)
    r.write({ "a.txt": "a\n" })
    const head = r.commit("one")
    const cycle = (i: number) =>
      Effect.gen(function*() {
        const git = yield* Git
        const root = mkdtempSync(join(tmpdir(), "gauntlet-worktree-race-"))
        dirs.push(root)
        // The same basename for every worktree, as selftest's fixtures have.
        const dir = join(root, "work")
        yield* git.addWorktree(r.dir, dir, head)
        yield* git.removeWorktree(r.dir, dir)
        return i
      })
    const done = await Effect.runPromise(
      Effect.forEach(Array.from({ length: 64 }, (_, i) => i), cycle, { concurrency: 16 }).pipe(Effect.provide(CoreTest)),
    )
    expect(done).toHaveLength(64)
    expect(r.git("worktree", "list").trim().split("\n")).toHaveLength(1)
  }, 60_000)
})

import { afterEach, describe, expect, test } from "bun:test"
import { IMPLICIT_PROTECT } from "@gauntlet/ir"
import { Effect, Exit } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Git, type PreparedWorkspace, Workspace } from "../src/index.ts"
import { CoreTest } from "./layers.ts"
import { TempRepo } from "./temp-repo.ts"

// `withBase` against real git: inside it the change's files are as the base
// has them; afterwards the checkout is exactly as it was, protected files put
// back to the base included, and its file listing unchanged.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const protect = [{ group: "tests", kind: "tests" as const, globs: ["src/test/**"] }, IMPLICIT_PROTECT]

const run = <A>(r: TempRepo, base: string, head: string, use: (ws: PreparedWorkspace) => Effect.Effect<A, unknown, Git>) =>
  Effect.runPromiseExit(Effect.scoped(Workspace.use((w) => w.prepare({ repo: r.dir, base, head, protect, runnerConfig: [] })).pipe(Effect.flatMap(use))).pipe(Effect.provide(CoreTest)))

describe("the change's files as the base has them", () => {
  test("only while withBase runs; then the checkout is as it was", async () => {
    const r = new TempRepo()
    repos.push(r)
    r.write({ "src/main/A.kt": "class A // base", "src/main/Old.kt": "class Old", "src/test/ATest.kt": "class ATest // base" })
    const base = r.commit("base")
    r.write({ "src/main/A.kt": "class A // head", "src/main/New.kt": "class New", "src/test/ATest.kt": "class ATest // agent edit" })
    r.git("rm", "-q", "src/main/Old.kt")
    const head = r.commit("head")
    const paths = ["src/main/A.kt", "src/main/New.kt", "src/main/Old.kt", "src/test/ATest.kt"]
    const read = (dir: string) => Object.fromEntries(paths.map((p) => [p, existsSync(join(dir, p)) ? readFileSync(join(dir, p), "utf8") : null]))
    const exit = await run(r, base, head, (ws) =>
      Effect.gen(function*() {
        const git = yield* Git
        const before = { files: read(ws.dir), listed: [...(yield* git.listWorkingFiles(ws.dir))].sort() }
        const inside = yield* ws.withBase!(paths, Effect.sync(() => read(ws.dir)))
        const after = { files: read(ws.dir), listed: [...(yield* git.listWorkingFiles(ws.dir))].sort() }
        return { before, inside, after }
      }))
    if (Exit.isFailure(exit)) throw new Error(String(exit.cause))
    const { before, inside, after } = exit.value
    // The protected test is already the base's; the change's own edit to it never comes back.
    expect(before.files).toEqual({ "src/main/A.kt": "class A // head", "src/main/New.kt": "class New", "src/main/Old.kt": null, "src/test/ATest.kt": "class ATest // base" })
    expect(inside).toEqual({ "src/main/A.kt": "class A // base", "src/main/New.kt": null, "src/main/Old.kt": "class Old", "src/test/ATest.kt": "class ATest // base" })
    expect(after).toEqual(before)
  })

  test("the checkout is put back even when the run inside fails", async () => {
    const r = new TempRepo()
    repos.push(r)
    r.write({ "src/main/A.kt": "class A // base" })
    const base = r.commit("base")
    r.write({ "src/main/A.kt": "class A // head" })
    const head = r.commit("head")
    const exit = await run(r, base, head, (ws) =>
      ws.withBase!(["src/main/A.kt"], Effect.fail("boom")).pipe(
        Effect.catch(() => Effect.sync(() => readFileSync(join(ws.dir, "src/main/A.kt"), "utf8"))),
      ))
    if (Exit.isFailure(exit)) throw new Error(String(exit.cause))
    expect(exit.value).toBe("class A // head")
  })
})

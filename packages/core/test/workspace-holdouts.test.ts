import { afterEach, describe, expect, test } from "bun:test"
import { IMPLICIT_PROTECT } from "@gauntlet/ir"
import { Effect, Exit } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Git, type PreparedWorkspace, Workspace } from "../src/index.ts"
import { CoreTest } from "./layers.ts"
import { TempRepo } from "./temp-repo.ts"

// ADR 0019 against real git: holdout files are out of the checkout and its
// index, and `withHoldout` puts the base commit's copies in only while it runs.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const protect = [{ group: "tests", kind: "tests" as const, globs: ["src/test/**"] }, IMPLICIT_PROTECT]
const holdouts = [{ name: "acceptance", globs: ["src/test/holdout/**"] }]

const run = <A>(r: TempRepo, base: string, head: string, use: (ws: PreparedWorkspace) => Effect.Effect<A, unknown, Git>) =>
  Effect.runPromiseExit(Effect.scoped(Workspace.use((w) => w.prepare({ repo: r.dir, base, head, protect, runnerConfig: [], holdouts })).pipe(Effect.flatMap(use))).pipe(Effect.provide(CoreTest)))

describe("holdout files in a real checkout", () => {
  test("are absent, and present from base only inside withHoldout", async () => {
    const r = new TempRepo()
    repos.push(r)
    r.write({ "src/main/A.kt": "class A", "src/test/ATest.kt": "class ATest", "src/test/holdout/HTest.kt": "class HTest // base" })
    const base = r.commit("base")
    r.write({ "src/test/holdout/HTest.kt": "class HTest // head edit", "src/main/A.kt": "class A2" })
    const head = r.commit("head")
    const exit = await run(r, base, head, (ws) =>
      Effect.gen(function*() {
        const git = yield* Git
        const before = { file: existsSync(join(ws.dir, "src/test/holdout/HTest.kt")), listed: (yield* git.listWorkingFiles(ws.dir)).includes("src/test/holdout/HTest.kt") }
        const inside = yield* ws.withHoldout!(["src/test/holdout/**"], (paths) =>
          Effect.sync(() => ({ paths, text: readFileSync(join(ws.dir, "src/test/holdout/HTest.kt"), "utf8") })))
        const after = existsSync(join(ws.dir, "src/test/holdout/HTest.kt"))
        return { before, inside, after, materialised: ws.materialised.map((m) => `${m.path} ${m.group} ${m.action}`) }
      }))
    if (Exit.isFailure(exit)) throw new Error(String(exit.cause))
    expect(exit.value.before).toEqual({ file: false, listed: false })
    expect(exit.value.inside).toEqual({ paths: ["src/test/holdout/HTest.kt"], text: "class HTest // base" })
    expect(exit.value.after).toBe(false)
    expect(exit.value.materialised).toEqual(["src/test/holdout/HTest.kt holdout acceptance removed"])
  })

  test("a rename out of a holdout restores the protected original", async () => {
    const r = new TempRepo()
    repos.push(r)
    r.write({ "src/test/holdout/HTest.kt": "class HTest", "src/test/BTest.kt": "class BTest" })
    const base = r.commit("base")
    r.git("mv", "src/test/BTest.kt", "src/test/holdout/BTest.kt")
    const head = r.commit("head")
    const exit = await run(r, base, head, (ws) => Effect.succeed(ws.materialised.map((m) => `${m.path} ${m.group} ${m.action}`)))
    if (Exit.isFailure(exit)) throw new Error(String(exit.cause))
    expect(exit.value).toEqual(["src/test/BTest.kt tests restored", "src/test/holdout/BTest.kt holdout acceptance removed"])
  })
})

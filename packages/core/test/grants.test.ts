import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Git, GRANTS_REF, grantPathProblem, grantsBetween, recordGrant } from "../src/index.ts"
import { CoreTest } from "./layers.ts"
import { TempRepo } from "./temp-repo.ts"

// Grants (spec 0015): which paths can be granted, and which grants a change
// carries. A grant belongs to the commits built on the head it was given at,
// until the base takes that head in.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))
const run = <A, E>(e: Effect.Effect<A, E, Git>) => Effect.runPromise(e.pipe(Effect.provide(CoreTest)))

const grant = (headSha: string, pr = 7) => ({ pr, branch: "feature", headSha, paths: ["scripts/build.sh"], reason: "the build script needs a budget step", approver: "@platform" })

describe("grantPathProblem", () => {
  test("one file, from the repository's root, outside .git", () => {
    expect(grantPathProblem("scripts/build.sh")).toBeUndefined()
    expect(grantPathProblem(".gauntlet/policy.gx")).toBeUndefined()
    expect(grantPathProblem(".git")).toContain("can't name .git/")
    expect(grantPathProblem(".git/refs/notes/gauntlet-overrides")).toContain("can't name .git/")
    expect(grantPathProblem("/etc/passwd")).toContain("from the repository's root")
    expect(grantPathProblem("a//b")).toContain("from the repository's root")
    expect(grantPathProblem("./scripts/build.sh")).toContain("from the repository's root")
    expect(grantPathProblem("scripts/**")).toContain("doesn't take patterns")
  })
})

describe("grantsBetween", () => {
  const repo = () => {
    const r = new TempRepo()
    repos.push(r)
    r.write({ "a.txt": "a\n" })
    const base = r.commit("base")
    r.git("checkout", "-q", "-b", "feature")
    r.write({ "a.txt": "b\n" })
    const head = r.commit("feature")
    return { r, base, head }
  }

  test("a grant given on the change counts for commits built on it, until the base takes it in", async () => {
    const { r, base, head } = repo()
    await run(recordGrant(r.dir, grant(head)))
    r.write({ "a.txt": "c\n" })
    const later = r.commit("later")
    expect(await run(grantsBetween(r.dir, [base], later))).toEqual([grant(head)])
    expect(await run(grantsBetween(r.dir, [later], later))).toEqual([])
    expect(await run(grantsBetween(r.dir, [base], base))).toEqual([])
  })

  test("a note copied onto another commit, or for a commit git doesn't have, counts for nothing", async () => {
    const { r, base, head } = repo()
    await run(Effect.gen(function*() {
      yield* (yield* Git).appendNote(r.dir, GRANTS_REF, head, JSON.stringify(grant(base)))
    }))
    expect(await run(grantsBetween(r.dir, [base], head))).toEqual([])
    expect(await run(Effect.gen(function*() {
      return yield* (yield* Git).isAncestor(r.dir, "0".repeat(40), head)
    }))).toBe(false)
  })

  test("an invalid grant isn't recorded", async () => {
    const { r, head } = repo()
    const failure = (g: ReturnType<typeof grant>) => run(Effect.flip(recordGrant(r.dir, g))) as Promise<{ readonly reason?: string }>
    expect((await failure({ ...grant(head), paths: [] })).reason).toBe("name at least one path")
    expect((await failure({ ...grant(head), paths: [".git/config"] })).reason).toContain("can't name .git/")
    expect((await failure({ ...grant(head), reason: "short" })).reason).toBe("give a reason of at least 10 characters")
  })
})

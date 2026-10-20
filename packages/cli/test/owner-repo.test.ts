import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { checkoutProblem, ForgeFailed, type ForgeShape, ghForge } from "../src/owner.ts"
import { ownerCli } from "./owner-harness.ts"

// The owner's commands run gh and git in the `--repo` directory. A value that
// isn't a local checkout, such as owner/name, is refused before anything is
// spawned: a spawn in a missing directory fails as if gh weren't installed.

const dirs: string[] = []
const repos: TempRepo[] = []
afterEach(() => {
  repos.splice(0).forEach((r) => r.cleanup())
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "gauntlet-repo-"))
  dirs.push(dir)
  return dir
}

/** A forge that records it was reached at all. */
const untouchedForge = (reached: string[]): ForgeShape => {
  const touch = (op: string) => Effect.suspend(() => {
    reached.push(op)
    return Effect.fail(new ForgeFailed({ message: `${op} shouldn't run` }))
  })
  return { pullRequest: () => touch("pullRequest"), login: () => touch("login"), comment: () => touch("comment"), fetch: () => touch("fetch"), push: () => touch("push") }
}

describe("--repo for the owner's commands", () => {
  test("approve refuses owner/name before reaching the forge, and says --repo takes a checkout", async () => {
    const reached: string[] = []
    const res = await ownerCli(["approve", "7", "--head", "abcdef1", "--repo", "someone/no-such-repo"], { forge: untouchedForge(reached) })
    expect(res.code).toBe(2)
    expect(res.err).toContain("--repo takes a local checkout directory, not owner/name: someone/no-such-repo doesn't exist here.")
    expect(reached).toEqual([])
  })

  test("grant refuses a directory that isn't a git checkout, naming it", async () => {
    const reached: string[] = []
    const dir = scratch()
    const res = await ownerCli(["grant", "7", "build.gradle.kts", "--reason", "why", "--head", "abcdef1", "--repo", dir], { forge: untouchedForge(reached) })
    expect(res.code).toBe(2)
    expect(res.err).toContain(`--repo takes a local checkout directory: ${dir} isn't a git checkout.`)
    expect(reached).toEqual([])
  })
})

describe("checkoutProblem", () => {
  test("names a missing path, a file and a plain directory", () => {
    const dir = scratch()
    const missing = join(dir, "gone")
    expect(checkoutProblem(missing, missing)).toBe(`--repo takes a local checkout directory: ${missing} doesn't exist.`)
    const file = join(dir, "file")
    writeFileSync(file, "x")
    expect(checkoutProblem(file, file)).toBe(`--repo takes a local checkout directory: ${file} isn't a directory.`)
    expect(checkoutProblem(dir, dir)).toBe(`--repo takes a local checkout directory: ${dir} isn't a git checkout.`)
  })

  test("accepts a checkout and a directory inside one", () => {
    const r = new TempRepo()
    repos.push(r)
    const inner = join(r.dir, "src", "main")
    mkdirSync(inner, { recursive: true })
    expect(checkoutProblem(".", r.dir)).toBeUndefined()
    expect(checkoutProblem("src/main", inner)).toBeUndefined()
  })

  test("an owner/name that exists here as a directory is taken as one", () => {
    const r = new TempRepo()
    repos.push(r)
    const nested = join(r.dir, "owner", "name")
    mkdirSync(nested, { recursive: true })
    expect(checkoutProblem("owner/name", nested)).toBeUndefined()
  })
})

describe("ghForge", () => {
  test("a spawn that can't start says whether the directory or the command is missing", async () => {
    const gone = join(tmpdir(), "gauntlet-no-such-checkout")
    const inMissingDir = await Effect.runPromise(Effect.flip(ghForge("gh").login(gone)))
    expect(inMissingDir.message).toBe(`gh couldn't run: its working directory ${gone} doesn't exist.`)
    const notInstalled = await Effect.runPromise(Effect.flip(ghForge("gauntlet-no-such-gh").login(tmpdir())))
    expect(notInstalled.message).toBe("gauntlet-no-such-gh couldn't run: gauntlet-no-such-gh isn't on PATH.")
  })
})

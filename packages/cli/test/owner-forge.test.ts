import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { ghForge } from "../src/owner.ts"

// The owner's commands reach GitHub through the owner's own `gh`, and the
// remote through git. A stand-in `gh` records what it was asked; a bare
// repository stands in for origin.

const dirs: string[] = []
const repos: TempRepo[] = []
afterEach(() => {
  repos.splice(0).forEach((r) => r.cleanup())
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

const PR = { number: 7, state: "OPEN", title: "T", url: "https://github.com/o/r/pull/7", headRefOid: "a".repeat(40), headRefName: "feature", baseRefOid: "b".repeat(40), baseRefName: "main" }

/** A `gh` that logs its arguments and answers `pr view` and `api user`. */
const fakeGh = (prJson: string) => {
  const dir = mkdtempSync(join(tmpdir(), "gauntlet-gh-"))
  dirs.push(dir)
  const log = join(dir, "log")
  const bin = join(dir, "gh")
  writeFileSync(bin, `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$1 $2" in
  "pr view") printf '%s' '${prJson}' ;;
  "api user") echo platform ;;
  "pr comment") ;;
  *) echo "unknown: $*" >&2; exit 1 ;;
esac
`)
  chmodSync(bin, 0o755)
  return { bin, calls: () => readFileSync(log, "utf8").trim().split("\n") }
}

describe("ghForge", () => {
  test("reads the pull request and the login, and posts a comment, through gh", async () => {
    const gh = fakeGh(JSON.stringify(PR))
    const forge = ghForge(gh.bin)
    const cwd = tmpdir()
    expect(await Effect.runPromise(forge.pullRequest(cwd, 7))).toEqual(PR)
    expect(await Effect.runPromise(forge.login(cwd))).toBe("platform")
    await Effect.runPromise(forge.comment(cwd, 7, "/gauntlet approve abc1234"))
    expect(gh.calls()).toEqual([
      "pr view 7 --json number,state,title,url,headRefOid,headRefName,baseRefOid,baseRefName",
      "api user --jq .login",
      "pr comment 7 --body /gauntlet approve abc1234",
    ])
  })

  test("says what went wrong when gh fails or prints something else", async () => {
    const odd = ghForge(fakeGh("not json").bin)
    expect((await Effect.runPromise(Effect.flip(odd.pullRequest(tmpdir(), 7)))).message).toBe("gh pr view 7 printed something unexpected")
    const failing = await Effect.runPromise(Effect.flip(ghForge(fakeGh("{}").bin).fetch(tmpdir(), ["main"])))
    expect(failing.message).toContain("git fetch --no-tags origin main failed")
    const missing = await Effect.runPromise(Effect.flip(ghForge(join(tmpdir(), "no-such-gh")).login(tmpdir())))
    expect(missing.message).toContain("couldn't run")
  })

  test("fetches from and pushes to origin", async () => {
    const origin = mkdtempSync(join(tmpdir(), "gauntlet-origin-"))
    dirs.push(origin)
    Bun.spawnSync(["git", "init", "-q", "--bare", origin])
    const r = new TempRepo()
    repos.push(r)
    r.write({ "a.txt": "a\n" })
    const sha = r.commit("first")
    r.git("remote", "add", "origin", origin)
    r.git("push", "-q", "origin", "main")
    r.git("notes", "--ref", "gauntlet-overrides", "add", "-m", "note", sha)
    const forge = ghForge("gh")
    await Effect.runPromise(forge.push(r.dir, "refs/notes/gauntlet-overrides"))
    expect(Bun.spawnSync(["git", "-C", origin, "notes", "--ref", "gauntlet-overrides", "show", sha]).stdout.toString().trim()).toBe("note")
    await Effect.runPromise(forge.fetch(r.dir, ["+refs/heads/main:refs/remotes/origin/main"]))
    expect(r.git("rev-parse", "refs/remotes/origin/main")).toBe(sha)
  })
})

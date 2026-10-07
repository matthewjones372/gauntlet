import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli } from "./harness.ts"

// `gauntlet baseline` with a remote and no --trunk: the README's first run,
// where the policy was just committed on main and not pushed yet.

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((c) => c()))

const withOrigin = () => {
  // baseRepo leaves a feature branch checked out; this starts on main.
  const { r } = baseRepo()
  r.git("checkout", "-q", "main")
  const origin = mkdtempSync(join(tmpdir(), "gauntlet-origin-"))
  r.git("init", "-q", "--bare", origin)
  r.git("remote", "add", "origin", origin)
  r.git("push", "-q", "-u", "origin", "main")
  r.git("remote", "set-head", "origin", "main")
  cleanups.push(() => r.cleanup(), () => rmSync(origin, { recursive: true, force: true }))
  return r
}
const baselineFile = (r: TempRepo) => existsSync(join(r.dir, ".gauntlet", "baseline.sarif"))

describe("which commits a baseline may record", () => {
  test("main, ahead of origin with commits not pushed yet, is still trunk", async () => {
    const r = withOrigin()
    r.write({ "src/main/Extra.kt": "class Extra\n" })
    r.commit("not pushed yet")
    const res = await cli(["baseline", "--repo", r.dir])
    expect(res.err).not.toContain("A baseline records trunk")
    expect(res.code).toBe(0)
    expect(baselineFile(r)).toBe(true)
  })

  test("a feature branch never is", async () => {
    const r = withOrigin()
    r.git("checkout", "-q", "-b", "topic")
    r.write({ "src/main/Extra.kt": "class Extra\n" })
    r.commit("topic work")
    const res = await cli(["baseline", "--repo", r.dir])
    expect(res.code).not.toBe(0)
    expect(res.err).toContain("check out origin/HEAD first")
    expect(baselineFile(r)).toBe(false)
  })
})

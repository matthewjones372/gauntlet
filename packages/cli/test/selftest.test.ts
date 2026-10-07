import { afterEach, describe, expect, test } from "bun:test"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli, POLICY } from "./harness.ts"

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

/** Trunk with a baseline and the given project fixtures, ready for selftest. */
const trunk = async (fixtures: Record<string, string> = {}, policy = POLICY) => {
  const s = baseRepo()
  repos.push(s.r)
  s.r.git("checkout", "-q", "main")
  s.r.write({ ".gauntlet/policy.gx": policy, ...fixtures })
  s.r.commit("policy and fixtures")
  const b = await cli(["baseline", "--repo", s.r.dir, "--trunk", "main"])
  if (b.code !== 0) throw new Error(b.err)
  s.r.commit("baseline")
  return s.r
}

const BREAK_ADD = `Description: makes the add test fail
Expect: blocked

diff --git a/src/main/behaviour.txt b/src/main/behaviour.txt
--- a/src/main/behaviour.txt
+++ b/src/main/behaviour.txt
@@ -1 +1 @@
-all good
+broken add
`

const HARMLESS = `Description: a change no gate cares about
Expect: blocked

diff --git a/src/main/App.kt b/src/main/App.kt
--- a/src/main/App.kt
+++ b/src/main/App.kt
@@ -1 +1 @@
-class App
+class App // renamed nothing
`

describe("gauntlet selftest", () => {
  test("generic fixtures and a project patch are all caught", async () => {
    const r = await trunk({ ".gauntlet/selftest/break-add.patch": BREAK_ADD })
    const res = await cli(["selftest", "--repo", r.dir, "--json"])
    const result = JSON.parse(res.out)
    expect(result.control.wouldBlock).toBe(false)
    expect(result.fixtures.map((f: { fixture: string; caught: boolean }) => `${f.fixture}:${f.caught}`)).toEqual([
      "lowered-threshold:true", "edited-baseline:true", "fake-result-file:true", "break-add:true",
    ])
    expect(result.notApplicable).toContain("deleted-test")
    expect(result.passed).toBe(true)
    expect(res.code).toBe(0)
  }, 120000)

  test("a fixture that gets through fails the selftest and names the gap", async () => {
    const r = await trunk({ ".gauntlet/selftest/harmless.patch": HARMLESS })
    const res = await cli(["selftest", "--repo", r.dir, "--only", "harmless"])
    expect(res.code).toBe(1)
    expect(res.out).toContain("| harmless | **no** |")
    expect(res.out).toContain("Some tampering got through")
  }, 120000)

  test("a policy that blocks an empty change can't pass", async () => {
    const r = await trunk({}, POLICY.replace("coverage >= 80%", "coverage >= 99%"))
    const res = await cli(["selftest", "--repo", r.dir, "--only", "lowered-threshold"])
    expect(res.code).toBe(1)
    expect(res.out).toContain("The policy blocks an empty change")
  }, 120000)
})

import { afterEach, describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli, POLICY } from "./harness.ts"

// Tampering with the agent hooks' attempt record is a tamper category of its
// own (ADR 0026): selftest runs it under the policy's limits, and the
// stop-hook corpus holds the same cases as data.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const ROOT = join(import.meta.dir, "..", "..", "..")

const trunk = async (policy = POLICY) => {
  const s = baseRepo()
  repos.push(s.r)
  s.r.git("checkout", "-q", "main")
  s.r.write({ ".gauntlet/policy.gx": policy })
  s.r.commit("policy")
  const b = await cli(["baseline", "--repo", s.r.dir, "--trunk", "main"])
  if (b.code !== 0) throw new Error(b.err)
  s.r.commit("baseline")
  return s.r
}

describe("selftest: the attempt record", () => {
  test("every tampering makes the next blocked stop exhausted, and the control still blocks", async () => {
    const r = await trunk()
    const res = await cli(["selftest", "--repo", r.dir, "--only", "hook-state", "--json"])
    const result = JSON.parse(res.out)
    expect(result.hookState.map((h: { tamper: string; status: string; caught: boolean }) => `${h.tamper}:${h.status}:${h.caught}`)).toEqual([
      "none:blocked:true", "delete-record:exhausted:true", "corrupt-record:exhausted:true", "delete-witness:exhausted:true", "forge-count:exhausted:true",
    ])
    expect(result.passed).toBe(true)
    expect(res.code).toBe(0)
    const text = await cli(["selftest", "--repo", r.dir, "--only", "hook-state"])
    expect(text.out).toContain("| delete-record | yes | exhausted | the attempt record is deleted |")
  }, 120_000)

  test("holds under the policy's own limits, down to one attempt", async () => {
    const r = await trunk(POLICY.replace("predicate small", "attempts { unchanged 1, total 1 }\npredicate small"))
    const result = JSON.parse((await cli(["selftest", "--repo", r.dir, "--only", "hook-state", "--json"])).out)
    expect(result.hookState.every((h: { caught: boolean }) => h.caught)).toBe(true)
  }, 120_000)

  test("other --only selections leave it out", async () => {
    const r = await trunk()
    const result = JSON.parse((await cli(["selftest", "--repo", r.dir, "--only", "lowered-threshold", "--json"])).out)
    expect(result.hookState).toBeUndefined()
  }, 120_000)
})

describe("the stop-hook corpus", () => {
  test("has the control and every tampering, each with a note, and every case meets its expectation", async () => {
    const dir = join(ROOT, "corpus", "stop-hook")
    const cases = readdirSync(dir).sort()
    expect(cases).toEqual(["control", "corrupt-record", "delete-record", "delete-witness", "forge-count"])
    for (const c of cases) expect(readdirSync(join(dir, c)).sort()).toEqual(["NOTE.md", "case.json"])
    const res = await cli(["corpus", "--repo", ROOT, "--stop-hook", "--json"])
    const r = JSON.parse(res.out)
    expect(r.cases.map((c: { name: string; status: string; met: boolean }) => `${c.name}:${c.status}:${c.met}`)).toEqual([
      "control:blocked:true", "corrupt-record:exhausted:true", "delete-record:exhausted:true", "delete-witness:exhausted:true", "forge-count:exhausted:true",
    ])
    expect(res.code).toBe(0)
  }, 120_000)
})

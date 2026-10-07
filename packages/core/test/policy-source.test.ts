import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Exit, Option } from "effect"
import { PolicySource } from "../src/index.ts"
import { CoreTest } from "./layers.ts"
import { TempRepo } from "./temp-repo.ts"

const policy = (coverage: number, mode = "enforce") => `gauntlet "svc"
use jvm
mode ${mode}
owners @platform
suites { unit "src/test/**" }
gates { verify { unit, coverage >= ${coverage}% on changed } }
`

const repos: TempRepo[] = []
const repo = () => {
  const r = new TempRepo()
  repos.push(r)
  return r
}
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const load = (request: Parameters<PolicySource["Service"]["load"]>[0]) =>
  Effect.runPromiseExit(PolicySource.use((s) => s.load(request)).pipe(Effect.provide(CoreTest)))

const ok = async (request: Parameters<PolicySource["Service"]["load"]>[0]) => {
  const exit = await load(request)
  if (Exit.isFailure(exit)) throw new Error(`load failed: ${String(exit.cause)}`)
  return exit.value
}

const failureTag = (exit: Exit.Exit<unknown, unknown>) => {
  if (!Exit.isFailure(exit)) return undefined
  const fail = exit.cause.reasons.find((r) => r._tag === "Fail")
  return fail && "error" in fail ? (fail.error as { _tag: string })._tag : undefined
}

const coverageOf = (loaded: Awaited<ReturnType<typeof ok>>) => {
  const check = loaded.compiled.ir.gates[0]?.checks.find((c) => c.kind === "gate" && c.name === "coverage")
  return check && check.kind === "gate" ? check.threshold?.value.value : undefined
}

describe("PolicySource in CI (--policy-ref)", () => {
  test("a PR that loosens the policy is judged by the base policy", async () => {
    const r = repo()
    r.write({ ".gauntlet/policy.gx": policy(90), "src/A.kt": "class A" })
    const base = r.commit("base")
    r.write({ ".gauntlet/policy.gx": policy(50) })
    r.commit("loosen")
    const loaded = await ok({ repo: r.dir, policyRef: base })
    expect(loaded.origin).toBe("base")
    expect(coverageOf(loaded)).toBe(90)
    expect(loaded.drift).toEqual([{ path: ".gauntlet/policy.gx", change: "modified" }])
    expect(loaded.notes.join(" ")).toContain("nominates owner")
    expect(loaded.baseSha).toEqual(Option.some(base))
  })

  test("a baseline edit shows up as drift and doesn't change the policy used", async () => {
    const r = repo()
    r.write({ ".gauntlet/policy.gx": policy(90), ".gauntlet/baseline.sarif": "{}" })
    const base = r.commit("base")
    r.write({ ".gauntlet/baseline.sarif": `{"lowered":true}` })
    r.commit("lower baseline")
    const loaded = await ok({ repo: r.dir, policyRef: base })
    expect(loaded.origin).toBe("base")
    expect(loaded.drift).toEqual([{ path: ".gauntlet/baseline.sarif", change: "modified" }])
  })

  test("deleting the policy in the PR doesn't remove it", async () => {
    const r = repo()
    r.write({ ".gauntlet/policy.gx": policy(90) })
    const base = r.commit("base")
    r.remove(".gauntlet/policy.gx")
    r.commit("delete policy")
    const loaded = await ok({ repo: r.dir, policyRef: base })
    expect(loaded.origin).toBe("base")
    expect(coverageOf(loaded)).toBe(90)
    expect(loaded.drift).toEqual([{ path: ".gauntlet/policy.gx", change: "deleted" }])
  })

  test("first adoption uses the PR's policy, forced to shadow", async () => {
    const r = repo()
    r.write({ "src/A.kt": "class A" })
    const base = r.commit("before gauntlet")
    r.write({ ".gauntlet/policy.gx": policy(90, "enforce") })
    r.commit("adopt")
    const loaded = await ok({ repo: r.dir, policyRef: base })
    expect(loaded.firstAdoption).toBe(true)
    expect(loaded.origin).toBe("working-copy")
    expect(loaded.compiled.ir.mode).toBe("enforce")
    expect(loaded.effectiveMode).toBe("shadow")
  })

  test("an invalid base policy is an error even if the PR fixes it", async () => {
    const r = repo()
    r.write({ ".gauntlet/policy.gx": `gauntlet "svc"\nmode lax\n` })
    const base = r.commit("broken base")
    r.write({ ".gauntlet/policy.gx": policy(90) })
    r.commit("fix")
    expect(failureTag(await load({ repo: r.dir, policyRef: base }))).toBe("PolicyInvalid")
  })

  test("an unknown policy ref is an error, not a fallback to the head", async () => {
    const r = repo()
    r.write({ ".gauntlet/policy.gx": policy(90) })
    r.commit("base")
    expect(failureTag(await load({ repo: r.dir, policyRef: "no-such-ref" }))).toBe("BaseRefNotFound")
  })
})

describe("PolicySource locally", () => {
  test("uses the working copy and explains how it differs from the base", async () => {
    const r = repo()
    r.write({ ".gauntlet/policy.gx": policy(90) })
    r.commit("base")
    r.git("checkout", "-q", "-b", "feature")
    r.write({ ".gauntlet/policy.gx": policy(70) })
    const loaded = await ok({ repo: r.dir })
    expect(loaded.origin).toBe("working-copy")
    expect(coverageOf(loaded)).toBe(70)
    expect(loaded.drift).toEqual([{ path: ".gauntlet/policy.gx", change: "modified" }])
    expect(loaded.notes.join(" ")).toContain("--policy-ref")
  })

  test("says when no base branch could be found", async () => {
    const r = repo()
    r.write({ ".gauntlet/policy.gx": policy(90) })
    r.commit("only commit")
    r.git("branch", "-m", "trunk")
    const loaded = await ok({ repo: r.dir })
    expect(loaded.baseSha).toEqual(Option.none())
    expect(loaded.notes.join(" ")).toContain("No base branch")
  })

  test("no policy anywhere is PolicyNotFound", async () => {
    const r = repo()
    r.write({ "README.md": "hi" })
    r.commit("init")
    expect(failureTag(await load({ repo: r.dir }))).toBe("PolicyNotFound")
  })
})

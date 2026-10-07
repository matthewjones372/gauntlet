import { afterEach, describe, expect, test } from "bun:test"
import { Acceptor, type Decision } from "@gauntlet/author"
import { cpSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { scripted, type Step } from "../../author/test/fake.ts"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { AuthorRuntime } from "../src/author.ts"
import { appLayer, ExitStatus, Output, runCli } from "../src/index.ts"
import { INSTALLED_PACKS } from "../src/packs.ts"

const FIXTURES = join(import.meta.dir, "..", "..", "..", "examples", "fixtures")
const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const KEY = { GAUNTLET_AUTHOR_API_KEY: "test-key" }

/** Runs the CLI with a scripted model and a scripted person accepting proposals. */
const author = async (args: string[], o: { steps?: ReadonlyArray<Step>; decisions?: ReadonlyArray<Decision>; confirm?: boolean; env?: Record<string, string>; interactive?: boolean } = {}) => {
  const out: string[] = []
  const err: string[] = []
  const model = scripted(o.steps ?? [])
  let i = 0
  const acceptor = Layer.succeed(Acceptor, {
    decide: () => Effect.succeed(o.decisions?.[i++] ?? { _tag: "Reject" }),
    confirmLoosening: () => Effect.succeed(o.confirm ?? false),
    note: (m) => Effect.sync(() => void out.push(m)),
  })
  const runtime = Layer.succeed(AuthorRuntime, { env: o.env ?? KEY, interactive: o.interactive ?? true, model: () => model.layer, acceptor })
  const capture = Layer.succeed(Output, { out: (t) => Effect.sync(() => void out.push(t)), err: (t) => Effect.sync(() => void err.push(t)) })
  const code = await Effect.runPromise(runCli(args).pipe(Effect.provide(Layer.mergeAll(appLayer([...INSTALLED_PACKS]), capture, ExitStatus.layer, runtime))))
  return { code, out: out.join("\n"), err: err.join("\n"), modelCalls: model.calls() }
}

/** The Kotlin fixture before Gauntlet, with the lenient template policy committed (so the agent has zones to propose). */
const project = async () => {
  const r = new TempRepo()
  repos.push(r)
  cpSync(join(FIXTURES, "kotlin-service"), r.dir, { recursive: true, filter: (src) => !/\/(build|\.gradle|\.kotlin|\.gauntlet)(\/|$)/.test(src) })
  r.commit("project")
  await author(["init", "--repo", r.dir, "--template", "--lenient", "--name", "svc", "--owner", "@platform"])
  r.commit("policy")
  return r
}
const policy = (r: TempRepo) => readFileSync(join(r.dir, ".gauntlet", "policy.gx"), "utf8")

const MONEY = {
  kind: "zone", name: "money", action: "set",
  text: `zone money {\n  paths "src/main/kotlin/svc/settlement/**"\n  owner @payments\n  rule kotlin.no-floating-money\n}`,
  rationale: "Settlement converts money between currencies.",
  citation: { kind: "sensitive-code", path: "src/main/kotlin/svc/settlement/Fx.kt", line: 7, excerpt: "fun convert(amount: Money): Money" },
}
const INVENTED = { ...MONEY, name: "ledger", text: MONEY.text.replace("money", "ledger"), citation: { ...MONEY.citation, excerpt: "fun transfer(" } }
const steps = (proposals: unknown[]): Step[] => [
  { tools: [{ name: "search", params: { pattern: "Money" } }] },
  { text: "Found the settlement code." },
  { object: { proposals } },
]

describe("gauntlet author review", () => {
  test("writes only what the person accepted, and says what it dropped", async () => {
    const r = await project()
    const res = await author(["author", "review", "--repo", r.dir], { steps: steps([MONEY, INVENTED]), decisions: [{ _tag: "Accept" }] })
    expect(res.code).toBe(0)
    expect(res.err).toContain("Dropped 1 proposal before review:\n  - set zone ledger: citation rejected: line 7 of src/main/kotlin/svc/settlement/Fx.kt doesn't contain the quoted text")
    expect(res.out).toContain("1 accepted, 0 rejected.")
    expect(res.out).toContain("get a policy owner's review")
    expect(policy(r)).toContain("zone money {\n  paths \"src/main/kotlin/svc/settlement/**\"")
    expect((await author(["validate", "--repo", r.dir])).code).toBe(0)
  })

  test("nothing is written without acceptance", async () => {
    const r = await project()
    const before = policy(r)
    const res = await author(["author", "review", "--repo", r.dir], { steps: steps([MONEY]), decisions: [{ _tag: "Reject" }] })
    expect(res.out).toContain("0 accepted, 1 rejected.")
    expect(policy(r)).toBe(before)
  })

  test("a loosening isn't written without the typed confirmation", async () => {
    const r = await project()
    const before = policy(r)
    const loosen = {
      kind: "review", action: "set", text: "review {\n  auto when all gates pass\n}", rationale: "Fewer reviews.",
      citation: { kind: "configured-tool", path: "build.gradle.kts", excerpt: "info.solidsoft.pitest" },
    }
    // A configured tool only backs gates changes, so this one is dropped before anyone sees it.
    const dropped = await author(["author", "review", "--repo", r.dir], { steps: steps([loosen]), decisions: [{ _tag: "Accept" }], confirm: true })
    expect(dropped.err).toContain("citation rejected")
    expect(policy(r)).toBe(before)
    // Covers an uncovered file (a sound citation) but stops protecting gradle/: a loosening.
    const swap = {
      kind: "protect", action: "set", text: `protect {\n  tests "src/test/**"\n  config "*.gradle.kts", "src/main/kotlin/svc/infra/**"\n}`, rationale: "Guard the infrastructure code.",
      citation: { kind: "uncovered-path", path: "src/main/kotlin/svc/infra/Ledger.kt" },
    }
    const declined = await author(["author", "review", "--repo", r.dir], { steps: steps([swap]), decisions: [{ _tag: "Accept" }], confirm: false })
    expect(declined.out).toContain("Not applied: loosening protect needs the typed confirmation.")
    expect(policy(r)).toBe(before)
    const confirmed = await author(["author", "review", "--repo", r.dir], { steps: steps([swap]), decisions: [{ _tag: "Accept" }], confirm: true })
    expect(confirmed.out).toContain("1 accepted, 0 rejected.")
    expect(policy(r)).toContain(`"src/main/kotlin/svc/infra/**"`)
  })

  test("refuses inside a coding agent, without a terminal or without its own key, before calling any model", async () => {
    const r = await project()
    const inAgent = await author(["author", "review", "--repo", r.dir], { env: { ...KEY, CLAUDECODE: "1" }, steps: steps([MONEY]) })
    expect(inAgent.code).toBe(2)
    expect(inAgent.err).toContain("CLAUDECODE is set")
    expect(inAgent.modelCalls).toBe(0)
    expect((await author(["author", "review", "--repo", r.dir], { interactive: false })).err).toContain("interactive terminal")
    expect((await author(["author", "review", "--repo", r.dir], { env: { ANTHROPIC_API_KEY: "sk-ant" } })).err).toContain("GAUNTLET_AUTHOR_API_KEY isn't set")
  })
})

describe("gauntlet init with the authoring agent", () => {
  const fresh = () => {
    const r = new TempRepo()
    repos.push(r)
    cpSync(join(FIXTURES, "kotlin-service"), r.dir, { recursive: true, filter: (src) => !/\/(build|\.gradle|\.kotlin|\.gauntlet)(\/|$)/.test(src) })
    r.commit("project")
    return r
  }

  test("uses the agent when it's available, starting from the template", async () => {
    const r = fresh()
    const res = await author(["init", "--repo", r.dir, "--name", "svc"], { steps: steps([MONEY]), decisions: [{ _tag: "Accept" }] })
    expect(res.code).toBe(0)
    expect(policy(r)).toContain("\nzone money {")
    expect(policy(r)).toContain("mode shadow")
  })

  test("falls back to the template and says why", async () => {
    const r = fresh()
    const res = await author(["init", "--repo", r.dir, "--lenient", "--name", "svc"], { env: {} })
    expect(res.err).toContain("Drafting from the packs' defaults (--template): GAUNTLET_AUTHOR_API_KEY isn't set")
    expect(policy(r)).not.toContain("\nzone money {")
  })
})

describe("gauntlet author explain", () => {
  test("explains a block in plain language", async () => {
    const r = await project()
    const res = await author(["author", "explain", "gates", "--repo", r.dir], { steps: [{ text: "Every change must build and pass the unit tests." }] })
    expect(res.out).toBe("Every change must build and pass the unit tests.")
  })
})

import { describe, expect, test } from "bun:test"
import { compilePolicy } from "@gauntlet/dsl"
import { jvmSpec } from "@gauntlet/pack-jvm"
import { Effect, Layer } from "effect"
import { Acceptor, type Decision, draftProposals, runSession, type Valid } from "../src/index.ts"
import { BASE, context, MONEY_ZONE, PROTECT_TESTS, scripted } from "./fake.ts"

const baseIr = (() => {
  const r = compilePolicy({ file: ".gauntlet/policy.gx", text: BASE }, [jvmSpec])
  if (r._tag === "Invalid") throw new Error("bad base")
  return r.compiled.ir
})()

const LOOSEN = {
  kind: "review", action: "set", text: "review {\n  auto when all gates pass\n}",
  rationale: "Simplify.", citation: { kind: "shadow-escape", reason: "unit failed: 1 of 9 tests failed" },
} as const

const proposalsFor = async (list: ReadonlyArray<unknown>): Promise<ReadonlyArray<Valid>> => {
  const model = scripted([{ text: "." }, { object: { proposals: list } }])
  const r = await Effect.runPromise(draftProposals({ mode: "review", text: BASE, ctx: context() }).pipe(Effect.provide(model.layer)))
  return r.proposals
}

const session = (proposals: ReadonlyArray<Valid>, decisions: ReadonlyArray<Decision>, confirm = false) => {
  const notes: string[] = []
  const asked: string[] = []
  let i = 0
  const acceptor = Layer.succeed(Acceptor, {
    decide: (p) => Effect.sync(() => {
      asked.push(`${p.index}/${p.total} ${p.proposal.kind} before=${p.before === undefined ? "none" : "some"}`)
      return decisions[i++] ?? { _tag: "Reject" }
    }),
    confirmLoosening: (_p, l) => Effect.sync(() => {
      notes.push(`asked to confirm: ${l.map((x) => x.what).join("; ")}`)
      return confirm
    }),
    note: (m) => Effect.sync(() => void notes.push(m)),
  })
  return Effect.runPromise(runSession(BASE, baseIr, proposals, context()).pipe(Effect.provide(acceptor))).then((r) => ({ ...r, notes, asked }))
}

describe("accepting proposals", () => {
  test("nothing changes unless a person accepts", async () => {
    const r = await session(await proposalsFor([MONEY_ZONE, PROTECT_TESTS]), [{ _tag: "Reject" }, { _tag: "Reject" }])
    expect(r.text).toBe(BASE)
    expect(r.accepted).toEqual([])
    expect(r.asked).toEqual(["1/2 zone before=none", "2/2 protect before=none"])
  })

  test("accepted blocks are applied in order; quitting rejects the rest", async () => {
    const r = await session(await proposalsFor([MONEY_ZONE, PROTECT_TESTS]), [{ _tag: "Accept" }, { _tag: "Quit" }])
    expect(r.text).toContain("zone money {")
    expect(r.text).not.toContain("protect {")
    expect(r.rejected.map((p) => p.kind)).toEqual(["protect"])
  })

  test("a person's edit replaces the proposed block, and must still compile", async () => {
    const edited = await session(await proposalsFor([PROTECT_TESTS]), [{ _tag: "Edit", text: `protect {\n  tests "src/test/**", "src/it/**"\n}` }])
    expect(edited.text).toContain(`tests "src/test/**", "src/it/**"`)
    const broken = await session(await proposalsFor([PROTECT_TESTS]), [{ _tag: "Edit", text: "protect { tests " }])
    expect(broken.text).toBe(BASE)
    expect(broken.notes[0]).toStartWith("Skipped protect:")
  })

  test("a loosening is applied only after the typed confirmation", async () => {
    const declined = await session(await proposalsFor([LOOSEN]), [{ _tag: "Accept" }], false)
    expect(declined.text).toBe(BASE)
    expect(declined.notes).toEqual([
      "asked to confirm: review rule removed: review when protected-changed",
      "Not applied: loosening review needs the typed confirmation.",
    ])
    const confirmed = await session(await proposalsFor([LOOSEN]), [{ _tag: "Accept" }], true)
    expect(confirmed.text).not.toContain("review when protected changed")
  })

  test("an edit that loosens needs the confirmation too, even when the proposal didn't", async () => {
    const gates = {
      kind: "gates", action: "set", text: "gates {\n  fast   { build }\n  verify { unit, mutation ratchet on changed }\n}",
      rationale: "Pitest is applied.", citation: { kind: "configured-tool", path: "build.gradle.kts", excerpt: `id("info.solidsoft.pitest")` },
    }
    const proposals = await proposalsFor([gates])
    expect(proposals[0]!.loosenings).toEqual([])
    const r = await session(proposals, [{ _tag: "Edit", text: "gates {\n  fast   { build }\n  verify { mutation ratchet on changed }\n}" }])
    expect(r.notes).toEqual(["asked to confirm: suite unit is no longer a required gate", "Not applied: loosening gates needs the typed confirmation."])
    expect(r.text).toBe(BASE)
  })
})

import { DEFAULT_POLICY_FILE, editBlock, policyBlocks, sameBlock } from "@gauntlet/dsl"
import type { PolicyIR } from "@gauntlet/ir"
import { Context, Effect } from "effect"
import type { Valid } from "./agent.ts"
import type { AuthorContext } from "./context.ts"
import { type Loosening, looseningsBetween } from "./loosening.ts"
import type { Proposal } from "./proposals.ts"
import { compileText } from "./validate.ts"

// A person decides on each proposal; nothing is written without that. A
// loosening needs a second, typed confirmation (ADR 0009). Decisions apply in
// order, each to the policy as it stands after the earlier ones.

export type Decision =
  | { readonly _tag: "Accept" }
  | { readonly _tag: "Reject" }
  | { readonly _tag: "Edit"; readonly text: string }
  | { readonly _tag: "Quit" }

export interface Presented {
  readonly proposal: Proposal
  /** The block as it is now, or undefined when the proposal adds it. */
  readonly before: string | undefined
  readonly index: number
  readonly total: number
}

export class Acceptor extends Context.Service<Acceptor, {
  readonly decide: (p: Presented) => Effect.Effect<Decision>
  /** Asked only for loosenings; true only when the person typed the confirmation. */
  readonly confirmLoosening: (p: Presented, loosenings: ReadonlyArray<Loosening>) => Effect.Effect<boolean>
  readonly note: (message: string) => Effect.Effect<void>
}>()("@gauntlet/author/Acceptor") {}

export interface SessionResult {
  readonly text: string
  readonly accepted: ReadonlyArray<Proposal>
  readonly rejected: ReadonlyArray<Proposal>
}

const currentBlock = (text: string, p: Proposal): string | undefined => {
  const found = policyBlocks(DEFAULT_POLICY_FILE, text)
  const block = found._tag === "Blocks" ? found.blocks.find((b) => sameBlock(b, { kind: p.kind, ...(p.name ? { name: p.name } : {}) })) : undefined
  return block ? text.slice(block.start, block.end) : undefined
}

export const runSession = (baseText: string, baseIr: PolicyIR, proposals: ReadonlyArray<Valid>, ctx: AuthorContext) =>
  Effect.gen(function*() {
    const acceptor = yield* Acceptor
    let text = baseText
    let ir = baseIr
    const accepted: Proposal[] = []
    const rejected: Proposal[] = []
    for (const [index, v] of proposals.entries()) {
      const presented: Presented = { proposal: v.proposal, before: currentBlock(text, v.proposal), index: index + 1, total: proposals.length }
      const decision = yield* acceptor.decide(presented)
      if (decision._tag === "Quit") {
        rejected.push(...proposals.slice(index).map((p) => p.proposal))
        break
      }
      if (decision._tag === "Reject") {
        rejected.push(v.proposal)
        continue
      }
      const id = { kind: v.proposal.kind, ...(v.proposal.name ? { name: v.proposal.name } : {}) }
      const edit = v.proposal.action === "remove" && decision._tag === "Accept"
        ? { op: "remove" as const, id }
        : { op: "set" as const, id, text: decision._tag === "Edit" ? decision.text : v.proposal.text ?? "" }
      const edited = editBlock(DEFAULT_POLICY_FILE, text, edit)
      const compiled = edited._tag === "Edited" ? compileText(edited.text, ctx) : undefined
      if (edited._tag === "Failed" || compiled?._tag !== "Compiled") {
        yield* acceptor.note(`Skipped ${v.proposal.kind}: ${edited._tag === "Failed" ? edited.reason : "the policy doesn't compile with it"}.`)
        rejected.push(v.proposal)
        continue
      }
      // Loosening is judged against the policy as it stands now, edits included.
      const loosenings = looseningsBetween(ir, compiled.compiled.ir)
      if (loosenings.length > 0 && !(yield* acceptor.confirmLoosening(presented, loosenings))) {
        yield* acceptor.note(`Not applied: loosening ${v.proposal.kind} needs the typed confirmation.`)
        rejected.push(v.proposal)
        continue
      }
      text = edited.text
      ir = compiled.compiled.ir
      accepted.push(v.proposal)
    }
    return { text, accepted, rejected } satisfies SessionResult
  })

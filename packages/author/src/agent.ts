import { compilePolicy, DEFAULT_POLICY_FILE, describeBlock, PolicyInvalid } from "@gauntlet/dsl"
import type { PolicyIR } from "@gauntlet/ir"
import { Effect } from "effect"
import { Chat } from "effect/ai"
import type { AuthorContext } from "./context.ts"
import { proposePrompt, repairPrompt, systemPrompt, taskPrompt } from "./prompt.ts"
import { type Proposal, Proposals } from "./proposals.ts"
import { authorHandlers, AuthorToolkit } from "./tools.ts"
import { type Checked, checkProposal } from "./validate.ts"

// The authoring loop: explore with read-only tools, propose, and repair
// proposals that don't compile until they do or the attempts run out.
// Proposals with a citation Gauntlet can't verify are dropped and logged,
// never shown as if they were sound.

export interface DraftRequest {
  readonly mode: "init" | "review"
  /** The policy to improve: the template draft for init, the current policy for review. */
  readonly text: string
  readonly ctx: AuthorContext
  readonly maxToolTurns?: number
  readonly maxRepairs?: number
}

export type Valid = Extract<Checked, { _tag: "Valid" }>

export interface Dropped {
  readonly proposal: Proposal
  readonly reason: string
}

export interface DraftResult {
  readonly proposals: ReadonlyArray<Valid>
  readonly dropped: ReadonlyArray<Dropped>
  /** Rounds of proposals the model returned (1 when the first round was usable). */
  readonly rounds: number
}

export const label = (p: Proposal) => `${p.action} ${describeBlock({ kind: p.kind, ...(p.name ? { name: p.name } : {}) })}`

const problem = (c: Extract<Checked, { _tag: "Invalid" }>) =>
  [`${label(c.proposal)}: ${c.reason}`, ...c.diagnostics.map((d) => `  ${d.message}${d.fix ? ` Fix: ${d.fix}` : ""}`)].join("\n")

export const draftProposals = (request: DraftRequest) =>
  Effect.gen(function*() {
    const { ctx } = request
    const base = compilePolicy({ file: DEFAULT_POLICY_FILE, text: request.text, files: ctx.files }, ctx.packs)
    if (base._tag === "Invalid") return yield* Effect.fail(new PolicyInvalid({ file: DEFAULT_POLICY_FILE, diagnostics: base.diagnostics, text: request.text }))
    const baseIr = base.compiled.ir
    return yield* explore(request, baseIr).pipe(Effect.provide(authorHandlers(ctx, () => baseIr)))
  })

const explore = (request: DraftRequest, baseIr: PolicyIR) =>
  Effect.gen(function*() {
    const { ctx } = request
    const chat = yield* Chat.fromPrompt([{ role: "system", content: systemPrompt(ctx) }])
    let response = yield* chat.generateText({ prompt: taskPrompt(request.mode, request.text), toolkit: AuthorToolkit })
    for (let turn = 1; response.finishReason === "tool-calls" && turn < (request.maxToolTurns ?? 25); turn++) {
      response = yield* chat.generateText({ prompt: [], toolkit: AuthorToolkit })
    }

    const dropped: Dropped[] = []
    let prompt = proposePrompt
    const maxRounds = 1 + (request.maxRepairs ?? 3)
    for (let round = 1; ; round++) {
      const answer = yield* chat.generateObject({ prompt, schema: Proposals, objectName: "proposals" })
      const checked = yield* Effect.forEach(answer.value.proposals, (p) => checkProposal(p, request.text, baseIr, ctx))
      const invalid = checked.filter((c) => c._tag === "Invalid")
      if (invalid.length > 0 && round < maxRounds) {
        prompt = repairPrompt(invalid.map(problem))
        continue
      }
      // Duplicate proposals for one block keep the first.
      const valid: Valid[] = []
      for (const c of checked) {
        if (c._tag === "Uncited") dropped.push({ proposal: c.proposal, reason: `citation rejected: ${c.reason}` })
        else if (c._tag === "Unchanged") dropped.push({ proposal: c.proposal, reason: "it changes nothing" })
        else if (c._tag === "Invalid") dropped.push({ proposal: c.proposal, reason: `still unusable after ${round} rounds: ${c.reason}` })
        else if (valid.some((v) => v.proposal.kind === c.proposal.kind && v.proposal.name === c.proposal.name)) dropped.push({ proposal: c.proposal, reason: "another proposal already changes this block" })
        else valid.push(c)
      }
      return { proposals: valid, dropped, rounds: round } satisfies DraftResult
    }
  })

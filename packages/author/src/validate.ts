import { coverage, protectionFor } from "@gauntlet/core"
import { compilePolicy, DEFAULT_POLICY_FILE, type Diagnostic, editBlock, NAMED_KINDS, policyBlocks, sameBlock } from "@gauntlet/dsl"
import { canonicalJson, type PolicyIR } from "@gauntlet/ir"
import { Effect, Option } from "effect"
import type { AuthorContext } from "./context.ts"
import { type Loosening, looseningsBetween } from "./loosening.ts"
import type { Citation, Proposal } from "./proposals.ts"

// Every proposal is checked before a person sees it: it must be one
// well-formed block, the policy must still compile with it, and its citation
// must point at a fact Gauntlet can verify and that the proposal addresses.

export type Checked =
  | { readonly _tag: "Valid"; readonly proposal: Proposal; readonly text: string; readonly ir: PolicyIR; readonly loosenings: ReadonlyArray<Loosening> }
  | { readonly _tag: "Uncited"; readonly proposal: Proposal; readonly reason: string }
  | { readonly _tag: "Unchanged"; readonly proposal: Proposal }
  | { readonly _tag: "Invalid"; readonly proposal: Proposal; readonly reason: string; readonly diagnostics: ReadonlyArray<Diagnostic> }

const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs|src\/test|src\/[a-zA-Z]*Test)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(py|go)$|(^|\/)test_[^/]*\.py$|Tests?\.(kt|java|scala)$/

export const compileText = (text: string, ctx: AuthorContext) => compilePolicy({ file: DEFAULT_POLICY_FILE, text, files: ctx.files }, ctx.packs)

/** The proposal as a block edit, or why it isn't one. */
const asEdit = (p: Proposal) => {
  if (NAMED_KINDS.has(p.kind) && !p.name) return { _tag: "Bad" as const, reason: `a ${p.kind} proposal needs the block's name` }
  const id = { kind: p.kind, ...(p.name ? { name: p.name } : {}) }
  if (p.action === "remove") return { _tag: "Edit" as const, edit: { op: "remove" as const, id } }
  if (!p.text) return { _tag: "Bad" as const, reason: "a set proposal needs the block's text" }
  const parsed = policyBlocks("proposal.gx", `gauntlet "proposal"\n${p.text}\n`)
  if (parsed._tag === "SyntaxErrors") return { _tag: "Bad" as const, reason: `the block doesn't parse: ${parsed.diagnostics[0]?.message ?? ""}` }
  if (parsed.blocks.length !== 1 || !sameBlock(parsed.blocks[0]!, id)) return { _tag: "Bad" as const, reason: `the text must be exactly one ${p.kind}${p.name ? ` ${p.name}` : ""} block` }
  return { _tag: "Edit" as const, edit: { op: "set" as const, id, text: p.text } }
}

const lineOf = (text: string, line: number) => text.split(/\r?\n/)[line - 1]

const contains = (haystack: string | undefined, excerpt: string) => {
  const e = excerpt.trim()
  return haystack !== undefined && e.length >= 3 && haystack.includes(e)
}

/** Why the citation doesn't hold or isn't addressed, or undefined when it's sound. */
const checkCitation = (c: Citation, ctx: AuthorContext, before: PolicyIR, after: PolicyIR, p: Proposal) =>
  Effect.gen(function*() {
    const known = (path: string) => ctx.files.includes(path)
    const covers = (ir: PolicyIR, path: string) => coverage(ir, [path]).files[0]!
    switch (c.kind) {
      case "sensitive-code": {
        if (!known(c.path)) return `${c.path} isn't in the repository`
        const text = Option.getOrUndefined(yield* ctx.read(c.path))
        if (!contains(text === undefined ? undefined : lineOf(text, c.line), c.excerpt)) return `line ${c.line} of ${c.path} doesn't contain the quoted text`
        const [b, a] = [covers(before, c.path), covers(after, c.path)]
        if (a.zones.every((z) => b.zones.includes(z)) && a.rules.every((r) => b.rules.includes(r))) return `the proposal doesn't put ${c.path} in a zone or under new rules`
        return undefined
      }
      case "unprotected-tests": {
        if (!known(c.path)) return `${c.path} isn't in the repository`
        if (!TEST_PATH.test(c.path)) return `${c.path} doesn't look like a test file`
        if (protectionFor(c.path, before.protect, ctx.runnerConfig)?.kind === "tests") return `${c.path} is already protected as a test`
        if (protectionFor(c.path, after.protect, ctx.runnerConfig)?.kind !== "tests") return `the proposal doesn't protect ${c.path} as a test`
        return undefined
      }
      case "uncovered-path": {
        if (!known(c.path)) return `${c.path} isn't in the repository`
        if (!coverage(before, [c.path]).uncovered.includes(c.path)) return `${c.path} is already covered`
        if (coverage(after, [c.path]).uncovered.includes(c.path)) return `the proposal leaves ${c.path} uncovered`
        return undefined
      }
      case "shadow-escape":
        return ctx.shadow.topReasons.some((r) => r.reason === c.reason) ? undefined : "the shadow history doesn't list that reason"
      case "selftest-gap": {
        if (!(yield* ctx.selftestPlan(before)).notApplicable.includes(c.fixture)) return `selftest already applies ${c.fixture}`
        if ((yield* ctx.selftestPlan(after)).notApplicable.includes(c.fixture)) return `the proposal doesn't let selftest apply ${c.fixture}`
        return undefined
      }
      case "configured-tool": {
        if (!known(c.path)) return `${c.path} isn't in the repository`
        if (!contains(Option.getOrUndefined(yield* ctx.read(c.path)), c.excerpt)) return `${c.path} doesn't contain the quoted text`
        if (p.kind !== "gates" || canonicalJson(before.gates) === canonicalJson(after.gates)) return "a configured tool backs a gates proposal that changes the gates"
        return undefined
      }
    }
  })

export const checkProposal = (p: Proposal, baseText: string, baseIr: PolicyIR, ctx: AuthorContext) =>
  Effect.gen(function*() {
    const edit = asEdit(p)
    if (edit._tag === "Bad") return { _tag: "Invalid", proposal: p, reason: edit.reason, diagnostics: [] } satisfies Checked
    const edited = editBlock(DEFAULT_POLICY_FILE, baseText, edit.edit)
    if (edited._tag === "Failed") return { _tag: "Invalid", proposal: p, reason: edited.reason, diagnostics: [] } satisfies Checked
    if (edited.text === baseText) return { _tag: "Unchanged", proposal: p } satisfies Checked
    const compiled = compileText(edited.text, ctx)
    if (compiled._tag === "Invalid") return { _tag: "Invalid", proposal: p, reason: "the policy doesn't compile with it", diagnostics: compiled.diagnostics } satisfies Checked
    const ir = compiled.compiled.ir
    const why = yield* checkCitation(p.citation, ctx, baseIr, ir, p)
    if (why !== undefined) return { _tag: "Uncited", proposal: p, reason: why } satisfies Checked
    return { _tag: "Valid", proposal: p, text: edited.text, ir, loosenings: looseningsBetween(baseIr, ir) } satisfies Checked
  })

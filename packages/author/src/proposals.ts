import { Schema } from "effect"

// What the authoring agent may propose. It edits whole policy blocks; it may
// not change `use`, `mode` or `owners` (which packs run, whether the policy
// blocks, and who approves are people's decisions), and every proposal must
// cite evidence Gauntlet can check itself (PLAN section 15).

export const ProposableKind = Schema.Literals([
  "protect", "zone", "arch", "suites", "integrity", "import", "gates", "on fail", "predicate", "review",
])
export type ProposableKind = typeof ProposableKind.Type

export const Citation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("sensitive-code"),
    path: Schema.String,
    line: Schema.Number,
    excerpt: Schema.String.annotate({ description: "text copied exactly from that line" }),
  }),
  Schema.Struct({ kind: Schema.Literal("unprotected-tests"), path: Schema.String.annotate({ description: "a test file nothing protects" }) }),
  Schema.Struct({ kind: Schema.Literal("uncovered-path"), path: Schema.String.annotate({ description: "a file no zone, protect group or suite covers" }) }),
  Schema.Struct({ kind: Schema.Literal("shadow-escape"), reason: Schema.String.annotate({ description: "a reason exactly as the shadow history lists it" }) }),
  Schema.Struct({ kind: Schema.Literal("selftest-gap"), fixture: Schema.String.annotate({ description: "a built-in fixture the selftest plan lists as not applicable" }) }),
  Schema.Struct({
    kind: Schema.Literal("configured-tool"),
    path: Schema.String,
    excerpt: Schema.String.annotate({ description: "text copied exactly from the build or manifest file that sets the tool up" }),
  }),
])
export type Citation = typeof Citation.Type

export const Proposal = Schema.Struct({
  kind: ProposableKind,
  name: Schema.optionalKey(Schema.String.annotate({ description: "for zone, import, on fail and predicate blocks: the block's name" })),
  action: Schema.Literals(["set", "remove"]),
  text: Schema.optionalKey(Schema.String.annotate({ description: "for set: the complete block as policy text" })),
  rationale: Schema.String.annotate({ description: "one or two sentences for the person reviewing the proposal" }),
  citation: Citation,
})
export type Proposal = typeof Proposal.Type

export const Proposals = Schema.Struct({ proposals: Schema.Array(Proposal) })
export type Proposals = typeof Proposals.Type

export const describeCitation = (c: Citation): string => {
  switch (c.kind) {
    case "sensitive-code": return `${c.path}:${c.line} \`${c.excerpt.trim()}\``
    case "unprotected-tests": return `unprotected test file ${c.path}`
    case "uncovered-path": return `nothing covers ${c.path}`
    case "shadow-escape": return `shadow history: ${c.reason}`
    case "selftest-gap": return `selftest can't apply ${c.fixture}`
    case "configured-tool": return `${c.path} sets up the tool: \`${c.excerpt.trim()}\``
  }
}

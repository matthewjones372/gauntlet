import type { Diagnostic } from "./diagnostic.ts"
import type * as Ast from "./generated/ast.ts"
import { parse } from "./parse.ts"
import { TOP_LEVEL_BLOCKS } from "./vocabulary.ts"

// Top-level blocks of policy text, located by kind and name, so a change can
// replace exactly one block and leave the rest of the file (comments, layout)
// as the author wrote it. The authoring agent's proposals are applied this way.

export type BlockKind = (typeof TOP_LEVEL_BLOCKS)[number]

/** A block's identity: its kind, plus the name for kinds that can repeat (`zone money`, `on fail mutation`). */
export interface BlockId {
  readonly kind: BlockKind
  readonly name?: string
}

export interface PolicyBlock extends BlockId {
  /** Offsets of the block's text, from its keyword to its last character. */
  readonly start: number
  readonly end: number
}

const KINDS: Readonly<Record<string, BlockKind>> = {
  Use: "use", Mode: "mode", Owners: "owners", Protect: "protect", Zone: "zone", Arch: "arch", Suites: "suites",
  Integrity: "integrity", Import: "import", Budget: "budget", Gates: "gates", OnFail: "on fail", Predicate: "predicate",
  Review: "review", Stack: "stack", Quarantine: "quarantine", Split: "split",
}

/** Kinds that can appear more than once, told apart by name. */
export const NAMED_KINDS: ReadonlySet<BlockKind> = new Set(["zone", "import", "budget", "on fail", "predicate"])

const nameOf = (b: Ast.Block): string | undefined => {
  switch (b.$type) {
    case "Zone": case "Import": case "Budget": case "Predicate": return b.name
    case "OnFail": return b.gate
    default: return undefined
  }
}

export const sameBlock = (a: BlockId, b: BlockId) => a.kind === b.kind && (a.name ?? "") === (b.name ?? "")

export const describeBlock = (b: BlockId) => (b.name ? `${b.kind} ${b.name}` : b.kind)

export type BlocksResult =
  | { readonly _tag: "Blocks"; readonly blocks: ReadonlyArray<PolicyBlock> }
  | { readonly _tag: "SyntaxErrors"; readonly diagnostics: ReadonlyArray<Diagnostic> }

export const policyBlocks = (file: string, text: string): BlocksResult => {
  const parsed = parse(file, text)
  if (parsed._tag === "SyntaxErrors") return parsed
  const blocks = parsed.ast.blocks.flatMap((b): PolicyBlock[] => {
    const cst = b.$cstNode
    const kind = KINDS[b.$type]
    if (!cst || !kind) return []
    const name = nameOf(b)
    return [{ kind, ...(name !== undefined ? { name } : {}), start: cst.offset, end: cst.end }]
  })
  return { _tag: "Blocks", blocks }
}

export type BlockEdit =
  | { readonly op: "set"; readonly id: BlockId; readonly text: string }
  | { readonly op: "remove"; readonly id: BlockId }

export type EditResult =
  | { readonly _tag: "Edited"; readonly text: string }
  | { readonly _tag: "Failed"; readonly reason: string }

/**
 * Sets (replaces or adds) or removes one block. A new block goes after the
 * last block that comes before it in the usual order, so drafts stay in the
 * familiar layout. Comments directly above a replaced block are kept.
 */
export const editBlock = (file: string, text: string, edit: BlockEdit): EditResult => {
  const found = policyBlocks(file, text)
  if (found._tag === "SyntaxErrors") return { _tag: "Failed", reason: "the current policy doesn't parse" }
  const existing = found.blocks.filter((b) => sameBlock(b, edit.id))
  if (existing.length > 1) return { _tag: "Failed", reason: `${describeBlock(edit.id)} appears more than once` }
  const target = existing[0]
  if (edit.op === "remove") {
    if (!target) return { _tag: "Failed", reason: `there is no ${describeBlock(edit.id)} block to remove` }
    const after = text.slice(target.end).replace(/^[ \t]*\r?\n/, "")
    return { _tag: "Edited", text: `${text.slice(0, target.start)}${after}`.replace(/\n{3,}/g, "\n\n") }
  }
  const body = edit.text.trim()
  if (target) return { _tag: "Edited", text: `${text.slice(0, target.start)}${body}${text.slice(target.end)}` }
  const rank = TOP_LEVEL_BLOCKS.indexOf(edit.id.kind)
  const before = found.blocks.filter((b) => TOP_LEVEL_BLOCKS.indexOf(b.kind) <= rank).at(-1)
  if (!before) {
    // Nothing comes earlier: before the first block, or after the header when there are none.
    const first = found.blocks[0]
    if (!first) return { _tag: "Edited", text: `${text.trimEnd()}\n\n${body}\n` }
    return { _tag: "Edited", text: `${text.slice(0, first.start)}${body}\n\n${text.slice(first.start)}` }
  }
  return { _tag: "Edited", text: `${text.slice(0, before.end)}\n\n${body}${text.slice(before.end)}` }
}

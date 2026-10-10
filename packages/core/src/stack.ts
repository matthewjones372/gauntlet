import type { PolicyIR } from "@gauntlet/ir"
import { buildsOf, hasBuilds, ownerDir } from "./builds.ts"
import type { DiffFacts } from "./diff-facts.ts"

// A big change spread over several parts of the repository is hard to review
// in one go. Gauntlet suggests splitting it into stacked pull requests: one per
// part, each reviewed on top of the one before, the lower layers first. It's a
// suggestion in the report; it never changes the decision.

/** Below this many changed lines a change is easy enough to review in one pull request. */
export const STACK_LINES = 400

export interface StackStep {
  /** What the pull request holds: a package, a build, or Gauntlet's policy and settings. */
  readonly title: string
  readonly files: ReadonlyArray<string>
  readonly lines: number
  /** It touches a zone, the policy or protected files, so an owner signs it off. */
  readonly needsOwner: boolean
}

export interface StackSuggestion {
  readonly lines: number
  readonly steps: ReadonlyArray<StackStep>
}

const POLICY = "Gauntlet's policy and settings"
const DOCS_TITLE = "documentation"
const DOCS = /(\.(md|markdown|rst|adoc)$)|((^|\/)(LICENSE|NOTICE|AUTHORS|CHANGELOG)(\.(md|txt))?$)/i
// Folders whose children are separate packages in a monorepo.
const MONOREPO = new Set(["packages", "packs", "apps", "libs", "modules", "services", "crates", "cmd"])

/** The part of the repository a file belongs to. Tests go with the code they're next to. */
const partOf = (ir: PolicyIR, path: string): string => {
  if (path.startsWith(".gauntlet/") || path.startsWith(".github/") || path.startsWith(".claude/")) return POLICY
  if (hasBuilds(ir)) {
    const dir = ownerDir(buildsOf(ir).map((b) => b.dir), path)
    if (dir !== undefined && dir !== ".") return dir
  }
  const segments = path.split("/")
  if (segments.length > 2 && MONOREPO.has(segments[0]!)) return `${segments[0]}/${segments[1]}`
  if (DOCS.test(path)) return DOCS_TITLE
  return segments.length > 1 ? segments[0]! : "the repository's root"
}

/**
 * The parts in the order to review them: Gauntlet's policy first (an owner signs
 * it, and the rest is judged by it), then the policy's arch modules lowest
 * first (a module comes before those it must not depend on, since they may
 * depend on it), then the rest by name, documentation last.
 */
const order = (ir: PolicyIR, parts: ReadonlyArray<string>): string[] => {
  const moduleOf = (part: string) => part.split("/").at(-1)!
  const modules = new Set(ir.arch.flatMap((r) => [r.module, ...r.mustNotDependOn]))
  const before = new Map<string, Set<string>>()
  for (const r of ir.arch) for (const n of r.mustNotDependOn) before.set(n, (before.get(n) ?? new Set()).add(r.module))
  const placed: string[] = []
  const pending = parts.filter((p) => modules.has(moduleOf(p))).sort()
  while (pending.length > 0) {
    // The first part with nothing left that must come before it; a cycle falls back to the name.
    const i = Math.max(0, pending.findIndex((p) => [...(before.get(moduleOf(p)) ?? [])].every((m) => !pending.some((q) => moduleOf(q) === m))))
    placed.push(...pending.splice(i, 1))
  }
  const rest = parts.filter((p) => !modules.has(moduleOf(p)) && p !== POLICY && p !== DOCS_TITLE).sort()
  return [...parts.filter((p) => p === POLICY), ...placed, ...rest, ...parts.filter((p) => p === DOCS_TITLE)]
}

/** Stacked pull requests for a big change over several parts, or undefined when one is fine. */
export const suggestStack = (ir: PolicyIR, facts: DiffFacts): StackSuggestion | undefined => {
  if (facts.linesChanged < STACK_LINES) return undefined
  const byPart = new Map<string, DiffFacts["files"][number][]>()
  for (const f of facts.files) byPart.set(partOf(ir, f.path), [...(byPart.get(partOf(ir, f.path)) ?? []), f])
  if (byPart.size < 2) return undefined
  const owned = new Set([
    ...facts.zonesTouched.flatMap((z) => z.files),
    ...facts.protectedTouched.filter((p) => p.action !== "kept").map((p) => p.path),
  ])
  const steps = order(ir, [...byPart.keys()]).map((part): StackStep => {
    const files = byPart.get(part)!
    return {
      title: part,
      files: files.map((f) => f.path).sort(),
      lines: files.reduce((n, f) => n + f.added + f.removed, 0),
      needsOwner: part === POLICY || files.some((f) => owned.has(f.path)),
    }
  })
  return { lines: facts.linesChanged, steps }
}

import type { PolicyIR } from "@gauntlet/ir"
import { buildsOf, hasBuilds, ownerDir } from "./builds.ts"
import type { DiffFacts } from "./diff-facts.ts"
import { aboutMutants, type OverBudget } from "./mutation-budget.ts"

// A big change spread over several parts of the repository is hard to review
// in one go. Gauntlet suggests splitting it into stacked pull requests: one per
// part, each reviewed on top of the one before, the lower layers first. It's a
// suggestion in the report; it never changes the decision.

/** Below this many changed lines a change is easy enough to review in one pull request, unless the policy says (\`split when diff > n lines\`). */
export const STACK_LINES = 400

/** A part smaller than this joins the pull request after it, so nobody reviews a few lines on their own. */
export const SMALL_PART_LINES = 30

export interface StackStep {
  /** What the pull request holds: a package, a build, or Gauntlet's policy and settings. */
  readonly title: string
  readonly files: ReadonlyArray<string>
  readonly lines: number
  /** It touches a zone, the policy or protected files, so an owner signs it off. */
  readonly needsOwner: boolean
  /** Split for a mutation budget (spec 0020): about how many mutants the step brings. */
  readonly mutants?: number
}

export interface StackSuggestion {
  readonly lines: number
  readonly steps: ReadonlyArray<StackStep>
  /** Set when the split is for a mutation budget the change is over (spec 0020), whatever its size in lines. */
  readonly mutation?: { readonly estimate: number; readonly budget: number }
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

/**
 * Small parts join the pull request after them (the last one, the one before),
 * so nobody reviews a few lines on their own. Gauntlet's policy and settings
 * stay a pull request of their own, for an owner.
 */
const foldSmall = (steps: ReadonlyArray<StackStep>): StackStep[] => {
  const out = [...steps]
  const join = (a: StackStep, b: StackStep): StackStep => ({
    title: `${a.title}, ${b.title}`,
    files: [...a.files, ...b.files].sort(),
    lines: a.lines + b.lines,
    needsOwner: a.needsOwner || b.needsOwner,
  })
  for (let i = 0; i < out.length;) {
    const s = out[i]!
    const target = i + 1 < out.length && out[i + 1]!.title !== POLICY ? i + 1 : i - 1
    if (s.title === POLICY || s.lines >= SMALL_PART_LINES || target < 0 || out[target]!.title === POLICY) {
      i++
      continue
    }
    const [a, b] = target > i ? [s, out[target]!] : [out[target]!, s]
    out.splice(Math.min(i, target), 2, join(a, b))
    i = Math.min(i, target)
  }
  return out
}

/**
 * Stacked pull requests for a big change over several parts, or undefined when
 * one is fine. A change over a mutation budget (spec 0020) is split so each
 * pull request stays within it, whatever its size in lines.
 */
export const suggestStack = (ir: PolicyIR, facts: DiffFacts, mutation?: OverBudget): StackSuggestion | undefined => {
  if (mutation !== undefined) return mutationStack(ir, facts, mutation)
  if (facts.linesChanged < (ir.split?.lines ?? STACK_LINES)) return undefined
  const byPart = partsOf(ir, facts)
  if (byPart.size < 2) return undefined
  const owned = ownedFiles(facts)
  const steps = order(ir, [...byPart.keys()]).map((part) => stepOf(part, byPart.get(part)!, owned))
  const folded = foldSmall(steps)
  return folded.length < 2 ? undefined : { lines: facts.linesChanged, steps: folded }
}

type ChangedFile = DiffFacts["files"][number]

const partsOf = (ir: PolicyIR, facts: DiffFacts) => {
  const byPart = new Map<string, ChangedFile[]>()
  for (const f of facts.files) byPart.set(partOf(ir, f.path), [...(byPart.get(partOf(ir, f.path)) ?? []), f])
  return byPart
}

const ownedFiles = (facts: DiffFacts): ReadonlySet<string> =>
  new Set([...facts.zonesTouched.flatMap((z) => z.files), ...facts.protectedTouched.filter((p) => p.action !== "kept").map((p) => p.path)])

const stepOf = (title: string, files: ReadonlyArray<ChangedFile>, owned: ReadonlySet<string>, mutants?: number): StackStep => ({
  title,
  files: files.map((f) => f.path).sort(),
  lines: files.reduce((n, f) => n + f.added + f.removed, 0),
  needsOwner: title === POLICY || files.some((f) => owned.has(f.path)),
  ...(mutants !== undefined ? { mutants } : {}),
})

/**
 * The split for a mutation budget: the parts in review order, a part over the
 * budget broken into its files (its other files, tests among them, go with the
 * first), then consecutive pieces joined while they stay within the budget.
 * Gauntlet's settings stay a pull request of their own.
 */
const mutationStack = (ir: PolicyIR, facts: DiffFacts, over: OverBudget): StackSuggestion => {
  const mutantsOf = new Map(over.estimate.files.map((f) => [f.path, f.mutants]))
  const count = (files: ReadonlyArray<ChangedFile>) => files.reduce((n, f) => n + (mutantsOf.get(f.path) ?? 0), 0)
  const byPart = partsOf(ir, facts)
  const pieces: Array<{ readonly title: string; readonly files: ReadonlyArray<ChangedFile> }> = []
  for (const part of order(ir, [...byPart.keys()])) {
    const files = byPart.get(part)!
    const mutated = files.filter((f) => mutantsOf.has(f.path)).sort((a, b) => (a.path < b.path ? -1 : 1))
    if (part === POLICY || count(files) <= over.budget || mutated.length < 2) {
      pieces.push({ title: part, files })
      continue
    }
    const rest = files.filter((f) => !mutantsOf.has(f.path))
    mutated.forEach((f, i) => pieces.push({ title: f.path, files: i === 0 ? [f, ...rest] : [f] }))
  }
  const owned = ownedFiles(facts)
  const steps: StackStep[] = []
  let current: { readonly title: string; readonly files: ReadonlyArray<ChangedFile> } | undefined
  const flush = () => {
    if (current) steps.push(stepOf(current.title, current.files, owned, count(current.files)))
    current = undefined
  }
  for (const piece of pieces) {
    if (piece.title === POLICY) {
      flush()
      steps.push(stepOf(piece.title, piece.files, owned, count(piece.files)))
    } else if (current && current.title !== POLICY && count(current.files) + count(piece.files) <= over.budget) {
      current = { title: `${current.title}, ${piece.title}`, files: [...current.files, ...piece.files] }
    } else {
      flush()
      current = piece
    }
  }
  flush()
  return { lines: facts.linesChanged, steps, mutation: { estimate: over.estimate.mutants, budget: over.budget } }
}

/** The advisory finding's text for a change over its mutation budget: the estimate, the budget and the split. */
export const splitAdvice = (stack: StackSuggestion): string => {
  const { estimate, budget } = stack.mutation!
  const steps = stack.steps.map((s, i) => {
    const n = s.mutants ?? 0
    // Only a piece with one mutated file can be over on its own: a part over the budget is broken into its files.
    const alone = n > budget ? ", over the budget on its own" : ""
    return `${i + 1}. ${s.title} (${aboutMutants(n)}${alone})`
  })
  return `About ${estimate} mutants on the changed lines, over the policy's budget of ${budget}. Split the change into pull requests of up to ${budget} each: ${steps.join("; ")}.`
}

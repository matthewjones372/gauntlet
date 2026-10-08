import {
  type Check,
  type Comparator,
  type Condition,
  DEFAULT_INTEGRITY,
  type FlagCheck,
  type ForbidCheck,
  IMPLICIT_PROTECT,
  IR_VERSION,
  type LayerProperty,
  type PolicyIR,
  type Quantity,
  type RatchetCheck,
  type Threshold,
  type Tier,
  type Unit,
} from "@gauntlet/ir"
import { type AstNode, type CstNode, GrammarUtils } from "langium"
import type { Diagnostic } from "./diagnostic.ts"
import type * as Ast from "./generated/ast.ts"
import { checkGlob } from "./glob.ts"
import type { Span } from "./span.ts"
import { didYouMean, quoteList } from "./suggest.ts"
import {
  ADVISORY_TIER,
  AGGREGATES,
  BUDGET_METRICS,
  FACT_CONDITIONS,
  INTEGRITY_PHRASES,
  LAYER_PROPERTY_FORMS,
  MODES,
  RESERVED_GROUPS,
  SCOPES,
  TIERS,
  UNITS,
} from "./vocabulary.ts"

// Turns the Langium AST into an IR draft. Checks that need only the file
// itself (vocabulary, units, duplicates, globs, retired syntax) happen here.
// Checks that need the pack catalog or the whole policy happen in
// `resolve.ts` and `conflicts.ts`, which read the references collected here.

/** Compiler annotation: where an IR node came from. Dropped from the final IR. */
export const SPAN: unique symbol = Symbol.for("@gauntlet/dsl/span")
export type Spanned = { [SPAN]?: Span }

export const spanOfNode = (node: object): Span | undefined => (node as Spanned)[SPAN]

const at = <const T extends object>(node: T, span: Span): T => Object.assign(node, { [SPAN]: span })

/** A name the policy refers to, kept with its location for later checks. */
export type Ref =
  | { readonly kind: "pack"; readonly name: string; readonly span: Span }
  | { readonly kind: "rule"; readonly name: string; readonly zone: string; readonly span: Span }
  | { readonly kind: "integrity"; readonly id: RatchetCheck | ForbidCheck | FlagCheck; readonly phrase: string; readonly span: Span }
  | { readonly kind: "check"; readonly tier: string; readonly name: string; readonly check: Check; readonly span: Span }
  | { readonly kind: "zone-ref"; readonly name: string; readonly span: Span }
  | { readonly kind: "budget-ref"; readonly name: string; readonly span: Span }
  | { readonly kind: "on-fail"; readonly gate: string; readonly span: Span }
  | { readonly kind: "predicate-ref"; readonly name: string; readonly from: string | undefined; readonly span: Span }
  | { readonly kind: "glob"; readonly owner: { readonly protect: string } | { readonly zone: string }; readonly glob: string; readonly span: Span }

export interface Draft {
  readonly ir: PolicyIR
  readonly refs: ReadonlyArray<Ref>
  /** Spans of top-level constructs that later checks report against. */
  readonly spans: {
    readonly name: Span
    readonly mode?: Span
    readonly owners?: Span
    readonly gates?: Span
    readonly review?: Span
    readonly stack?: Span
    readonly integrity?: Span
    /** Where each build folder is named, for checks against the repository's files. */
    readonly builds?: ReadonlyArray<{ readonly pack: string; readonly dir: string; readonly span: Span }>
  }
}

export type Report = (d: Omit<Diagnostic, "file">) => void

const spanOf = (cst: CstNode | undefined): Span => {
  if (!cst) return { line: 1, column: 1, endLine: 1, endColumn: 1 }
  const { start, end } = cst.range
  return { line: start.line + 1, column: start.character + 1, endLine: end.line + 1, endColumn: end.character + 1 }
}

const nodeSpan = (node: AstNode): Span => spanOf(node.$cstNode)

const itemSpans = (node: AstNode, property: string): Span[] =>
  GrammarUtils.findNodesForProperty(node.$cstNode, property).map(spanOf)

const propertySpan = (node: AstNode, property: string): Span => {
  const cst = GrammarUtils.findNodeForProperty(node.$cstNode, property)
  return cst ? spanOf(cst) : nodeSpan(node)
}

/** The span of the first keyword of a node, for "this block" style errors. */
const headSpan = (node: AstNode, keyword: string): Span => {
  const s = nodeSpan(node)
  return { line: s.line, column: s.column, endLine: s.line, endColumn: s.column + keyword.length }
}

const joinSpans = (a: Span, b: Span): Span => ({ line: a.line, column: a.column, endLine: b.endLine, endColumn: b.endColumn })

const isOneOf = <T extends string>(xs: ReadonlyArray<T>, x: string): x is T => (xs as ReadonlyArray<string>).includes(x)

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends ReadonlyArray<infer A> ? A[] : T[K] }

export const compile = (ast: Ast.Policy, report: Report): Draft => {
  const refs: Ref[] = []
  const error = (code: string, span: Span, message: string, expected: string, fix: string, available?: ReadonlyArray<string>) =>
    report({ severity: "error", code, span, message, expected, fix, ...(available ? { available: [...available] } : {}) })

  const seen = new Map<string, Span>()
  const once = (keyword: string, node: AstNode): boolean => {
    const span = headSpan(node, keyword)
    const first = seen.get(keyword)
    if (first) {
      error("duplicate-block", span, `\`${keyword}\` appears more than once; the first is on line ${first.line}.`,
        `a single \`${keyword}\``, `Merge this into the \`${keyword}\` on line ${first.line}.`)
      return false
    }
    seen.set(keyword, span)
    return true
  }

  const named = (node: AstNode, property: string, values: ReadonlyArray<string>) => {
    const spans = itemSpans(node, property)
    return values.map((name, i) => ({ name, span: spans[i] ?? nodeSpan(node) }))
  }

  const quantity = (q: Ast.Quantity): Quantity | undefined => {
    if (q.unit === undefined) return { value: q.value }
    if (isOneOf(UNITS, q.unit)) return { value: q.value, unit: q.unit as Unit }
    error("unknown-unit", propertySpan(q, "unit"), `Unknown unit '${q.unit}'.`, `one of ${quoteList(UNITS)}`,
      didYouMean(q.unit, UNITS, `Use one of ${quoteList(UNITS)}. If '${q.unit}' starts a new item, put a comma before it.`), UNITS)
    return undefined
  }

  const globsOf = (node: AstNode, values: ReadonlyArray<string>, owner: { protect: string } | { zone: string } | undefined): string[] => {
    const spans = itemSpans(node, "globs")
    return values.flatMap((raw, i) => {
      const span = spans[i] ?? nodeSpan(node)
      const glob = raw.endsWith("/") ? `${raw}**` : raw
      const problem = checkGlob(glob)
      if (problem) {
        error("invalid-glob", span, `Invalid path pattern "${raw}": ${problem.message}`, "a relative glob such as \"src/test/**\"", problem.fix)
        return []
      }
      if (owner) refs.push({ kind: "glob", owner, glob, span })
      return [glob]
    })
  }

  // ---------- header ----------

  const nameSpan = propertySpan(ast, "name")
  if (ast.header === "harness") {
    error("retired-syntax", headSpan(ast, "harness"), "The `harness` header was renamed.", "`gauntlet \"<name>\"`",
      `Write: gauntlet "${ast.name}"`)
  }
  if (ast.name.trim() === "") {
    error("empty-name", nameSpan, "The policy name is empty.", "a non-empty name", "Name the policy, for example: gauntlet \"payments-service\"")
  }

  const ir: Mutable<PolicyIR> = {
    irVersion: IR_VERSION,
    name: ast.name,
    mode: "shadow",
    packs: [],
    owners: [],
    protect: [],
    zones: [],
    arch: [],
    suites: [],
    integrity: { ratchet: [...DEFAULT_INTEGRITY.ratchet], forbid: [...DEFAULT_INTEGRITY.forbid], flag: [...DEFAULT_INTEGRITY.flag] },
    budgets: [],
    gates: [],
    remediation: [],
    imports: [],
    predicates: [],
    review: [],
  }
  at(ir, nameSpan)
  const spans: Mutable<Draft["spans"]> = { name: nameSpan }

  // Suites first, so gate checks can tell suites from pack gates wherever the
  // blocks appear in the file.
  const suiteKinds = new Map<string, "suite" | "holdout">()
  for (const block of ast.blocks) {
    if (block.$type !== "Suites") continue
    for (const s of block.suites) suiteKinds.set(s.$type === "HoldoutSuite" ? s.name : s.kind, s.$type === "HoldoutSuite" ? "holdout" : "suite")
  }

  const protectGroups = new Map<string, Mutable<PolicyIR["protect"][number]>>()

  for (const block of ast.blocks) {
    switch (block.$type) {
      case "Use":
        if (!once("use", block)) break
        {
          const builds: { pack: string; dir: string; span: Span }[] = []
          for (const entry of block.entries) {
            refs.push({ kind: "pack", name: entry.name, span: propertySpan(entry, "name") })
            ir.packs.push(entry.name)
            const spans = itemSpans(entry, "dirs")
            for (const [i, raw] of entry.dirs.entries()) {
              const span = spans[i] ?? nodeSpan(entry)
              const dir = raw.trim().replace(/^\.\/+/, "").replace(/\/+$/, "") || "."
              if (dir.startsWith("/") || dir.split("/").includes("..")) {
                error("build-dir-outside", span, `"${raw}" isn't a folder inside the repository.`, "a folder path from the repository's root", `Write the folder as it appears from the root, such as "services/payments".`)
                continue
              }
              if (builds.some((b) => b.pack === entry.name && b.dir === dir)) {
                error("duplicate-build", span, `"${dir}" is listed twice for '${entry.name}'.`, "each folder once per pack", `Remove the second "${dir}".`)
                continue
              }
              builds.push({ pack: entry.name, dir, span })
            }
          }
          // Once one pack names folders, a pack that names none builds at the root.
          if (builds.length > 0) {
            for (const entry of block.entries) if (entry.dirs.length === 0) builds.push({ pack: entry.name, dir: ".", span: propertySpan(entry, "name") })
            ir.builds = builds.map(({ pack, dir }) => ({ pack, dir }))
            spans.builds = builds
          }
        }
        break
      case "Mode":
        if (!once("mode", block)) break
        spans.mode = nodeSpan(block)
        if (isOneOf(MODES, block.value)) ir.mode = block.value
        else {
          error("unknown-mode", propertySpan(block, "value"), `Unknown mode '${block.value}'.`, "'shadow' or 'enforce'",
            didYouMean(block.value, MODES, "Use `mode shadow` to report only, or `mode enforce` to block on failure."), MODES)
        }
        break
      case "Owners":
        if (!once("owners", block)) break
        spans.owners = nodeSpan(block)
        ir.owners.push(...block.owners)
        break
      case "Protect":
        protect(block)
        break
      case "Zone":
        zone(block)
        break
      case "Arch":
        if (once("arch", block)) arch(block)
        break
      case "Suites":
        if (once("suites", block)) suites(block)
        break
      case "Integrity":
        if (once("integrity", block)) integrity(block)
        break
      case "Import":
        importBlock(block)
        break
      case "Budget":
        budget(block)
        break
      case "Gates":
        if (!once("gates", block)) break
        spans.gates = headSpan(block, "gates")
        for (const t of block.tiers) tier(t)
        break
      case "OnFail":
        onFail(block)
        break
      case "Predicate":
        predicate(block)
        break
      case "Review":
        if (!once("review", block)) break
        spans.review = headSpan(block, "review")
        for (const r of block.rules) reviewRule(r)
        break
      case "Stack":
        if (!once("stack", block)) break
        spans.stack = headSpan(block, "stack")
        ir.stack = stack(block)
        break
      case "Quarantine":
        if (once("quarantine", block)) quarantine(block)
        break
    }
  }

  ir.protect = [...protectGroups.values(), { ...IMPLICIT_PROTECT, globs: [...IMPLICIT_PROTECT.globs] }]

  return { ir, refs, spans }

  // ---------- blocks ----------

  function protectGroup(name: string, span: Span, node: AstNode, values: ReadonlyArray<string>, isDefault: boolean) {
    if (name === "gauntlet") {
      error("reserved-group", span, "The group name 'gauntlet' is reserved: `.gauntlet/` is always protected.", "another group name",
        "Rename the group. `.gauntlet/` needs no entry; it is protected implicitly.")
      return
    }
    const existing = protectGroups.get(name)
    if (existing && !isDefault) {
      error("duplicate-group", span, `Protect group '${name}' is declared more than once.`, "each group once",
        `Merge these paths into the first '${name}' group.`)
      return
    }
    const globs = globsOf(node, values, { protect: name })
    if (existing) existing.globs.push(...globs)
    else protectGroups.set(name, at({ group: name, kind: RESERVED_GROUPS[name] ?? "other", globs }, span))
  }

  function protect(p: Ast.Protect) {
    if (p.groups.length === 0) protectGroup("default", headSpan(p, "protect"), p, p.globs, true)
    for (const g of p.groups) protectGroup(g.name, propertySpan(g, "name"), g, g.globs, false)
  }

  function zone(z: Ast.Zone) {
    const span = propertySpan(z, "name")
    if (ir.zones.some((x) => x.name === z.name)) {
      error("duplicate-zone", span, `Zone '${z.name}' is declared more than once.`, "unique zone names", `Merge the two '${z.name}' zones or rename one.`)
      return
    }
    const globs: string[] = []
    const owners: string[] = []
    const rules: string[] = []
    for (const item of z.items) {
      if (item.$type === "ZonePaths") globs.push(...globsOf(item, item.globs, { zone: z.name }))
      if (item.$type === "ZoneOwner") owners.push(...item.owners)
      if (item.$type === "ZoneRule") {
        for (const r of named(item, "rules", item.rules)) {
          refs.push({ kind: "rule", name: r.name, zone: z.name, span: r.span })
          rules.push(r.name)
        }
      }
    }
    if (!z.items.some((i) => i.$type === "ZonePaths")) {
      error("zone-without-paths", span, `Zone '${z.name}' has no paths, so it can never be touched.`, "a `paths` line inside the zone",
        `Add a line such as: paths "src/**/${z.name}/**"`)
    }
    ir.zones.push(at({ name: z.name, globs, owners, rules }, span))
  }

  function arch(a: Ast.Arch) {
    for (const rule of a.rules) {
      const targets = named(rule, "to", rule.to)
      for (const t of targets) {
        if (t.name === rule.from) {
          error("arch-self-dependency", t.span, `Module '${rule.from}' can't be forbidden from depending on itself.`,
            "a different module name", `Name the module that '${rule.from}' must not depend on, or remove '${t.name}'.`)
        }
      }
      ir.arch.push(at({ module: rule.from, mustNotDependOn: targets.map((t) => t.name).filter((n) => n !== rule.from) }, nodeSpan(rule)))
    }
  }

  function suites(s: Ast.Suites) {
    for (const suite of s.suites) {
      if (suite.$type === "HoldoutSuite") {
        const span = propertySpan(suite, "name")
        if (!suite.ciOnly) {
          error("holdout-not-ci-only", span, `Holdout '${suite.name}' must say \`ci only\`: holdouts never run in the agent's sandbox.`,
            "`ci only` after the holdout name", `Write: holdout "${suite.name}" ci only`)
        }
        addSuite(at({ kind: "holdout", name: suite.name, ciOnly: suite.ciOnly, ...(suite.globs.length > 0 ? { globs: globsOf(suite, suite.globs, undefined) } : {}) }, span))
        continue
      }
      const span = propertySpan(suite, "kind")
      if (suite.env !== undefined || suite.kind === "hidden") {
        error("retired-syntax", nodeSpan(suite), "`hidden ... from env` was replaced by holdout suites.", "`holdout \"<name>\" ci only`",
          `Write: holdout "${suite.location}" ci only`)
        continue
      }
      addSuite(at({ kind: "suite", name: suite.kind, location: suite.location }, span))
    }
  }

  function addSuite(suite: PolicyIR["suites"][number]) {
    if (ir.suites.some((x) => x.name === suite.name)) {
      error("duplicate-suite", spanOfNode(suite)!, `Suite '${suite.name}' is declared more than once.`, "unique suite names",
        `Remove one of the '${suite.name}' suites or rename it.`)
      return
    }
    ir.suites.push(suite)
  }

  function integrity(block: Ast.Integrity) {
    spans.integrity = headSpan(block, "integrity")
    for (const item of block.items) {
      const kind = item.kind as keyof typeof INTEGRITY_PHRASES
      const table = INTEGRITY_PHRASES[kind]
      for (const phrase of item.phrases) splitByLine(phrase, "words", phrase.words).forEach(({ words, span }) => {
        const text = words.join(" ")
        const id = (table as Record<string, RatchetCheck | ForbidCheck | FlagCheck>)[text]
        if (id) {
          refs.push({ kind: "integrity", id, phrase: text, span })
          return
        }
        const otherKind = (Object.keys(INTEGRITY_PHRASES) as (keyof typeof INTEGRITY_PHRASES)[])
          .find((k) => k !== kind && text in INTEGRITY_PHRASES[k])
        if (otherKind) {
          error("wrong-integrity-list", span, `'${text}' is a ${otherKind} check, not a ${kind} check.`, `a ${kind} phrase`,
            `Move it to a \`${otherKind}\` line: ${otherKind} ${text}`, Object.keys(table))
          return
        }
        error("unknown-integrity-check", span, `Unknown ${kind} check '${text}'.`, `one of ${quoteList(Object.keys(table))}`,
          didYouMean(text, Object.keys(table), `Use one of ${quoteList(Object.keys(table))}.`), Object.keys(table))
      })
    }
  }

  function importBlock(block: Ast.Import) {
    const span = propertySpan(block, "name")
    const commands = block.items.flatMap((i) => (i.$type === "ImportCommand" ? [i] : []))
    const caution = block.items.some((i) => i.$type === "ImportCaution")
    if (ir.imports.some((x) => x.name === block.name)) {
      error("duplicate-import", span, `Import '${block.name}' is declared more than once.`, "unique import names", "Remove or rename one of them.")
      return
    }
    if (commands.length === 0) {
      error("import-without-command", span, `Import '${block.name}' has no command. Gauntlet runs every import itself and never reads existing files.`,
        "a `command` line containing {sarif}", `Add a line such as: command "${block.name} --sarif --output {sarif}"`)
      return
    }
    if (commands.length > 1) {
      error("duplicate-command", nodeSpan(commands[1]!), `Import '${block.name}' has more than one command.`, "a single `command`", "Keep one `command` line.")
    }
    const command = commands[0]!.command
    if (!command.includes("{sarif}")) {
      error("import-without-sarif", propertySpan(commands[0]!, "command"),
        "The import command must write its SARIF to {sarif}, the path Gauntlet creates for it.", "a command containing {sarif}",
        "Pass {sarif} as the tool's output path, for example: --output {sarif}")
    }
    ir.imports.push(at({ name: block.name, command, trust: caution ? "caution" as const : "evidence" as const }, span))
  }

  function budget(b: Ast.Budget) {
    const span = propertySpan(b, "name")
    if (ir.budgets.some((x) => x.name === b.name)) {
      error("duplicate-budget", span, `Budget '${b.name}' is declared more than once.`, "unique budget names", "Remove or rename one of them.")
      return
    }
    let command: string | undefined
    const thresholds: Mutable<PolicyIR["budgets"][number]>["thresholds"] = []
    for (const item of b.items) {
      if (item.$type === "BudgetCommand") {
        if (command !== undefined) {
          error("duplicate-command", nodeSpan(item), `Budget '${b.name}' has more than one command.`, "a single `command`", "Keep one `command` line.")
        }
        command = item.command
        continue
      }
      const t = threshold(b.name, item)
      if (t) thresholds.push(t)
    }
    if (command === undefined) {
      error("budget-without-command", span, `Budget '${b.name}' has no command, so nothing can be measured.`,
        "a `command` line inside the budget", "Add a line such as: command \"./perf/run.sh\"")
    }
    ir.budgets.push(at({ name: b.name, command: command ?? "", thresholds }, span))
  }

  function threshold(budgetName: string, t: Ast.Threshold): PolicyIR["budgets"][number]["thresholds"][number] | undefined {
    const span = nodeSpan(t)
    const metricNames = Object.keys(BUDGET_METRICS)
    const field = t.metric.field
    const accepted = BUDGET_METRICS[field]
    if (!accepted) {
      error("unknown-metric", propertySpan(t.metric, "field"), `Unknown budget metric '${field}'.`, `one of ${quoteList(metricNames)}`,
        didYouMean(field, metricNames, `Use one of ${quoteList(metricNames)}.`), metricNames)
      return undefined
    }
    const aggregate = t.metric.aggregate
    if (aggregate !== undefined && !isOneOf(AGGREGATES, aggregate)) {
      error("unknown-aggregate", propertySpan(t.metric, "aggregate"), `Unknown aggregate '${aggregate}'.`, `one of ${quoteList(AGGREGATES)}`,
        didYouMean(aggregate, AGGREGATES, `Use one of ${quoteList(AGGREGATES)}, or write the metric on its own.`), AGGREGATES)
      return undefined
    }
    const value = quantity(t.value)
    if (!value) return undefined
    const valueSpan = propertySpan(t, "value")
    if (value.unit === undefined || !accepted.includes(value.unit)) {
      const what = value.unit === undefined ? "has no unit" : `can't be measured in '${value.unit}'`
      error("wrong-unit", valueSpan, `In budget '${budgetName}', '${field}' ${what}.`, `a unit from ${quoteList(accepted)}`,
        `Write the amount with a unit, for example ${t.value.value}${accepted[0]}.`, accepted)
      return undefined
    }
    if (value.unit === "%" && value.value > 100) {
      error("percent-out-of-range", valueSpan, `${value.value}% is more than 100%.`, "a percentage between 0 and 100", "Use a value between 0% and 100%.")
    }
    if (field === "regression" && !t.vsBaseline) {
      error("regression-needs-baseline", span, "A regression is measured against the baseline.", "`vs baseline` after the amount",
        `Write: regression ${t.op} ${t.value.value}% vs baseline`)
    }
    if (field !== "regression" && t.vsBaseline) {
      error("baseline-only-for-regression", span, `Only 'regression' is compared against the baseline, not '${field}'.`,
        "`vs baseline` only on a regression threshold", "Remove `vs baseline`, or add a separate line: regression < 5% vs baseline")
    }
    return at({
      ...(aggregate !== undefined ? { aggregate } : {}),
      metric: field,
      op: t.op as Comparator,
      value,
      vsBaseline: t.vsBaseline,
    }, span)
  }

  function tier(t: Ast.GateTier) {
    const span = propertySpan(t, "name")
    if (ir.gates.some((x) => x.name === t.name)) {
      error("duplicate-tier", span, `Gate tier '${t.name}' is declared more than once.`, "unique tier names", `Merge the checks into the first '${t.name}'.`)
      return
    }
    if (t.checks.length === 0) {
      error("empty-tier", span, `Gate tier '${t.name}' has no checks.`, "at least one check, such as `build` or `unit`",
        `Add checks, for example: ${t.name} { build, unit }, or remove the tier.`)
    }
    const advisory = t.name === ADVISORY_TIER
    const checks = t.checks.flatMap((c) => check(t.name, advisory, c) ?? [])
    ir.gates.push(at({ name: t.name, advisory, checks }, span))
  }

  function check(tierName: string, advisory: boolean, c: Ast.Check): Check | undefined {
    const span = nodeSpan(c)
    const done = (result: Check, name: string) => {
      refs.push({ kind: "check", tier: tierName, name, check: result, span })
      return at(result, span)
    }
    if (c.$type === "LlmReviewCheck") {
      const m = /^x([0-9]+)$/.exec(c.times)
      if (!m || Number(m[1]) < 1) {
        error("bad-review-count", propertySpan(c, "times"), `'${c.times}' isn't a review count.`, "x followed by a number, such as x3",
          "Write the number of independent reviews as x<N>, for example: llm review x3")
        return undefined
      }
      if (!advisory) {
        error("llm-review-not-advisory", span, "`llm review` is probabilistic, so it can only run in the advisory tier.",
          `\`llm review\` inside \`${ADVISORY_TIER} { ... }\``, `Move it to: ${ADVISORY_TIER} { llm review ${c.times} }`)
        return undefined
      }
      return done({ kind: "llm-review", reviews: Number(m[1]) }, "llm review")
    }
    if (advisory) {
      const what = c.$type === "BudgetCheck" ? `budget ${c.budget}` : c.name
      error("deterministic-check-in-advisory", span, `'${what}' is deterministic evidence; the advisory tier only holds caution-only checks.`,
        "`llm review x<N>`", `Move '${what}' to a required tier so it can fail the change.`)
      return undefined
    }
    if (c.$type === "BudgetCheck") {
      refs.push({ kind: "budget-ref", name: c.budget, span: propertySpan(c, "budget") })
      return done({ kind: "budget", budget: c.budget }, `budget ${c.budget}`)
    }
    const suiteKind = suiteKinds.get(c.name)
    if (suiteKind) {
      if (c.ratchet || c.op !== undefined || c.scope !== undefined || c.zone !== undefined) {
        error("suite-with-modifiers", span, `'${c.name}' is a suite: it passes or fails, so it takes no ratchet, threshold or scope.`,
          `just '${c.name}'`, `Write '${c.name}' on its own. Coverage and mutation thresholds go on the coverage and mutation gates.`)
        return undefined
      }
      return done({ kind: suiteKind, name: c.name }, c.name)
    }
    let scope: "changed" | "all" = "all"
    if (c.scope !== undefined) {
      if (!isOneOf(SCOPES, c.scope)) {
        error("unknown-scope", propertySpan(c, "scope"), `Unknown scope '${c.scope}'.`, "'changed' or 'all'",
          didYouMean(c.scope, SCOPES, "Write `on changed` to check only what the change touches, or `on all` for the whole project."), SCOPES)
        return undefined
      }
      scope = c.scope
    }
    let threshold: Threshold | undefined
    if (c.op !== undefined && c.value !== undefined) {
      const value = quantity(c.value)
      if (!value) return undefined
      threshold = { op: c.op as Comparator, value }
    }
    if (c.zone !== undefined) refs.push({ kind: "zone-ref", name: c.zone, span: propertySpan(c, "zone") })
    return done({
      kind: "gate",
      name: c.name,
      ratchet: c.ratchet,
      ...(threshold ? { threshold } : {}),
      scope,
      ...(c.zone !== undefined ? { zone: c.zone } : {}),
    }, c.name)
  }

  function onFail(o: Ast.OnFail) {
    const span = propertySpan(o, "gate")
    if (ir.remediation.some((r) => r.gate === o.gate)) {
      error("duplicate-on-fail", span, `\`on fail ${o.gate}\` appears more than once.`, "one remediation per gate", "Combine the advice into one `fix` string.")
      return
    }
    if (o.fix.trim() === "") {
      error("empty-fix", propertySpan(o, "fix"), `The remediation for '${o.gate}' is empty.`, "advice the agent can act on",
        "Say how to fix the failure without weakening the check.")
      return
    }
    refs.push({ kind: "on-fail", gate: o.gate, span })
    ir.remediation.push(at({ gate: o.gate, fix: o.fix }, nodeSpan(o)))
  }

  function predicate(p: Ast.Predicate) {
    const span = propertySpan(p, "name")
    if (ir.predicates.some((x) => x.name === p.name)) {
      error("duplicate-predicate", span, `Predicate '${p.name}' is defined more than once.`, "unique predicate names", "Remove or rename one of them.")
      return
    }
    const conditions = p.conditions.map((c) => condition(c, p.name))
    if (conditions.some((c) => c === undefined)) return
    ir.predicates.push(at({ name: p.name, conditions: conditions as Condition[] }, nodeSpan(p)))
  }

  function reviewRule(rule: Ast.ReviewRule) {
    const span = nodeSpan(rule)
    const verbSpan = headSpan(rule, rule.verb)
    if (rule.verb === "require") {
      error("retired-syntax", verbSpan, "`require` was renamed: rules now name the tier they nominate.", "`owner`, `review`, `skim` or `auto`",
        "Write `review when ...`.")
      return
    }
    if (rule.verb === "raise") {
      error("retired-syntax", verbSpan, "`raise` was removed: every rule nominates a tier and the most cautious one wins, so a relative raise has no meaning.",
        "`owner`, `review`, `skim` or `auto`",
        "Write `review when ...`. Missing evidence already nominates review, so `raise when evidence missing` can simply be deleted.")
      return
    }
    const conditions = rule.conditions.map((c) => condition(c, undefined))
    if (conditions.some((c) => c === undefined)) return
    ir.review.push(at({ tier: rule.verb as Tier, conditions: conditions as Condition[] }, span))
  }

  function condition(c: Ast.Condition, inPredicate: string | undefined): Condition | undefined {
    const span = nodeSpan(c)
    const phrases = [...Object.keys(FACT_CONDITIONS), "diff < <n> lines"]
    if (c.$type === "DiffCondition") {
      if (c.value.unit !== "lines") {
        error("wrong-unit", propertySpan(c, "value"), "A diff size is counted in lines.", "'lines'", `Write: diff ${c.op} ${c.value.value} lines`, ["lines"])
        return undefined
      }
      return at({ kind: "diff", op: c.op as Comparator, lines: c.value.value }, span)
    }
    if (c.$type === "PredicateRef") {
      refs.push({ kind: "predicate-ref", name: c.name, from: inPredicate, span })
      return at({ kind: "predicate", name: c.name }, span)
    }
    const phrase = [c.negated ? "no" : "", c.all ? "all" : "", c.subject, c.state].filter((w) => w !== "").join(" ")
    const kind = FACT_CONDITIONS[phrase]
    if (!kind && (phrase === "policy changed" || phrase === "baseline changed")) {
      error("implicit-condition", span, `'${phrase}' needs no rule: any change under \`.gauntlet/\` already nominates owner.`,
        `one of ${quoteList(phrases)}, or a predicate name`, "Remove this rule.", phrases)
      return undefined
    }
    if (!kind) {
      error("unknown-condition", span, `Unknown condition '${phrase}'.`, `one of ${quoteList(phrases)}, or a predicate name`,
        didYouMean(phrase, phrases, `Use one of ${quoteList(phrases)}.`), phrases)
      return undefined
    }
    return at({ kind }, span)
  }

  function quarantine(q: Ast.Quarantine) {
    const entries: NonNullable<PolicyIR["quarantine"]>[number][] = []
    for (const e of q.entries) {
      const test = e.test
      const span = propertySpan(e, "test")
      if (test.trim() === "") {
        error("empty-quarantine", span, "A quarantine needs the test's id.", "a test id as the report shows it", "Copy the id from the report's Failing tests list.")
        continue
      }
      if (entries.some((x) => x.test === test)) {
        error("duplicate-quarantine", span, `'${test}' is quarantined more than once.`, "each test once", "Keep one entry for it.")
        continue
      }
      const [y, m, d] = e.until.split("-").map(Number) as [number, number, number]
      const date = new Date(Date.UTC(y, m - 1, d))
      if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
        error("invalid-date", propertySpan(e, "until"), `'${e.until}' isn't a date.`, "a date as YYYY-MM-DD", "Use a real calendar date, such as 2026-11-01.")
        continue
      }
      entries.push(at({ test, until: e.until, owners: [...e.owners] }, span))
    }
    if (entries.length > 0) ir.quarantine = entries
  }

  function stack(s: Ast.Stack): NonNullable<PolicyIR["stack"]> {
    const layers: Mutable<NonNullable<PolicyIR["stack"]>>["layers"] = []
    let maxLayerDiffLines: number | undefined
    let reviewStackWhen: NonNullable<PolicyIR["stack"]>["reviewStackWhen"]
    for (const item of s.items) {
      if (item.$type === "StackLayer") {
        const span = propertySpan(item, "name")
        if (layers.some((l) => l.name === item.name)) {
          error("duplicate-layer", span, `Stack layer '${item.name}' is declared more than once.`, "unique layer names", "Remove or rename one of them.")
          continue
        }
        layers.push(at({ name: item.name, properties: item.props.flatMap(layerProps) }, span))
      } else if (item.$type === "StackLimit") {
        if (item.value.unit !== "lines") {
          error("wrong-unit", propertySpan(item, "value"), "A layer's diff size is counted in lines.", "'lines'",
            `Write: max layer diff ${item.value.value} lines`, ["lines"])
        } else maxLayerDiffLines = item.value.value
      } else if (isOneOf(TIERS, item.tier)) {
        reviewStackWhen = at({ op: item.op as Comparator, tier: item.tier }, nodeSpan(item))
      } else {
        error("unknown-tier", propertySpan(item, "tier"), `Unknown review tier '${item.tier}'.`, `one of ${quoteList(TIERS)}`,
          didYouMean(item.tier, TIERS, `Use one of ${quoteList(TIERS)}.`), TIERS)
      }
    }
    return at({
      layers,
      ...(maxLayerDiffLines !== undefined ? { maxLayerDiffLines } : {}),
      ...(reviewStackWhen ? { reviewStackWhen } : {}),
    }, headSpan(s, "stack"))
  }

  function layerProps(p: Ast.LayerProp): LayerProperty[] {
    const groups = splitByLine(p, "words", p.words)
    return groups.flatMap((g, i) => {
      const isLast = i === groups.length - 1
      return layerProperty(g.words, isLast ? p.to : [], isLast && p.to.length > 0 ? nodeSpan(p) : g.span) ?? []
    })
  }

  function layerProperty(words: ReadonlyArray<string>, to: ReadonlyArray<string>, span: Span): LayerProperty | undefined {
    const text = [...words, ...(to.length > 0 ? ["->", ...to] : [])].join(" ")
    if (to.length > 0) {
      if (words.length === 2 && words[1] === "red" && to.length === 1 && to[0] === "green") return at({ kind: "red-to-green", suite: words[0]! }, span)
    } else if (words.length === 2 && words[1] === "unchanged") {
      return at({ kind: "unchanged", subject: words[0]! }, span)
    } else if (words.length === 1 && (words[0] === "additive" || words[0] === "reversible")) {
      return at({ kind: words[0] }, span)
    } else if (words[0] === "touches" && words.length > 1) {
      return at({ kind: "touches", subjects: words.slice(1) }, span)
    } else if (words.length > 1 && words[words.length - 1] === "only") {
      return at({ kind: "only", subjects: words.slice(0, -1) }, span)
    }
    error("unknown-layer-property", span, `Unknown stack layer property '${text}'.`, `one of: ${LAYER_PROPERTY_FORMS.join("; ")}`,
      "Rewrite it in one of the accepted forms, for example `tests unchanged` or `acceptance red -> green`.", LAYER_PROPERTY_FORMS)
    return undefined
  }
}

/**
 * A free word list ends at a comma or, since commas are optional (PLAN Q3),
 * at a line break. Splits one parsed list into its per-line groups.
 */
const splitByLine = (node: AstNode, property: string, words: ReadonlyArray<string>) => {
  const spans = itemSpans(node, property)
  const groups: { words: string[]; span: Span }[] = []
  words.forEach((w, i) => {
    const span = spans[i] ?? nodeSpan(node)
    const last = groups[groups.length - 1]
    if (last && last.span.endLine === span.line) {
      last.words.push(w)
      last.span = joinSpans(last.span, span)
    } else groups.push({ words: [w], span })
  })
  return groups
}

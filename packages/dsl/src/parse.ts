import type { IParserErrorMessageProvider, IToken, TokenType } from "chevrotain"
import {
  createDefaultCoreModule,
  createDefaultSharedCoreModule,
  EmptyFileSystem,
  inject,
  URI,
} from "langium"
import type { Diagnostic } from "./diagnostic.ts"
import type * as Ast from "./generated/ast.ts"
import { GauntletGeneratedModule, GauntletGeneratedSharedModule } from "./generated/module.ts"
import type { Span } from "./span.ts"
import { closest, quoteList } from "./suggest.ts"
import { TOP_LEVEL_BLOCKS } from "./vocabulary.ts"

// Chevrotain builds error messages through this provider. We encode the raw
// facts as JSON and turn them into Gauntlet diagnostics below, where we also
// have the token stream and the source text.
interface Encoded {
  readonly kind: "mismatch" | "no-alternative" | "early-exit" | "extra"
  readonly expected: ReadonlyArray<string>
  readonly rule: string
}

const firstTokens = (paths: TokenType[][]): string[] => paths.flatMap((p) => (p[0] ? [p[0].name] : []))

// Langium appends a zero-width space to rule names it hands to Chevrotain.
const ruleOf = (name: string) => name.replace(/\u200B/g, "")

const structuredErrors: IParserErrorMessageProvider = {
  buildMismatchTokenMessage: ({ expected, ruleName }) =>
    JSON.stringify({ kind: expected.name === "EOF" ? "extra" : "mismatch", expected: expected.name === "EOF" ? [] : [expected.name], rule: ruleOf(ruleName) } satisfies Encoded),
  buildNotAllInputParsedMessage: ({ ruleName }) =>
    JSON.stringify({ kind: "extra", expected: [], rule: ruleOf(ruleName) } satisfies Encoded),
  buildNoViableAltMessage: ({ expectedPathsPerAlt, ruleName }) =>
    JSON.stringify({ kind: "no-alternative", expected: expectedPathsPerAlt.flatMap(firstTokens), rule: ruleOf(ruleName) } satisfies Encoded),
  buildEarlyExitMessage: ({ expectedIterationPaths, ruleName }) =>
    JSON.stringify({ kind: "early-exit", expected: firstTokens(expectedIterationPaths), rule: ruleOf(ruleName) } satisfies Encoded),
}

const services = (() => {
  const shared = inject(createDefaultSharedCoreModule(EmptyFileSystem), GauntletGeneratedSharedModule)
  const lang = inject(createDefaultCoreModule({ shared }), GauntletGeneratedModule, {
    parser: { ParserErrorMessageProvider: () => structuredErrors },
  })
  shared.ServiceRegistry.register(lang)
  return { shared, lang }
})()

let documentCounter = 0

export type Parsed =
  | { readonly _tag: "Parsed"; readonly ast: Ast.Policy }
  | { readonly _tag: "SyntaxErrors"; readonly diagnostics: ReadonlyArray<Diagnostic> }

/** Parse policy text. Only the first parser error is reported, since later ones are usually cascades. */
export const parse = (file: string, text: string): Parsed => {
  const uri = URI.parse(`memory:///gauntlet/${documentCounter++}.gx`)
  const doc = services.shared.workspace.LangiumDocumentFactory.fromString<Ast.Policy>(text, uri)
  const { lexerErrors, parserErrors, value } = doc.parseResult
  const firstLexerError = lexerErrors[0]
  if (firstLexerError) {
    return { _tag: "SyntaxErrors", diagnostics: [lexerDiagnostic(file, text, firstLexerError.offset, firstLexerError.length)] }
  }
  const first = parserErrors[0]
  if (first) {
    const tokens = services.lang.parser.Lexer.tokenize(text).tokens
    return { _tag: "SyntaxErrors", diagnostics: [parserDiagnostic(file, text, tokens, first.token, first.message)] }
  }
  return { _tag: "Parsed", ast: value }
}

// ---------- positions ----------

export const spanOfOffsets = (text: string, start: number, end: number): Span => {
  const at = (offset: number) => {
    const before = text.slice(0, offset).split(/\r?\n/)
    return { line: before.length, column: (before[before.length - 1] ?? "").length + 1 }
  }
  const s = at(start)
  const e = at(Math.max(start, end))
  return { line: s.line, column: s.column, endLine: e.line, endColumn: e.column }
}

const isEof = (token: IToken) => token.tokenType.name === "EOF" || Number.isNaN(token.startOffset)

const spanOfToken = (text: string, token: IToken): Span =>
  isEof(token)
    ? spanOfOffsets(text, text.trimEnd().length, text.trimEnd().length)
    : spanOfOffsets(text, token.startOffset, token.startOffset + token.image.length)

// ---------- lexer errors ----------

const lexerDiagnostic = (file: string, text: string, offset: number, length: number): Diagnostic => {
  const ch = text[offset] ?? ""
  const span = spanOfOffsets(text, offset, offset + Math.max(1, length))
  const base = {
    severity: "error" as const,
    file,
    span,
    expected: "a name, a quoted string, a number, an owner such as @team, or one of { } ( ) , . < <= > >= == != -> %",
  }
  switch (ch) {
    case "\"":
      return { ...base, code: "unterminated-string", message: "This string is never closed.", fix: "Add a closing \" on the same line. Strings cannot span lines." }
    case "'":
      return { ...base, code: "unexpected-character", message: "Unexpected character \"'\".", fix: "Use double quotes for strings, for example \"src/test/**\"." }
    case "#":
      return { ...base, code: "unexpected-character", message: "Unexpected character '#'.", fix: "Comments start with //." }
    case ";":
      return { ...base, code: "unexpected-character", message: "Unexpected character ';'.", fix: "Remove the ';'. Statements end at the line break or at a comma." }
    case "=":
      return { ...base, code: "unexpected-character", message: "Unexpected character '='.", fix: "Use '==' to compare, or '>=' / '<=' for thresholds. Blocks don't use '=' for assignment." }
    default:
      return { ...base, code: "unexpected-character", message: `Unexpected character '${ch}'.`, fix: `Remove '${ch}'. Names use letters, digits, '_' and '-'.` }
  }
}

// ---------- parser errors ----------

const describeToken = (name: string): string => {
  switch (name) {
    case "ID": return "a name"
    case "STRING": return "a quoted string"
    case "NUMBER": return "a number"
    case "DATE": return "a date such as 2026-11-01"
    case "OWNER": return "an owner such as @payments"
    case "EOF": return "the end of the file"
    default: return `'${name}'`
  }
}

const describeFound = (token: IToken) => (isEof(token) ? "the end of the file" : `'${token.image}'`)

const RULE_CONTEXT: Record<string, string> = {
  Policy: "at the top level",
  Use: "in `use`",
  Mode: "in `mode`",
  Owners: "in `owners`",
  Protect: "in `protect`",
  ProtectGroup: "in a protect group (<group> \"<glob>\", ...)",
  Zone: "in a `zone` block",
  ZoneItem: "in a `zone` block",
  ZonePaths: "in zone `paths`",
  ZoneOwner: "in zone `owner`",
  ZoneRule: "in zone `rule`",
  Arch: "in the `arch` block",
  ArchRule: "in an arch rule (module <a> must not depend on <b>)",
  Suites: "in the `suites` block",
  HoldoutSuite: "in a holdout (holdout \"<name>\" ci only)",
  TestSuite: "in a suite (<name> \"<path glob>\")",
  Integrity: "in the `integrity` block",
  IntegrityItem: "in an integrity list (ratchet|forbid|flag <checks>)",
  IntegrityPhrase: "in an integrity list",
  Import: "in an `import` block",
  ImportItem: "in an `import` block",
  ImportCommand: "in an import `command`",
  Budget: "in a `budget` block",
  BudgetItem: "in a `budget` block",
  BudgetCommand: "in a budget `command`",
  Threshold: "in a budget threshold (<metric> <comparison> <amount>)",
  Metric: "in a budget metric",
  Gates: "in the `gates` block",
  GateTier: "in a gate tier (<name> { <checks> })",
  Check: "in a gate check",
  MetricCheck: "in a gate check",
  BudgetCheck: "in a budget check (budget <name>)",
  LlmReviewCheck: "in `llm review x<N>`",
  OnFail: "in `on fail <gate> { fix \"...\" }`",
  Predicate: "in a predicate (predicate <name> = <condition> and ...)",
  Review: "in the `review` block",
  ReviewRule: "in a review rule (<owner|review|skim|auto> when <condition>)",
  Condition: "in a condition",
  FactCondition: "in a condition such as `zone touched` or `protected changed`",
  DiffCondition: "in a size condition (diff < <n> lines)",
  Stack: "in the `stack` block",
  StackItem: "in the `stack` block",
  StackLayer: "in a stack layer",
  LayerProp: "in a stack layer property",
  StackLimit: "in `max layer diff`",
  StackReview: "in `review stack when cumulative <comparison> <tier>`",
  Quarantine: "in the `quarantine` block",
  QuarantineEntry: "in a quarantine entry (\"<test id>\" until <YYYY-MM-DD> owner @team)",
  Quantity: "in an amount",
}

const KEYWORDS = new Set([
  "gauntlet", "harness", "use", "mode", "owners", "protect", "zone", "paths", "owner", "rule", "arch", "module",
  "must", "not", "depend", "on", "suites", "holdout", "ci", "only", "from", "env", "integrity", "ratchet", "forbid",
  "flag", "import", "caution", "budget", "command", "vs", "baseline", "gates", "llm", "review", "in", "fail", "fix",
  "predicate", "when", "and", "skim", "auto", "require", "raise", "no", "all", "touched", "changed", "added",
  "missing", "pass", "diff", "stack", "layer", "max", "cumulative", "quarantine", "until",
])

const RETIRED = new Set(["harness", "require", "raise"])

/** Keywords the grammar also accepts as names (the `Name` rule). */
const NAME_KEYWORDS = new Set([
  "baseline", "env", "command", "cumulative", "caution", "ci", "only", "fix", "fail", "changed", "all", "touched",
  "added", "missing", "pass", "until",
])

/** What may start a line inside each block, for "unexpected line" hints. */
const BLOCK_ITEMS: Record<string, ReadonlyArray<string>> = {
  Review: ["owner", "review", "skim", "auto"],
  Zone: ["paths", "owner", "rule"],
  Integrity: ["ratchet", "forbid", "flag"],
  Arch: ["module"],
  Stack: ["layer", "max", "review"],
  Import: ["command", "caution"],
}

/** The line of the last '{' before `offset` that has no matching '}'. */
const unclosedBraceLine = (text: string, tokens: ReadonlyArray<IToken>, offset: number): number | undefined => {
  const open: IToken[] = []
  for (const t of tokens) {
    if (t.startOffset >= offset) break
    if (t.image === "{") open.push(t)
    if (t.image === "}") open.pop()
  }
  const last = open[open.length - 1]
  return last ? spanOfOffsets(text, last.startOffset, last.startOffset + 1).line : undefined
}

const parserDiagnostic = (
  file: string,
  text: string,
  tokens: ReadonlyArray<IToken>,
  found: IToken,
  rawMessage: string,
): Diagnostic => {
  let encoded: Encoded
  try {
    encoded = JSON.parse(rawMessage) as Encoded
  } catch {
    encoded = { kind: "no-alternative", expected: [], rule: "Policy" }
  }
  const span = spanOfToken(text, found)
  const context = RULE_CONTEXT[encoded.rule] ?? ""
  const foundText = describeFound(found)
  const image = isEof(found) ? "" : found.image
  // Retired keywords never appear in suggestions, and when any name will do,
  // the keywords that also count as names are not listed one by one.
  const rawExpected = [...new Set(encoded.expected)].filter((n) => !RETIRED.has(n))
  const expectedNames = rawExpected.includes("ID") ? rawExpected.filter((n) => !NAME_KEYWORDS.has(n)) : rawExpected
  const keywordsExpected = expectedNames.filter((n) => KEYWORDS.has(n) || /^[a-z]+$/.test(n))
  const expectedText = expectedNames.length === 0
    ? `a top-level block: ${TOP_LEVEL_BLOCKS.join(", ")}`
    : expectedNames.length === 1
      ? describeToken(expectedNames[0]!)
      : `one of ${expectedNames.map(describeToken).join(", ")}`
  const diag = (code: string, message: string, fix: string, expected = expectedText): Diagnostic => ({
    severity: "error",
    code,
    file,
    span,
    // Tidy the gap an empty context leaves, as in "Expected 'x'  but found".
    message: message.replace(/ {2,}/g, " ").replace(/ \./g, "."),
    expected,
    fix,
  })

  // Missing header.
  if (encoded.rule === "Policy" && expectedNames.includes("gauntlet")) {
    return diag("missing-header", `A policy must start with \`gauntlet "<name>"\` but found ${foundText}.`,
      "Add a first line such as: gauntlet \"my-service\"")
  }

  // Ran out of input inside a block.
  if (isEof(found)) {
    const line = unclosedBraceLine(text, tokens, text.length)
    if (line !== undefined) {
      return diag("unclosed-block", `The block opened on line ${line} is never closed.`, `Add '}' to close the block opened on line ${line}.`)
    }
    return diag("unexpected-end", `The file ends early: expected ${expectedText} ${context}.`, `Finish the statement with ${expectedText}.`)
  }

  // Leftover input after a complete policy.
  if (encoded.kind === "extra") {
    if (image === "}") return diag("unmatched-brace", "This '}' has no matching '{'.", "Remove this '}'.")
    if (image === "gauntlet") return diag("duplicate-header", "A policy has exactly one `gauntlet` header.", "Remove this second `gauntlet` line.")
    const near = closest(image, TOP_LEVEL_BLOCKS)
    return diag("unexpected-statement", `Unexpected ${foundText} at the top level.`,
      near.length > 0 ? `Did you mean '${near[0]}'?` : `Start each top-level statement with one of: ${TOP_LEVEL_BLOCKS.join(", ")}.`)
  }

  // A reserved word where a name was expected.
  if (expectedNames.includes("ID") && KEYWORDS.has(image) && !keywordsExpected.includes(image)) {
    return diag("reserved-word", `'${image}' is a reserved word and can't be used as a name ${context}.`, "Choose a different name.")
  }

  // An unknown line inside a block: Chevrotain only reports the missing '}'.
  const starters = BLOCK_ITEMS[encoded.rule]
  if (starters && expectedNames.length === 1 && expectedNames[0] === "}" && !KEYWORDS.has(image)) {
    const near = closest(image, starters)
    return diag("unexpected-token", `Unexpected ${foundText} ${context}.`,
      near.length > 0
        ? `Did you mean '${near[0]}'?`
        : `Start each line ${context} with ${starters.map((x) => `'${x}'`).join(", ")}, or close the block with '}'.`,
      `one of ${[...starters, "}"].map((x) => `'${x}'`).join(", ")}`)
  }

  // A keyword where a name or the end of a block was expected.
  if (KEYWORDS.has(image) && !keywordsExpected.includes(image) && encoded.rule !== "Policy"
    && expectedNames.some((n) => n === "}" || n === "ID")) {
    return diag("reserved-word", `'${image}' is a reserved word and can't appear here ${context}.`,
      "If it is meant as a name, choose a different name.")
  }

  // A bare word where a quoted string was expected.
  if (expectedNames.length === 1 && expectedNames[0] === "STRING" && found.tokenType.name !== "STRING") {
    return diag("expected-string", `Expected a quoted string ${context} but found ${foundText}.`, `Put it in double quotes: "${image}"`)
  }

  // A misspelt keyword.
  const near = closest(image, keywordsExpected)
  if (near.length > 0) {
    return diag("unexpected-token", `Expected ${expectedText} ${context} but found ${foundText}.`, `Did you mean '${near[0]}'?`)
  }

  if (expectedNames.length === 1) {
    return diag("unexpected-token", `Expected ${expectedText} ${context} but found ${foundText}.`, `Insert ${expectedText} before ${foundText}.`)
  }
  return diag("unexpected-token", `Expected ${expectedText} ${context} but found ${foundText}.`,
    `Replace ${foundText} with ${keywordsExpected.length > 0 ? quoteList(keywordsExpected) : expectedText}.`)
}

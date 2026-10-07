import type { RuleSpec } from "@gauntlet/dsl"
import type { Result } from "@gauntlet/sarif"
import { calleeName, line, type Node, ofType, parseKotlin } from "./syntax.ts"

// Pack rules a zone can name (`rule kotlin.no-var`). They run in the lint
// gate over the zone's files and report SARIF results, so findings are
// grandfathered and ratcheted like any other lint finding.

export const RULES: ReadonlyArray<RuleSpec> = [
  { name: "kotlin.no-floating-money", description: "money is never held in Double or Float" },
  { name: "kotlin.no-var", description: "no mutable `var` declarations" },
  { name: "kotlin.no-mutable-collections", description: "no mutable collection types or builders" },
  { name: "kotlin.no-throw", description: "errors are values, not thrown exceptions" },
  { name: "kotlin.no-null-assertion", description: "no `!!` null assertions" },
  { name: "kotlin.no-run-catching", description: "no runCatching: it catches Throwable, including coroutine cancellation" },
]

const MONEY_NAME = /amount|price|money|total|balance|cost|fee|rate|sum|cash|payment/i
const FLOATING = new Set(["Double", "Float", "Double?", "Float?"])
const MUTABLE_BUILDERS = new Set([
  "mutableListOf", "mutableMapOf", "mutableSetOf", "arrayListOf", "hashMapOf", "hashSetOf", "linkedMapOf", "linkedSetOf",
  "ArrayList", "HashMap", "HashSet", "LinkedHashMap", "LinkedHashSet", "mutableStateOf",
])
const MUTABLE_TYPES = /^(MutableList|MutableMap|MutableSet|MutableCollection|MutableIterable|ArrayList|HashMap|HashSet)\b/

const result = (ruleId: string, path: string, at: Node, message: string): Result => ({
  ruleId,
  level: "warning",
  message: { text: message },
  locations: [{ physicalLocation: { artifactLocation: { uri: path }, region: { startLine: line(at) } } }],
})

const declaredName = (n: Node) => n.namedChildren.find((c) => c?.type === "identifier")?.text ?? ""
const declaredType = (n: Node) => n.namedChildren.find((c) => c?.type === "user_type" || c?.type === "nullable_type")?.text ?? ""
const hasToken = (n: Node, token: string) => n.children.some((c) => c?.type === token)

const CHECKS: Record<string, (path: string, root: Node) => Result[]> = {
  "kotlin.no-floating-money": (path, root) =>
    ofType(root, "class_parameter", "parameter", "variable_declaration").flatMap((n) => {
      const name = declaredName(n)
      return MONEY_NAME.test(name) && FLOATING.has(declaredType(n).replace(/\s/g, ""))
        ? [result("kotlin.no-floating-money", path, n, `'${name}' holds money in ${declaredType(n)}; use minor units in a Long or a BigDecimal.`)]
        : []
    }),
  "kotlin.no-var": (path, root) =>
    [...ofType(root, "property_declaration"), ...ofType(root, "class_parameter")]
      .filter((n) => hasToken(n, "var"))
      .map((n) => result("kotlin.no-var", path, n, "`var` declares mutable state; use `val`.")),
  "kotlin.no-mutable-collections": (path, root) => [
    ...ofType(root, "call_expression").filter((c) => MUTABLE_BUILDERS.has(calleeName(c) ?? ""))
      .map((c) => result("kotlin.no-mutable-collections", path, c, `${calleeName(c)} builds a mutable collection; build an immutable one.`)),
    ...ofType(root, "user_type").filter((t) => MUTABLE_TYPES.test(t.text) && t.parent?.type !== "user_type")
      .map((t) => result("kotlin.no-mutable-collections", path, t, `${t.text.split("<")[0]} is a mutable collection type.`)),
  ],
  "kotlin.no-throw": (path, root) =>
    ofType(root, "throw_expression").map((t) => result("kotlin.no-throw", path, t, "Thrown exception; return the error as a value (Result, Either) instead.")),
  "kotlin.no-run-catching": (path, root) =>
    ofType(root, "call_expression").filter((c) => calleeName(c) === "runCatching").map((c) =>
      result("kotlin.no-run-catching", path, c,
        "runCatching catches every Throwable, including CancellationException, which breaks coroutine cancellation. Catch the specific exceptions you expect, or use a typed error.")),
  "kotlin.no-null-assertion": (path, root) =>
    ofType(root, "unary_expression", "postfix_expression")
      .filter((n) => n.children.some((c) => c?.type === "!!"))
      .map((n) => result("kotlin.no-null-assertion", path, n, "`!!` asserts non-null and throws; handle the null case.")),
}

/** Runs the named rules over Kotlin files. Unknown rule names are ignored (the validator rejects them). */
export const runRules = (rules: ReadonlyArray<string>, files: ReadonlyArray<{ readonly path: string; readonly text: string }>): Result[] => {
  const checks = rules.flatMap((r) => (CHECKS[r] ? [CHECKS[r]] : []))
  if (checks.length === 0) return []
  const lineOf = (r: Result) => r.locations?.[0]?.physicalLocation?.region?.startLine ?? 0
  return files.flatMap((f) => {
    const root = parseKotlin(f.text).rootNode
    return checks.flatMap((check) => check(f.path, root)).sort((a, b) => lineOf(a) - lineOf(b) || (a.ruleId < b.ruleId ? -1 : 1))
  })
}

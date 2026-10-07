import type { RuleSpec } from "@gauntlet/dsl"
import type { Result } from "@gauntlet/sarif"
import { calleeName, line, type Node, ofType, parseTs } from "./syntax.ts"

// Pack rules a zone can name (`rule ts.no-let`), run in the lint gate over
// the zone's files and reported as SARIF, so they are grandfathered and
// ratcheted like any lint finding.

export const RULES: ReadonlyArray<RuleSpec> = [
  { name: "ts.no-floating-money", description: "money is never held in a `number`" },
  { name: "ts.no-let", description: "no `let` or `var`: bindings don't change" },
  { name: "ts.no-throw", description: "errors are values, not thrown exceptions" },
  { name: "ts.no-any", description: "no `any`" },
  { name: "ts.no-non-null-assertion", description: "no `!` non-null assertions" },
  { name: "ts.no-array-mutation", description: "no in-place array mutation (push, splice, sort...)" },
]

const MONEY_NAME = /amount|price|money|total|balance|cost|fee|rate|sum|cash|payment/i
const MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"])

const result = (ruleId: string, path: string, at: Node, message: string): Result => ({
  ruleId,
  level: "warning",
  message: { text: message },
  locations: [{ physicalLocation: { artifactLocation: { uri: path }, region: { startLine: line(at) } } }],
})

const isNumberAnnotation = (n: Node | null) => n?.type === "type_annotation" && n.namedChildren.some((c) => c?.type === "predefined_type" && c.text === "number")

const CHECKS: Record<string, (path: string, root: Node) => Result[]> = {
  "ts.no-floating-money": (path, root) =>
    ofType(root, "variable_declarator", "required_parameter", "optional_parameter", "public_field_definition", "property_signature").flatMap((n) => {
      const name = (n.childForFieldName("name") ?? n.childForFieldName("pattern"))?.text ?? ""
      const annotation = n.childForFieldName("type") ?? n.namedChildren.find((c) => c?.type === "type_annotation") ?? null
      return MONEY_NAME.test(name) && isNumberAnnotation(annotation)
        ? [result("ts.no-floating-money", path, n, `'${name}' holds money in a number; use integer minor units in a bigint, or a decimal type.`)]
        : []
    }),
  "ts.no-let": (path, root) => [
    ...ofType(root, "lexical_declaration").filter((d) => d.children.some((c) => c?.type === "let")),
    ...ofType(root, "variable_declaration"),
  ].map((d) => result("ts.no-let", path, d, `\`${d.text.split(/\s/)[0]}\` declares a binding that can change; use \`const\`.`)),
  "ts.no-throw": (path, root) =>
    ofType(root, "throw_statement").map((t) => result("ts.no-throw", path, t, "Thrown exception; return the error as a value (a Result or Either) instead.")),
  "ts.no-any": (path, root) =>
    ofType(root, "predefined_type").filter((t) => t.text === "any").map((t) => result("ts.no-any", path, t, "`any` turns off type checking; use `unknown` and narrow it.")),
  "ts.no-non-null-assertion": (path, root) =>
    ofType(root, "non_null_expression").map((n) => result("ts.no-non-null-assertion", path, n, "`!` asserts non-null without checking; handle the null case.")),
  "ts.no-array-mutation": (path, root) =>
    ofType(root, "call_expression")
      .filter((c) => c.childForFieldName("function")?.type === "member_expression" && MUTATORS.has(calleeName(c)))
      .map((c) => result("ts.no-array-mutation", path, c, `${calleeName(c)} mutates the array in place; build a new one instead.`)),
}

/** Runs the named rules over source files. Unknown names are ignored (the validator rejects them). */
export const runRules = (rules: ReadonlyArray<string>, files: ReadonlyArray<{ readonly path: string; readonly text: string }>): Result[] => {
  const checks = rules.flatMap((r) => (CHECKS[r] ? [CHECKS[r]] : []))
  if (checks.length === 0) return []
  const lineOf = (r: Result) => r.locations?.[0]?.physicalLocation?.region?.startLine ?? 0
  return files.flatMap((f) => {
    const root = parseTs(f.path, f.text).rootNode
    return checks.flatMap((check) => check(f.path, root)).sort((a, b) => lineOf(a) - lineOf(b) || (a.ruleId < b.ruleId ? -1 : 1))
  })
}

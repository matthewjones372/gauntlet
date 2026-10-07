import type { RuleSpec } from "@gauntlet/dsl"
import type { Result } from "@gauntlet/sarif"
import { calleeText, line, type Node, ofType, parseGo } from "./syntax.ts"

// Pack rules a zone can name (`rule go.no-panic`), run in the lint gate and
// reported as SARIF, so they are grandfathered and ratcheted like any lint
// finding.

export const RULES: ReadonlyArray<RuleSpec> = [
  { name: "go.no-floating-money", description: "money is never held in a float32 or float64" },
  { name: "go.no-panic", description: "errors are returned, not panicked" },
  { name: "go.no-ignored-errors", description: "no error discarded with `_`" },
  { name: "go.no-global-vars", description: "no package-level mutable variables" },
]

const MONEY_NAME = /amount|price|money|total|balance|cost|fee|rate|sum|cash|payment/i
const FLOAT = /^\*?(float32|float64)$/

const result = (ruleId: string, path: string, at: Node, message: string): Result => ({
  ruleId,
  level: "warning",
  message: { text: message },
  locations: [{ physicalLocation: { artifactLocation: { uri: path }, region: { startLine: line(at) } } }],
})

/** Names and type of a parameter, struct field or var spec. */
const declared = (n: Node) => ({
  names: n.namedChildren.filter((c) => c?.type === "identifier" || c?.type === "field_identifier").map((c) => c!.text),
  type: n.childForFieldName("type")?.text ?? "",
})

const CHECKS: Record<string, (path: string, root: Node) => Result[]> = {
  "go.no-floating-money": (path, root) =>
    ofType(root, "parameter_declaration", "field_declaration", "var_spec").flatMap((n) => {
      const d = declared(n)
      return FLOAT.test(d.type) && d.names.some((x) => MONEY_NAME.test(x))
        ? [result("go.no-floating-money", path, n, `'${d.names.find((x) => MONEY_NAME.test(x))}' holds money in a ${d.type}; use integer minor units.`)]
        : []
    }),
  "go.no-panic": (path, root) =>
    ofType(root, "call_expression").filter((c) => calleeText(c) === "panic" || calleeText(c) === "log.Fatal" || calleeText(c) === "log.Fatalf")
      .map((c) => result("go.no-panic", path, c, `${calleeText(c)} stops the program; return an error instead.`)),
  "go.no-ignored-errors": (path, root) =>
    ofType(root, "short_var_declaration", "assignment_statement").filter((s) => {
      const left = s.childForFieldName("left")
      const right = s.childForFieldName("right")
      const names = left?.namedChildren.filter((c) => c !== null).map((c) => c!.text) ?? []
      // The error is conventionally last: `v, _ := f()` or `_ = f()`.
      return names.at(-1) === "_" && right?.namedChildren.length === 1 && right.namedChild(0)?.type === "call_expression"
    }).map((s) => result("go.no-ignored-errors", path, s, "The error is discarded with `_`; handle it or return it.")),
  "go.no-global-vars": (path, root) =>
    root.namedChildren.filter((c) => c?.type === "var_declaration").flatMap((v) => ofType(v!, "var_spec"))
      .map((s) => result("go.no-global-vars", path, s, `Package-level variable ${declared(s).names.join(", ")}: shared mutable state; pass it in instead.`)),
}

export const runRules = (rules: ReadonlyArray<string>, files: ReadonlyArray<{ readonly path: string; readonly text: string }>): Result[] => {
  const checks = rules.flatMap((r) => (CHECKS[r] ? [CHECKS[r]] : []))
  if (checks.length === 0) return []
  const lineOf = (r: Result) => r.locations?.[0]?.physicalLocation?.region?.startLine ?? 0
  return files.flatMap((f) => {
    const root = parseGo(f.text).rootNode
    return checks.flatMap((check) => check(f.path, root)).sort((a, b) => lineOf(a) - lineOf(b) || (a.ruleId < b.ruleId ? -1 : 1))
  })
}

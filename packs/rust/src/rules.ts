import type { RuleSpec } from "@gauntlet/dsl"
import type { Result } from "@gauntlet/sarif"
import { inTestModule, line, macroName, methodName, type Node, ofType, parseRust } from "./syntax.ts"

// Pack rules a zone can name (`rule rust.no-unwrap`), run in the lint gate and
// reported as SARIF, so they are grandfathered and ratcheted like any lint
// finding. Test modules (`#[cfg(test)]`) are exempt.

export const RULES: ReadonlyArray<RuleSpec> = [
  { name: "rust.no-floating-money", description: "money is never held in an f32 or f64" },
  { name: "rust.no-unwrap", description: "no .unwrap() or .expect(): handle the error or the None" },
  { name: "rust.no-panic", description: "no panic!, todo!, unimplemented! or unreachable!" },
  { name: "rust.no-unsafe", description: "no unsafe blocks or functions" },
  { name: "rust.no-mut-statics", description: "no `static mut`" },
]

const MONEY_NAME = /amount|price|money|total|balance|cost|fee|rate|sum|cash|payment/i
const FLOAT = /^(f32|f64|Option<f(32|64)>)$/

const result = (ruleId: string, path: string, at: Node, message: string): Result => ({
  ruleId,
  level: "warning",
  message: { text: message },
  locations: [{ physicalLocation: { artifactLocation: { uri: path }, region: { startLine: line(at) } } }],
})

const declared = (n: Node) => ({
  name: (n.childForFieldName("pattern") ?? n.childForFieldName("name") ?? n.namedChildren.find((c) => c?.type === "field_identifier" || c?.type === "identifier"))?.text ?? "",
  type: n.childForFieldName("type")?.text.replace(/\s/g, "") ?? "",
})

const CHECKS: Record<string, (path: string, root: Node) => Result[]> = {
  "rust.no-floating-money": (path, root) =>
    ofType(root, "parameter", "field_declaration", "let_declaration").flatMap((n) => {
      const d = declared(n)
      return FLOAT.test(d.type) && MONEY_NAME.test(d.name)
        ? [result("rust.no-floating-money", path, n, `'${d.name}' holds money in an ${d.type}; use integer minor units.`)]
        : []
    }),
  "rust.no-unwrap": (path, root) =>
    ofType(root, "call_expression").filter((c) => (methodName(c) === "unwrap" || methodName(c) === "expect") && !inTestModule(c))
      .map((c) => result("rust.no-unwrap", path, c, `.${methodName(c)}() panics on an error or None; handle it or return it with ?.`)),
  "rust.no-panic": (path, root) =>
    ofType(root, "macro_invocation").filter((m) => /^(panic|todo|unimplemented|unreachable)$/.test(macroName(m)) && !inTestModule(m))
      .map((m) => result("rust.no-panic", path, m, `${macroName(m)}! stops the program; return an error instead.`)),
  "rust.no-unsafe": (path, root) =>
    [...ofType(root, "unsafe_block"), ...ofType(root, "function_item").filter((f) => f.children.some((c) => c?.type === "function_modifiers" && c.text.includes("unsafe")))]
      .map((n) => result("rust.no-unsafe", path, n, "unsafe code: the compiler can't check it; keep it out of this zone.")),
  "rust.no-mut-statics": (path, root) =>
    ofType(root, "static_item").filter((s) => s.namedChildren.some((c) => c?.type === "mutable_specifier"))
      .map((s) => result("rust.no-mut-statics", path, s, "`static mut` is shared mutable state; pass values in instead.")),
}

export const runRules = (rules: ReadonlyArray<string>, files: ReadonlyArray<{ readonly path: string; readonly text: string }>): Result[] => {
  const checks = rules.flatMap((r) => (CHECKS[r] ? [CHECKS[r]] : []))
  if (checks.length === 0) return []
  const lineOf = (r: Result) => r.locations?.[0]?.physicalLocation?.region?.startLine ?? 0
  return files.flatMap((f) => {
    const root = parseRust(f.text).rootNode
    return checks.flatMap((check) => check(f.path, root)).sort((a, b) => lineOf(a) - lineOf(b) || (a.ruleId < b.ruleId ? -1 : 1))
  })
}

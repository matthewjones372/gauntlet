import type { RuleSpec } from "@gauntlet/dsl"
import type { Result } from "@gauntlet/sarif"
import { calleeText, line, type Node, ofType, parsePython } from "./syntax.ts"

// Pack rules a zone can name (`rule py.no-mutable-defaults`), run in the lint
// gate and reported as SARIF, so they are grandfathered and ratcheted like
// any lint finding.

export const RULES: ReadonlyArray<RuleSpec> = [
  { name: "py.no-floating-money", description: "money is never held in a float" },
  { name: "py.no-global-mutation", description: "no `global` or `nonlocal` rebinding" },
  { name: "py.no-bare-except", description: "no `except:` or `except Exception` that catches everything" },
  { name: "py.no-mutable-defaults", description: "no mutable default arguments" },
  { name: "py.no-raise", description: "errors are values, not raised exceptions" },
]

const MONEY_NAME = /amount|price|money|total|balance|cost|fee|rate|sum|cash|payment/i
const CATCH_ALL = new Set(["Exception", "BaseException"])

const result = (ruleId: string, path: string, at: Node, message: string): Result => ({
  ruleId,
  level: "warning",
  message: { text: message },
  locations: [{ physicalLocation: { artifactLocation: { uri: path }, region: { startLine: line(at) } } }],
})

/** The exception types an except clause names, or none for a bare `except:`. */
export const exceptTypes = (clause: Node): string[] => {
  const value = clause.namedChildren.find((c) => c !== null && c.type !== "block" && c.type !== "comment")
  if (!value) return []
  const target = value.type === "as_pattern" ? value.namedChild(0) : value
  if (!target) return []
  return target.type === "tuple" ? target.namedChildren.filter((c) => c !== null).map((c) => c!.text) : [target.text]
}

const CHECKS: Record<string, (path: string, root: Node) => Result[]> = {
  "py.no-floating-money": (path, root) =>
    [...ofType(root, "typed_parameter", "typed_default_parameter"), ...ofType(root, "assignment").filter((a) => a.childForFieldName("type"))]
      .flatMap((n) => {
        const name = (n.childForFieldName("name") ?? n.childForFieldName("left") ?? n.namedChild(0))?.text ?? ""
        const type = n.childForFieldName("type")?.text ?? ""
        return MONEY_NAME.test(name) && /^(float|Optional\[float\]|float \| None)$/.test(type)
          ? [result("py.no-floating-money", path, n, `'${name}' holds money in a float; use integer minor units or Decimal.`)]
          : []
      }),
  "py.no-global-mutation": (path, root) =>
    ofType(root, "global_statement", "nonlocal_statement").map((n) => result("py.no-global-mutation", path, n, `\`${n.text.split(/\s/)[0]}\` rebinds a name outside the function; pass values in and return results.`)),
  "py.no-bare-except": (path, root) =>
    ofType(root, "except_clause").filter((c) => {
      const types = exceptTypes(c)
      return types.length === 0 || types.some((t) => CATCH_ALL.has(t))
    }).map((c) => result("py.no-bare-except", path, c, "This catches every exception, including ones that signal bugs; catch the specific exceptions you expect.")),
  "py.no-mutable-defaults": (path, root) =>
    ofType(root, "default_parameter", "typed_default_parameter").filter((p) => {
      const value = p.childForFieldName("value")
      return value !== null && (["list", "dictionary", "set", "list_comprehension", "dictionary_comprehension"].includes(value.type)
        || (value.type === "call" && /^(list|dict|set|defaultdict|deque)$/.test(calleeText(value))))
    }).map((p) => result("py.no-mutable-defaults", path, p, "A mutable default is shared between calls; default to None and create it inside.")),
  "py.no-raise": (path, root) =>
    ofType(root, "raise_statement").map((r) => result("py.no-raise", path, r, "Raised exception; return the error as a value instead.")),
}

export const runRules = (rules: ReadonlyArray<string>, files: ReadonlyArray<{ readonly path: string; readonly text: string }>): Result[] => {
  const checks = rules.flatMap((r) => (CHECKS[r] ? [CHECKS[r]] : []))
  if (checks.length === 0) return []
  const lineOf = (r: Result) => r.locations?.[0]?.physicalLocation?.region?.startLine ?? 0
  return files.flatMap((f) => {
    const root = parsePython(f.text).rootNode
    return checks.flatMap((check) => check(f.path, root)).sort((a, b) => lineOf(a) - lineOf(b) || (a.ruleId < b.ruleId ? -1 : 1))
  })
}

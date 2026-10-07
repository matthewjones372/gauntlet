import type { RuleSpec } from "@gauntlet/dsl"
import type { Result } from "@gauntlet/sarif"
import { calleeText, line, type Node, ofType, parseScala } from "./syntax.ts"

// Pack rules a zone can name (`rule scala.no-throw`), run in the lint gate and
// reported as SARIF, so they are grandfathered and ratcheted like any lint
// finding. They are the functional-programming rules the ZIO and Cats Effect
// profiles usually want.

export const RULES: ReadonlyArray<RuleSpec> = [
  { name: "scala.no-floating-money", description: "money is never held in a Double or Float" },
  { name: "scala.no-var", description: "no mutable `var` definitions" },
  { name: "scala.no-throw", description: "errors are values (Either, ZIO, IO), not thrown exceptions" },
  { name: "scala.no-null", description: "no `null`: use Option" },
  { name: "scala.no-mutable-collections", description: "no scala.collection.mutable" },
  { name: "scala.no-unsafe-run", description: "no unsafeRun* or Unsafe.unsafe: run effects at the edge" },
]

const MONEY_NAME = /amount|price|money|total|balance|cost|fee|rate|sum|cash|payment/i
const FLOAT = /^(Double|Float|Option\[(Double|Float)\])$/
const MUTABLE = /\bcollection\.mutable\b|\bmutable\.[A-Z]\w*/
const UNSAFE_RUN = /(^|\.)(unsafeRunSync|unsafeRunAndForget|unsafeRunTimed|unsafeToFuture|unsafeRunSyncToFuture)$|^Unsafe\.unsafe$/

/** One finding per line, for constructs that nest (a field expression inside another). */
const onePerLine = (nodes: ReadonlyArray<Node>) => nodes.filter((n, i, all) => all.findIndex((x) => line(x) === line(n)) === i)

const result = (ruleId: string, path: string, at: Node, message: string): Result => ({
  ruleId,
  level: "warning",
  message: { text: message },
  locations: [{ physicalLocation: { artifactLocation: { uri: path }, region: { startLine: line(at) } } }],
})

const CHECKS: Record<string, (path: string, root: Node) => Result[]> = {
  "scala.no-floating-money": (path, root) =>
    ofType(root, "parameter", "class_parameter", "val_definition", "var_definition").flatMap((n) => {
      const name = (n.childForFieldName("name") ?? n.childForFieldName("pattern") ?? n.namedChildren.find((c) => c?.type === "identifier"))?.text ?? ""
      const type = n.childForFieldName("type")?.text.replace(/\s/g, "") ?? ""
      return FLOAT.test(type) && MONEY_NAME.test(name) ? [result("scala.no-floating-money", path, n, `'${name}' holds money in a ${type}; use integer minor units or BigDecimal.`)] : []
    }),
  "scala.no-var": (path, root) => ofType(root, "var_definition", "var_declaration").map((v) => result("scala.no-var", path, v, "`var` declares mutable state; use `val` and transform values.")),
  "scala.no-throw": (path, root) => ofType(root, "throw_expression").map((t) => result("scala.no-throw", path, t, "Thrown exception; return the error as a value (Either, ZIO, IO) instead.")),
  "scala.no-null": (path, root) => ofType(root, "null_literal").map((n) => result("scala.no-null", path, n, "`null`; use Option.")),
  "scala.no-mutable-collections": (path, root) =>
    onePerLine([...ofType(root, "import_declaration"), ...ofType(root, "field_expression"), ...ofType(root, "stable_type_identifier"), ...ofType(root, "stable_identifier")]
      .filter((n) => MUTABLE.test(n.text)))
      .map((n) => result("scala.no-mutable-collections", path, n, "Mutable collection; use immutable collections and transformations.")),
  "scala.no-unsafe-run": (path, root) =>
    onePerLine(ofType(root, "call_expression", "field_expression").filter((c) => UNSAFE_RUN.test(c.type === "call_expression" ? calleeText(c) : c.text)))
      .map((c) => result("scala.no-unsafe-run", path, c, "Running an effect unsafely breaks referential transparency; compose it and run it at the edge.")),
}

export const runRules = (rules: ReadonlyArray<string>, files: ReadonlyArray<{ readonly path: string; readonly text: string }>): Result[] => {
  const checks = rules.flatMap((r) => (CHECKS[r] ? [CHECKS[r]] : []))
  if (checks.length === 0) return []
  const lineOf = (r: Result) => r.locations?.[0]?.physicalLocation?.region?.startLine ?? 0
  return files.flatMap((f) => {
    const root = parseScala(f.text).rootNode
    return checks.flatMap((check) => check(f.path, root)).sort((a, b) => lineOf(a) - lineOf(b) || (a.ruleId < b.ruleId ? -1 : 1))
  })
}

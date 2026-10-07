import { descendants, grammar, line, type Node, ofType, type Tree } from "@gauntlet/syntax"
import scalaWasm from "./assets/tree-sitter-scala.wasm" with { type: "file" }

// Scala syntax (2 and 3) via the shared tree-sitter runtime (ADR 0013).
// Test frameworks define tests as curried calls, `test("name") { ... }`
// (ScalaTest FunSuite, munit, ZIO Test, weaver), or as infix expressions,
// `"it" should "work" in { ... }` (ScalaTest's word styles).

export const parseScala = await grammar(scalaWasm)

export { descendants, line, ofType }
export type { Node }

export const nameOf = (def: Node) => def.childForFieldName("name")?.text ?? def.namedChildren.find((c) => c?.type === "identifier")?.text ?? ""

/** The identifier a call names: `assert` in `assert(x)`, `assertEquals` in `munit.Assertions.assertEquals(...)`. */
export const calleeName = (call: Node): string => {
  const fn = call.childForFieldName("function") ?? call.namedChild(0)
  if (!fn) return ""
  if (fn.type === "identifier") return fn.text
  if (fn.type === "field_expression") return fn.childForFieldName("field")?.text ?? fn.namedChild(fn.namedChildCount - 1)?.text ?? ""
  if (fn.type === "generic_function") return fn.namedChild(0)?.text ?? ""
  return ""
}

/** The full callee text: `sys.exit`, `TestAspect.flaky`. */
export const calleeText = (call: Node): string => (call.childForFieldName("function") ?? call.namedChild(0))?.text ?? ""

export const args = (call: Node): Node[] => (call.childForFieldName("arguments") ?? call.namedChildren.find((c) => c?.type === "arguments"))?.namedChildren.filter((n): n is Node => n !== null) ?? []

/** The operator of an infix expression: `in`, `shouldBe`, `@@`. */
export const operatorOf = (infix: Node) => infix.childForFieldName("operator")?.text ?? infix.namedChild(1)?.text ?? ""

const unquote = (s: string) => s.replace(/^"""|"""$/g, "").replace(/^s?"|"$/g, "")

/** The innermost definition enclosing a line, as `Object.method`. */
export const enclosingSymbol = (tree: Tree, lineNumber: number): string | undefined => {
  const names: string[] = []
  let node: Node | null = tree.rootNode
  while (node) {
    const next: Node | undefined = node.namedChildren.find((c) => c !== null && c.startPosition.row + 1 <= lineNumber && c.endPosition.row + 1 >= lineNumber) ?? undefined
    if (!next) break
    if (["class_definition", "object_definition", "trait_definition", "function_definition"].includes(next.type)) {
      const name = nameOf(next)
      if (name) names.push(name)
    }
    node = next
  }
  return names.length > 0 ? names.join(".") : undefined
}

/** Strips a `//` comment, leaving `//` inside strings alone. */
export const stripLineComment = (text: string): string => {
  let quote = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote) {
      if (ch === "\\") i++
      else if (ch === "\"") quote = false
      continue
    }
    if (ch === "\"") quote = true
    else if (ch === "/" && text[i + 1] === "/") return text.slice(0, i)
  }
  return text
}

export { unquote }

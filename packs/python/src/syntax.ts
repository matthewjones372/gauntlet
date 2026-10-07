import { descendants, grammar, line, type Node, ofType, type Tree } from "@gauntlet/syntax"
import pythonWasm from "./assets/tree-sitter-python.wasm" with { type: "file" }

// Python syntax via the shared tree-sitter runtime (ADR 0013).

export const parsePython = await grammar(pythonWasm)

export { descendants, line, ofType }
export type { Node }

/** The full callee text: `self.assertEqual`, `sys.exit`, `pytest.raises`. */
export const calleeText = (call: Node): string => call.childForFieldName("function")?.text ?? ""

/** The last name in the callee: `assertEqual` in `self.assertEqual(...)`. */
export const calleeName = (call: Node): string => {
  const fn = call.childForFieldName("function")
  if (!fn) return ""
  if (fn.type === "identifier") return fn.text
  if (fn.type === "attribute") return fn.childForFieldName("attribute")?.text ?? ""
  return ""
}

export const args = (call: Node): Node[] =>
  (call.childForFieldName("arguments")?.namedChildren ?? []).filter((n): n is Node => n !== null)

export const nameOf = (def: Node) => def.childForFieldName("name")?.text ?? ""

/** Decorator texts on a function or class, without the `@`: `pytest.mark.skip`, `given(st.integers())`. */
export const decorators = (def: Node): string[] =>
  def.parent?.type === "decorated_definition"
    ? def.parent.namedChildren.filter((c) => c?.type === "decorator").map((d) => d!.text.replace(/^@\s*/, ""))
    : []

/** The innermost class or function enclosing a line, as `Outer.inner`. */
export const enclosingSymbol = (tree: Tree, lineNumber: number): string | undefined => {
  const names: string[] = []
  let node: Node | null = tree.rootNode
  while (node) {
    const next: Node | undefined = node.namedChildren.find((c) => c !== null && c.startPosition.row + 1 <= lineNumber && c.endPosition.row + 1 >= lineNumber) ?? undefined
    if (!next) break
    if (next.type === "function_definition" || next.type === "class_definition") {
      const name = nameOf(next)
      if (name) names.push(name)
    }
    node = next
  }
  return names.length > 0 ? names.join(".") : undefined
}

/** Strips a `#` comment, leaving `#` inside strings alone. */
export const stripLineComment = (text: string): string => {
  let quote: string | undefined
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === "\\") {
      i++
      continue
    }
    if (quote) {
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === "\"" || ch === "'") quote = ch
    else if (ch === "#") return text.slice(0, i)
  }
  return text
}

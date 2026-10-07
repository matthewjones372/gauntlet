import { descendants, grammar, line, type Node, ofType, type Tree } from "@gauntlet/syntax"
import goWasm from "./assets/tree-sitter-go.wasm" with { type: "file" }

// Go syntax via the shared tree-sitter runtime (ADR 0013).

export const parseGo = await grammar(goWasm)

export { descendants, line, ofType }
export type { Node }

/** The full callee text: `t.Errorf`, `os.Exit`, `assert.Equal`. */
export const calleeText = (call: Node): string => call.childForFieldName("function")?.text ?? ""

/** The last name in the callee: `Errorf` in `t.Errorf(...)`. */
export const calleeName = (call: Node): string => {
  const fn = call.childForFieldName("function")
  if (!fn) return ""
  if (fn.type === "identifier") return fn.text
  if (fn.type === "selector_expression") return fn.childForFieldName("field")?.text ?? ""
  return ""
}

export const args = (call: Node): Node[] =>
  (call.childForFieldName("arguments")?.namedChildren ?? []).filter((n): n is Node => n !== null)

export const nameOf = (decl: Node) => decl.childForFieldName("name")?.text ?? ""

/** The receiver type of a method, without the pointer: `Money` for `func (m *Money) Add(...)`. */
export const receiverType = (method: Node): string =>
  (method.childForFieldName("receiver")?.text ?? "").replace(/^\(\s*(\w+\s+)?\*?/, "").replace(/[\s)[].*$/, "")

/** The package a file declares. */
export const packageName = (root: Node): string =>
  ofType(root, "package_clause")[0]?.namedChildren.find((c) => c?.type === "package_identifier")?.text ?? ""

/** Import paths a file declares. */
export const importPaths = (root: Node): { readonly path: string; readonly line: number }[] =>
  ofType(root, "import_spec").flatMap((s) => {
    const p = s.childForFieldName("path") ?? s.namedChildren.find((c) => c?.type === "interpreted_string_literal" || c?.type === "raw_string_literal") ?? null
    return p ? [{ path: p.text.replace(/^["`]|["`]$/g, ""), line: line(s) }] : []
  })

/** The innermost function or method enclosing a line, as `Type.Method` or `Func`. */
export const enclosingSymbol = (tree: Tree, lineNumber: number): string | undefined => {
  for (const n of descendants(tree.rootNode)) {
    if ((n.type === "function_declaration" || n.type === "method_declaration") && n.startPosition.row + 1 <= lineNumber && n.endPosition.row + 1 >= lineNumber) {
      return n.type === "method_declaration" ? `${receiverType(n)}.${nameOf(n)}` : nameOf(n)
    }
  }
  return undefined
}

/** Strips a `//` comment, leaving `//` inside strings and runes alone. */
export const stripLineComment = (text: string): string => {
  let quote: string | undefined
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote) {
      if (ch === "\\" && quote !== "`") {
        i++
        continue
      }
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === "\"" || ch === "'" || ch === "`") quote = ch
    else if (ch === "/" && text[i + 1] === "/") return text.slice(0, i)
  }
  return text
}

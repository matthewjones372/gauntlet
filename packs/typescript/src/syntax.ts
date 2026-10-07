import { descendants, grammar, line, type Node, ofType, type Tree } from "@gauntlet/syntax"
import tsxWasm from "./assets/tree-sitter-tsx.wasm" with { type: "file" }
import typescriptWasm from "./assets/tree-sitter-typescript.wasm" with { type: "file" }

// TypeScript and TSX syntax via the shared tree-sitter runtime (ADR 0013).
// Plain JavaScript parses with the TypeScript grammar, a superset.

const parseTypeScript = await grammar(typescriptWasm)
const parseTsx = await grammar(tsxWasm)

export const parseTs = (path: string, text: string): Tree => (/\.(tsx|jsx)$/.test(path) ? parseTsx(text) : parseTypeScript(text))

export { descendants, line, ofType }
export type { Node }

/** The full callee text: `it.skip`, `expect(x).toBe`, `process.exit`. */
export const calleeText = (call: Node): string => call.childForFieldName("function")?.text ?? call.namedChild(0)?.text ?? ""

/** The last name in the callee: `skip` in `it.skip(...)`, `toBe` in `expect(x).toBe(...)`. */
export const calleeName = (call: Node): string => {
  const fn = call.childForFieldName("function") ?? call.namedChild(0)
  if (!fn) return ""
  if (fn.type === "identifier") return fn.text
  if (fn.type === "member_expression") return fn.childForFieldName("property")?.text ?? ""
  return ""
}

/** The arguments of a call, as nodes. */
export const args = (call: Node): Node[] => (call.childForFieldName("arguments")?.namedChildren ?? []).filter((n): n is Node => n !== null)

const NAMED: Record<string, string> = {
  function_declaration: "name",
  generator_function_declaration: "name",
  class_declaration: "name",
  abstract_class_declaration: "name",
  method_definition: "name",
  interface_declaration: "name",
}

/** The innermost class, function or method enclosing a line, as `Outer.inner`. */
export const enclosingSymbol = (tree: Tree, lineNumber: number): string | undefined => {
  const names: string[] = []
  let node: Node | null = tree.rootNode
  while (node) {
    const next: Node | undefined = node.namedChildren.find((c) => c !== null && c.startPosition.row + 1 <= lineNumber && c.endPosition.row + 1 >= lineNumber) ?? undefined
    if (!next) break
    const field = NAMED[next.type]
    if (field) {
      const name = next.childForFieldName(field)?.text
      if (name) names.push(name)
    } else if (next.type === "variable_declarator" && ["arrow_function", "function_expression"].includes(next.childForFieldName("value")?.type ?? "")) {
      const name = next.childForFieldName("name")?.text
      if (name) names.push(name)
    }
    node = next
  }
  return names.length > 0 ? names.join(".") : undefined
}

/** Strips a `//` comment from a line, leaving `//` inside strings and templates alone. */
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
    if (ch === "\"" || ch === "'" || ch === "`") quote = ch
    else if (ch === "/" && text[i + 1] === "/") return text.slice(0, i)
  }
  return text
}

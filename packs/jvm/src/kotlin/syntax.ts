import { descendants, grammar, line, type Node, ofType, type Tree } from "@gauntlet/syntax"
import kotlinWasm from "../assets/tree-sitter-kotlin.wasm" with { type: "file" }

// Kotlin syntax via the shared tree-sitter runtime and the vendored grammar
// (ADR 0013). Loaded once when the pack is imported, so the fingerprint
// symbol locator can stay synchronous.

export const parseKotlin = await grammar(kotlinWasm)

export { descendants, line, ofType }
export type { Node }

/** The name a call is made to: `assertEquals` in `assertEquals(a, b)` and `kotlin.test.assertEquals(a, b)`. */
export const calleeName = (call: Node): string | undefined => {
  const head = call.namedChild(0)
  if (!head) return undefined
  if (head.type === "identifier") return head.text
  if (head.type === "navigation_expression") {
    const last = head.namedChild(head.namedChildCount - 1)
    return last?.text
  }
  return undefined
}

/** The full callee text, such as `System.getenv`. */
export const calleeText = (call: Node): string => call.namedChild(0)?.text ?? ""

/** Annotation names on a declaration's modifiers: `Test`, `Disabled`, `Tag`. */
export const annotations = (decl: Node): { name: string; node: Node; args: string }[] =>
  ofType(decl.childForFieldName("modifiers") ?? decl.namedChildren.find((c) => c?.type === "modifiers") ?? decl, "annotation")
    .filter((a) => a.parent?.parent === decl || a.parent?.type === "modifiers")
    .map((a) => {
      const type = ofType(a, "user_type")[0]
      const args = ofType(a, "value_arguments")[0]?.text ?? ""
      return { name: type?.text.split(".").pop() ?? "", node: a, args }
    })

const DECLARATIONS = ["function_declaration", "class_declaration", "object_declaration"]

const nameOf = (decl: Node) => decl.namedChildren.find((c) => c?.type === "identifier")?.text

/** The innermost class or function enclosing a line, as `Outer.inner`. */
export const enclosingSymbol = (tree: Tree, lineNumber: number): string | undefined => {
  const names: string[] = []
  let node: Node | null = tree.rootNode
  while (node) {
    const next: Node | undefined = node.namedChildren.find((c) => c !== null && c.startPosition.row + 1 <= lineNumber && c.endPosition.row + 1 >= lineNumber) ?? undefined
    if (!next) break
    if (DECLARATIONS.includes(next.type)) {
      const name = nameOf(next)
      if (name) names.push(name)
    }
    node = next
  }
  return names.length > 0 ? names.join(".") : undefined
}

/** Strips a `//` comment from a line, leaving `//` inside string literals alone. */
export const stripLineComment = (text: string): string => {
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === "\\") {
      i++
      continue
    }
    if (ch === "\"") inString = !inString
    if (!inString && ch === "/" && text[i + 1] === "/") return text.slice(0, i)
  }
  return text
}

export const isKotlin = (path: string) => path.endsWith(".kt") || path.endsWith(".kts")

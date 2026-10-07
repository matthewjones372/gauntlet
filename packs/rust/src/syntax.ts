import { descendants, grammar, line, type Node, ofType, type Tree } from "@gauntlet/syntax"
import rustWasm from "./assets/tree-sitter-rust.wasm" with { type: "file" }

// Rust syntax via the shared tree-sitter runtime (ADR 0013). Attributes are
// sibling nodes before the item they annotate, and code inside macros
// (proptest!, assert!) is a token tree, so some checks read token text.

export const parseRust = await grammar(rustWasm)

export { descendants, line, ofType }
export type { Node }

export const nameOf = (item: Node) => item.childForFieldName("name")?.text ?? ""

/** The attributes on an item, as text without `#[` and `]`: `test`, `ignore = "flaky"`, `cfg(test)`. */
export const attributesOf = (item: Node): string[] => {
  const out: string[] = []
  for (let p = item.previousNamedSibling; p && (p.type === "attribute_item" || p.type === "line_comment" || p.type === "block_comment"); p = p.previousNamedSibling) {
    if (p.type === "attribute_item") out.unshift(p.namedChild(0)?.text ?? "")
  }
  return out
}

/** The macro a macro invocation calls: `assert_eq` for `assert_eq!(...)`. */
export const macroName = (m: Node) => m.childForFieldName("macro")?.text ?? m.namedChild(0)?.text ?? ""

/** The full callee text of a call: `std::process::exit`, or `x.unwrap` for method calls. */
export const calleeText = (call: Node): string => call.childForFieldName("function")?.text ?? ""

/** The method a call invokes, for `x.unwrap()`: `unwrap`. */
export const methodName = (call: Node): string => {
  const fn = call.childForFieldName("function")
  return fn?.type === "field_expression" ? fn.childForFieldName("field")?.text ?? "" : ""
}

/** Whether a node sits inside an item annotated `#[cfg(test)]` (a test module). */
export const inTestModule = (n: Node): boolean => {
  for (let p: Node | null = n.parent; p; p = p.parent) {
    if (p.type === "mod_item" || p.type === "function_item" || p.type === "impl_item") {
      if (attributesOf(p).some((a) => /^cfg\(\s*test\s*\)$/.test(a.replace(/\s/g, "")))) return true
    }
  }
  return false
}

/** The innermost function enclosing a line, with its impl type: `Money::add`. */
export const enclosingSymbol = (tree: Tree, lineNumber: number): string | undefined => {
  let found: Node | undefined
  for (const n of descendants(tree.rootNode)) {
    if (n.type === "function_item" && n.startPosition.row + 1 <= lineNumber && n.endPosition.row + 1 >= lineNumber) found = n
  }
  if (!found) return undefined
  let impl: Node | null = found.parent
  while (impl && impl.type !== "impl_item") impl = impl.parent
  const type = impl?.childForFieldName("type")?.text
  return type ? `${type}::${nameOf(found)}` : nameOf(found)
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

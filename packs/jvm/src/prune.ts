import type { CodeSurveyor, Declared } from "@gauntlet/core"
import { isKotlin, line, type Node, parseKotlin } from "./kotlin/syntax.ts"
import { isMainSource } from "./sources.ts"
import { COPIED_INTO_CALLERS } from "./test-map.ts"

// The JVM pack's reading of main source for `gauntlet prune code` (spec 0017
// §5). Kotlin is read with the pack's tree-sitter grammar, declaration by
// declaration; Java has no grammar here, so a Java file is judged whole, by
// its class name.

/** Annotations of the languages themselves; any other may be how a framework finds the code (Spring, JAX-RS, Micronaut, Ktor plugins). */
const LANGUAGE_ANNOTATIONS = new Set([
  "Suppress", "JvmStatic", "JvmOverloads", "JvmName", "JvmField", "JvmInline", "Throws", "Deprecated", "Volatile", "Synchronized",
  "Transient", "OptIn", "PublishedApi", "Override", "SuppressWarnings", "FunctionalInterface", "SafeVarargs",
])

/** Why something outside the code may reach the file, or undefined. */
const entryPoint = (text: string): string | undefined => {
  if (/\bfun\s+main\s*\(|\bstatic\s+(?:public\s+)?void\s+main\s*\(/.test(text)) return "it has a main function"
  for (const m of text.matchAll(/@(?!file:)([A-Z]\w*)/g)) if (!LANGUAGE_ANNOTATIONS.has(m[1]!)) return `it's annotated @${m[1]}, which a framework may use to reach it`
  return undefined
}

const modifiers = (d: Node) => d.namedChildren.find((c) => c?.type === "modifiers")
const hidden = (d: Node) => modifiers(d)?.namedChildren.some((c) => (c?.type === "visibility_modifier" && c.text === "private") || (c?.type === "member_modifier" && c.text === "override")) ?? false
const nameOf = (d: Node) =>
  d.type === "property_declaration"
    ? d.namedChildren.find((c) => c?.type === "variable_declaration")?.namedChildren.find((c) => c?.type === "identifier")?.text
    : d.namedChildren.find((c) => c?.type === "identifier")?.text

const KINDS: Record<string, string> = { function_declaration: "function", property_declaration: "property", object_declaration: "object", class_declaration: "class" }

const kindOf = (d: Node) => (d.type === "class_declaration" && d.children.some((c) => c?.type === "interface") ? "interface" : KINDS[d.type]!)

/** Members of a class or object body, and of its companion object, as `Owner.member`. */
const members = (body: Node | undefined, owner: string): Declared[] =>
  (body?.namedChildren ?? []).flatMap((m) => {
    if (!m) return []
    if (m.type === "companion_object") return members(m.namedChildren.find((c) => c?.type === "class_body"), owner)
    if ((m.type !== "function_declaration" && m.type !== "property_declaration") || hidden(m)) return []
    const name = nameOf(m)
    return name ? [{ name, line: line(m), kind: m.type === "function_declaration" ? "method" : "property", in: owner }] : []
  })

const kotlinDeclared = (root: Node): Declared[] =>
  root.namedChildren.flatMap((d) => {
    if (!d || !(d.type in KINDS) || hidden(d)) return []
    const name = nameOf(d)
    if (!name) return []
    return [{ name, line: line(d), kind: kindOf(d) }, ...members(d.namedChildren.find((c) => c?.type === "class_body"), name)]
  })

export const jvmCode: CodeSurveyor = {
  reads: isMainSource,
  survey: (path, text) => {
    // The map leaves these out: their code runs inside their callers.
    if (COPIED_INTO_CALLERS.test(text)) return { declared: [], leftOut: "the compiler copies its inline functions or constants into callers, so the map can't see it run" }
    const entry = entryPoint(text)
    if (entry !== undefined) return { declared: [], leftOut: entry }
    if (!isKotlin(path)) return { declared: [] }
    const root = parseKotlin(text).rootNode
    if (root.hasError) return { declared: [], leftOut: "it couldn't be parsed" }
    return { declared: kotlinDeclared(root) }
  },
}

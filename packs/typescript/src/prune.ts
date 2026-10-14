import type { CodeSurveyor, Declared } from "@gauntlet/core"
import { line, type Node, parseTs } from "./syntax.ts"
import { isMainSource } from "./toolchain.ts"

// The TypeScript pack's reading of main source for `gauntlet prune code`
// (spec 0017 §5): what each file exports, and whether something outside the
// project's code may load it, so it's never listed.

/** Names that usually start a program or a package, and folders whose files frameworks load by convention. */
const ENTRY_NAME = /^(main|index|cli|server|app|worker|bin|setup|instrumentation|middleware)$/
const ENTRY_FOLDER = /(^|\/)(bin|scripts|pages|app|routes|api|public|migrations|seeds|\.storybook)\//
const ENTRY_FILE = /(^|\/)(\+[^/]+|[^/]+\.(config|stories|story|setup)\.[^/]+|(page|layout|route|loading|error|not-found|template|default)\.[jt]sx?)$/

const stem = (path: string) => path.split("/").pop()!.replace(/\.[^.]+$/, "")

/** Why something outside the code may load the file, or undefined. */
const entryPoint = (path: string, text: string, root: Node): string | undefined => {
  if (text.startsWith("#!")) return "it starts with a #! line, so it's run as a program"
  if (ENTRY_NAME.test(stem(path))) return "its name is an entry point's"
  if (ENTRY_FOLDER.test(path) || ENTRY_FILE.test(path)) return "a framework or tool may load it by its path"
  for (const n of root.namedChildren) {
    if (!n) continue
    if (n.type === "export_statement" && n.children.some((c) => c?.type === "default")) return "it has a default export, which a framework may load"
    if (n.type === "expression_statement" && n.namedChild(0)?.type !== "string") return "it runs code when it's loaded"
  }
  return undefined
}

const PRIVATE = /^(private|protected)$/

const classMembers = (cls: Node, owner: string): Declared[] =>
  (cls.childForFieldName("body")?.namedChildren ?? []).flatMap((m) => {
    if (!m || m.type !== "method_definition") return []
    const name = m.childForFieldName("name")
    if (!name || name.type !== "property_identifier" || name.text === "constructor") return []
    if (m.namedChildren.some((c) => c?.type === "accessibility_modifier" && PRIVATE.test(c.text))) return []
    return [{ name: name.text, line: line(m), kind: "method", in: owner }]
  })

const declaration = (d: Node): Declared[] => {
  switch (d.type) {
    case "function_declaration":
    case "generator_function_declaration": {
      const name = d.childForFieldName("name")?.text
      return name ? [{ name, line: line(d), kind: "function" }] : []
    }
    case "class_declaration":
    case "abstract_class_declaration": {
      const name = d.childForFieldName("name")?.text
      return name ? [{ name, line: line(d), kind: "class" }, ...classMembers(d, name)] : []
    }
    case "lexical_declaration":
    case "variable_declaration":
      return d.namedChildren.flatMap((v) => {
        const name = v?.type === "variable_declarator" ? v.childForFieldName("name") : undefined
        if (!v || !name || name.type !== "identifier") return []
        const value = v.childForFieldName("value")?.type ?? ""
        return [{ name: name.text, line: line(v), kind: ["arrow_function", "function_expression", "function"].includes(value) ? "function" : "constant" }]
      })
    case "interface_declaration":
    case "type_alias_declaration":
    case "enum_declaration": {
      const name = d.childForFieldName("name")?.text
      return name ? [{ name, line: line(d), kind: d.type === "enum_declaration" ? "enum" : "type" }] : []
    }
    default:
      return []
  }
}

/** What a file exports: declarations, and names in `export { ... }`. */
const exported = (root: Node): Declared[] =>
  root.namedChildren.flatMap((n) => {
    if (!n || n.type !== "export_statement") return []
    const decl = n.childForFieldName("declaration")
    if (decl) return declaration(decl)
    const clause = n.namedChildren.find((c) => c?.type === "export_clause")
    // `export * from` and `export { x } from` re-export another file's names: that file declares them.
    if (!clause || n.childForFieldName("source")) return []
    return clause.namedChildren.flatMap((s) => {
      const name = s?.childForFieldName("alias")?.text ?? s?.childForFieldName("name")?.text
      return s && name ? [{ name, line: line(s), kind: "export" }] : []
    })
  })

export const typescriptCode: CodeSurveyor = {
  reads: isMainSource,
  survey: (path, text) => {
    const root = parseTs(path, text).rootNode
    const entry = entryPoint(path, text, root)
    if (entry !== undefined) return { declared: [], leftOut: entry }
    if (root.hasError) return { declared: [], leftOut: "it couldn't be parsed" }
    return { declared: exported(root) }
  },
}

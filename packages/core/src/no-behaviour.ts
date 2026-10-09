// A change that can't alter what the code does: only comments in source files,
// or only documentation. Gauntlet then runs no build, tests, coverage or
// mutation (ADR 0023): there's nothing for them to find. It's deliberately
// narrow. A comment that tools read (a suppression, a type-check or lint
// directive, a build tag) counts as code, and so does any language or file
// this doesn't know.

/** Files that are documentation, never built or run. Plain text isn't one: it can be a fixture or data. */
const DOCS = /(\.(md|markdown|rst|adoc)$)|((^|\/)(LICENSE|NOTICE|AUTHORS|CHANGELOG)(\.(md|txt))?$)/i

type Syntax = { readonly line: ReadonlyArray<string>; readonly block: boolean; readonly nested: boolean; readonly strings: ReadonlyArray<string> }

const C_LIKE: Syntax = { line: ["//"], block: true, nested: false, strings: ['"""', '"', "'", "`"] }
const NESTED: Syntax = { ...C_LIKE, nested: true }
const SYNTAX: ReadonlyArray<[RegExp, Syntax]> = [
  [/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|java|go)$/, C_LIKE],
  [/\.(kt|kts|scala|sc|rs)$/, NESTED],
  [/\.py$/, { line: ["#"], block: false, nested: false, strings: ['"""', "'''", '"', "'"] }],
  [/\.(clj|cljc|cljs|edn)$/, { line: [";"], block: false, nested: false, strings: ['"'] }],
]

/** Comments tools act on: suppressions, type and lint directives, build tags, coverage and formatter switches. */
const DIRECTIVE = /@ts-|eslint|biome-ignore|prettier-ignore|istanbul|c8 ignore|v8 ignore|noinspection|nolint|go:|\+build|scalafix|scalastyle|scalafmt|detekt|ktlint|nosonar|noqa|type:\s*ignore|pylint|pyright|mypy|fmt:|clippy|rustfmt|coverage|pragma|suppress|lint|#!/i

/**
 * The source with its comments removed and whitespace collapsed, or undefined
 * when the language is unknown or a comment is one tools act on.
 */
export const withoutComments = (path: string, text: string): string | undefined => {
  const syntax = SYNTAX.find(([re]) => re.test(path))?.[1]
  if (!syntax) return undefined
  let out = ""
  let i = 0
  while (i < text.length) {
    const quote = syntax.strings.find((q) => text.startsWith(q, i))
    if (quote) {
      // A string, escapes included, kept as it is.
      let j = i + quote.length
      while (j < text.length && !text.startsWith(quote, j)) j += text[j] === "\\" && quote.length === 1 ? 2 : 1
      out += text.slice(i, j + quote.length)
      i = j + quote.length
      continue
    }
    // A comment starts after a space, a line start or punctuation, never inside something like a regex literal.
    const starts = i === 0 || /[\s;,{}()[\]=]/.test(text[i - 1]!)
    const line = starts ? syntax.line.find((l) => text.startsWith(l, i)) : undefined
    if (line) {
      const end = text.indexOf("\n", i)
      const comment = text.slice(i, end < 0 ? text.length : end)
      if (DIRECTIVE.test(comment)) return undefined
      out += " "
      i = end < 0 ? text.length : end
      continue
    }
    if (syntax.block && starts && text.startsWith("/*", i)) {
      let depth = 1
      let j = i + 2
      while (j < text.length && depth > 0) {
        if (syntax.nested && text.startsWith("/*", j)) {
          depth++
          j += 2
        } else if (text.startsWith("*/", j)) {
          depth--
          j += 2
        } else j++
      }
      if (DIRECTIVE.test(text.slice(i, j))) return undefined
      out += " "
      i = j
      continue
    }
    out += text[i]
    i++
  }
  return out.replace(/\s+/g, " ").trim()
}

interface ChangedSource {
  readonly path: string
  readonly status: "added" | "modified" | "deleted" | "renamed" | "copied" | string
}

/**
 * Whether a change only edits comments or documentation. Added, deleted and
 * renamed source files always count as code.
 */
export const behaviourUnchanged = async (
  files: ReadonlyArray<ChangedSource>,
  read: (side: "base" | "head", path: string) => Promise<string | undefined>,
): Promise<boolean> => {
  if (files.length === 0) return false
  for (const f of files) {
    if (DOCS.test(f.path)) continue
    if (f.status !== "modified") return false
    const [before, after] = await Promise.all([read("base", f.path), read("head", f.path)])
    if (before === undefined || after === undefined) return false
    const a = withoutComments(f.path, before)
    const b = withoutComments(f.path, after)
    if (a === undefined || b === undefined || a !== b) return false
  }
  return true
}

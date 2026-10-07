// A reader for Clojure source: enough of the Clojure reader to find forms,
// their positions and their metadata, without evaluating anything. Clojure's
// syntax is s-expressions, so this replaces a tree-sitter grammar (ADR 0018).

export type FormType = "list" | "vector" | "map" | "set" | "fn" | "symbol" | "keyword" | "string" | "regex" | "number" | "char" | "other"

export interface Form {
  readonly type: FormType
  /** Symbols, keywords and numbers as written; strings without quotes. */
  readonly text: string
  readonly children: ReadonlyArray<Form>
  /** Metadata attached with ^: `^:kaocha/skip` gives [":kaocha/skip"], `^{:a 1}` gives the map's text. */
  readonly meta: ReadonlyArray<string>
  /** A form discarded with #_ (kept, so suppressions written as #_{:clj-kondo/ignore ...} are visible). */
  readonly discarded: boolean
  /** Wrapped in ', `, ~, ~@, @ or #' (the wrapper is in `prefix`). */
  readonly prefix: string
  readonly start: number
  readonly end: number
  readonly line: number
  readonly endLine: number
}

const CLOSE: Record<string, string> = { "(": ")", "[": "]", "{": "}" }
const DELIMITER = /[\s,()[\]{}"';`^@~\\]/

/** Reads every top-level form. Unbalanced input reads as far as it can; it never throws. */
export const read = (text: string): Form[] => {
  let i = 0
  const lineStarts: number[] = [0]
  for (let k = 0; k < text.length; k++) if (text[k] === "\n") lineStarts.push(k + 1)
  const lineAt = (pos: number) => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid]! <= pos) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }

  const skipSpace = () => {
    while (i < text.length) {
      const c = text[i]!
      if (c === ";") while (i < text.length && text[i] !== "\n") i++
      else if (/[\s,]/.test(c)) i++
      else break
    }
  }

  const make = (type: FormType, start: number, value: string, children: Form[] = []): Form => ({
    type, text: value, children, meta: [], discarded: false, prefix: "", start, end: i, line: lineAt(start), endLine: lineAt(Math.max(start, i - 1)),
  })

  const readSeq = (close: string, start: number, type: FormType, open: number): Form => {
    const children: Form[] = []
    i = open
    for (;;) {
      skipSpace()
      if (i >= text.length) break
      if (text[i] === close) {
        i++
        break
      }
      if (/[)\]}]/.test(text[i]!)) {
        // A stray closer: stop this sequence without consuming it.
        break
      }
      const f = readForm()
      if (f) children.push(f)
    }
    return make(type, start, text.slice(start, i), children)
  }

  const readString = (start: number, type: FormType): Form => {
    let k = i + 1
    while (k < text.length && text[k] !== "\"") k += text[k] === "\\" ? 2 : 1
    const value = text.slice(i + 1, k)
    i = Math.min(text.length, k + 1)
    return make(type, start, value)
  }

  const readToken = (start: number): Form => {
    let k = i
    while (k < text.length && !DELIMITER.test(text[k]!)) k++
    if (k === i) k++
    const token = text.slice(i, k)
    i = k
    const type: FormType = token.startsWith(":") ? "keyword" : /^[+-]?\d/.test(token) ? "number" : "symbol"
    return make(type, start, token)
  }

  const readForm = (): Form | undefined => {
    skipSpace()
    if (i >= text.length) return undefined
    const start = i
    const c = text[i]!
    if (c === "(" || c === "[" || c === "{") return readSeq(CLOSE[c]!, start, c === "(" ? "list" : c === "[" ? "vector" : "map", i + 1)
    if (c === "\"") return readString(start, "string")
    if (c === "\\") {
      let k = i + 2
      while (k < text.length && /[a-zA-Z0-9]/.test(text[k]!) && /[a-zA-Z]/.test(text[i + 1] ?? "")) k++
      i = Math.min(text.length, k)
      return make("char", start, text.slice(start, i))
    }
    if (c === "^") {
      i++
      const m = readForm()
      const target = readForm()
      if (!target) return m
      const tag = m ? (m.type === "map" ? m.text : m.type === "keyword" ? m.text : `:tag ${m.text}`) : ""
      return { ...target, meta: [tag, ...target.meta], start, line: lineAt(start) }
    }
    if (c === "'" || c === "`" || c === "@" || c === "~") {
      const prefix = c === "~" && text[i + 1] === "@" ? "~@" : c
      i += prefix.length
      const target = readForm()
      return target ? { ...target, prefix: prefix + target.prefix, start, line: lineAt(start) } : undefined
    }
    if (c === "#") {
      const n = text[i + 1]
      if (n === "(") return readSeq(")", start, "fn", i + 2)
      if (n === "{") return readSeq("}", start, "set", i + 2)
      if (n === "\"") {
        i++
        return readString(start, "regex")
      }
      if (n === "_") {
        i += 2
        const target = readForm()
        return target ? { ...target, discarded: true, start, line: lineAt(start) } : undefined
      }
      if (n === "'") {
        i += 2
        const target = readForm()
        return target ? { ...target, prefix: "#'", start, line: lineAt(start) } : undefined
      }
      if (n === "?") {
        // Reader conditionals: #?(:clj a :cljs b) and #?@(...) read as their list.
        i += text[i + 2] === "@" ? 3 : 2
        return readForm()
      }
      if (n === ":") {
        // Namespaced maps: #:ns{...}.
        i += 2
        readToken(i)
        return readForm()
      }
      // Tagged literals (#inst "...", #uuid "...") and ##Inf: the tag, then its form.
      i++
      const tag = readToken(start)
      if (tag.text.startsWith("#")) return tag
      const value = readForm()
      return value ?? tag
    }
    return readToken(start)
  }

  const forms: Form[] = []
  while (i < text.length) {
    skipSpace()
    if (i >= text.length) break
    if (/[)\]}]/.test(text[i]!)) {
      i++
      continue
    }
    const f = readForm()
    if (f) forms.push(f)
  }
  return forms
}

/** Every form, depth first, discarded ones included. */
export const walk = function*(forms: ReadonlyArray<Form>): Generator<Form> {
  for (const f of forms) {
    yield f
    yield* walk(f.children)
  }
}

/** Live forms only: what the compiler sees (no #_ forms, nothing inside `(comment ...)`). */
export const live = function*(forms: ReadonlyArray<Form>): Generator<Form> {
  for (const f of forms) {
    if (f.discarded || (f.type === "list" && head(f) === "comment")) continue
    yield f
    yield* live(f.children)
  }
}

/** The symbol a list starts with: `defn` for `(defn f [] ...)`. */
export const head = (f: Form): string => (f.type === "list" && f.children[0]?.type === "symbol" ? f.children[0].text : "")

/** The unqualified name a head refers to: `is` for `t/is` or `clojure.test/is`. */
export const local = (symbol: string): string => symbol.replace(/^.*\//, "")

export const calls = (forms: ReadonlyArray<Form>, names: RegExp): Form[] => [...live(forms)].filter((f) => names.test(local(head(f))) && f.prefix === "")

/** The namespace a file declares, and the libraries its ns form requires. */
export const nsOf = (forms: ReadonlyArray<Form>): { name: string; requires: { lib: string; line: number }[]; line: number } | undefined => {
  const ns = forms.find((f) => head(f) === "ns" && !f.discarded)
  if (!ns) return undefined
  const name = ns.children[1]?.text ?? ""
  const requires: { lib: string; line: number }[] = []
  for (const clause of ns.children.slice(2)) {
    if (clause.type !== "list" || !/^:(require|use|require-macros)$/.test(clause.children[0]?.text ?? "")) continue
    for (const spec of clause.children.slice(1)) {
      if (spec.type === "symbol") {
        requires.push({ lib: spec.text, line: spec.line })
        continue
      }
      if (spec.type !== "vector" && spec.type !== "list") continue
      const [first, ...rest] = spec.children
      if (first?.type !== "symbol") continue
      // A prefix list, (:require [clojure [set :as s] string]), has no options of its own.
      const prefixList = rest.length > 0 && rest.every((c) => c.type === "vector" || c.type === "symbol")
      if (!prefixList) {
        requires.push({ lib: first.text, line: spec.line })
        continue
      }
      for (const n of rest) {
        const lib = n.type === "vector" ? n.children[0]?.text : n.text
        if (lib) requires.push({ lib: `${first.text}.${lib}`, line: n.line })
      }
    }
  }
  return { name, requires, line: ns.line }
}

/** The top-level definition enclosing a line: `money/add` for a line inside `(defn add ...)`. */
export const enclosingSymbol = (forms: ReadonlyArray<Form>, lineNo: number): string | undefined => {
  const ns = nsOf(forms)?.name
  const def = forms.find((f) => f.line <= lineNo && lineNo <= f.endLine && /^def/.test(head(f)) && f.children[1]?.type === "symbol")
  if (!def) return undefined
  return ns ? `${ns}/${def.children[1]!.text}` : def.children[1]!.text
}

/** A line without its trailing comment, for fingerprints that survive comment edits. */
export const stripLineComment = (l: string): string => {
  let inString = false
  for (let k = 0; k < l.length; k++) {
    const c = l[k]
    if (c === "\\") {
      k++
      continue
    }
    if (c === "\"") inString = !inString
    else if (c === ";" && !inString) return l.slice(0, k).trimEnd()
  }
  return l.trimEnd()
}

/** Aliases the ns form gives required libraries: `[svc.domain.money :as m]` maps m to svc.domain.money. */
export const aliasesOf = (forms: ReadonlyArray<Form>): Map<string, string> => {
  const out = new Map<string, string>()
  const ns = forms.find((f) => head(f) === "ns" && !f.discarded)
  for (const clause of ns?.children.slice(2) ?? []) {
    if (clause.type !== "list" || clause.children[0]?.text !== ":require") continue
    for (const spec of clause.children.slice(1)) {
      if (spec.type !== "vector") continue
      const as = spec.children.findIndex((c) => c.text === ":as")
      if (as > 0 && spec.children[0]?.type === "symbol" && spec.children[as + 1]) out.set(spec.children[as + 1]!.text, spec.children[0].text)
    }
  }
  return out
}

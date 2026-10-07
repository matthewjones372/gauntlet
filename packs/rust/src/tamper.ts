import type { FileEdit, TamperContext, Tampering } from "@gauntlet/core"
import { Effect, Option } from "effect"
import { testFunctions } from "./detectors.ts"
import { line, macroName, nameOf, type Node, ofType, parseRust } from "./syntax.ts"
import { isMainSource, isRust, isTestFile } from "./toolchain.ts"

// Tamper fixtures for `gauntlet selftest`, built from the project's own files.

const without = (text: string, from: number, to: number) => text.split("\n").filter((_, i) => i + 1 < from || i + 1 > to).join("\n")
const lineEnd = (n: Node) => n.endPosition.row + 1
const indentOf = (text: string, at: number) => /^\s*/.exec(text.split("\n")[at - 1] ?? "")?.[0] ?? ""
const firstAttributeLine = (fn: Node) => {
  let first = line(fn)
  for (let p = fn.previousNamedSibling; p && p.type === "attribute_item"; p = p.previousNamedSibling) first = line(p)
  return first
}
const LITERAL = /^(-?\d[\d_]*|true|false|"[^"]*")$/

export const tamper = (ctx: TamperContext) =>
  Effect.gen(function*() {
    const out: Tampering[] = []
    const edit = (fixture: string, description: string, edits: ReadonlyArray<FileEdit>) => out.push({ fixture, description, edits })
    const readAll = (paths: ReadonlyArray<string>) =>
      Effect.forEach(paths, (p) => ctx.read(p).pipe(Effect.map((t) => Option.map(t, (text) => ({ path: p, text }))))).pipe(Effect.map((xs) => xs.flatMap(Option.toArray)))

    // Integration tests first: whole files of tests, protected as tests.
    const rust = ctx.files.filter(isRust).sort((a, b) => Number(isTestFile(b)) - Number(isTestFile(a)) || (a < b ? -1 : 1))
    const sources = yield* readAll(rust.slice(0, 80))
    const tests = sources.flatMap((f) => testFunctions(parseRust(f.text).rootNode).filter((t) => !t.attributes.some((a) => /^ignore/.test(a))).map((t) => ({ ...t, file: f })))
    const mains = sources.filter((f) => isMainSource(f.path))

    const first = tests[0]
    if (first) {
      edit("deleted-test", `the change deletes ${first.name}`, [{ path: first.file.path, content: without(first.file.text, firstAttributeLine(first.node), lineEnd(first.node)) }])
      const lines = first.file.text.split("\n")
      lines.splice(line(first.node) - 1, 0, `${indentOf(first.file.text, line(first.node))}#[ignore]`)
      edit("added-skip", `the change ignores ${first.name}`, [{ path: first.file.path, content: lines.join("\n") }])
    }
    const asserted = tests.find((t) => ofType(t.node, "macro_invocation").some((m) => /^assert/.test(macroName(m))))
    if (asserted) {
      const m = ofType(asserted.node, "macro_invocation").find((m) => /^assert/.test(macroName(m)))!
      edit("weakened-assertion", `the change removes an assertion from ${asserted.name}`, [{ path: asserted.file.path, content: without(asserted.file.text, line(m), lineEnd(m)) }])
    }

    const main = mains.find((m) => ofType(parseRust(m.text).rootNode, "function_item").length > 0)
    if (main) {
      const fn = ofType(parseRust(main.text).rootNode, "function_item")[0]!
      const lines = main.text.split("\n")
      lines.splice(firstAttributeLine(fn) - 1, 0, `${indentOf(main.text, line(fn))}#[allow(dead_code)]`)
      edit("added-suppression", `the change adds #[allow(dead_code)] to ${main.path}`, [{ path: main.path, content: lines.join("\n") }])
      edit("test-id-in-main", `the change makes ${main.path} behave differently under test`, [{ path: main.path, content: `${main.text}\npub fn gauntlet_selftest_probe() -> bool {\n    cfg!(test)\n}\n` }])
    }

    // Hardcode what a test expects: `assert_eq!(f(...), <literal>)` makes f return the literal.
    for (const t of tests) {
      const expectation = ofType(t.node, "macro_invocation").flatMap((m) => {
        if (macroName(m) !== "assert_eq") return []
        const inner = (m.namedChildren.find((c) => c?.type === "token_tree")?.text ?? "").slice(1, -1)
        const parts = splitTop(inner).map((p) => p.trim())
        const [call, literal] = parts.length >= 2 && LITERAL.test(parts[1]!) ? [parts[0]!, parts[1]!] : parts.length >= 2 && LITERAL.test(parts[0]!) ? [parts[1]!, parts[0]!] : []
        const fn = call ? /(\w+)\s*\(/.exec(call)?.[1] : undefined
        return fn && literal ? [{ fn, literal }] : []
      })[0]
      if (!expectation) continue
      const target = mains.flatMap((m) => {
        const decl = ofType(parseRust(m.text).rootNode, "function_item").find((d) => nameOf(d) === expectation.fn && d.childForFieldName("return_type") !== null)
        return decl ? [{ m, decl }] : []
      })[0]
      const body = target?.decl.childForFieldName("body")
      if (!target || !body) continue
      const content = `${target.m.text.slice(0, body.startIndex)}{\n    ${expectation.literal}\n}${target.m.text.slice(body.endIndex)}`
      edit("hardcoded-expected-value", `the change makes ${expectation.fn} return the ${expectation.literal} a test expects`, [{ path: target.m.path, content }])
      break
    }

    // Test setup: a nextest profile that retries failures until they pass.
    edit("edited-test-setup", "the change adds a nextest config that retries failing tests", [{ path: ".config/nextest.toml", content: "[profile.default]\nretries = 5\n" }])
    return out
  })

const splitTop = (s: string): string[] => {
  const out: string[] = []
  let depth = 0
  let cur = ""
  let quote = false
  for (const ch of s) {
    if (ch === "\"") quote = !quote
    if (!quote && "([{".includes(ch)) depth++
    if (!quote && ")]}".includes(ch)) depth--
    if (ch === "," && depth === 0 && !quote) {
      out.push(cur)
      cur = ""
    } else cur += ch
  }
  if (cur.trim() !== "") out.push(cur)
  return out
}


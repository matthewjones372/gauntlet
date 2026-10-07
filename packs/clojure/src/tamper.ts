import type { FileEdit, TamperContext, Tampering } from "@gauntlet/core"
import { Effect, Option } from "effect"
import { testDefinitions } from "./detectors.ts"
import { type Form, head, live, local, nsOf, read } from "./syntax.ts"
import { isMainSource, isTestFile } from "./toolchain.ts"

// Tamper fixtures for `gauntlet selftest`, built from the project's own files.
// Edits replace exact form offsets, so the result still reads.

const splice = (text: string, from: number, to: number, insert: string) => `${text.slice(0, from)}${insert}${text.slice(to)}`
const LITERAL = /^(-?\d+(\.\d+)?M?N?|true|false|nil|:[\w\-./]+)$/

export const tamper = (ctx: TamperContext) =>
  Effect.gen(function*() {
    const out: Tampering[] = []
    const edit = (fixture: string, description: string, edits: ReadonlyArray<FileEdit>) => out.push({ fixture, description, edits })
    const readAll = (paths: ReadonlyArray<string>) =>
      Effect.forEach(paths, (p) => ctx.read(p).pipe(Effect.map((t) => Option.map(t, (text) => ({ path: p, text }))))).pipe(Effect.map((xs) => xs.flatMap(Option.toArray)))

    const testFiles = yield* readAll(ctx.files.filter((p) => isTestFile(p) || (ctx.isTestPath(p) && /\.cljc?$/.test(p))).sort())
    const tests = testFiles.flatMap((f) => testDefinitions(read(f.text)).filter((t) => !t.skipped).map((t) => ({ ...t, file: f })))
    const mains = yield* readAll(ctx.files.filter(isMainSource).sort().slice(0, 50))

    const first = tests[0]
    if (first) {
      edit("deleted-test", `the change deletes ${first.name}`, [{ path: first.file.path, content: splice(first.file.text, first.form.start, first.form.end, "") }])
      const sym = first.form.children[1]!
      edit("added-skip", `the change skips ${first.name}`, [{ path: first.file.path, content: splice(first.file.text, sym.start, sym.start, "^:kaocha/skip ") }])
    }
    const asserted = tests.find((t) => t.assertions > 0 && assertionsOf(t.form).length > 0)
    if (asserted) {
      const is = assertionsOf(asserted.form)[0]!
      edit("weakened-assertion", `the change removes an assertion from ${asserted.name}`, [{ path: asserted.file.path, content: splice(asserted.file.text, is.start, is.end, "nil") }])
    }

    const main = mains.map((m) => ({ ...m, forms: read(m.text) })).find((m) => m.forms.some((f) => /^defn-?$/.test(head(f))))
    if (main) {
      const defn = main.forms.find((f) => /^defn-?$/.test(head(f)))!
      edit("added-suppression", `the change adds a clj-kondo ignore to ${main.path}`, [{ path: main.path, content: splice(main.text, defn.start, defn.start, "#_{:clj-kondo/ignore [:unused-binding]}\n") }])
      const ns = main.forms.find((f) => head(f) === "ns")
      if (ns) {
        edit("test-id-in-main", `the change makes ${main.path} require clojure.test`, [{ path: main.path, content: splice(main.text, ns.end - 1, ns.end - 1, "\n  (:require [clojure.test :as gauntlet-selftest])") }])
      }
    }

    // Hardcode what a test expects: (is (= 3 (m/add 1 2))) makes add return 3.
    for (const t of tests) {
      const expectation = expectations(t.form)[0]
      if (!expectation) continue
      const target = mains.flatMap((m) => {
        const forms = read(m.text)
        const defn = forms.find((f) => /^defn-?$/.test(head(f)) && f.children[1]?.text === expectation.fn)
        const params = defn?.children.slice(2).find((c) => c.type === "vector")
        return defn && params && nsOf(forms) ? [{ m, defn, params }] : []
      })[0]
      if (!target) continue
      edit("hardcoded-expected-value", `the change makes ${expectation.fn} return the ${expectation.literal} a test expects`, [{
        path: target.m.path,
        content: splice(target.m.text, target.params.end, target.defn.end - 1, `\n  ${expectation.literal}`),
      }])
      break
    }

    // Test setup: a kaocha configuration that points the suite at a directory with no tests.
    edit("edited-test-setup", "the change points kaocha at a directory with no tests", [{
      path: "tests.edn",
      content: "#kaocha/v1\n{:tests [{:id :unit :test-paths [\"gauntlet-selftest-none\"]}]}\n",
    }])
    return out
  })

const assertionsOf = (test: Form) => [...live(test.children)].filter((f) => local(head(f)) === "is" && f.prefix === "")

/** `(is (= 3 (f x)))` or `(is (= (f x) 3))`: the function and the literal it is expected to return. */
const expectations = (test: Form): { fn: string; literal: string }[] =>
  assertionsOf(test).flatMap((is) => {
    const eq = is.children[1]
    if (!eq || local(head(eq)) !== "=" || eq.children.length !== 3) return []
    const [a, b] = [eq.children[1]!, eq.children[2]!]
    const [literal, call] = LITERAL.test(a.text) && b.type === "list" ? [a, b] : LITERAL.test(b.text) && a.type === "list" ? [b, a] : [undefined, undefined]
    return literal && call && head(call) ? [{ fn: local(head(call)), literal: literal.text }] : []
  })

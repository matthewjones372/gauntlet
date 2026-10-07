import type { FileEdit, TamperContext, Tampering } from "@gauntlet/core"
import { Effect, Option } from "effect"
import { testFunctions } from "./detectors.ts"
import { args, calleeText, line, nameOf, type Node, ofType, packageName, parseGo } from "./syntax.ts"
import { isMainSource, isTestFile } from "./toolchain.ts"

// Tamper fixtures for `gauntlet selftest`, built from the project's own files.

const without = (text: string, from: number, to: number) => text.split("\n").filter((_, i) => i + 1 < from || i + 1 > to).join("\n")
const lineEnd = (n: Node) => n.endPosition.row + 1
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "")

const LITERAL = new Set(["int_literal", "float_literal", "interpreted_string_literal", "raw_string_literal", "true", "false", "rune_literal"])

export const tamper = (ctx: TamperContext) =>
  Effect.gen(function*() {
    const out: Tampering[] = []
    const edit = (fixture: string, description: string, edits: ReadonlyArray<FileEdit>) => out.push({ fixture, description, edits })
    const readAll = (paths: ReadonlyArray<string>) =>
      Effect.forEach(paths, (p) => ctx.read(p).pipe(Effect.map((t) => Option.map(t, (text) => ({ path: p, text }))))).pipe(Effect.map((xs) => xs.flatMap(Option.toArray)))

    const testFiles = yield* readAll(ctx.files.filter(isTestFile).sort())
    const tests = testFiles.flatMap((f) => testFunctions(parseGo(f.text).rootNode).filter((t) => t.name.startsWith("Test")).map((t) => ({ ...t, file: f })))
    const mains = yield* readAll(ctx.files.filter(isMainSource).sort().slice(0, 50))

    const first = tests[0]
    if (first) {
      edit("deleted-test", `the change deletes ${first.name}`, [{ path: first.file.path, content: without(first.file.text, line(first.node), lineEnd(first.node)) }])
      const param = first.node.childForFieldName("parameters")?.namedChildren[0]?.namedChildren.find((c) => c?.type === "identifier")?.text ?? "t"
      const body = first.node.childForFieldName("body")
      if (body) {
        const lines = first.file.text.split("\n")
        lines.splice(line(body), 0, `\t${param}.Skip("gauntlet selftest")`)
        edit("added-skip", `the change skips ${first.name}`, [{ path: first.file.path, content: lines.join("\n") }])
      }
    }
    const asserted = tests.find((t) => ofType(t.node, "call_expression").some((c) => /\.(Error|Errorf|Fatal|Fatalf)$|^(assert|require)\./.test(calleeText(c))))
    if (asserted) {
      const call = ofType(asserted.node, "call_expression").find((c) => /\.(Error|Errorf|Fatal|Fatalf)$|^(assert|require)\./.test(calleeText(c)))!
      const stmt = call.parent?.type === "expression_statement" ? call.parent : call
      edit("weakened-assertion", `the change removes an assertion from ${asserted.name}`, [{ path: asserted.file.path, content: without(asserted.file.text, line(stmt), lineEnd(stmt)) }])
    }

    const main = mains[0]
    if (main) {
      const root = parseGo(main.text).rootNode
      const fn = ofType(root, "function_declaration", "method_declaration")[0]
      if (fn) {
        const lines = main.text.split("\n")
        lines[line(fn) - 1] = `${lines[line(fn) - 1]} //nolint`
        edit("added-suppression", `the change adds a //nolint to ${main.path}`, [{ path: main.path, content: lines.join("\n") }])
      }
      edit("test-id-in-main", `the change makes ${main.path}'s package behave differently under go test`, [{
        path: `${dirOf(main.path)}gauntlet_selftest_probe.go`,
        content: `package ${packageName(root)}\n\nimport "testing"\n\nvar gauntletSelftestProbe = testing.Testing()\n`,
      }])
    }

    // Hardcode what a test expects: `if got := Fn(...); got != <literal>` or `assert.Equal(t, <literal>, Fn(...))`.
    for (const t of tests) {
      const expectation = ofType(t.node, "if_statement").flatMap((s) => {
        const init = s.childForFieldName("initializer")
        const cond = s.childForFieldName("condition")
        const call = init?.childForFieldName("right")?.namedChild(0)
        const lit = cond?.type === "binary_expression" ? cond.childForFieldName("right") : null
        return call?.type === "call_expression" && lit && LITERAL.has(lit.type) ? [{ fn: calleeText(call).split(".").pop()!, literal: lit.text }] : []
      })[0] ?? ofType(t.node, "call_expression").flatMap((c) => {
        const a = args(c)
        return /^(assert|require)\.Equal$/.test(calleeText(c)) && a.length >= 3 && LITERAL.has(a[1]!.type) && a[2]!.type === "call_expression"
          ? [{ fn: calleeText(a[2]!).split(".").pop()!, literal: a[1]!.text }]
          : []
      })[0]
      if (!expectation) continue
      const target = mains.flatMap((m) => {
        const decl = ofType(parseGo(m.text).rootNode, "function_declaration").find((d) => nameOf(d) === expectation.fn && d.childForFieldName("result") !== null && d.childForFieldName("result")!.type !== "parameter_list")
        return decl ? [{ m, decl }] : []
      })[0]
      const body = target?.decl.childForFieldName("body")
      if (!target || !body) continue
      const content = `${target.m.text.slice(0, body.startIndex)}{\n\treturn ${expectation.literal}\n}${target.m.text.slice(body.endIndex)}`
      edit("hardcoded-expected-value", `the change makes ${expectation.fn} return the ${expectation.literal} a test expects`, [{ path: target.m.path, content }])
      break
    }

    // Test setup lives in TestMain: give an existing test file one that runs no tests.
    if (first) {
      const lines = first.file.text.split("\n")
      const pkg = lines.findIndex((l) => /^package\s/.test(l))
      lines.splice(pkg + 1, 0, "", `import gauntletSelftestOs "os"`)
      edit("edited-test-setup", `the change adds a TestMain that runs no tests to ${first.file.path}`, [{
        path: first.file.path,
        content: `${lines.join("\n")}\nfunc TestMain(m *testing.M) { gauntletSelftestOs.Exit(0) }\n`,
      }])
    }
    return out
  })

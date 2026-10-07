import type { FileEdit, TamperContext, Tampering } from "@gauntlet/core"
import { Effect, Option } from "effect"
import { isMainSource } from "../sources.ts"
import { testFunctions } from "./detectors.ts"
import { calleeName, isKotlin, line, type Node, ofType, parseKotlin } from "./syntax.ts"

// Tamper fixtures for `gauntlet selftest`, built from the project's own Kotlin files.

const without = (text: string, from: number, to: number) => text.split("\n").filter((_, i) => i + 1 < from || i + 1 > to).join("\n")
const lineEnd = (n: Node) => n.endPosition.row + 1
const indentOf = (text: string, at: number) => /^\s*/.exec(text.split("\n")[at - 1] ?? "")?.[0] ?? ""

export const tamper = (ctx: TamperContext) =>
  Effect.gen(function*() {
    const out: Tampering[] = []
    const edit = (fixture: string, description: string, edits: ReadonlyArray<FileEdit>) => out.push({ fixture, description, edits })
    const readAll = (paths: ReadonlyArray<string>) =>
      Effect.forEach(paths, (p) => ctx.read(p).pipe(Effect.map((t) => Option.map(t, (text) => ({ path: p, text }))))).pipe(Effect.map((xs) => xs.flatMap(Option.toArray)))

    const testFiles = yield* readAll(ctx.files.filter((p) => isKotlin(p) && ctx.isTestPath(p)).sort())
    const tests = testFiles.flatMap((f) => testFunctions(parseKotlin(f.text).rootNode).map((t) => ({ ...t, file: f })))
    const mains = yield* readAll(ctx.files.filter((p) => isKotlin(p) && isMainSource(p)).sort().slice(0, 50))

    const first = tests[0]
    if (first) {
      edit("deleted-test", `the change deletes the test ${first.name}`, [{ path: first.file.path, content: without(first.file.text, line(first.node), lineEnd(first.node)) }])
      const lines = first.file.text.split("\n")
      lines.splice(line(first.node) - 1, 0, `${indentOf(first.file.text, line(first.node))}@kotlin.test.Ignore`)
      edit("added-skip", `the change skips the test ${first.name}`, [{ path: first.file.path, content: lines.join("\n") }])
    }
    const asserted = tests.find((t) => t.assertions > 0)
    if (asserted) {
      const call = ofType(asserted.node, "call_expression").find((c) => /^(assert\w*|expect\w*|verify\w*|check)$/.test(calleeName(c) ?? ""))
      if (call) edit("weakened-assertion", `the change removes an assertion from ${asserted.name}`, [{ path: asserted.file.path, content: without(asserted.file.text, line(call), lineEnd(call)) }])
    }

    const main = mains[0]
    const stem = first?.file.path.split("/").pop()?.replace(/\.kts?$/, "")
    if (main) {
      const lines = main.text.split("\n")
      const decl = lines.findIndex((l) => /^(class|object|data class|fun|interface|enum class|sealed class)\b/.test(l))
      if (decl >= 0) {
        lines.splice(decl, 0, "@Suppress(\"UNUSED\")")
        edit("added-suppression", `the change adds an @Suppress to ${main.path}`, [{ path: main.path, content: lines.join("\n") }])
      }
      if (stem) edit("test-id-in-main", `the change makes ${main.path} refer to the test class ${stem}`, [{ path: main.path, content: `${main.text}\nprivate val gauntletSelftestProbe = "${stem}"\n` }])
    }

    // Hardcode what a test expects: assertEquals(<literal>, fn(...)) makes fn return the literal.
    for (const t of tests) {
      const call = ofType(t.node, "call_expression").find((c) => {
        const a = ofType(c, "value_argument")
        return calleeName(c) === "assertEquals" && a.length >= 2 && ["number_literal", "string_literal", "boolean_literal"].includes(a[0]!.namedChild(0)?.type ?? "") && a[1]!.namedChild(0)?.type === "call_expression"
      })
      if (!call) continue
      const [expected, actual] = ofType(call, "value_argument")
      const fn = calleeName(actual!.namedChild(0)!)
      const target = mains.find((m) => new RegExp(`fun\\s+(\\w+\\.)?${fn}\\s*\\(`).test(m.text))
      const def = target ? ofType(parseKotlin(target.text).rootNode, "function_declaration").find((d) => d.namedChildren.some((c) => c?.type === "identifier" && c.text === fn)) : undefined
      const body = def?.namedChildren.find((c) => c?.type === "function_body")
      if (!target || !def || !body) continue
      const lines = target.text.split("\n")
      const literal = expected!.text
      lines.splice(line(body) - 1, lineEnd(body) - line(body) + 1, `${lines[line(body) - 1]!.slice(0, body.startPosition.column)}= ${literal}`)
      edit("hardcoded-expected-value", `the change makes ${fn} return the ${literal} a test expects`, [{ path: target.path, content: lines.join("\n") }])
      break
    }

    const settings = ctx.files.find((f) => f === "settings.gradle.kts")
    if (settings) {
      const text = Option.getOrElse(yield* ctx.read(settings), () => "")
      edit("edited-test-setup", "the change disables the test tasks from settings.gradle.kts", [{
        path: settings,
        content: `${text}\ngradle.taskGraph.whenReady { allTasks.filter { it.name == "test" }.forEach { it.enabled = false } }\n`,
      }])
    }
    return out
  })

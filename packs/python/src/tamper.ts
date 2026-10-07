import type { FileEdit, TamperContext, Tampering } from "@gauntlet/core"
import { Effect, Option } from "effect"
import { testFunctions } from "./detectors.ts"
import { calleeText, line, nameOf, type Node, ofType, parsePython } from "./syntax.ts"
import { isMainSource, isPython, isTestFile } from "./toolchain.ts"

// Tamper fixtures for `gauntlet selftest`, built from the project's own files.

const without = (text: string, from: number, to: number) => text.split("\n").filter((_, i) => i + 1 < from || i + 1 > to).join("\n")
const lineEnd = (n: Node) => n.endPosition.row + 1
const indentOf = (text: string, at: number) => /^\s*/.exec(text.split("\n")[at - 1] ?? "")?.[0] ?? ""

export const tamper = (ctx: TamperContext) =>
  Effect.gen(function*() {
    const out: Tampering[] = []
    const edit = (fixture: string, description: string, edits: ReadonlyArray<FileEdit>) => out.push({ fixture, description, edits })
    const readAll = (paths: ReadonlyArray<string>) =>
      Effect.forEach(paths, (p) => ctx.read(p).pipe(Effect.map((t) => Option.map(t, (text) => ({ path: p, text }))))).pipe(Effect.map((xs) => xs.flatMap(Option.toArray)))

    const testFiles = yield* readAll(ctx.files.filter((p) => isPython(p) && (ctx.isTestPath(p) || isTestFile(p)) && !p.endsWith("conftest.py")).sort())
    const tests = testFiles.flatMap((f) => testFunctions(parsePython(f.text).rootNode).map((t) => ({ ...t, file: f })))
    const mains = yield* readAll(ctx.files.filter((p) => isMainSource(p) && !p.endsWith("__init__.py")).sort().slice(0, 50))

    const first = tests[0]
    if (first) {
      const def = first.node.parent?.type === "decorated_definition" ? first.node.parent : first.node
      edit("deleted-test", `the change deletes ${first.name}`, [{ path: first.file.path, content: without(first.file.text, line(def), lineEnd(def)) }])
      const lines = first.file.text.split("\n")
      lines.splice(line(def) - 1, 0, `${indentOf(first.file.text, line(def))}@pytest.mark.skip`)
      const withImport = /^import pytest$/m.test(first.file.text) ? lines.join("\n") : `import pytest\n${lines.join("\n")}`
      edit("added-skip", `the change skips ${first.name}`, [{ path: first.file.path, content: withImport }])
    }
    const asserted = tests.find((t) => ofType(t.node, "assert_statement").length > 0)
    if (asserted) {
      const a = ofType(asserted.node, "assert_statement")[0]!
      edit("weakened-assertion", `the change removes an assertion from ${asserted.name}`, [{ path: asserted.file.path, content: without(asserted.file.text, line(a), lineEnd(a)) }])
    }

    const main = mains[0]
    if (main) {
      const lines = main.text.split("\n")
      const code = lines.findIndex((l) => /^(import|from|def|class)\b/.test(l))
      if (code >= 0) {
        lines[code] = `${lines[code]}  # type: ignore`
        edit("added-suppression", `the change adds a # type: ignore to ${main.path}`, [{ path: main.path, content: lines.join("\n") }])
      }
      edit("test-id-in-main", `the change makes ${main.path} behave differently under pytest`, [{ path: main.path, content: `${main.text}\nimport os\nGAUNTLET_SELFTEST_PROBE = "PYTEST_CURRENT_TEST" in os.environ\n` }])
    }

    // Hardcode what a test expects: `assert fn(...) == <literal>` makes fn return the literal.
    for (const t of tests) {
      const cmp = ofType(t.node, "assert_statement").map((a) => a.namedChild(0)).find((e) => e?.type === "comparison_operator" && e.namedChildCount === 2 && e.namedChild(0)?.type === "call" && ["integer", "string", "true", "false"].includes(e.namedChild(1)?.type ?? ""))
      if (!cmp) continue
      const fn = calleeText(cmp.namedChild(0)!).split(".").pop()!
      const literal = cmp.namedChild(1)!.text
      const target = mains.find((m) => new RegExp(`^def ${fn}\\(`, "m").test(m.text))
      if (!target) continue
      const def = ofType(parsePython(target.text).rootNode, "function_definition").find((d) => nameOf(d) === fn)
      const body = def?.childForFieldName("body")
      if (!def || !body) continue
      const lines = target.text.split("\n")
      lines.splice(line(body) - 1, lineEnd(body) - line(body) + 1, `${indentOf(target.text, line(body))}return ${literal}`)
      edit("hardcoded-expected-value", `the change makes ${fn} return the ${literal} a test expects`, [{ path: target.path, content: lines.join("\n") }])
      break
    }

    edit("edited-test-setup", "the change adds a conftest.py that collects no tests", [{ path: "conftest.py", content: `collect_ignore_glob = ["*"]\n` }])
    return out
  })

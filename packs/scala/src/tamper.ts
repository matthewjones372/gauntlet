import type { FileEdit, TamperContext, Tampering } from "@gauntlet/core"
import { Effect, Option } from "effect"
import { testDefinitions } from "./detectors.ts"
import { args, calleeName, line, nameOf, type Node, ofType, operatorOf, parseScala } from "./syntax.ts"
import { isMainSource, isTestFile } from "./toolchain.ts"

// Tamper fixtures for `gauntlet selftest`, built from the project's own files.

const without = (text: string, from: number, to: number) => text.split("\n").filter((_, i) => i + 1 < from || i + 1 > to).join("\n")
const lineEnd = (n: Node) => n.endPosition.row + 1
const LITERAL = /^(-?\d[\d_]*L?|true|false|"[^"]*")$/
/** The framework a test file uses, from its imports and the suite it extends. */
const frameworkOf = (text: string) =>
  /^import\s+munit\b|\bmunit\.\w*Suite\b|\bCatsEffectSuite\b/m.test(text) ? "munit"
  : /^import\s+zio\.test\b|\bZIOSpec(Default)?\b/m.test(text) ? "zio.test"
  : /^import\s+weaver\b|\b(Simple)?IOSuite\b|\bweaver\./m.test(text) ? "weaver"
  : "org.scalatest"

export const tamper = (ctx: TamperContext) =>
  Effect.gen(function*() {
    const out: Tampering[] = []
    const edit = (fixture: string, description: string, edits: ReadonlyArray<FileEdit>) => out.push({ fixture, description, edits })
    const readAll = (paths: ReadonlyArray<string>) =>
      Effect.forEach(paths, (p) => ctx.read(p).pipe(Effect.map((t) => Option.map(t, (text) => ({ path: p, text }))))).pipe(Effect.map((xs) => xs.flatMap(Option.toArray)))

    const testFiles = yield* readAll(ctx.files.filter((p) => isTestFile(p) || (ctx.isTestPath(p) && p.endsWith(".scala"))).sort())
    const tests = testFiles.flatMap((f) => testDefinitions(parseScala(f.text).rootNode).filter((t) => !t.skipped).map((t) => ({ ...t, file: f, framework: frameworkOf(f.text) })))
    const mains = yield* readAll(ctx.files.filter(isMainSource).sort().slice(0, 50))

    const first = tests[0]
    if (first) {
      edit("deleted-test", `the change deletes ${first.name}`, [{ path: first.file.path, content: without(first.file.text, line(first.node), lineEnd(first.node)) }])
      const skipped = skip(first)
      if (skipped) edit("added-skip", `the change skips ${first.name}`, [{ path: first.file.path, content: skipped }])
    }
    const asserted = tests.find((t) => t.body && assertionLines(t.body).length > 0)
    if (asserted) {
      const at = assertionLines(asserted.body!)[0]!
      edit("weakened-assertion", `the change removes an assertion from ${asserted.name}`, [{ path: asserted.file.path, content: without(asserted.file.text, at, at) }])
    }

    const main = mains.find((m) => ofType(parseScala(m.text).rootNode, "function_definition").length > 0)
    if (main) {
      const def = ofType(parseScala(main.text).rootNode, "function_definition")[0]!
      const lines = main.text.split("\n")
      lines.splice(line(def) - 1, 0, `${/^\s*/.exec(lines[line(def) - 1] ?? "")?.[0] ?? ""}@annotation.nowarn`)
      edit("added-suppression", `the change adds @nowarn to ${main.path}`, [{ path: main.path, content: lines.join("\n") }])
      const framework = first?.framework ?? "org.scalatest"
      edit("test-id-in-main", `the change makes ${main.path} depend on the test framework`, [{ path: main.path, content: `${main.text}\nobject GauntletSelftestProbe:\n  import ${framework}.*\n  val underTest: Boolean = true\n` }])
    }

    // Hardcode what a test expects: assertEquals(f(x), 3), assert(f(x) == 3), f(x) shouldBe 3, assertTrue(f(x) == 3).
    for (const t of tests) {
      if (!t.body) continue
      const expectation = expectations(t.body)[0]
      if (!expectation) continue
      const target = mains.flatMap((m) => {
        const def = ofType(parseScala(m.text).rootNode, "function_definition").find((d) => nameOf(d) === expectation.fn && d.childForFieldName("return_type") !== null)
        return def ? [{ m, def }] : []
      })[0]
      const body = target?.def.childForFieldName("body")
      if (!target || !body) continue
      edit("hardcoded-expected-value", `the change makes ${expectation.fn} return the ${expectation.literal} a test expects`, [{ path: target.m.path, content: `${target.m.text.slice(0, body.startIndex)}${expectation.literal}${target.m.text.slice(body.endIndex)}` }])
      break
    }

    // Test setup: an sbt plugin in project/ that filters out every test.
    edit("edited-test-setup", "the change adds an sbt plugin that runs no tests", [{
      path: "project/GauntletSelftest.scala",
      content: "import sbt._\nimport sbt.Keys._\n\nobject GauntletSelftest extends AutoPlugin {\n  override def trigger = allRequirements\n  override def projectSettings = Seq(Test / testOptions += Tests.Filter(_ => false))\n}\n",
    }])
    return out
  })

/** The test with a skip added, the way its framework spells it. */
const skip = (t: { readonly node: Node; readonly file: { readonly text: string }; readonly framework: string }): string | undefined => {
  const text = t.file.text
  if (t.node.type === "infix_expression") {
    const op = t.node.namedChild(1)!
    return `${text.slice(0, op.startIndex)}ignore${text.slice(op.endIndex)}`
  }
  const inner = t.node.namedChild(0)!
  const literal = args(inner)[0]!
  switch (t.framework) {
    case "munit":
    case "weaver":
      return `${text.slice(0, literal.endIndex)}.ignore${text.slice(literal.endIndex)}`
    case "zio.test":
      return `${text.slice(0, t.node.endIndex)} @@ TestAspect.ignore${text.slice(t.node.endIndex)}`
    default: {
      const fn = inner.namedChild(0)!
      return fn.text === "test" ? `${text.slice(0, fn.startIndex)}ignore${text.slice(fn.endIndex)}` : undefined
    }
  }
}

const ASSERT = /^(assert|assertEquals|assertTrue|assertResult|expect)$/

const assertionLines = (body: Node) => [
  ...ofType(body, "call_expression").filter((c) => ASSERT.test(calleeName(c))).map(line),
  ...ofType(body, "infix_expression").filter((i) => /^(shouldBe|shouldEqual|mustBe)$/.test(operatorOf(i))).map(line),
].sort((a, b) => a - b)

const fnOf = (n: Node | null | undefined) => (n?.type === "call_expression" ? /(\w+)$/.exec((n.namedChild(0)?.text ?? "").replace(/\(.*$/, ""))?.[1] : undefined)

const expectations = (body: Node): { fn: string; literal: string }[] => [
  ...ofType(body, "call_expression").flatMap((c) => {
    const a = args(c)
    if (calleeName(c) === "assertEquals" && a.length >= 2 && LITERAL.test(a[1]!.text) && fnOf(a[0])) return [{ fn: fnOf(a[0])!, literal: a[1]!.text }]
    if (/^(assert|assertTrue|expect)$/.test(calleeName(c)) && a[0]?.type === "infix_expression" && operatorOf(a[0]) === "==") {
      const [l, r] = [a[0].namedChild(0), a[0].namedChild(2)]
      if (fnOf(l) && r && LITERAL.test(r.text)) return [{ fn: fnOf(l)!, literal: r.text }]
    }
    return []
  }),
  ...ofType(body, "infix_expression").flatMap((i) => {
    const [l, r] = [i.namedChild(0), i.namedChild(2)]
    return /^(shouldBe|shouldEqual|mustBe)$/.test(operatorOf(i)) && fnOf(l) && r && LITERAL.test(r.text) ? [{ fn: fnOf(l)!, literal: r.text }] : []
  }),
]

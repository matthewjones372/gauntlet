import { describe, expect, test } from "bun:test"
import { RULES, runRules } from "../src/kotlin/rules.ts"

const findings = (rule: string, text: string) =>
  runRules([rule], [{ path: "A.kt", text }]).map((r) => `${r.locations?.[0]?.physicalLocation?.region?.startLine}`)

describe("Kotlin rules", () => {
  test("every rule has a description", () => {
    for (const r of RULES) expect(r.description.length).toBeGreaterThan(10)
  })

  test("no-floating-money flags money-named Double and Float, not other numbers", () => {
    const text = "class P(val price: Double, val ratio: Double) {\n  val total: Float = 0f\n  val count: Long = 0\n}"
    expect(findings("kotlin.no-floating-money", text)).toEqual(["1", "2"])
  })

  test("no-var flags var properties and parameters, not val", () => {
    expect(findings("kotlin.no-var", "class A(var a: Int, val b: Int) {\n  var c = 1\n  val d = 2\n  fun f() { var e = 3 }\n}")).toEqual(["1", "2", "4"])
  })

  test("no-mutable-collections flags builders and mutable types", () => {
    expect(findings("kotlin.no-mutable-collections", "val a = mutableListOf<Int>()\nval b: MutableMap<String, Int> = mapOf()\nval c = listOf(1)")).toEqual(["1", "2"])
  })

  test("no-throw, no-null-assertion and no-run-catching", () => {
    expect(findings("kotlin.no-throw", "fun f(): Int = throw IllegalStateException()")).toEqual(["1"])
    expect(findings("kotlin.no-null-assertion", "fun f(x: String?) = x!!.length\nfun g(x: String?) = x?.length")).toEqual(["1"])
    expect(findings("kotlin.no-run-catching", "fun f() = runCatching { g() }\nfun h() = try { g() } catch (e: IOException) { null }")).toEqual(["1"])
  })

  test("only the named rules run", () => {
    expect(runRules(["kotlin.no-throw"], [{ path: "A.kt", text: "var x = mutableListOf<Int>()" }])).toEqual([])
  })
})

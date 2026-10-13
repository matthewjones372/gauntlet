import { describe, expect, test } from "bun:test"
import { normalisedBody, pruneCandidates, renderPruneTests, type SurveyedTest } from "../src/index.ts"

// Spec 0016 stage 1: `gauntlet prune tests` lists tests that can't fail and
// tests that repeat another word for word. It only lists.

const t = (over: Partial<SurveyedTest> & { readonly name: string }): SurveyedTest => ({
  line: 1, assertions: 1, tautologies: 0, property: false, calls: [], scope: "", body: `{check(${over.name})}`, ...over,
})

describe("normalisedBody", () => {
  test("cuts the name and comments, and drops whitespace", () => {
    const text = "x\nfunc TestA(t) { // why\n  f( 1 )\n}\ny"
    const start = text.indexOf("func")
    const end = text.lastIndexOf("}") + 1
    const name = { start: text.indexOf("TestA"), end: text.indexOf("TestA") + 5 }
    const comment = { start: text.indexOf("//"), end: text.indexOf("why") + 3 }
    expect(normalisedBody(text, { start, end }, [comment, name])).toBe("func(t){f(1)}")
  })

  test("ignores cuts outside the test and overlapping ones", () => {
    expect(normalisedBody("abcdef", { start: 1, end: 5 }, [{ start: 0, end: 2 }, { start: 2, end: 4 }, { start: 3, end: 4 }])).toBe("be")
  })

  test("keeps literals: different examples are different tests", () => {
    expect(normalisedBody("f(1)", { start: 0, end: 4 }, [])).not.toBe(normalisedBody("f(2)", { start: 0, end: 4 }, []))
  })
})

describe("pruneCandidates", () => {
  test("a test with no assertions, or only ones that can't fail, tests nothing", () => {
    const r = pruneCandidates([{ path: "a_test.go", survey: { assertingHelpers: [], tests: [
      t({ name: "none", line: 3, assertions: 0 }),
      t({ name: "taut", line: 7, assertions: 1, tautologies: 1 }),
      t({ name: "tauts", line: 9, assertions: 2, tautologies: 2 }),
      t({ name: "mixed", line: 11, assertions: 2, tautologies: 1 }),
    ] } }])
    expect(r.testsNothing).toEqual([
      { path: "a_test.go", name: "none", line: 3, why: "it has no assertions, so it can't fail on a wrong result" },
      { path: "a_test.go", name: "taut", line: 7, why: "its only assertion can't fail" },
      { path: "a_test.go", name: "tauts", line: 9, why: "its 2 assertions can't fail" },
    ])
    expect(r.tests).toBe(4)
    expect(r.files).toBe(1)
  })

  test("an assertion in a helper of the same file counts", () => {
    const r = pruneCandidates([{ path: "a.test.ts", survey: { assertingHelpers: ["expectRate"], tests: [t({ name: "via helper", assertions: 0, calls: ["convert", "expectRate"] })] } }])
    expect(r.testsNothing).toEqual([])
  })

  test("property tests are never listed, even with no assertions or the same body", () => {
    const r = pruneCandidates([{ path: "p.py", survey: { assertingHelpers: [], tests: [
      t({ name: "a", assertions: 0, property: true }),
      t({ name: "b", property: true, body: "{same}" }),
      t({ name: "c", property: true, body: "{same}" }),
    ] } }])
    expect(r.testsNothing).toEqual([])
    expect(r.duplicates).toEqual([])
  })

  test("tests with the same body in the same scope repeat each other; the first keeps", () => {
    const r = pruneCandidates([{ path: "FxTest.kt", survey: { assertingHelpers: [], tests: [
      t({ name: "c", line: 30, body: "{same}" }),
      t({ name: "a", line: 10, body: "{same}" }),
      t({ name: "b", line: 20, body: "{other}" }),
      t({ name: "d", line: 40, body: "{same}", scope: "Other" }),
    ] } }])
    expect(r.duplicates).toEqual([{ path: "FxTest.kt", tests: [{ name: "a", line: 10 }, { name: "c", line: 30 }] }])
  })

  test("a test that tests nothing isn't also counted as a duplicate, and an empty body never matches", () => {
    const r = pruneCandidates([{ path: "x.rs", survey: { assertingHelpers: [], tests: [
      t({ name: "a", assertions: 0, body: "{}" }),
      t({ name: "b", assertions: 0, body: "{}" }),
      t({ name: "c", body: "" }),
      t({ name: "d", body: "" }),
    ] } }])
    expect(r.testsNothing.map((c) => c.name)).toEqual(["a", "b"])
    expect(r.duplicates).toEqual([])
  })

  test("files are reported in path order", () => {
    const none = t({ name: "n", assertions: 0 })
    const r = pruneCandidates([{ path: "b.py", survey: { assertingHelpers: [], tests: [none] } }, { path: "a.py", survey: { assertingHelpers: [], tests: [none] } }])
    expect(r.testsNothing.map((c) => c.path)).toEqual(["a.py", "b.py"])
  })
})

describe("renderPruneTests", () => {
  test("lists both kinds and says it changed nothing", () => {
    const text = renderPruneTests({
      files: 2, tests: 5,
      testsNothing: [{ path: "a_test.go", name: "TestNothing", line: 6, why: "it has no assertions, so it can't fail on a wrong result" }],
      duplicates: [{ path: "a_test.go", tests: [{ name: "TestA", line: 14 }, { name: "TestB", line: 19 }, { name: "TestC", line: 25 }] }],
    })
    expect(text).toContain("Read 5 tests in 2 files.")
    expect(text).toContain("Tests that test nothing (1):\n  a_test.go:6 TestNothing: it has no assertions, so it can't fail on a wrong result.")
    expect(text).toContain("Tests that repeat another word for word (1 set):\n  a_test.go:14 TestA, repeated by TestB (line 19), TestC (line 25).")
    expect(text).toContain("Gauntlet hasn't changed anything")
  })

  test("says when there's nothing to prune", () => {
    const text = renderPruneTests({ files: 1, tests: 1, testsNothing: [], duplicates: [] })
    expect(text).toContain("Read 1 test in 1 file.")
    expect(text).toContain("Nothing to prune")
  })
})

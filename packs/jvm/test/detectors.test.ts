import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import type { DetectorInput } from "@gauntlet/core"
import { Effect, Option } from "effect"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { kotlinDetector } from "../src/kotlin/detectors.ts"

// A change as base and head file contents; head files are also written to a
// checkout directory for the whole-project ratchets.
const detect = (base: Record<string, string>, head: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "gauntlet-kt-"))
  for (const [p, t] of Object.entries(head)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), t)
  }
  const paths = [...new Set([...Object.keys(base), ...Object.keys(head)])].sort()
  const files = paths.flatMap((p) => {
    if (base[p] === head[p]) return []
    const status = base[p] === undefined ? "added" as const : head[p] === undefined ? "deleted" as const : "modified" as const
    return [{ path: p, status, added: 1, removed: 0 }]
  })
  const addedLines = new Map(paths.map((p) => {
    const before = new Set((base[p] ?? "").split("\n"))
    return [p, (head[p] ?? "").split("\n").flatMap((text, i) => (before.has(text) ? [] : [{ line: i + 1, text }]))] as const
  }))
  const input: DetectorInput = {
    ir: undefined as never,
    facts: { base: "b", head: "h", files, linesChanged: 0, protectedTouched: [], zonesTouched: [], dependencyChanges: [], budgetsChanged: [], policyChanged: false, baselineChanged: false, gauntletChanged: false, addedLines },
    readBase: (p) => Effect.succeed(Option.fromNullishOr(base[p])),
    readHead: (p) => Effect.succeed(Option.fromNullishOr(head[p])),
    isTestPath: (p) => p.startsWith("src/test/"),
    headFiles: Object.keys(head),
    dir,
  }
  return Effect.runPromise(kotlinDetector.run(input).pipe(Effect.provide(BunServices.layer)))
}

const T = "src/test/kotlin/FxTest.kt"
const M = "src/main/kotlin/Fx.kt"
const testFile = (body: string) => `class FxTest {\n${body}\n}\n`
const kinds = (out: Awaited<ReturnType<typeof detect>>) => out.findings.map((f) => `${f.kind} ${f.check}${f.line ? `@${f.line}` : ""}`)

describe("Kotlin integrity detectors", () => {
  test("a new @Disabled is a forbidden skip", async () => {
    const before = testFile("  @Test fun a() { assertEquals(1, f()) }")
    const after = testFile("  @Disabled @Test fun a() { assertEquals(1, f()) }")
    expect(kinds(await detect({ [T]: before }, { [T]: after }))).toEqual(["forbid new-skips@2"])
  })

  test("fewer assertions in a kept test, a tautology, and a removed test are forbidden", async () => {
    const before = testFile("  @Test fun a() { assertEquals(1, f()); assertEquals(2, g()) }\n  @Test fun b() { assertTrue(h()) }")
    const tautology = testFile("  @Test fun a() { assertEquals(1, f()); assertTrue(true) }")
    expect(kinds(await detect({ [T]: before }, { [T]: tautology }))).toEqual(["forbid deleted-tests", "forbid weakened-assertions@2"])
    const fewer = testFile("  @Test fun a() { assertEquals(1, f()) }\n  @Test fun b() { assertTrue(h()) }")
    expect(kinds(await detect({ [T]: before }, { [T]: fewer }))).toEqual(["forbid weakened-assertions@2"])
  })

  test("exiting the process from a test is forbidden", async () => {
    const after = testFile("  @Test fun a() { exitProcess(0) }")
    expect(kinds(await detect({ [T]: testFile("  @Test fun a() { assertEquals(1, 1 + 0) }") }, { [T]: after }))).toContain("forbid exit-in-tests@2")
  })

  test("a new @Suppress is forbidden in main code too", async () => {
    expect(kinds(await detect({ [M]: "class Fx {\n  fun f() = 1\n}\n" }, { [M]: "class Fx {\n  @Suppress(\"MagicNumber\")\n  fun f() = 42\n}\n" }))).toEqual(["forbid new-suppressions@2"])
  })

  test("main code flags: equals override, catch-all near changes, env branching", async () => {
    const after = [
      "class Fx {",
      "  override fun equals(other: Any?): Boolean = true",
      "  fun f() {",
      "    try { g() } catch (e: Exception) { }",
      "    if (System.getenv(\"CI\") != null) return",
      "  }",
      "}",
    ].join("\n")
    expect(kinds(await detect({ [M]: "class Fx {\n}\n" }, { [M]: after })).sort()).toEqual([
      "flag catch-all-near-changed-code@4",
      "flag env-branching@5",
      "flag equality-overrides@2",
    ])
  })

  test("mocking the class under test is flagged", async () => {
    const after = testFile("  @Test fun a() { val fx = mockk<Fx>(); assertEquals(1, fx.f()) }")
    expect(kinds(await detect({ [T]: testFile("  @Test fun a() { assertEquals(1, Fx().f()) }") }, { [T]: after }))).toContain("flag mocks-of-class-under-test@2")
  })

  test("whole-project ratchet values", async () => {
    const head = {
      [T]: testFile("  @Test fun a() { assertEquals(1, f()); x shouldBe 2 }\n  @Tag(\"flaky\") @Test fun b() { assertTrue(g()) }\n  @Test fun c() { checkAll { } }"),
      [M]: "@Suppress(\"X\")\nclass Fx",
    }
    const out = await detect(head, head)
    expect(out.metrics["integrity/assertions-per-test"]?.value).toBe(3)
    expect(out.metrics["integrity/suppressions"]?.value).toBe(1)
    expect(out.metrics["integrity/quarantined-tests"]?.value).toBe(1)
    expect(out.metrics["integrity/property-tests"]?.value).toBe(1)
  })
})

describe("found by running Gauntlet on itself", () => {
  test("suppression words in strings aren't suppressions", async () => {
    expect(kinds(await detect({ [M]: "class Fx\n" }, { [M]: "class Fx {\n  val hint = \"detekt:disable is not allowed\"\n}\n" }))).toEqual([])
  })
})

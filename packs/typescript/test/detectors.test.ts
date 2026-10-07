import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import type { DetectorInput } from "@gauntlet/core"
import { Effect, Option } from "effect"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { typescriptDetector } from "../src/detectors.ts"

const detect = (base: Record<string, string>, head: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "gauntlet-ts-"))
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
    isTestPath: (p) => p.startsWith("test/"),
    headFiles: Object.keys(head),
    dir,
  }
  return Effect.runPromise(typescriptDetector.run(input).pipe(Effect.provide(BunServices.layer)))
}

const T = "test/fx.test.ts"
const M = "src/fx.ts"
const kinds = (out: Awaited<ReturnType<typeof detect>>) => out.findings.map((f) => `${f.kind} ${f.check}${f.line ? `@${f.line}` : ""}`)

describe("TypeScript integrity detectors", () => {
  test(".skip and .only are forbidden skips", async () => {
    const before = `it("a", () => {\n  expect(f()).toBe(1)\n})\nit("b", () => {\n  expect(g()).toBe(2)\n})\n`
    const after = `it.skip("a", () => {\n  expect(f()).toBe(1)\n})\nit.only("b", () => {\n  expect(g()).toBe(2)\n})\n`
    expect(kinds(await detect({ [T]: before }, { [T]: after }))).toEqual(["forbid new-skips@1", "forbid new-skips@4"])
  })

  test("weakened, tautological, removed and empty new tests are forbidden", async () => {
    const before = `it("a", () => {\n  expect(f()).toBe(1)\n  expect(g()).toBe(2)\n})\nit("b", () => {\n  expect(h()).toBe(3)\n})\n`
    const after = `it("a", () => {\n  expect(f()).toBe(1)\n  expect(true).toBe(true)\n})\nit("c", () => {\n  f()\n})\n`
    expect(kinds(await detect({ [T]: before }, { [T]: after }))).toEqual([
      "forbid deleted-tests", "forbid weakened-assertions@5", "forbid weakened-assertions@3",
    ])
  })

  test("process.exit in a test, and mocking the module under test", async () => {
    const after = `vi.mock("../src/fx")\nit("a", () => {\n  expect(f()).toBe(1)\n  process.exit(0)\n})\n`
    expect(kinds(await detect({ [T]: `it("a", () => {\n  expect(f()).toBe(1)\n})\n` }, { [T]: after })).sort()).toEqual(["flag mocks-of-class-under-test@1", "forbid exit-in-tests@4"])
  })

  test("main code: test imports, test-runner checks, suppressions, equality, catch-all, env branching", async () => {
    const after = [
      `import { fixture } from "../test/fixtures"`,
      "export class Fx {",
      "  equals(o: Fx) { return true }",
      "  run() {",
      "    if (process.env.VITEST) return 1",
      "    // @ts-ignore",
      "    try { g() } catch (e) { }",
      "    if (process.env.FEATURE_X) return 2",
      "  }",
      "}",
    ].join("\n")
    expect(kinds(await detect({ [M]: "export class Fx {}\n" }, { [M]: after })).sort()).toEqual([
      "flag catch-all-near-changed-code@7",
      "flag env-branching@5",
      "flag env-branching@8",
      "flag equality-overrides@3",
      "forbid new-suppressions@6",
      "forbid test-refs-in-main@1",
      "forbid test-refs-in-main@5",
    ])
  })

  test("whole-project ratchet values", async () => {
    const head = {
      [T]: `it("a", () => {\n  expect(f()).toBe(1)\n  expect(g()).toBe(2)\n})\ntest.fails("b", () => {\n  expect(1).toBe(2)\n})\nit("p", () => {\n  fc.assert(fc.property(fc.integer(), (n) => n === n))\n})\n`,
      [M]: "// eslint-disable-next-line\nexport const x = 1\n",
    }
    const out = await detect(head, head)
    expect(out.metrics["integrity/assertions-per-test"]?.value).toBe(3)
    expect(out.metrics["integrity/suppressions"]?.value).toBe(1)
    expect(out.metrics["integrity/quarantined-tests"]?.value).toBe(1)
    expect(out.metrics["integrity/property-tests"]?.value).toBe(2)
  })
})

describe("found by running Gauntlet on itself", () => {
  test("suppression words in code or strings aren't suppressions", async () => {
    const before = "export const x = 1\n"
    const after = 'export const MARKERS = /@ts-ignore|eslint-disable/\nexport const help = "use // @ts-expect-error sparingly"\n'
    expect(kinds(await detect({ [M]: before }, { [M]: after }))).toEqual([])
  })
})

import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import type { DetectorInput } from "@gauntlet/core"
import { Effect, Option } from "effect"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { parseDependencies } from "../src/dependencies.ts"
import { goDetector } from "../src/detectors.ts"
import { subsetTargets } from "../src/gates.ts"
import { onboard } from "../src/onboard.ts"
import { convertGoTest, parseCoverProfile, parseGremlins } from "../src/reports.ts"
import { runRules } from "../src/rules.ts"
import { enclosingSymbol, parseGo, stripLineComment } from "../src/syntax.ts"
import { isMainSource, isTestFile, packageDir } from "../src/toolchain.ts"

const lines = (rule: string, text: string) => runRules([rule], [{ path: "a.go", text }]).map((r) => r.locations?.[0]?.physicalLocation?.region?.startLine)

describe("Go rules", () => {
  test("no-floating-money looks at money-named floats in params, fields and vars", () => {
    expect(lines("go.no-floating-money", "package p\n\ntype T struct {\n\tAmount float64\n\tRatio float64\n}\n\nfunc f(price float32, n int) {}\n\nvar total float64\n")).toEqual([4, 8, 10])
  })
  test("no-panic, no-ignored-errors, no-global-vars", () => {
    expect(lines("go.no-panic", "package p\n\nfunc f() {\n\tpanic(\"x\")\n\tlog.Fatal(1)\n}\n")).toEqual([4, 5])
    expect(lines("go.no-ignored-errors", "package p\n\nfunc f() {\n\tv, _ := g()\n\t_ = h()\n\tw, err := g()\n\t_, _ = v, w\n}\n")).toEqual([4, 5])
    expect(lines("go.no-global-vars", "package p\n\nvar cache = map[string]int{}\n\nconst limit = 3\n\nfunc f() { var local = 1; _ = local }\n")).toEqual([3])
  })
})

describe("Go reports", () => {
  const events = (xs: object[]) => xs.map((x) => JSON.stringify(x)).join("\n")

  test("go test -json: ids, failures with file and line, subtests, skips", () => {
    const r = convertGoTest("unit", events([
      { Action: "run", Package: "example.com/svc/money", Test: "TestAdd" },
      { Action: "output", Package: "example.com/svc/money", Test: "TestAdd", Output: "    money_test.go:7: got 3\n" },
      { Action: "fail", Package: "example.com/svc/money", Test: "TestAdd" },
      { Action: "pass", Package: "example.com/svc/money", Test: "TestPositive/one" },
      { Action: "pass", Package: "example.com/svc/money", Test: "TestPositive" },
      { Action: "skip", Package: "example.com/svc/money", Test: "TestLater" },
      { Action: "fail", Package: "example.com/svc/money" },
    ]), "example.com/svc")
    expect(r.counts).toEqual({ executed: 3, passed: 2, failed: 1, errored: 0, skipped: 1 })
    expect(r.ids).toEqual(["example.com/svc/money.TestAdd", "example.com/svc/money.TestLater", "example.com/svc/money.TestPositive", "example.com/svc/money.TestPositive/one"])
    expect(r.run.results).toEqual([{
      ruleId: "test/failed", level: "error", message: { text: "example.com/svc/money.TestAdd: got 3" },
      locations: [{ physicalLocation: { artifactLocation: { uri: "money/money_test.go" }, region: { startLine: 7 } }, logicalLocations: [{ fullyQualifiedName: "example.com/svc/money.TestAdd", kind: "function" }] }],
    }])
  })

  test("a package that fails without a failing test is an errored test, never a silent green", () => {
    const r = convertGoTest("unit", events([
      { Action: "output", Package: "example.com/svc/broken", Output: "broken/x.go:3:1: syntax error\n" },
      { Action: "output", Package: "example.com/svc/broken", Output: "FAIL\texample.com/svc/broken [build failed]\n" },
      { Action: "fail", Package: "example.com/svc/broken" },
    ]), "example.com/svc")
    expect(r.counts).toEqual({ executed: 1, passed: 0, failed: 0, errored: 1, skipped: 0 })
    expect(r.run.results[0]!.message.text).toBe("example.com/svc/broken: broken/x.go:3:1: syntax error")
  })

  test("coverprofile becomes line coverage relative to the module", () => {
    const files = parseCoverProfile("mode: set\nexample.com/svc/money/money.go:3.30,3.44 1 1\nexample.com/svc/money/money.go:6.2,7.11 1 0\nexample.com/svc/money/money.go:7.3,8.1 1 1\n", "example.com/svc")
    expect(files).toEqual([{ path: "money/money.go", lines: new Map([[3, true], [6, false], [7, true], [8, true]]) }])
  })

  test("gremlins results, with not-viable mutants left out of the score", () => {
    const m = Option.getOrThrow(parseGremlins(JSON.stringify({ files: [{ file_name: "money/money.go", mutations: [
      { type: "CONDITIONALS_BOUNDARY", status: "LIVED", line: 6, column: 7 },
      { type: "ARITHMETIC_BASE", status: "KILLED", line: 3, column: 9 },
      { type: "INVERT_NEGATIVES", status: "NOT COVERED", line: 9, column: 2 },
      { type: "INCREMENT_DECREMENT", status: "NOT VIABLE", line: 9, column: 2 },
    ] }] })))
    expect(m.map((x) => x.outcome)).toEqual(["survived", "killed", "not-covered", "other"])
  })

  test("go.mod requirements, single-line and block", () => {
    expect(parseDependencies("go.mod", "module m\n\ngo 1.27\n\nrequire github.com/a/b v1.2.3\n\nrequire (\n\tgithub.com/c/d v0.1.0 // indirect\n\tgolang.org/x/e v0.2.0\n)\n"))
      .toEqual(["github.com/a/b@v1.2.3", "github.com/c/d@v0.1.0", "golang.org/x/e@v0.2.0"])
  })
})

describe("Go syntax and files", () => {
  test("symbols, comments and file kinds", () => {
    const tree = parseGo("package p\n\ntype M struct{}\n\nfunc (m *M) Add() int {\n\treturn 1\n}\n\nfunc Free() {}\n")
    expect(enclosingSymbol(tree, 6)).toBe("M.Add")
    expect(enclosingSymbol(tree, 9)).toBe("Free")
    expect(stripLineComment(`x := "a // b" // note`)).toBe(`x := "a // b" `)
    expect([isTestFile("a/b_test.go"), isMainSource("a/b.go"), isMainSource("vendor/x/y.go"), packageDir("a/b.go"), packageDir("b.go")]).toEqual([true, true, false, "./a", "."])
  })

  test("a rerun selects packages from files, and single tests from ids", () => {
    expect(subsetTargets({ files: ["money/money_test.go"], ids: [], seed: 1 }, "example.com/svc")).toEqual({ packages: ["./money"], run: undefined })
    expect(subsetTargets({ files: [], ids: ["example.com/svc/money.TestAdd", "example.com/svc.TestRoot/sub"], seed: 1 }, "example.com/svc")).toEqual({ packages: [".", "./money"], run: "^(TestAdd|TestRoot)$" })
  })

  test("onboarding proposes lint and mutation only when configured", () => {
    const bare = onboard({ files: ["go.mod", "a.go", "a_test.go", "testdata/x.json"], read: () => undefined })
    expect(bare.fast).toEqual(["build"])
    expect(bare.verify).toEqual(["coverage ratchet on changed"])
    expect(bare.protect).toEqual({ tests: ["**/*_test.go"], fixtures: ["testdata/**"], config: [] })
    const configured = onboard({ files: ["go.mod", "a.go", "a_test.go", ".golangci.yml", ".gremlins.yaml"], read: () => undefined })
    expect(configured.fast).toEqual(["build", "lint ratchet"])
    expect(configured.verify).toEqual(["coverage ratchet on changed", "mutation ratchet on changed"])
    expect(configured.setup).toEqual([])
  })
})

const detect = (base: Record<string, string>, head: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "gauntlet-go-"))
  for (const [p, t] of Object.entries(head)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), t)
  }
  const paths = [...new Set([...Object.keys(base), ...Object.keys(head)])].sort()
  const files = paths.flatMap((p) => base[p] === head[p] ? [] : [{ path: p, status: base[p] === undefined ? "added" as const : "modified" as const, added: 1, removed: 0 }])
  const addedLines = new Map(paths.map((p) => {
    const before = new Set((base[p] ?? "").split("\n"))
    return [p, (head[p] ?? "").split("\n").flatMap((text, i) => (before.has(text) ? [] : [{ line: i + 1, text }]))] as const
  }))
  const input: DetectorInput = {
    ir: undefined as never,
    facts: { base: "b", head: "h", files, linesChanged: 0, protectedTouched: [], zonesTouched: [], dependencyChanges: [], budgetsChanged: [], policyChanged: false, baselineChanged: false, gauntletChanged: false, addedLines },
    readBase: (p) => Effect.succeed(Option.fromNullishOr(base[p])),
    readHead: (p) => Effect.succeed(Option.fromNullishOr(head[p])),
    isTestPath: (p) => p.endsWith("_test.go"),
    headFiles: Object.keys(head),
    dir,
  }
  return Effect.runPromise(goDetector.run(input).pipe(Effect.provide(BunServices.layer)))
}

const TEST = `package money

import "testing"

func TestAdd(t *testing.T) {
	if Add(1, 2) != 3 {
		t.Errorf("wrong")
	}
	if Add(0, 0) != 0 {
		t.Error("zero")
	}
}

func TestPositive(t *testing.T) {
	if !Positive(1) {
		t.Fatal("1")
	}
}
`

describe("Go detectors", () => {
  const kinds = (r: Awaited<ReturnType<typeof detect>>) => r.findings.map((f) => `${f.kind} ${f.check}${f.line ? `:${f.line}` : ""}`)

  test("skips, removed tests, weakened assertions, tautologies and exits", async () => {
    const head = TEST
      .replace("func TestPositive(t *testing.T) {", "func TestPositive(t *testing.T) {\n\tt.Skip(\"later\")")
      .replace("\tif Add(0, 0) != 0 {\n\t\tt.Error(\"zero\")\n\t}\n", "\tassert.Equal(t, 1, 1)\n\tos.Exit(0)\n")
    const r = await detect({ "money/money_test.go": TEST }, { "money/money_test.go": head })
    expect(kinds(r)).toEqual(["forbid new-skips:14", "forbid weakened-assertions:9", "forbid exit-in-tests:10"])
  })

  test("os.Exit in TestMain is how Go test binaries end, not a cheat", async () => {
    const r = await detect({}, { "money/main_test.go": "package money\n\nimport (\n\t\"os\"\n\t\"testing\"\n)\n\nfunc TestMain(m *testing.M) { os.Exit(m.Run()) }\n" })
    expect(kinds(r)).toEqual([])
  })

  test("new tests without assertions; fuzz tests are exempt and count as property tests", async () => {
    const r = await detect({}, { "money/new_test.go": "package money\n\nimport \"testing\"\n\nfunc TestNothing(t *testing.T) { Add(1, 2) }\n\nfunc FuzzAdd(f *testing.F) { f.Fuzz(func(t *testing.T, a int) { Add(a, 0) }) }\n" })
    expect(kinds(r)).toEqual(["forbid weakened-assertions:5"])
    expect(r.metrics["integrity/property-tests"]?.value).toBe(1)
  })

  test("main code: suppressions, the testing package, equality, recover and env branching", async () => {
    const main = "package money\n\nimport (\n\t\"os\"\n\t\"testing\"\n)\n\ntype M struct{}\n\nfunc (m M) Equal(o M) bool { return true }\n\nfunc Add(a, b int) int { return a + b } //nolint\n\nfunc Mode() string {\n\tdefer func() { recover() }()\n\tif os.Getenv(\"CI\") != \"\" {\n\t\treturn \"ci\"\n\t}\n\tif testing.Testing() {\n\t\treturn \"test\"\n\t}\n\treturn \"\"\n}\n"
    const r = await detect({}, { "money/money.go": main })
    expect(kinds(r)).toEqual([
      "forbid new-suppressions:12", "forbid test-refs-in-main:5", "forbid test-refs-in-main:19",
      "flag equality-overrides:10", "flag catch-all-near-changed-code:15", "flag env-branching:16",
    ])
  })

  test("a test file that fakes a struct of the package under test", async () => {
    const r = await detect({ "money/ledger.go": "package money\n\ntype Ledger struct{}\n\ntype Store interface{ Get() }\n" }, {
      "money/ledger.go": "package money\n\ntype Ledger struct{}\n\ntype Store interface{ Get() }\n",
      "money/ledger_test.go": "package money\n\ntype fakeLedger struct{}\n\ntype mockStore struct{}\n",
    })
    expect(kinds(r)).toEqual(["flag mocks-of-class-under-test:3"])
  })
})

describe("TestMain", () => {
  test("a TestMain that never runs the tests is forbidden", async () => {
    const r = await detect({}, { "money/main_test.go": "package money\n\nimport (\n\t\"os\"\n\t\"testing\"\n)\n\nfunc TestMain(m *testing.M) { os.Exit(0) }\n" })
    expect(r.findings.map((f) => `${f.check}:${f.line}`)).toEqual(["exit-in-tests:8"])
    expect(r.findings[0]!.message).toBe("TestMain never calls m.Run(), so none of the package's tests run.")
  })
})

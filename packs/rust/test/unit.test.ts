import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import type { DetectorInput } from "@gauntlet/core"
import { Effect, Option } from "effect"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { parseDependencies } from "../src/dependencies.ts"
import { rustDetector } from "../src/detectors.ts"
import { subsetFilter } from "../src/gates.ts"
import { onboard } from "../src/onboard.ts"
import { convertClippy, parseLcov, parseMutants } from "../src/reports.ts"
import { runRules } from "../src/rules.ts"
import { attributesOf, enclosingSymbol, inTestModule, ofType, parseRust, stripLineComment } from "../src/syntax.ts"
import { tamper } from "../src/tamper.ts"
import { isMainSource, isTestFile, modulePath } from "../src/toolchain.ts"

const lines = (rule: string, text: string) => runRules([rule], [{ path: "src/a.rs", text }]).map((r) => r.locations?.[0]?.physicalLocation?.region?.startLine)

describe("Rust rules", () => {
  test("no-floating-money looks at money-named floats", () => {
    expect(lines("rust.no-floating-money", "struct P {\n    amount: f64,\n    ratio: f64,\n}\nfn f(price: f32, n: i32) {\n    let total: f64 = 0.0;\n}\n")).toEqual([2, 5, 6])
  })
  test("no-unwrap and no-panic skip test modules", () => {
    const code = "fn f() -> i32 {\n    g().unwrap();\n    h().expect(\"x\");\n    todo!()\n}\n#[cfg(test)]\nmod tests {\n    fn t() { g().unwrap(); panic!(\"x\") }\n}\n"
    expect(lines("rust.no-unwrap", code)).toEqual([2, 3])
    expect(lines("rust.no-panic", code)).toEqual([4])
  })
  test("no-unsafe and no-mut-statics", () => {
    expect(lines("rust.no-unsafe", "unsafe fn a() {}\nfn b() {\n    unsafe { c() }\n}\n")).toEqual([1, 3])
    expect(lines("rust.no-mut-statics", "static mut N: i32 = 0;\nstatic M: i32 = 0;\n")).toEqual([1])
  })
})

describe("Rust reports", () => {
  test("clippy JSON: lints only, deduplicated across targets, relative paths", () => {
    const msg = (code: string | null, level: string, file: string, line: number) => JSON.stringify({ reason: "compiler-message", message: { code: code ? { code } : null, level, message: `m ${code}`, spans: [{ file_name: file, line_start: line, is_primary: true }] } })
    const run = convertClippy([
      msg("clippy::needless_return", "warning", "src/infra/ledger.rs", 16),
      msg("clippy::needless_return", "warning", "src/infra/ledger.rs", 16),
      msg("E0308", "error", "src/a.rs", 1),
      msg(null, "warning", "src/a.rs", 2),
      JSON.stringify({ reason: "build-finished", success: true }),
    ].join("\n"), "/repo")
    expect(run.results.map((r) => `${r.ruleId}@${r.locations?.[0]?.physicalLocation?.artifactLocation?.uri}:${r.locations?.[0]?.physicalLocation?.region?.startLine}`)).toEqual(["clippy::needless_return@src/infra/ledger.rs:16"])
  })

  test("lcov and cargo-mutants outcomes", () => {
    expect(parseLcov("SF:/repo/src/a.rs\nDA:1,1\nDA:2,0\nend_of_record\n", "/repo")).toEqual([{ path: "src/a.rs", lines: new Map([[1, true], [2, false]]) }])
    const mutant = (summary: string, line: number) => ({ scenario: { Mutant: { name: `src/a.rs:${line}:5: replace add -> i64 with 0`, file: "src/a.rs", span: { start: { line } } } }, summary })
    const m = Option.getOrThrow(parseMutants(JSON.stringify({ outcomes: [{ scenario: "Baseline", summary: "Success" }, mutant("CaughtMutant", 3), mutant("MissedMutant", 4), mutant("Unviable", 5), mutant("Timeout", 6)] })))
    expect(m.map((x) => `${x.line}:${x.outcome}`)).toEqual(["3:killed", "4:survived", "5:other", "6:timeout"])
    expect(m[0]!.description).toBe("replace add -> i64 with 0")
  })

  test("Cargo.toml dependencies in their usual forms", () => {
    expect(parseDependencies("Cargo.toml", "[package]\nname = \"x\"\n\n[dependencies]\nserde = \"1\"\ntokio = { version = \"1.40\", features = [\"full\"] }\nlocal = { path = \"../local\" }\n\n[dev-dependencies]\nproptest = \"1.5\"\n\n[target.'cfg(unix)'.dependencies]\nlibc = \"0.2\"\n\n[dependencies.rand]\nversion = \"0.9\"\n"))
      .toEqual(["libc@0.2", "local@*", "proptest@1.5", "rand@0.9", "serde@1", "tokio@1.40"])
  })
})

describe("Rust syntax and files", () => {
  test("attributes, test modules, symbols and module paths", () => {
    const tree = parseRust("struct M;\nimpl M {\n    fn add(&self) -> i32 {\n        1\n    }\n}\n#[cfg(test)]\nmod tests {\n    #[test]\n    #[ignore = \"slow\"]\n    fn adds() {}\n}\n")
    const adds = ofType(tree.rootNode, "function_item").find((f) => f.text.includes("adds"))!
    expect(attributesOf(adds)).toEqual(["test", "ignore = \"slow\""])
    expect(inTestModule(adds)).toBe(true)
    expect(enclosingSymbol(tree, 4)).toBe("M::add")
    expect(stripLineComment(`let s = "a // b"; // note`)).toBe(`let s = "a // b"; `)
    expect([modulePath("src/domain/money.rs"), modulePath("src/domain/mod.rs"), modulePath("src/lib.rs"), modulePath("crates/core/src/x.rs")]).toEqual(["domain::money", "domain", "", "x"])
    expect([isTestFile("tests/money.rs"), isMainSource("src/a.rs"), isMainSource("target/debug/x.rs"), isMainSource("build.rs")]).toEqual([true, true, false, false])
  })

  test("rerun filters: integration binaries, module paths and exact test names", () => {
    expect(subsetFilter({ files: ["tests/money.rs", "src/domain/money.rs"], ids: ["svc::fx.converts"], seed: 1 }, )).toBe("binary(=money) | test(/^domain::money::/) | test(=converts)")
    expect(subsetFilter({ files: ["README.md"], ids: [], seed: 1 })).toBeUndefined()
  })

  test("onboarding proposes mutation only with a cargo-mutants config", () => {
    const bare = onboard({ files: ["Cargo.toml", "src/lib.rs", "tests/a.rs", "clippy.toml"], read: () => undefined })
    expect(bare.fast).toEqual(["build", "lint ratchet"])
    expect(bare.verify).toEqual(["coverage ratchet on changed"])
    expect(bare.protect).toEqual({ tests: ["tests/**"], fixtures: [], config: ["clippy.toml"] })
    expect(onboard({ files: ["Cargo.toml", "src/lib.rs", ".cargo/mutants.toml"], read: () => undefined }).verify).toEqual(["coverage ratchet on changed", "mutation ratchet on changed"])
  })
})

const detect = (base: Record<string, string>, head: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "gauntlet-rs-"))
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
    isTestPath: (p) => p.startsWith("tests/"),
    headFiles: Object.keys(head),
    dir,
  }
  return Effect.runPromise(rustDetector.run(input).pipe(Effect.provide(BunServices.layer)))
}
const kinds = (r: Awaited<ReturnType<typeof detect>>) => r.findings.map((f) => `${f.kind} ${f.check}${f.line ? `:${f.line}` : ""}`)

const TEST = "use svc::add;\n\n#[test]\nfn adds() {\n    assert_eq!(add(1, 2), 3);\n    assert_eq!(add(0, 0), 0);\n}\n\n#[test]\nfn positive() {\n    assert!(add(1, 1) > 0);\n}\n"

describe("Rust detectors", () => {
  test("ignores, removed and weakened tests, tautologies and exits", async () => {
    const head = TEST.replace("#[test]\nfn positive", "#[test]\n#[ignore]\nfn positive").replace("    assert_eq!(add(0, 0), 0);\n", "    assert_eq!(1, 1);\n    std::process::exit(0);\n")
    expect(kinds(await detect({ "tests/a.rs": TEST }, { "tests/a.rs": head }))).toEqual(["forbid new-skips:12", "forbid weakened-assertions:6", "forbid exit-in-tests:7"])
  })

  test("inline test modules are tests too, and an empty new test is forbidden", async () => {
    const main = "pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn adds() {\n        add(1, 2);\n    }\n\n    #[test]\n    fn checks() {\n        if add(1, 2) != 3 {\n            panic!(\"wrong\");\n        }\n    }\n}\n"
    expect(kinds(await detect({}, { "src/lib.rs": main }))).toEqual(["forbid weakened-assertions:10"])
  })

  test("main code: suppressions, cfg(test), equality impls, catch_unwind, swallowed errors, env branching", async () => {
    const main = "#[allow(dead_code)]\nfn a() -> bool {\n    if cfg!(test) {\n        return true;\n    }\n    if std::env::var(\"CI\").is_ok() {\n        return false;\n    }\n    let _ = std::panic::catch_unwind(|| b());\n    match c() {\n        Ok(v) => v,\n        Err(_) => {}\n    }\n    true\n}\n#[cfg(not(test))]\nfn real() {}\nstruct M;\nimpl PartialEq for M {\n    fn eq(&self, _: &M) -> bool { true }\n}\n"
    expect(kinds(await detect({}, { "src/lib.rs": main }))).toEqual([
      "forbid new-suppressions:1", "forbid test-refs-in-main:3", "forbid test-refs-in-main:16",
      "flag equality-overrides:19", "flag env-branching:6", "flag catch-all-near-changed-code:9", "flag catch-all-near-changed-code:12",
    ])
  })

  test("proptest counts as property tests; a flaky ignore counts as quarantined; mocking a crate struct is flagged", async () => {
    const r = await detect({ "src/lib.rs": "pub struct Ledger;\n" }, {
      "src/lib.rs": "pub struct Ledger;\n",
      "tests/p.rs": "proptest! {\n    #[test]\n    fn adds(x in 0..10i32) {\n        prop_assert!(x < 10);\n    }\n}\n\n#[test]\n#[ignore = \"flaky on CI\"]\nfn later() {\n    assert!(true);\n}\n\nmock! {\n    pub Ledger {}\n}\n",
    })
    expect(r.metrics["integrity/property-tests"]?.value).toBe(1)
    expect(r.metrics["integrity/quarantined-tests"]?.value).toBe(1)
    expect(kinds(r)).toContain("flag mocks-of-class-under-test:14")
  })
})

describe("Rust tamper fixtures", () => {
  test("each fixture is built from the project's own files", async () => {
    const files: Record<string, string> = {
      "Cargo.toml": "[package]\nname = \"svc\"\n",
      "src/lib.rs": "pub fn add(a: i64, b: i64) -> i64 {\n    a + b\n}\n",
      "tests/add.rs": "use svc::add;\n\n#[test]\nfn adds() {\n    assert_eq!(add(1, 2), 3);\n}\n",
    }
    const out = await Effect.runPromise(tamper({ files: Object.keys(files).sort(), read: (p) => Effect.succeed(Option.fromNullishOr(files[p])), ir: undefined as never, isTestPath: (p) => p.startsWith("tests/") }))
    expect(out.map((t) => t.fixture)).toEqual(["deleted-test", "added-skip", "weakened-assertion", "added-suppression", "test-id-in-main", "hardcoded-expected-value", "edited-test-setup"])
    const content = (f: string) => out.find((t) => t.fixture === f)!.edits[0]!.content!
    expect(content("deleted-test")).not.toContain("fn adds")
    expect(content("deleted-test")).not.toContain("#[test]")
    expect(content("added-skip")).toContain("#[test]\n#[ignore]\nfn adds")
    expect(content("weakened-assertion")).not.toContain("assert_eq!")
    expect(content("added-suppression")).toStartWith("#[allow(dead_code)]\npub fn add")
    expect(content("test-id-in-main")).toContain("cfg!(test)")
    expect(content("hardcoded-expected-value")).toContain("pub fn add(a: i64, b: i64) -> i64 {\n    3\n}")
    expect(out.find((t) => t.fixture === "edited-test-setup")!.edits[0]).toEqual({ path: ".config/nextest.toml", content: "[profile.default]\nretries = 5\n" })
  })
})

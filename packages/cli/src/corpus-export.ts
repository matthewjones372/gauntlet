// `gauntlet corpus --export` (spec 0002): writes the tamper corpus under
// corpus/tamper/, the positive cases from each pack's own selftest tamper
// generator and three hand-written negatives per pack, as patches against the
// pack's fixture in examples/fixtures. A maintainer runs it, reviews the
// output and commits it; `gauntlet corpus` runs what's committed.
import { testPathMatcher } from "@gauntlet/core"
import { compilePolicy } from "@gauntlet/dsl"
import { Effect, Option } from "effect"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { INSTALLED_PACKS } from "./packs.ts"

const FIXTURES: Record<string, string> = {
  jvm: "kotlin-service",
  typescript: "ts-service",
  python: "py-service",
  go: "go-service",
  rust: "rust-service",
  scala: "scala-service",
  clojure: "clojure-service",
}

/** Selftest fixtures that the integrity detectors catch, and the finding each must produce. */
const POSITIVES: Record<string, { finding: string; note: string }> = {
  "deleted-test": { finding: "deleted-tests", note: "A test is deleted outright. The change must report the missing test." },
  "added-skip": { finding: "new-skips", note: "A passing test is skipped the way its framework spells it. A skip hides the test from every later run." },
  "weakened-assertion": { finding: "weakened-assertions", note: "An assertion is removed from a test, so the test checks less than it did." },
  "added-suppression": { finding: "new-suppressions", note: "A lint or compiler suppression is added to main code, silencing a check instead of fixing the cause." },
  "test-id-in-main": { finding: "test-refs-in-main", note: "Main code starts depending on the test framework, the first step towards behaving differently under test." },
}

interface Edit { readonly path: string; readonly from: string; readonly to: string }

/** Negatives: each must not fire any integrity forbid. */
const NEGATIVES: Record<string, Record<"renamed-test" | "extracted-helper" | "tightened-assertion", ReadonlyArray<Edit>>> = {
  go: {
    "renamed-test": [{ path: "domain/money_test.go", from: "func TestAdds(", to: "func TestAddsTwoAmounts(" }],
    "extracted-helper": [
      { path: "domain/money_test.go", from: "func TestAdds(t *testing.T) {\n\tgot, err := Add(Money{100, \"EUR\"}, Money{200, \"EUR\"})\n\tif err != nil || got != (Money{300, \"EUR\"}) {", to: "func eur(minor int64) Money { return Money{minor, \"EUR\"} }\n\nfunc TestAdds(t *testing.T) {\n\tgot, err := Add(eur(100), eur(200))\n\tif err != nil || got != eur(300) {" },
    ],
    "tightened-assertion": [{ path: "domain/money_test.go", from: "Money{1, \"USD\"}); err == nil {", to: "Money{1, \"USD\"}); err == nil || err.Error() == \"\" {" }],
  },
  jvm: {
    "renamed-test": [{ path: "src/test/kotlin/svc/domain/MoneyTest.kt", from: "fun adds()", to: "fun addsTwoAmounts()" }],
    "extracted-helper": [
      { path: "src/test/kotlin/svc/domain/MoneyTest.kt", from: "class MoneyTest {\n", to: "class MoneyTest {\n    private fun eur(minor: Long) = Money(minor, \"EUR\")\n\n" },
      { path: "src/test/kotlin/svc/domain/MoneyTest.kt", from: "assertEquals(Money(300, \"EUR\"), Money(100, \"EUR\") + Money(200, \"EUR\"))", to: "assertEquals(eur(300), eur(100) + eur(200))" },
    ],
    "tightened-assertion": [{ path: "src/test/kotlin/svc/domain/MoneyTest.kt", from: "assertTrue(Money(1, \"EUR\").isPositive())", to: "assertEquals(true, Money(1, \"EUR\").isPositive())" }],
  },
  python: {
    "renamed-test": [{ path: "tests/domain/test_money.py", from: "def test_adds():", to: "def test_adds_two_amounts():" }],
    "extracted-helper": [
      { path: "tests/domain/test_money.py", from: "\n\ndef test_adds():\n    assert add(Money(100, \"EUR\"), Money(200, \"EUR\")) == Money(300, \"EUR\")", to: "\n\ndef eur(minor):\n    return Money(minor, \"EUR\")\n\n\ndef test_adds():\n    assert add(eur(100), eur(200)) == eur(300)" },
    ],
    "tightened-assertion": [{ path: "tests/domain/test_money.py", from: "assert is_positive(Money(1, \"EUR\"))", to: "assert is_positive(Money(1, \"EUR\")) is True" }],
  },
  typescript: {
    "renamed-test": [{ path: "test/domain/money.test.ts", from: "it(\"adds\",", to: "it(\"adds two amounts\"," }],
    "extracted-helper": [
      { path: "test/domain/money.test.ts", from: "import { add, isPositive, money } from \"../../src/domain/money.ts\"\n", to: "import { add, isPositive, money } from \"../../src/domain/money.ts\"\n\nconst eur = (minor: bigint) => money(minor, \"EUR\")\n" },
      { path: "test/domain/money.test.ts", from: "expect(add(money(100n, \"EUR\"), money(200n, \"EUR\"))).toEqual(money(300n, \"EUR\"))", to: "expect(add(eur(100n), eur(200n))).toEqual(eur(300n))" },
    ],
    "tightened-assertion": [{ path: "test/domain/money.test.ts", from: ".toEqual(money(300n, \"EUR\"))", to: ".toStrictEqual(money(300n, \"EUR\"))" }],
  },
  rust: {
    "renamed-test": [{ path: "tests/money.rs", from: "fn adds()", to: "fn adds_two_amounts()" }],
    "extracted-helper": [
      { path: "tests/money.rs", from: "use svc::domain::money::{add, is_positive, Money};\n", to: "use svc::domain::money::{add, is_positive, Money};\n\nfn eur(minor: i64) -> Money {\n    Money::new(minor, \"EUR\")\n}\n" },
      { path: "tests/money.rs", from: "assert_eq!(add(&Money::new(100, \"EUR\"), &Money::new(200, \"EUR\")), Ok(Money::new(300, \"EUR\")));", to: "assert_eq!(add(&eur(100), &eur(200)), Ok(eur(300)));" },
    ],
    "tightened-assertion": [{ path: "tests/money.rs", from: "assert!(is_positive(&Money::new(1, \"EUR\")));", to: "assert_eq!(is_positive(&Money::new(1, \"EUR\")), true);" }],
  },
  scala: {
    "renamed-test": [{ path: "src/test/scala/svc/domain/MoneySpec.scala", from: "test(\"adds\")", to: "test(\"adds two amounts\")" }],
    "extracted-helper": [
      { path: "src/test/scala/svc/domain/MoneySpec.scala", from: "class MoneySpec extends AnyFunSuite:\n", to: "class MoneySpec extends AnyFunSuite:\n  private def eur(minor: Long): Money = Money(minor, \"EUR\")\n\n" },
      { path: "src/test/scala/svc/domain/MoneySpec.scala", from: "assert(Money.add(Money(100, \"EUR\"), Money(200, \"EUR\")) == Right(Money(300, \"EUR\")))", to: "assert(Money.add(eur(100), eur(200)) == Right(eur(300)))" },
    ],
    "tightened-assertion": [{ path: "src/test/scala/svc/domain/MoneySpec.scala", from: "assert(Money.isPositive(Money(1, \"EUR\")))", to: "assert(Money.isPositive(Money(1, \"EUR\")) == true)" }],
  },
  clojure: {
    "renamed-test": [{ path: "test/svc/domain/money_test.clj", from: "(deftest adds\n", to: "(deftest adds-two-amounts\n" }],
    "extracted-helper": [
      { path: "test/svc/domain/money_test.clj", from: "(deftest adds\n  (is (= (money/money 5 \"EUR\") (money/add (money/money 2 \"EUR\") (money/money 3 \"EUR\")))))", to: "(defn- eur [minor]\n  (money/money minor \"EUR\"))\n\n(deftest adds\n  (is (= (eur 5) (money/add (eur 2) (eur 3)))))" },
    ],
    "tightened-assertion": [{ path: "test/svc/domain/money_test.clj", from: "(is (money/positive? (money/money 1 \"EUR\")))", to: "(is (true? (money/positive? (money/money 1 \"EUR\"))))" }],
  },
}

const NEGATIVE_NOTES: Record<string, string> = {
  "renamed-test": "A test is renamed and its body is unchanged. Nothing was weakened, so nothing should fire.",
  "extracted-helper": "Setup is moved out of a test into a helper it calls. The test asserts exactly what it did.",
  "tightened-assertion": "An assertion is replaced with a stricter equivalent. Verification got stronger, not weaker.",
}

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "corpus", GIT_AUTHOR_EMAIL: "corpus@gauntlet.invalid", GIT_COMMITTER_NAME: "corpus", GIT_COMMITTER_EMAIL: "corpus@gauntlet.invalid" } })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`)
  return r.stdout.toString()
}

const trackedFiles = (ROOT: string, fixture: string) =>
  git(ROOT, "ls-files", `examples/fixtures/${fixture}`).trim().split("\n").map((p) => p.slice(`examples/fixtures/${fixture}/`.length))

/** The patch that turns the fixture into the fixture with `files` replaced (null deletes). */
const patchFor = (ROOT: string, fixture: string, files: Record<string, string | null>) => {
  const dir = mkdtempSync(join(tmpdir(), "gauntlet-corpus-export-"))
  try {
    for (const p of trackedFiles(ROOT, fixture)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true })
      writeFileSync(join(dir, p), readFileSync(join(ROOT, "examples/fixtures", fixture, p)))
    }
    git(dir, "init", "-q", "-b", "main")
    git(dir, "add", "-A")
    git(dir, "commit", "-q", "-m", "base")
    for (const [p, text] of Object.entries(files)) {
      if (text === null) rmSync(join(dir, p), { force: true })
      else {
        mkdirSync(dirname(join(dir, p)), { recursive: true })
        writeFileSync(join(dir, p), text)
      }
    }
    git(dir, "add", "-A")
    return git(dir, "diff", "--cached", "--no-color")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const writeCase = (OUT: string, pack: string, name: string, patch: string, expected: object, note: string) => {
  if (patch.trim() === "") throw new Error(`${pack}/${name}: the edit changed nothing`)
  const dir = join(OUT, pack, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "tamper.patch"), patch)
  writeFileSync(join(dir, "expected.json"), `${JSON.stringify(expected, null, 2)}\n`)
  writeFileSync(join(dir, "NOTE.md"), `# ${pack}: ${name}\n\n${note}\n`)
}

/** Rewrites corpus/tamper under `ROOT` from the fixtures and the packs' tamper generators; returns the packs written. */
export const exportCorpus = async (ROOT: string): Promise<string[]> => {
  const OUT = join(ROOT, "corpus", "tamper")
  const written: string[] = []
  rmSync(OUT, { recursive: true, force: true })
  for (const pack of INSTALLED_PACKS) {
    const name = pack.spec.name
    const fixture = FIXTURES[name]
    if (!fixture || !pack.tamper) continue
    const fixtureDir = join(ROOT, "examples/fixtures", fixture)
    const read = (p: string) => readFileSync(join(fixtureDir, p), "utf8")
    const compiled = compilePolicy({ file: ".gauntlet/policy.gx", text: read(".gauntlet/policy.gx") }, INSTALLED_PACKS.map((p) => p.spec))
    if (compiled._tag === "Invalid") throw new Error(`${fixture}'s policy doesn't compile`)
    const ir = compiled.compiled.ir
    const files = trackedFiles(ROOT, fixture)
    const tamperings = await Effect.runPromise(pack.tamper({
      files,
      read: (p) => Effect.sync(() => (files.includes(p) ? Option.some(read(p)) : Option.none())),
      ir,
      isTestPath: testPathMatcher(ir),
    }) as Effect.Effect<ReadonlyArray<{ fixture: string; description: string; edits: ReadonlyArray<{ path: string; content: string | null }> }>, never, never>)
    for (const [fixtureName, { finding, note }] of Object.entries(POSITIVES)) {
      const t = tamperings.find((x) => x.fixture === fixtureName)
      if (!t) continue
      const patch = patchFor(ROOT, fixture, Object.fromEntries(t.edits.map((e) => [e.path, e.content])))
      writeCase(OUT, name, fixtureName, patch, { kind: "positive", fixture, finding }, `${note}\n\nGenerated from the ${name} pack's selftest tamper: ${t.description}.`)
    }
    for (const [caseName, edits] of Object.entries(NEGATIVES[name] ?? {})) {
      const changed: Record<string, string> = {}
      for (const e of edits) {
        const current = changed[e.path] ?? read(e.path)
        if (!current.includes(e.from)) throw new Error(`${name}/${caseName}: ${e.path} doesn't contain ${JSON.stringify(e.from)}`)
        changed[e.path] = current.replace(e.from, e.to)
      }
      writeCase(OUT, name, caseName, patchFor(ROOT, fixture, changed), { kind: "negative", fixture }, NEGATIVE_NOTES[caseName]!)
    }
    written.push(name)
  }
  return written
}

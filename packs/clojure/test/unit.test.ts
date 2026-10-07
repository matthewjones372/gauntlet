import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import type { DetectorInput } from "@gauntlet/core"
import { Effect, Option } from "effect"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { parseDependencies } from "../src/dependencies.ts"
import { clojureDetector, suppressionLines, testDefinitions } from "../src/detectors.ts"
import { onboard } from "../src/onboard.ts"
import { convertKondo, focusOf, parseLcov, tidyJUnit } from "../src/reports.ts"
import { runRules } from "../src/rules.ts"
import { enclosingSymbol, head, live, nsOf, read, stripLineComment } from "../src/syntax.ts"
import { tamper } from "../src/tamper.ts"
import { buildTool, isMainSource, isTestFile, nsOfPath, sourceRoots, testRoots } from "../src/toolchain.ts"
import { fixture, project } from "./sources.ts"

describe("the Clojure reader", () => {
  test("forms, positions, metadata, discards and reader macros", () => {
    const forms = read("(ns a.b)\n\n;; (deftest commented)\n(deftest ^:kaocha/skip t\n  #_(is false)\n  (is (= \"a;b\" (str \\a \";b\"))))\n#{1 2} #\"re\" @x 'q `(~a ~@b) #(inc %) #?(:clj 1) #inst \"2026-01-01\" ^{:doc \"d\"} m")
    expect(forms.map((f) => f.type)).toEqual(["list", "list", "set", "regex", "symbol", "symbol", "list", "fn", "list", "string", "symbol"])
    const deftest = forms[1]!
    expect([deftest.line, deftest.endLine, deftest.children[1]!.meta]).toEqual([4, 6, [":kaocha/skip"]])
    expect([...live(forms)].filter((f) => head(f) === "is")).toHaveLength(1)
    expect(forms.at(-1)!.meta).toEqual(["{:doc \"d\"}"])
  })

  test("unbalanced input reads as far as it can", () => {
    expect(read("(defn f [x]\n  (+ x 1)").map((f) => head(f))).toEqual(["defn"])
    expect(read(")) (a)").map((f) => head(f))).toEqual(["a"])
  })

  test("ns requires, including prefix lists; enclosing symbols; comments", () => {
    const ns = nsOf(read("(ns a.core\n  (:require [clojure.string :as str]\n            [clojure [set :as set] walk]\n            a.util)\n  (:import (java.util UUID)))"))
    expect(ns?.requires.map((r) => `${r.lib}:${r.line}`)).toEqual(["clojure.string:2", "clojure.set:3", "clojure.walk:3", "a.util:4"])
    expect(enclosingSymbol(read(fixture("clojure-service/src/svc/domain/money.clj")), 8)).toBe("svc.domain.money/add")
    expect(stripLineComment("(str \"a;b\") ; note")).toBe("(str \"a;b\")")
  })
})

describe("Clojure files and projects", () => {
  test("file kinds, roots, namespaces and build tools", () => {
    expect([isTestFile("test/svc/a_test.clj"), isMainSource("src/svc/a.clj"), isMainSource("dev/user.clj"), isMainSource("project.clj"), isMainSource("src/a.cljs")]).toEqual([true, true, false, false, false])
    expect(nsOfPath("test/svc/domain/money_test.clj")).toBe("svc.domain.money-test")
    expect([sourceRoots(["src/a.clj", "test/a_test.clj"]), testRoots(["src/a.clj", "test/a_test.clj", "test-integration/b_test.clj"])]).toEqual([["src"], ["test", "test-integration"]])
    expect([buildTool(["deps.edn", "project.clj"]), buildTool(["project.clj"]), buildTool(["build.sbt"])]).toEqual(["deps", "lein", undefined])
  })

  test("dependencies from deps.edn and project.clj", () => {
    expect(parseDependencies("deps.edn", fixture("clojure-service/deps.edn"))).toEqual(["org.clojure/clojure@1.12.6", "org.clojure/test.check@1.1.3"])
    expect(parseDependencies("project.clj", "(defproject calc \"0.1.0\"\n  ;; [old/lib \"1\"]\n  :dependencies [[org.clojure/clojure \"1.12.6\"] [ring \"1.13.0\"]])")).toEqual(["org.clojure/clojure@1.12.6", "ring@1.13.0"])
  })

  test("onboarding: suites and coverage always, lint with a clj-kondo config, never mutation", () => {
    const files = Object.keys(project("clojure-service")).sort()
    const o = onboard({ files, read: () => undefined })
    expect(o.fast).toEqual(["build", "lint ratchet"])
    expect(o.verify).toEqual(["coverage ratchet on changed"])
    expect(o.protect).toEqual({ tests: ["test/**"], fixtures: [], config: ["deps.edn", "tests.edn", ".clj-kondo/**"] })
    expect(o.suites).toEqual([{ name: "unit", location: "test/**" }])
    const lein = onboard({ files: Object.keys(project("clojure-lein")), read: () => undefined })
    expect([lein.fast, lein.protect.config, lein.setup[0]]).toEqual([["build"], ["project.clj"], "Install clj-kondo and add a .clj-kondo/config.edn to gate lint."])
  })
})

describe("Clojure reports", () => {
  test("clj-kondo JSON becomes SARIF", () => {
    const run = Option.getOrThrow(convertKondo(JSON.stringify({ findings: [{ filename: "/repo/src/a.clj", row: 4, level: "warning", type: "unused-binding", message: "unused binding x" }, { filename: "src/b.clj", level: "error", type: "syntax", message: "EOF" }] }), "/repo"))
    expect(run.results.map((r) => `${r.ruleId}:${r.level}:${r.locations![0]!.physicalLocation!.artifactLocation!.uri}:${r.locations![0]!.physicalLocation!.region!.startLine}`))
      .toEqual(["unused-binding:warning:src/a.clj:4", "syntax:error:src/b.clj:1"])
    expect(Option.isNone(convertKondo("not json", "/repo"))).toBe(true)
  })

  test("cloverage lcov, kaocha test names and focus ids", () => {
    expect(parseLcov("TN:\nSF:src/a.clj\nDA:1,1\nDA:3,0\nend_of_record\n", "/repo")).toEqual([{ path: "src/a.clj", lines: new Map([[1, true], [3, false]]) }])
    expect(tidyJUnit(`<testcase name="svc.a-test/adds" classname="svc.a-test" time="0"><testcase name="other" classname="svc.a-test">`))
      .toBe(`<testcase name="adds" classname="svc.a-test" time="0"><testcase name="other" classname="svc.a-test">`)
    expect([focusOf("svc.a-test.adds", ["svc.a", "svc.a-test"]), focusOf("svc.a-test", ["svc.a-test"]), focusOf("x.y", ["svc.a-test"])]).toEqual(["svc.a-test/adds", "svc.a-test", undefined])
  })
})

describe("Clojure rules", () => {
  const lines = (rule: string, text: string) => runRules([rule], [{ path: "src/a.clj", text }]).map((r) => r.locations?.[0]?.physicalLocation?.region?.startLine)

  test("floating money, throws, mutable state, unsafe reads and printing", () => {
    expect(lines("clojure.no-floating-money", "(ns a)\n(def price 9.99)\n(def ratio 0.5)\n(defn f [^double amount] (let [total (double 1)] total))\n(def fee 100)\n")).toEqual([2, 4, 4])
    expect(lines("clojure.no-throw", "(ns a)\n(defn f [] (throw (ex-info \"x\" {})))\n#_(throw x)\n(comment (throw y))\n")).toEqual([2])
    expect(lines("clojure.no-mutable-state", "(ns a)\n(def s (atom 0))\n(defn f [] (swap! s inc))\n")).toEqual([2, 3])
    expect(lines("clojure.no-unsafe-read", "(ns a (:require [clojure.edn :as edn]))\n(read-string s)\n(edn/read-string s)\n(eval x)\n")).toEqual([2, 4])
    expect(lines("clojure.no-println", "(ns a)\n(defn f [] (println \"x\") (prn 1))\n")).toEqual([2, 2])
  })
})

describe("tests as kaocha runs them", () => {
  const names = (text: string) => testDefinitions(read(text)).map((t) => `${t.name}:${t.assertions}${t.skipped ? ":skipped" : ""}${t.quarantined ? ":quarantined" : ""}${t.property ? ":property" : ""}`)

  test("deftest and defspec, live only", () => {
    expect(names(fixture("clojure-service/test/svc/domain/money_test.clj"))).toEqual([
      "svc.domain.money-test.adds:1", "svc.domain.money-test.refuses-mixed-currencies:1", "svc.domain.money-test.knows-when-positive:2", "svc.domain.money-test.adding-zero-changes-nothing:1:property",
    ])
    expect(names("(ns t)\n#_(deftest gone (is true))\n(comment (deftest also-gone))\n(deftest ^:kaocha/skip s (is (f)))\n(deftest ^:flaky q (t/is (f)) (are [x] (f x) 1 2))\n(deftest p (checking \"x\" [n gen/int] (is (f n))))\n"))
      .toEqual(["t.s:1:skipped", "t.q:2:quarantined", "t.p:1:property"])
  })

  test("clj-kondo suppressions, wherever they are written", () => {
    expect(suppressionLines(read("(ns a)\n#_{:clj-kondo/ignore [:unused-binding]}\n(defn f [x] 1)\n#_:clj-kondo/ignore\n(def y 1)\n(defn ^{:clj-kondo/ignore [:a]} g [])\n(ns b {:clj-kondo/config '{:linters {}}})\n"))).toEqual([2, 4, 6, 7])
  })
})

const detect = (base: Record<string, string>, head: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "gauntlet-clj-"))
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
    isTestPath: (p) => p.startsWith("test/"),
    headFiles: Object.keys(head),
    dir,
  }
  return Effect.runPromise(clojureDetector.run(input).pipe(Effect.provide(BunServices.layer)))
}
const kinds = (r: Awaited<ReturnType<typeof detect>>) => r.findings.map((f) => `${f.kind} ${f.check}${f.line ? `:${f.line}` : ""}`)

describe("Clojure detectors", () => {
  const T = "test/svc/domain/money_test.clj"
  const SPEC = fixture("clojure-service/test/svc/domain/money_test.clj")

  test("skipped, removed and weakened tests, tautologies and exits", async () => {
    const head = SPEC.replace("(deftest refuses-mixed-currencies", "(deftest ^:kaocha/skip refuses-mixed-currencies")
      .replace("  (is (not (money/positive? (money/money 0 \"EUR\")))))", "  (is true)\n  (System/exit 0))")
      .replace(/\(defspec adding-zero-changes-nothing[\s\S]*$/, "")
    expect(kinds(await detect({ [T]: SPEC }, { [T]: head }))).toEqual([
      "forbid new-skips:11", "forbid deleted-tests", "forbid weakened-assertions:16", "forbid exit-in-tests:17",
    ])
  })

  test("a new test without assertions is forbidden; with-redefs of the namespace under test is flagged", async () => {
    const r = await detect({}, {
      "test/svc/ledger_test.clj": "(ns svc.ledger-test\n  (:require [clojure.test :refer [deftest is]]\n            [svc.ledger :as ledger]\n            [svc.clock :as clock]))\n\n(deftest nothing\n  (ledger/total []))\n\n(deftest mocks\n  (with-redefs [ledger/total (constantly 0)\n                clock/now (constantly 1)]\n    (is (= 0 (ledger/total [])))))\n",
    })
    expect(kinds(r)).toEqual(["forbid weakened-assertions:6", "flag mocks-of-class-under-test:10"])
  })

  test("main code: suppressions, test libraries, equality, catch-alls, env branching", async () => {
    const main = "(ns svc.a\n  (:require [clojure.test :as t]))\n\n#_{:clj-kondo/ignore [:unused-binding]}\n(defn f [x]\n  (if (System/getenv \"CI\") 1 2))\n\n(deftype Id [v]\n  Object\n  (equals [_ o] true))\n\n(defn g []\n  (try (h)\n    (catch Exception _ 0)))\n"
    expect(kinds(await detect({}, { "src/svc/a.clj": main }))).toEqual([
      "forbid new-suppressions:4", "forbid test-refs-in-main:2", "flag env-branching:6", "flag equality-overrides:10", "flag catch-all-near-changed-code:14",
    ])
  })

  test("metrics count assertions, properties and suppressions at head", async () => {
    const r = await detect({}, { [T]: SPEC })
    expect(Object.fromEntries(Object.entries(r.metrics).map(([k, v]) => [k, v.value]))).toEqual({
      "integrity/assertions-per-test": 5, "integrity/suppressions": 0, "integrity/quarantined-tests": 0, "integrity/property-tests": 1,
    })
  })
})

describe("Clojure tamper fixtures", () => {
  test("each fixture is built from the project's own files, and still reads", async () => {
    const files = project("clojure-lein")
    const out = await Effect.runPromise(tamper({ files: Object.keys(files).sort(), read: (p) => Effect.succeed(Option.fromNullishOr(files[p])), ir: undefined as never, isTestPath: (p) => p.startsWith("test/") }))
    expect(out.map((t) => t.fixture)).toEqual(["deleted-test", "added-skip", "weakened-assertion", "added-suppression", "test-id-in-main", "hardcoded-expected-value", "edited-test-setup"])
    const content = (f: string) => out.find((t) => t.fixture === f)!.edits[0]!.content!
    expect(content("added-skip")).toContain("(deftest ^:kaocha/skip adds")
    expect(content("deleted-test")).not.toContain("(deftest adds\n")
    expect(content("weakened-assertion")).toContain("(deftest adds\n  nil)")
    expect(content("hardcoded-expected-value")).toBe("(ns calc.core)\n\n(defn add [a b]\n  3)\n")
    expect(nsOf(read(content("test-id-in-main")))?.requires.map((r) => r.lib)).toEqual(["clojure.test"])
    expect(out.find((t) => t.fixture === "edited-test-setup")!.edits[0]!.path).toBe("tests.edn")
    // Every edited Clojure file still reads to the same number of top-level forms or fewer, with balanced parens.
    for (const t of out) for (const e of t.edits) if (e.path.endsWith(".clj")) expect((e.content!.match(/\(/g) ?? []).length).toBe((e.content!.match(/\)/g) ?? []).length)
  })
})

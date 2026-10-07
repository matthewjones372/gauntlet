import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cpSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { cli } from "../../../packages/cli/test/harness.ts"
import { TempRepo } from "../../../packages/core/test/temp-repo.ts"
import { clojurePack } from "../src/index.ts"

// End to end with the real Clojure CLI, Leiningen and clj-kondo: a deps.edn
// service through every gate and the selftest, and a small Leiningen project
// checking that its tests are counted, a failure is named, a skip is caught
// and a policy's `mutation` is reported not executed. Opt in with
// GAUNTLET_E2E=1; CI always runs it.

const E2E = process.env.GAUNTLET_E2E === "1"
const FIXTURES = join(import.meta.dir, "..", "..", "..", "examples", "fixtures")
const TIMEOUT = 10 * 60 * 1000
const IGNORED = /\/(target|\.cpcache|\.clj-kondo\/\.cache|\.lsp)(\/|$)/
const clojure = (args: string[]) => cli(args, [clojurePack])

const copy = (fixture: string) => {
  const repo = new TempRepo()
  cpSync(join(FIXTURES, fixture), repo.dir, { recursive: true, filter: (src) => !IGNORED.test(src) })
  return repo
}

const checkOn = async (repo: TempRepo, base: string, name: string) => {
  const out = join(repo.dir, ".git", `out-${name}`)
  const res = await clojure(["check", "--repo", repo.dir, "--policy-ref", base, "--out", out, "--no-record"])
  const report = JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8"))
  const check = (c: string) => report.checks.find((x: { check: string }) => x.check === c)
  return { code: res.code, report, check, status: (c: string) => check(c)?.status }
}

describe.skipIf(!E2E)("Clojure pack end to end (real Clojure CLI, deps.edn service)", () => {
  let repo: TempRepo
  let base = ""
  const read = (p: string) => readFileSync(join(FIXTURES, "clojure-service", p), "utf8")
  const scenario = (name: string, files: Record<string, string>) => {
    repo.git("checkout", "-q", "-B", name, base)
    repo.write(files)
    repo.commit(name)
  }
  const check = (name: string) => checkOn(repo, base, name)

  beforeAll(async () => {
    repo = copy("clojure-service")
    repo.commit("trunk")
    const recorded = await clojure(["baseline", "--repo", repo.dir, "--trunk", "main"])
    if (recorded.code !== 0) throw new Error(`baseline failed: ${recorded.err}\n${recorded.out}`)
    base = repo.commit("baseline")
  }, TIMEOUT)

  afterAll(() => repo?.cleanup())

  test("the baseline grandfathers clj-kondo's finding and records coverage and tests", () => {
    const b = JSON.parse(readFileSync(join(repo.dir, ".gauntlet", "baseline.sarif"), "utf8"))
    expect(b.runs.find((r: { tool: { driver: { name: string } } }) => r.tool.driver.name === "clj-kondo").results.map((r: { ruleId: string }) => r.ruleId)).toEqual(["unused-binding"])
    expect(b.runs[0].properties.gauntlet.testIds).toHaveLength(5)
    expect(b.runs[0].properties.gauntlet.metrics.coverage.value).toBeGreaterThan(50)
  })

  test("1. a small, tested change gets auto", async () => {
    scenario("clean", {
      "src/svc/domain/money.clj": `${read("src/svc/domain/money.clj")}\n(defn negate [m]\n  (money (- (:minor m)) (:currency m)))\n`,
      "test/svc/domain/negate_test.clj": "(ns svc.domain.negate-test\n  (:require [clojure.test :refer [deftest is]]\n            [svc.domain.money :as money]))\n\n(deftest negates\n  (is (= (money/money -5 \"EUR\") (money/negate (money/money 5 \"EUR\")))))\n",
    })
    const r = await check("clean")
    expect(r.report.checks.map((c: { check: string; status: string }) => `${c.check}:${c.status}`)).toEqual(["arch:passed", "build:passed", "lint:passed", "coverage:passed", "unit:passed"])
    expect(r.report.decision.tier).toBe("auto")
    expect(r.code).toBe(0)
  }, TIMEOUT)

  test("2. a namespace that doesn't load fails the build", async () => {
    scenario("compile-error", { "src/svc/infra/ledger.clj": `${read("src/svc/infra/ledger.clj")}\n(defn broken [x]\n  (+ x (undefined-fn 1)))\n` })
    expect((await check("compile-error")).status("build")).toBe("failed")
  }, TIMEOUT)

  test("3. a change that breaks a test fails the unit gate, and names the test", async () => {
    scenario("broken", { "src/svc/settlement/fx.clj": read("src/svc/settlement/fx.clj").replace("10000", "1000") })
    const r = await check("broken")
    expect(r.status("unit")).toBe("failed")
    expect(r.check("unit").failures[0]).toStartWith("svc.settlement.fx-test.converts")
    expect(r.code).toBe(1)
  }, TIMEOUT)

  test("4. weakening a protected test: the base copy runs, the change is forbidden", async () => {
    scenario("weakened", {
      "test/svc/domain/money_test.clj": read("test/svc/domain/money_test.clj")
        .replace("(deftest refuses-mixed-currencies", "(deftest ^:kaocha/skip refuses-mixed-currencies")
        .replace("\n  (is (not (money/positive? (money/money 0 \"EUR\")))))", ")"),
    })
    const r = await check("weakened")
    const found = r.report.integrity.findings.map((f: { check: string }) => f.check)
    expect(found).toContain("new-skips")
    expect(found).toContain("weakened-assertions")
    expect(r.status("unit")).toBe("passed")
    expect(r.code).toBe(1)
  }, TIMEOUT)

  test("5. a grandfathered finding survives a line shift; a new one fails", async () => {
    scenario("shift", { "src/svc/infra/ledger.clj": read("src/svc/infra/ledger.clj").replace("(defn total", ";; The ledger keeps balances.\n(defn total") })
    expect((await check("shift")).status("lint")).toBe("passed")
    scenario("new-finding", { "src/svc/infra/ledger.clj": `${read("src/svc/infra/ledger.clj")}\n(defn size [entries]\n  (let [ignored 1]\n    (count entries)))\n` })
    const r = await check("new-finding")
    expect(r.status("lint")).toBe("failed")
    expect(r.report.violations.map((v: { ruleId: string }) => v.ruleId)).toContain("unused-binding")
  }, TIMEOUT)

  test("6. domain requiring infra breaks the arch rule", async () => {
    scenario("arch", { "src/svc/domain/audit.clj": "(ns svc.domain.audit\n  (:require [svc.infra.ledger :as ledger]))\n\n(defn audit [entries]\n  (ledger/total entries))\n" })
    const r = await check("arch")
    expect(r.status("arch")).toBe("failed")
    expect(r.report.violations.find((v: { ruleId: string }) => v.ruleId.startsWith("arch/")).message).toBe("domain requires svc.infra.ledger, which belongs to infra.")
  }, TIMEOUT)

  test("7. a throw in the money zone breaks the zone rule and needs an owner", async () => {
    scenario("zone-throw", { "src/svc/settlement/fx.clj": `${read("src/svc/settlement/fx.clj")}\n(defn require-rate [rate-bp]\n  (if (pos? rate-bp) rate-bp (throw (ex-info "rate must be positive" {:rate rate-bp}))))\n` })
    const r = await check("zone-throw")
    expect(r.report.violations.map((v: { ruleId: string }) => v.ruleId)).toContain("clojure.no-throw")
    expect(r.report.decision.tier).toBe("owner")
  }, TIMEOUT)

  test("8. a test exiting the JVM and main code requiring clojure.test are forbidden", async () => {
    scenario("cheats", {
      "test/svc/domain/exit_test.clj": "(ns svc.domain.exit-test\n  (:require [clojure.test :refer [deftest is]]\n            [svc.domain.money :as money]))\n\n(deftest leaves\n  (is (money/positive? (money/money 1 \"EUR\")))\n  (System/exit 0))\n",
      "src/svc/infra/strict.clj": "(ns svc.infra.strict\n  (:require [clojure.test :as t]))\n\n(def on true)\n",
    })
    const found = (await check("cheats")).report.integrity.findings.map((f: { check: string }) => f.check)
    expect(found).toContain("exit-in-tests")
    expect(found).toContain("test-refs-in-main")
  }, TIMEOUT)

  test("9. untested changed code fails coverage on changed lines", async () => {
    scenario("uncovered", { "src/svc/infra/audit_log.clj": "(ns svc.infra.audit-log)\n\n(defn describe [minor currency]\n  (if (pos? minor)\n    (str \"+\" minor \" \" currency)\n    (str minor \" \" currency)))\n" })
    expect((await check("uncovered")).status("coverage")).toBe("failed")
  }, TIMEOUT)

  test("selftest: every built-in tamper fixture that applies is caught", async () => {
    repo.git("checkout", "-q", "-B", "selftest", base)
    const res = await clojure(["selftest", "--repo", repo.dir, "--json"])
    const result = JSON.parse(res.out)
    const missed = result.fixtures.filter((f: { caught: boolean }) => !f.caught)
    if (missed.length > 0 || result.control.wouldBlock) console.log(JSON.stringify(result, null, 1))
    expect(result.control.wouldBlock).toBe(false)
    expect(missed).toEqual([])
    expect(result.fixtures.length).toBeGreaterThanOrEqual(9)
  }, TIMEOUT)
})

describe.skipIf(!E2E)("Clojure pack end to end (real Leiningen)", () => {
  let repo: TempRepo
  let base = ""
  const read = (p: string) => readFileSync(join(FIXTURES, "clojure-lein", p), "utf8")

  beforeAll(() => {
    repo = copy("clojure-lein")
    // The policy gates mutation too, which Clojure can't run.
    repo.write({ ".gauntlet/policy.gx": read(".gauntlet/policy.gx").replace("verify { unit }", "verify { unit, mutation }") })
    base = repo.commit("trunk")
  })
  afterAll(() => repo?.cleanup())

  test("tests are counted, a failure is named, a skip is caught, and mutation is reported not executed", async () => {
    repo.git("checkout", "-q", "-B", "broken", base)
    repo.write({ "src/calc/core.clj": read("src/calc/core.clj").replace("(+ a b)", "(+ a b 1)") })
    repo.commit("broken")
    const broken = await checkOn(repo, base, "broken")
    expect(broken.status("unit")).toBe("failed")
    expect(broken.check("unit").tests.executed).toBe(2)
    expect(broken.check("unit").failures.join("\n")).toContain("calc.core-test.adds")

    repo.git("checkout", "-q", "-B", "skipped", base)
    repo.write({ "test/calc/core_test.clj": read("test/calc/core_test.clj").replace("(deftest adds\n", "(deftest ^:kaocha/skip adds\n") })
    repo.commit("skipped")
    expect((await checkOn(repo, base, "skipped")).report.integrity.findings.map((f: { check: string }) => f.check)).toContain("new-skips")

    repo.git("checkout", "-q", "-B", "clean", base)
    repo.write({ "src/calc/core.clj": `${read("src/calc/core.clj")}\n(defn sub [a b]\n  (- a b))\n` })
    repo.commit("clean")
    const clean = await checkOn(repo, base, "clean")
    expect(clean.status("unit")).toBe("passed")
    expect(clean.status("mutation")).toBe("not-executed")
    expect(clean.report.decision.tier).toBe("review")
  }, TIMEOUT)
})

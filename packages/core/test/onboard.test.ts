import { describe, expect, test } from "bun:test"
import { directoriesNamed, draftPolicy, type Onboarding } from "../src/index.ts"
import { compiled } from "./fixtures.ts"

const compile = (text: string) => compiled(text).ir

const proposal = (o: Partial<Onboarding> = {}): Onboarding => ({
  protect: { tests: ["src/test/**"], fixtures: [], config: ["*.gradle.kts"] },
  suites: [{ name: "unit", location: "src/test/**" }],
  fast: ["build", "lint ratchet"],
  verify: ["coverage ratchet on changed"],
  setup: [],
  ...o,
})

describe("draftPolicy", () => {
  test("a draft compiles, starts in shadow mode and protects tests", () => {
    const d = draftPolicy({ name: "svc", owners: ["@platform"], strict: false, packRules: [], archGate: false, proposals: [{ pack: "jvm", onboarding: proposal() }] }, [])
    const ir = compile(d.text)
    expect(ir.mode).toBe("shadow")
    expect(ir.owners).toEqual(["@platform"])
    expect(ir.protect.find((g) => g.kind === "tests")?.globs).toEqual(["src/test/**"])
    expect(d.text).toContain("verify { unit, coverage ratchet on changed }")
  })

  test("without owners the line is a comment, so the draft still compiles", () => {
    const d = draftPolicy({ name: "svc", owners: [], strict: false, packRules: [], archGate: false, proposals: [{ pack: "jvm", onboarding: proposal() }] }, [])
    expect(d.text).toContain("// owners @your-team")
    expect(compile(d.text).owners).toEqual([])
  })

  test("proposals merge: shared gates and suite names appear once, setup hints are kept", () => {
    const d = draftPolicy({
      name: "svc",
      owners: [],
      strict: false,
      packRules: [],
      archGate: false,
      proposals: [
        { pack: "jvm", onboarding: proposal({ setup: ["add detekt"] }) },
        { pack: "lintonly", onboarding: proposal({ protect: { tests: ["test/**"], fixtures: [], config: [] }, fast: ["lint"], verify: [], setup: ["add stryker"] }) },
      ],
    }, [".github/workflows/ci.yml"])
    expect(d.text).toContain("use jvm, lintonly")
    expect(d.text).toContain(`tests  "src/test/**", "test/**"`)
    expect(d.text).toContain(`config "*.gradle.kts", ".github/workflows/**"`)
    expect(d.text).toContain("fast   { build, lint ratchet }")
    expect(d.setup).toEqual(["add detekt", "add stryker"])
  })

  test("with nothing to gate there is no auto rule, so every change needs review", () => {
    const d = draftPolicy({ name: "svc", owners: [], strict: false, packRules: [], archGate: false, proposals: [{ pack: "jvm", onboarding: proposal({ protect: { tests: [], fixtures: [], config: [] }, suites: [], fast: [], verify: [] }) }] }, [])
    expect(d.text).not.toContain("auto")
    expect(d.text).not.toContain("protect {")
    expect(compile(d.text).mode).toBe("shadow")
  })
})

describe("directoriesNamed", () => {
  test("root directories, and nested ones as **/", () => {
    expect(directoriesNamed(["test/a.ts", "src/x.ts"], ["test", "tests"])).toEqual(["test/**"])
    expect(directoriesNamed(["app/src/test/A.kt", "src/test/B.kt"], ["src/test"])).toEqual(["**/src/test/**"])
    expect(directoriesNamed(["src/main/A.kt"], ["src/test"])).toEqual([])
  })
})

describe("strict drafts: zones, arch and floors inferred from the layout", () => {
  const FILES = [
    "src/main/kotlin/svc/payments/stripe/Charge.kt", "src/main/kotlin/svc/payments/Refund.kt", "src/main/kotlin/svc/auth/Login.kt",
    "src/main/kotlin/svc/domain/Money.kt", "src/main/kotlin/svc/infra/Db.kt", "src/main/kotlin/svc/api/Routes.kt",
    "src/test/kotlin/svc/payments/ChargeTest.kt", "db/migrations/V1__init.sql", "build.gradle.kts",
  ]
  const strict = (owners: string[], o: Partial<Parameters<typeof draftPolicy>[0]> = {}) =>
    draftPolicy({ name: "svc", owners, strict: true, packRules: ["kotlin.no-floating-money", "kotlin.no-println"], archGate: true, proposals: [{ pack: "jvm", onboarding: proposal() }], ...o }, FILES)

  test("zones for money, security and migrations, each the shallowest matching folder, with the pack's money rule", () => {
    const ir = compile(strict(["@platform"]).text)
    expect(ir.zones.map((z) => `${z.name}:${z.globs.join(",")}:${z.rules.join(",")}:${z.owners.join(",")}`)).toEqual([
      "migrations:db/migrations/**::@platform",
      "money:src/main/kotlin/svc/payments/**:kotlin.no-floating-money:@platform",
      "security:src/main/kotlin/svc/auth/**::@platform",
    ])
  })

  test("an arch rule from the inner layer to the outer ones, and the arch gate in the fast tier", () => {
    const d = strict(["@platform"])
    expect(compile(d.text).arch).toEqual([{ module: "domain", mustNotDependOn: ["api", "infra"] }])
    expect(d.text).toContain("fast   { build, lint ratchet, arch }")
  })

  test("floors for new code on top of the ratchets", () => {
    expect(strict(["@platform"], { proposals: [{ pack: "jvm", onboarding: proposal({ verify: ["coverage ratchet on changed", "mutation ratchet on changed", "coverage >= 50%"] }) }] }).text)
      .toContain("verify { unit, coverage ratchet >= 80% on changed, mutation ratchet >= 60% on changed }")
  })

  test("without owners, zones that would reach protected files are left out, so the draft still compiles", () => {
    // Tests beside the code they test, as in Go: auth/LoginTest.kt is protected and inside the security folder.
    const beside = (owners: string[]) => draftPolicy({
      name: "svc", owners, strict: true, packRules: [], archGate: false,
      proposals: [{ pack: "jvm", onboarding: proposal({ protect: { tests: ["**/*Test.kt"], fixtures: [], config: [] } }) }],
    }, [...FILES, "src/main/kotlin/svc/auth/LoginTest.kt"])
    const files = [...FILES, "src/main/kotlin/svc/auth/LoginTest.kt"]
    expect(compiled(beside([]).text, files).ir.zones.map((z) => z.name)).toEqual(["migrations", "money"])
    expect(beside([]).text).toContain("  // owner @your-team")
    expect(compiled(beside(["@platform"]).text, files).ir.zones.map((z) => z.name)).toEqual(["migrations", "money", "security"])
  })

  test("no arch gate, or a flat layout, gives the commented examples; lenient gives today's draft", () => {
    expect(compile(strict(["@platform"], { archGate: false }).text).arch).toEqual([])
    expect(strict(["@platform"], { strict: false }).text).toContain("// zone money {")
    expect(strict(["@platform"], { strict: false }).text).toContain("verify { unit, coverage ratchet on changed }")
  })
})

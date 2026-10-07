import { afterEach, describe, expect, test } from "bun:test"
import { IMPLICIT_PROTECT, type ProtectGroup } from "@gauntlet/ir"
import { Effect, Exit } from "effect"
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { planMaterialisation, type PreparedWorkspace, Workspace } from "../src/index.ts"
import { CoreTest } from "./layers.ts"
import { TempRepo } from "./temp-repo.ts"

const protect: ReadonlyArray<ProtectGroup> = [
  { group: "tests", kind: "tests", globs: ["src/test/**"] },
  { group: "config", kind: "config", globs: ["*.gradle.kts"] },
  { group: "fixtures", kind: "fixtures", globs: ["src/test/resources/golden/**"] },
  IMPLICIT_PROTECT,
]
const runnerConfig = ["settings.gradle.kts", "**/junit-platform.properties"]

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

/** Runs `use` against a prepared workspace and returns its result plus the checkout dir. */
const withWorkspace = async <A>(r: TempRepo, base: string, head: string, use: (ws: PreparedWorkspace) => Effect.Effect<A, unknown>) => {
  let dir = ""
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Workspace.use((w) => w.prepare({ repo: r.dir, base, head, protect, runnerConfig })).pipe(
        Effect.tap((ws) => Effect.sync(() => (dir = ws.dir))),
        Effect.flatMap(use),
      ),
    ).pipe(Effect.provide(CoreTest)),
  )
  if (Exit.isFailure(exit)) throw new Error(String(exit.cause))
  return { value: exit.value, dir }
}

const scenario = () => {
  const r = new TempRepo()
  repos.push(r)
  r.write({
    "src/main/A.kt": "class A",
    "src/test/ATest.kt": "class ATest { @Test fun a() { assertEquals(1, 1) } }",
    "src/test/OldTest.kt": "class OldTest",
    "src/test/MovedTest.kt": "class MovedTest",
    "src/test/resources/golden/expected.txt": "golden",
    "build.gradle.kts": "plugins { kotlin(\"jvm\") }",
    "settings.gradle.kts": "rootProject.name = \"svc\"",
    ".gauntlet/policy.gx": "policy",
  })
  const base = r.commit("base")
  r.write({
    "src/main/A.kt": "class A { fun changed() = 1 }",
    "src/test/ATest.kt": "class ATest { @Test fun a() { assertTrue(true) } }",
    "src/test/NewTest.kt": "class NewTest",
    "src/test/resources/golden/expected.txt": "edited golden",
    "build.gradle.kts": "plugins { kotlin(\"jvm\") }\ntasks.test { enabled = false }",
    "settings.gradle.kts": "rootProject.name = \"hacked\"",
    "extra.gradle.kts": "// new config",
    ".gauntlet/policy.gx": "loosened",
    ".gauntlet/selftest/skip.patch": "new self-test",
  })
  r.remove("src/test/OldTest.kt")
  r.git("mv", "src/test/MovedTest.kt", "src/test/RenamedTest.kt")
  const head = r.commit("head")
  return { r, base, head }
}

const read = (dir: string, path: string) => (existsSync(join(dir, path)) ? readFileSync(join(dir, path), "utf8") : undefined)

describe("Workspace.prepare", () => {
  test("materialises protected files from base and leaves the rest at head", async () => {
    const { r, base, head } = scenario()
    const { value } = await withWorkspace(r, base, head, (ws) =>
      Effect.sync(() => ({
        main: read(ws.dir, "src/main/A.kt"),
        modifiedTest: read(ws.dir, "src/test/ATest.kt"),
        newTest: read(ws.dir, "src/test/NewTest.kt"),
        deletedTest: read(ws.dir, "src/test/OldTest.kt"),
        movedFrom: read(ws.dir, "src/test/MovedTest.kt"),
        movedTo: read(ws.dir, "src/test/RenamedTest.kt"),
        fixture: read(ws.dir, "src/test/resources/golden/expected.txt"),
        build: read(ws.dir, "build.gradle.kts"),
        settings: read(ws.dir, "settings.gradle.kts"),
        extraConfig: read(ws.dir, "extra.gradle.kts"),
        policy: read(ws.dir, ".gauntlet/policy.gx"),
        selftest: read(ws.dir, ".gauntlet/selftest/skip.patch"),
        materialised: ws.materialised,
      })))
    expect(value.main).toBe("class A { fun changed() = 1 }")
    expect(value.modifiedTest).toContain("assertEquals(1, 1)")
    expect(value.newTest).toBe("class NewTest")
    expect(value.deletedTest).toBe("class OldTest")
    expect(value.movedFrom).toBe("class MovedTest")
    expect(value.movedTo).toBeUndefined()
    expect(value.fixture).toBe("golden")
    expect(value.build).toBe("plugins { kotlin(\"jvm\") }")
    expect(value.settings).toBe("rootProject.name = \"svc\"")
    expect(value.extraConfig).toBeUndefined()
    expect(value.policy).toBe("policy")
    expect(value.selftest).toBeUndefined()
    expect(value.materialised.map((m) => `${m.action} ${m.kind} ${m.path}`)).toEqual([
      "restored gauntlet .gauntlet/policy.gx",
      "removed gauntlet .gauntlet/selftest/skip.patch",
      "restored config build.gradle.kts",
      "removed config extra.gradle.kts",
      "restored config settings.gradle.kts",
      "restored tests src/test/ATest.kt",
      "restored tests src/test/MovedTest.kt",
      "kept tests src/test/NewTest.kt",
      "restored tests src/test/OldTest.kt",
      "removed tests src/test/RenamedTest.kt",
      "restored fixtures src/test/resources/golden/expected.txt",
    ])
  })

  test("never touches the user's working tree, and removes the checkout afterwards", async () => {
    const { r, base, head } = scenario()
    r.write({ "src/main/A.kt": "uncommitted local edit" })
    const { dir } = await withWorkspace(r, base, head, () => Effect.void)
    expect(read(r.dir, "src/main/A.kt")).toBe("uncommitted local edit")
    expect(read(r.dir, "build.gradle.kts")).toContain("enabled = false")
    expect(dir).not.toBe("")
    expect(existsSync(dir)).toBe(false)
    expect(r.git("worktree", "list")).not.toContain(dir)
  })
})

describe("output directories (ADR 0012)", () => {
  test("a result file planted in the checkout is never collected", async () => {
    const r = new TempRepo()
    repos.push(r)
    r.write({ "src/main/A.kt": "class A" })
    const base = r.commit("base")
    r.write({ "build/test-results/test/TEST-planted.xml": `<testsuite tests="999" failures="0"/>` })
    const head = r.commit("plant a passing report")
    const { value } = await withWorkspace(r, base, head, (ws) =>
      Effect.gen(function*() {
        const out = yield* ws.outputDir("unit")
        // What a real tool run would write:
        writeFileSync(join(out, "TEST-real.xml"), `<testsuite tests="3" failures="1"/>`)
        return { out, files: yield* ws.collect("unit"), plantedInCheckout: existsSync(join(ws.dir, "build/test-results/test/TEST-planted.xml")) }
      }))
    expect(value.plantedInCheckout).toBe(true)
    expect(value.out.startsWith(join(value.out, "..", "..", "checkout"))).toBe(false)
    expect(value.files).toEqual([{ path: "TEST-real.xml", content: `<testsuite tests="3" failures="1"/>` }])
  })

  test("output directories are fresh, single-use and outside the checkout", async () => {
    const { r, base, head } = scenario()
    const { value } = await withWorkspace(r, base, head, (ws) =>
      Effect.gen(function*() {
        const out = yield* ws.outputDir("mutation")
        const second = yield* Effect.exit(ws.outputDir("mutation"))
        const badName = yield* Effect.exit(ws.outputDir("../escape"))
        const notCreated = yield* Effect.exit(ws.collect("coverage"))
        return { out, insideCheckout: out.startsWith(ws.dir), second, badName, notCreated }
      }))
    expect(value.insideCheckout).toBe(false)
    expect(Exit.isFailure(value.second)).toBe(true)
    expect(Exit.isFailure(value.badName)).toBe(true)
    expect(Exit.isFailure(value.notCreated)).toBe(true)
  })

  test("symlinks in an output directory are not followed", async () => {
    const { r, base, head } = scenario()
    const { value } = await withWorkspace(r, base, head, (ws) =>
      Effect.gen(function*() {
        const out = yield* ws.outputDir("unit")
        symlinkSync(join(ws.dir, "src/main/A.kt"), join(out, "TEST-link.xml"))
        writeFileSync(join(out, "TEST-real.xml"), "<testsuite/>")
        return yield* ws.collect("unit")
      }))
    expect(value.map((f) => f.path)).toEqual(["TEST-real.xml"])
  })
})

describe("planMaterialisation", () => {
  test("runner config is restored even when no protect group covers it", () => {
    const plan = planMaterialisation([{ status: "modified", path: "src/test/resources/junit-platform.properties" }], [], runnerConfig)
    expect(plan).toEqual([
      { path: "src/test/resources/junit-platform.properties", group: "runner-config", kind: "runner-config", change: "modified", action: "restored" },
    ])
  })

  test("the strictest group wins when globs overlap", () => {
    const plan = planMaterialisation(
      [{ status: "added", path: "src/test/build.gradle.kts" }],
      [{ group: "tests", kind: "tests", globs: ["src/test/**"] }, { group: "config", kind: "config", globs: ["**/*.gradle.kts"] }],
      [],
    )
    expect(plan).toEqual([{ path: "src/test/build.gradle.kts", group: "config", kind: "config", change: "added", action: "removed" }])
  })

  test("an unprotected file renamed into a tests group runs", () => {
    const plan = planMaterialisation([{ status: "renamed", oldPath: "scratch/X.kt", path: "src/test/XTest.kt" }], protect, [])
    expect(plan).toEqual([{ path: "src/test/XTest.kt", group: "tests", kind: "tests", change: "renamed", action: "kept" }])
  })
})

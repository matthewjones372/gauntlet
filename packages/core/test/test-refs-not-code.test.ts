import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Option } from "effect"
import { type IntegrityInput, runIntegrity, testPathMatcher } from "../src/index.ts"
import { compiled, noFacts } from "./fixtures.ts"

// test-refs-in-main is about code. Ownership and ignore files list test paths
// by design: gauntlet connect github writes a CODEOWNERS that does.

const { ir } = compiled(`gauntlet "svc"
use jvm
owners @platform
protect { tests "src/test/**" }
suites { unit "src/test/**" }
gates { verify { unit } }
`)
const run = (addedLines: Map<string, { line: number; text: string }[]>) => {
  const input: IntegrityInput = {
    ir,
    facts: noFacts({ addedLines }),
    readBase: () => Effect.succeed(Option.none()),
    readHead: () => Effect.succeed(Option.none()),
    isTestPath: testPathMatcher(ir),
    baselineMetrics: {},
    headFiles: ["src/test/money/FxTest.kt", "src/main/money/Fx.kt"],
    dir: "/nonexistent",
  }
  return Effect.runSync(runIntegrity(input, []).pipe(Effect.provide(BunServices.layer))).findings.filter((f) => f.check === "test-refs-in-main").map((f) => f.path)
}

describe("test paths outside code", () => {
  test("CODEOWNERS, .gitignore and anything under .github/ aren't main code", () => {
    const lines = [{ line: 5, text: "/src/test/ @platform" }]
    expect(run(new Map([[".github/CODEOWNERS", lines], ["CODEOWNERS", lines], [".gitignore", [{ line: 1, text: "src/test/tmp/" }]], [".github/workflows/x.yml", lines]]))).toEqual([])
  })

  test("main code naming a test path is still forbidden", () => {
    expect(run(new Map([["src/main/money/Fx.kt", [{ line: 3, text: "  load(\"src/test/resources/x.json\")" }]]]))).toEqual(["src/main/money/Fx.kt"])
  })
})

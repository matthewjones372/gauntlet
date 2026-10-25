import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { tamper } from "../src/tamper.ts"

const setupPath = async (files: Record<string, string>) => {
  const out = await Effect.runPromise(tamper({ files: Object.keys(files).sort(), read: (p) => Effect.succeed(Option.fromNullishOr(files[p])), ir: undefined as never, isTestPath: (p) => p.includes("/test") }))
  return out.find((t) => t.fixture === "edited-test-setup")!.edits[0]!.path
}

describe("the test setup fixture", () => {
  test("puts a bunfig.toml in the build's folder when the build has a folder of its own", async () => {
    expect(await setupPath({ "web/package.json": "{}", "web/packages/x/package.json": "{}" })).toBe("web/bunfig.toml")
  })

  test("puts a bunfig.toml at the root when the build is at the root", async () => {
    expect(await setupPath({ "package.json": "{}" })).toBe("bunfig.toml")
  })
})

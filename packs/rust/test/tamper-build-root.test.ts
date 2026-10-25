import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { tamper } from "../src/tamper.ts"

const setupPath = async (files: Record<string, string>) => {
  const out = await Effect.runPromise(tamper({ files: Object.keys(files).sort(), read: (p) => Effect.succeed(Option.fromNullishOr(files[p])), ir: undefined as never, isTestPath: (p) => p.includes("/test") }))
  return out.find((t) => t.fixture === "edited-test-setup")!.edits[0]!.path
}

describe("the test setup fixture", () => {
  test("puts a nextest config in the build's folder when the build has a folder of its own", async () => {
    expect(await setupPath({ "svc/Cargo.toml": "", "svc/crates/x/Cargo.toml": "" })).toBe("svc/.config/nextest.toml")
  })

  test("puts a nextest config at the root when the build is at the root", async () => {
    expect(await setupPath({ "Cargo.toml": "", "crates/x/Cargo.toml": "" })).toBe(".config/nextest.toml")
  })
})

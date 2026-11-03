import { describe, expect, test } from "bun:test"
import type { PolicyIR } from "@gauntlet/ir"
import { Effect, Option } from "effect"
import { tamper } from "../src/tamper.ts"

const setupPath = async (builds: PolicyIR["builds"], files: Record<string, string>) => {
  const ir = { packs: ["rust"], builds } as unknown as PolicyIR
  const out = await Effect.runPromise(tamper({ files: Object.keys(files).sort(), read: (p) => Effect.succeed(Option.fromNullishOr(files[p])), ir, isTestPath: (p) => p.includes("/test") }))
  return out.find((t) => t.fixture === "edited-test-setup")!.edits[0]!.path
}

describe("the test setup fixture", () => {
  test("puts a nextest config in the build's folder when the build has a folder of its own", async () => {
    expect(await setupPath([{ pack: "jvm", dir: "jobs" }, { pack: "rust", dir: "svc" }], { "jobs/build.gradle.kts": "", "svc/Cargo.toml": "{}" })).toBe("svc/.config/nextest.toml")
  })

  test("puts a nextest config at the root when the build is at the root", async () => {
    expect(await setupPath(undefined, { "web/Cargo.toml": "{}" })).toBe(".config/nextest.toml")
  })
})

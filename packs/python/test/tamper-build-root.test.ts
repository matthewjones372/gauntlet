import { describe, expect, test } from "bun:test"
import type { PolicyIR } from "@gauntlet/ir"
import { Effect, Option } from "effect"
import { tamper } from "../src/tamper.ts"

const setupPath = async (builds: PolicyIR["builds"], files: Record<string, string>) => {
  const ir = { packs: ["python"], builds } as unknown as PolicyIR
  const out = await Effect.runPromise(tamper({ files: Object.keys(files).sort(), read: (p) => Effect.succeed(Option.fromNullishOr(files[p])), ir, isTestPath: (p) => p.includes("/test") }))
  return out.find((t) => t.fixture === "edited-test-setup")!.edits[0]!.path
}

describe("the test setup fixture", () => {
  test("puts a conftest.py in the build's folder when the build has a folder of its own", async () => {
    expect(await setupPath([{ pack: "jvm", dir: "jobs" }, { pack: "python", dir: "svc" }], { "jobs/build.gradle.kts": "", "svc/pyproject.toml": "{}" })).toBe("svc/conftest.py")
  })

  test("puts a conftest.py at the root when the build is at the root", async () => {
    expect(await setupPath(undefined, { "web/pyproject.toml": "{}" })).toBe("conftest.py")
  })
})

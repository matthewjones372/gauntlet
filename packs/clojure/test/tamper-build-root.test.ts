import { describe, expect, test } from "bun:test"
import type { PolicyIR } from "@gauntlet/ir"
import { Effect, Option } from "effect"
import { tamper } from "../src/tamper.ts"

const setupPath = async (builds: PolicyIR["builds"], files: Record<string, string>) => {
  const ir = { packs: ["clojure"], builds } as unknown as PolicyIR
  const out = await Effect.runPromise(tamper({ files: Object.keys(files).sort(), read: (p) => Effect.succeed(Option.fromNullishOr(files[p])), ir, isTestPath: (p) => p.includes("/test") }))
  return out.find((t) => t.fixture === "edited-test-setup")!.edits[0]!.path
}

describe("the test setup fixture", () => {
  test("puts a kaocha tests.edn in the pack's build folder in the policy", async () => {
    expect(await setupPath([{ pack: "jvm", dir: "jobs" }, { pack: "clojure", dir: "svc" }], { "jobs/build.gradle.kts": "", "svc/deps.edn": "{}" })).toBe("svc/tests.edn")
  })

  test("puts a kaocha tests.edn at the root when the policy runs the pack there, wherever the build's files are", async () => {
    expect(await setupPath(undefined, { "web/deps.edn": "{}" })).toBe("tests.edn")
  })
})

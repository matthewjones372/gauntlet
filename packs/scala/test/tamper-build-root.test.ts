import { describe, expect, test } from "bun:test"
import type { PolicyIR } from "@gauntlet/ir"
import { Effect, Option } from "effect"
import { tamper } from "../src/tamper.ts"

const setupPath = async (builds: PolicyIR["builds"], files: Record<string, string>) => {
  const ir = { packs: ["scala"], builds } as unknown as PolicyIR
  const out = await Effect.runPromise(tamper({ files: Object.keys(files).sort(), read: (p) => Effect.succeed(Option.fromNullishOr(files[p])), ir, isTestPath: (p) => p.includes("/test") }))
  return out.find((t) => t.fixture === "edited-test-setup")!.edits[0]!.path
}

describe("the sbt plugin fixture", () => {
  test("goes in the project/ of an sbt build in a folder of its own", async () => {
    expect(await setupPath([{ pack: "jvm", dir: "jobs" }, { pack: "scala", dir: "svc" }], { "jobs/build.gradle.kts": "", "svc/build.sbt": "{}" })).toBe("svc/project/GauntletSelftest.scala")
  })

  test("goes in the root's project/ when the build is at the root", async () => {
    expect(await setupPath(undefined, { "web/build.sbt": "{}" })).toBe("project/GauntletSelftest.scala")
  })
})

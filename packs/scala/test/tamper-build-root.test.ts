import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { tamper } from "../src/tamper.ts"

const setupPath = async (files: Record<string, string>) => {
  const out = await Effect.runPromise(tamper({ files: Object.keys(files).sort(), read: (p) => Effect.succeed(Option.fromNullishOr(files[p])), ir: undefined as never, isTestPath: (p) => p.includes("/src/test/") }))
  return out.find((t) => t.fixture === "edited-test-setup")!.edits[0]!.path
}

describe("the sbt plugin fixture", () => {
  test("goes in the project/ of an sbt build in a folder of its own", async () => {
    expect(await setupPath({
      "lark-bank/build.gradle.kts": "",
      "bank-checks/build.sbt": "",
      "bank-checks/policy/build.sbt": "",
      "bank-checks/policy/src/main/scala/a/A.scala": "package a\n",
    })).toBe("bank-checks/project/GauntletSelftest.scala")
  })

  test("goes in the root's project/ when the build is at the root", async () => {
    expect(await setupPath({ "build.sbt": "", "core/build.sbt": "" })).toBe("project/GauntletSelftest.scala")
  })
})

import { describe, expect, test } from "bun:test"
import { buildRootOf } from "../src/selftest.ts"

describe("the folder a fixture's runner config goes in", () => {
  test("is the pack's build folder in the policy", () => {
    expect(buildRootOf({ builds: [{ pack: "jvm", dir: "lark-bank" }, { pack: "scala", dir: "bank-checks" }] }, "scala")).toBe("bank-checks/")
  })

  test("is the shallowest of the pack's build folders", () => {
    expect(buildRootOf({ builds: [{ pack: "jvm", dir: "lark-bank/events" }, { pack: "jvm", dir: "lark-bank" }] }, "jvm")).toBe("lark-bank/")
  })

  test("is the root when the policy runs the pack at the root", () => {
    expect(buildRootOf({ builds: [{ pack: "typescript", dir: "." }] }, "typescript")).toBe("")
  })

  test("is the root when the policy names no folders", () => {
    expect(buildRootOf({}, "typescript")).toBe("")
  })
})

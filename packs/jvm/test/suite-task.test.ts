import { describe, expect, test } from "bun:test"
import { suiteTask } from "../src/gates.ts"

describe("which Gradle task a suite runs", () => {
  test("a source set at the root, in every module, or in one module", () => {
    expect(suiteTask("src/test/**")).toBe("test")
    expect(suiteTask("**/src/test/**")).toBe("test")
    expect(suiteTask("app/src/test/**")).toBe(":app:test")
    expect(suiteTask("libs/core/src/integrationTest/**")).toBe(":libs:core:integrationTest")
  })

  test("patterns that don't name a source set can't be mapped", () => {
    expect(suiteTask("**/*Test.kt")).toBeUndefined()
    expect(suiteTask("{a,b}/src/test/**")).toBeUndefined()
  })
})

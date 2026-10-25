import { describe, expect, test } from "bun:test"
import { buildRootOf } from "../src/selftest.ts"

describe("the folder a fixture's runner config goes in", () => {
  test("is the root when a marker is there, whatever builds sit below it", () => {
    expect(buildRootOf(["core/Cargo.toml", "Cargo.toml", "src/lib.rs"], ["Cargo.toml"])).toBe("")
  })

  test("is the shallowest folder with a marker when the build has a folder of its own", () => {
    expect(buildRootOf(["lark-bank/build.gradle.kts", "bank-checks/policy/build.sbt", "bank-checks/build.sbt"], ["build.sbt"])).toBe("bank-checks/")
  })

  test("takes any of the markers, and only whole file names", () => {
    expect(buildRootOf(["svc/setup.cfg", "docs/not-pyproject.toml"], ["pyproject.toml", "setup.cfg"])).toBe("svc/")
  })

  test("is the root when nothing is marked", () => {
    expect(buildRootOf(["src/main.py"], ["pyproject.toml"])).toBe("")
  })
})

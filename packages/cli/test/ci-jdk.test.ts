import { afterEach, describe, expect, test } from "bun:test"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli } from "./harness.ts"

// The GitHub workflow sets up the JDK the Gradle builds ask for, so CI can
// build a project on a newer Java than the default.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

describe("the workflow's JDK", () => {
  test("is the highest jvmToolchain the Gradle builds name", async () => {
    const s = baseRepo()
    repos.push(s.r)
    s.r.write({ "build.gradle.kts": "kotlin { jvmToolchain(25) }\n", "lib/build.gradle.kts": "java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }\n" })
    s.r.commit("builds on Java 25")
    const res = await cli(["connect", "github", "--repo", s.r.dir, "--dry-run"])
    expect(res.out).toContain(`java-version: "25"`)
  })
})

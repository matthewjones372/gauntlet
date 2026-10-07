import { describe, expect, test } from "bun:test"
import { onboard } from "../src/onboard.ts"

const view = (files: Record<string, string>) => ({ files: Object.keys(files).sort(), read: (p: string) => files[p] })
const PLUGINS = `plugins {\n  kotlin("jvm") version "2.4.10"\n  id("dev.detekt") version "2.0.0-alpha.6"\n  id("org.jetbrains.kotlinx.kover") version "0.9.11"\n  id("info.solidsoft.pitest") version "1.19.0"\n}\n`

describe("jvm onboarding", () => {
  test("every gate whose plugin is applied", () => {
    const o = onboard(view({ "build.gradle.kts": PLUGINS, "settings.gradle.kts": "", "gradle/wrapper/gradle-wrapper.properties": "", "src/test/kotlin/ATest.kt": "", "src/main/kotlin/A.kt": "" }))
    expect(o.fast).toEqual(["build", "lint ratchet"])
    expect(o.verify).toEqual(["coverage ratchet on changed", "mutation ratchet on changed"])
    expect(o.setup).toEqual([])
    expect(o.protect).toEqual({ tests: ["src/test/**"], fixtures: [], config: ["*.gradle.kts", "gradle/**"] })
    expect(o.suites).toEqual([{ name: "unit", location: "src/test/**" }])
  })

  test("a gate without its plugin is left out, with the line to add", () => {
    const o = onboard(view({ "build.gradle.kts": `plugins { kotlin("jvm") version "2.4.10" }\n`, "src/test/kotlin/ATest.kt": "" }))
    expect(o.fast).toEqual(["build"])
    expect(o.verify).toEqual(["coverage ratchet on changed"])
    expect(o.setup).toEqual([
      `Add id("dev.detekt") version "2.0.0-alpha.6" to the plugins block of build.gradle.kts to gate lint.`,
      `Add id("info.solidsoft.pitest") version "1.19.0" to the plugins block of build.gradle.kts to gate mutation.`,
    ])
  })

  test("plugins from a version catalog count, and multi-module builds protect every module's tests and build files", () => {
    const o = onboard(view({
      "settings.gradle.kts": "",
      "app/build.gradle.kts": "plugins { alias(libs.plugins.kover) }",
      "gradle/libs.versions.toml": `[plugins]\nkover = { id = "org.jetbrains.kotlinx.kover", version = "0.9.11" }\n`,
      "app/src/test/kotlin/ATest.kt": "",
      "app/src/integrationTest/kotlin/BTest.kt": "",
      "app/src/test/resources/golden.json": "",
    }))
    expect(o.verify).toEqual(["coverage ratchet on changed"])
    expect(o.protect.tests).toEqual(["**/src/test/**", "**/src/integrationTest/**"])
    expect(o.protect.fixtures).toEqual(["**/src/test/resources/**"])
    expect(o.protect.config).toEqual(["*.gradle.kts", "**/*.gradle.kts", "gradle/**"])
  })
})

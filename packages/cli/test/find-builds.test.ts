import { describe, expect, test } from "bun:test"
import { findBuilds } from "@gauntlet/core"
import { INSTALLED_PACKS } from "../src/packs.ts"

// ADR 0022: with no build at the root, setup looks in folders for them.

const TWEET_STREET = [
  "README.md", ".github/workflows/build.yml",
  "lark-bank/settings.gradle.kts", "lark-bank/build.gradle.kts", "lark-bank/gradlew",
  "lark-bank/app/build.gradle.kts", "lark-bank/app/src/main/kotlin/App.kt",
  "lark-bank/events/settings.gradle.kts", "lark-bank/events/build.gradle.kts", "lark-bank/events/src/main/kotlin/Event.kt",
  "bank-access/settings.gradle.kts", "bank-access/fga/build.gradle.kts", "bank-access/fga/src/main/kotlin/Fga.kt",
  "bank-checks/build.sbt", "bank-checks/src/main/scala/Check.scala",
  "web/node_modules/x/package.json",
]

describe("findBuilds", () => {
  test("each folder with a build, an included build with its own settings, and never a subproject", () => {
    expect(findBuilds(TWEET_STREET, INSTALLED_PACKS)).toEqual([
      { pack: "jvm", dir: "bank-access" },
      { pack: "scala", dir: "bank-checks" },
      { pack: "jvm", dir: "lark-bank" },
      { pack: "jvm", dir: "lark-bank/events" },
    ])
  })

  test("hidden and dependency folders are never searched", () => {
    expect(findBuilds([".tools/settings.gradle.kts", ".tools/A.kt", "node_modules/p/package.json", "node_modules/p/i.ts"], INSTALLED_PACKS)).toEqual([])
  })
})

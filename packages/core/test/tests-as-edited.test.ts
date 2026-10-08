import { describe, expect, test } from "bun:test"
import { planMaterialisation } from "../src/index.ts"

// What happens to each changed protected file when edited tests run as edited.

const protect = [
  { group: "tests", kind: "tests" as const, globs: ["src/test/**"] },
  { group: "config", kind: "config" as const, globs: ["build.gradle.kts"] },
]
const plan = (changes: Parameters<typeof planMaterialisation>[0], asEdited: boolean) =>
  planMaterialisation(changes, protect, [], [], asEdited).map((m) => `${m.action} ${m.path}`)

describe("planMaterialisation with tests as edited", () => {
  const changes = [
    { status: "modified" as const, path: "src/test/ATest.kt" },
    { status: "deleted" as const, path: "src/test/GoneTest.kt" },
    { status: "renamed" as const, path: "src/test/NewName.kt", oldPath: "src/test/OldName.kt" },
    { status: "added" as const, path: "src/test/FreshTest.kt" },
    { status: "modified" as const, path: "build.gradle.kts" },
  ]

  test("edited, deleted and moved tests stay as the change has them; configuration is still restored", () => {
    expect(plan(changes, true)).toEqual([
      "restored build.gradle.kts",
      "edited src/test/ATest.kt",
      "kept src/test/FreshTest.kt",
      "edited src/test/GoneTest.kt",
      "edited src/test/NewName.kt",
      "edited src/test/OldName.kt",
    ])
  })

  test("without it (protect-only), tests are restored as before", () => {
    expect(plan(changes, false)).toEqual([
      "restored build.gradle.kts",
      "restored src/test/ATest.kt",
      "kept src/test/FreshTest.kt",
      "restored src/test/GoneTest.kt",
      "removed src/test/NewName.kt",
      "restored src/test/OldName.kt",
    ])
  })
})

import { describe, expect, test } from "bun:test"
import { checkGlob, globMatches, globsMayOverlap } from "../src/index.ts"

describe("checkGlob", () => {
  test.each(["src/test/**", "*.gradle.kts", "src/{main,test}/**", "src/[a-z]*/x.kt", ".gauntlet/**"])("accepts %s", (g) => {
    expect(checkGlob(g)).toBeUndefined()
  })
  test.each(["", "/abs/**", "a\\b", "../x/**", "a/***", "src/test**", "src/{main", "src/[ab"])("rejects %s", (g) => {
    expect(checkGlob(g)).toBeDefined()
  })
})

describe("globMatches", () => {
  const cases: ReadonlyArray<[string, string, boolean]> = [
    ["src/test/**", "src/test/a/B.kt", true],
    ["src/test/**", "src/test", true],
    ["src/test/**", "src/main/A.kt", false],
    ["*.gradle.kts", "build.gradle.kts", true],
    ["*.gradle.kts", "app/build.gradle.kts", false],
    ["**/*.gradle.kts", "app/build.gradle.kts", true],
    ["src/**/money/**", "src/main/kotlin/money/Fx.kt", true],
    ["src/**/money/**", "src/main/kotlin/honey/Fx.kt", false],
    ["src/{main,test}/**", "src/test/X.kt", true],
    ["src/{main,test}/**", "src/it/X.kt", false],
    ["src/?/x", "src/a/x", true],
    ["src/test/**", "src/test/a[1].kt", true],
  ]
  test.each(cases)("%s matches %s: %p", (glob, path, expected) => expect(globMatches(glob, path)).toBe(expected))
})

describe("globsMayOverlap", () => {
  const cases: ReadonlyArray<[string, string, boolean]> = [
    ["src/test/**", "src/**/money/**", true],
    ["src/test/**", "src/main/**", false],
    ["*.gradle.kts", "src/**", false],
    ["**", "anything/at/all", true],
    ["src/*/x/**", "src/a/x/y", true],
    ["src/*.kt", "src/main/**", false],
    [".gauntlet/**", "src/**", false],
  ]
  test.each(cases)("%s and %s: %p", (a, b, expected) => {
    expect(globsMayOverlap(a, b)).toBe(expected)
    expect(globsMayOverlap(b, a)).toBe(expected)
  })
})

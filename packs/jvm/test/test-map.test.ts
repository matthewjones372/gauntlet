import { describe, expect, test } from "bun:test"
import { classIndex, executedClasses, includesFor, testMapOf } from "../src/test-map.ts"
import { LISTENER_BYTES, LISTENER_CLASS } from "../src/testmap-listener.ts"
import { execFile } from "./exec-file.ts"

// The JVM pack's test map (spec 0013): JaCoCo's execution data, written by
// Gauntlet's listener once per test class, turned into the source files each
// class executed.

const sources = [
  { path: "domain/src/main/kotlin/bank/domain/Money.kt", text: "package bank.domain\n\ndata class Money(val minor: Long) {\n  companion object { val ZERO = Money(0) }\n}\n\nfun Money.double() = Money(minor * 2)\n" },
  { path: "domain/src/main/kotlin/bank/domain/Rates.kt", text: "package bank.domain\n\nconst val SCALE = 4\n\nobject Rates\n" },
  { path: "domain/src/main/kotlin/bank/domain/Inline.kt", text: "package bank.domain\n\ninline fun <T> timed(block: () -> T): T = block()\n" },
  { path: "app/src/main/java/bank/app/Server.java", text: "package bank.app;\n\npublic final class Server {}\nenum Mode { ON }\n" },
  { path: "app/src/main/kotlin/bank/app/Ledger.kt", text: "@file:JvmName(\"Ledgers\")\npackage bank.app\n\nfun post() = Unit\n" },
  { path: "domain/src/test/kotlin/bank/domain/MoneySpec.kt", text: "package bank.domain\n\nclass MoneySpec {\n  @Nested inner class Adding\n}\n" },
  { path: "domain/src/test/kotlin/bank/domain/Fixtures.kt", text: "package bank.domain\n\nobject Fixtures\n" },
]

describe("JaCoCo's execution data", () => {
  test("names the classes that ran any code, not those only loaded", () => {
    const bytes = execFile([{ name: "bank/domain/Money", probes: [false, true, false, false, false, false, false, false, false] }, { name: "bank/domain/Rates", probes: [false, false] }, { name: "bank/app/Server", probes: Array(17).fill(false).map((_, i) => i === 16) }])
    expect(executedClasses(bytes)).toEqual(["bank/app/Server", "bank/domain/Money"])
  })

  test("anything that isn't execution data reads as nothing to trust", () => {
    expect(executedClasses(new TextEncoder().encode("not an exec file"))).toBeUndefined()
    expect(executedClasses(execFile([{ name: "a/B", probes: [true] }]).slice(0, 20))).toBeUndefined()
  })
})

describe("which source file a class comes from", () => {
  const index = classIndex(sources)

  test("declared classes, nested and generated classes, file facades and @JvmName", () => {
    expect(["bank/domain/Money", "bank/domain/Money$Companion", "bank/domain/MoneyKt", "bank/domain/Rates", "bank/app/Server", "bank/app/Mode", "bank/app/Ledgers", "bank/domain/MoneySpec$Adding", "bank/other/Thing"].map(index))
      .toEqual([
        "domain/src/main/kotlin/bank/domain/Money.kt", "domain/src/main/kotlin/bank/domain/Money.kt", "domain/src/main/kotlin/bank/domain/Money.kt",
        "domain/src/main/kotlin/bank/domain/Rates.kt", "app/src/main/java/bank/app/Server.java", "app/src/main/java/bank/app/Server.java",
        "app/src/main/kotlin/bank/app/Ledger.kt", "domain/src/test/kotlin/bank/domain/MoneySpec.kt", undefined,
      ])
  })

  test("the agent is limited to the build's own packages", () => {
    expect(includesFor(sources)).toBe("bank.app.*:bank.domain.*")
    expect(includesFor([...sources, { path: "src/main/kotlin/Top.kt", text: "fun main() = Unit\n" }])).toBeUndefined()
  })
})

describe("the map", () => {
  const exec = (...names: string[]) => execFile(names.map((name) => ({ name, probes: [true] })))

  test("each test class's executed files, its own file among them", () => {
    const map = testMapOf([
      { testClass: "bank.domain.MoneySpec", bytes: exec("bank/domain/MoneySpec", "bank/domain/MoneySpec$Adding", "bank/domain/Money$Companion", "bank/domain/Fixtures") },
      { testClass: "bank.domain.OtherSpec", bytes: exec("bank/app/Server", "kotlin/collections/CollectionsKt") },
    ], sources)
    expect(map).toEqual({
      "bank.domain.MoneySpec": ["domain/src/main/kotlin/bank/domain/Money.kt", "domain/src/test/kotlin/bank/domain/Fixtures.kt", "domain/src/test/kotlin/bank/domain/MoneySpec.kt"],
      "bank.domain.OtherSpec": ["app/src/main/java/bank/app/Server.java"],
    })
  })

  test("files whose code is copied into their callers (inline functions, constants) are never in it, so changing one runs every test", () => {
    const map = testMapOf([{ testClass: "bank.domain.MoneySpec", bytes: exec("bank/domain/Rates", "bank/domain/InlineKt", "bank/domain/Money") }], sources)
    expect(map).toEqual({ "bank.domain.MoneySpec": ["domain/src/main/kotlin/bank/domain/Money.kt", "domain/src/test/kotlin/bank/domain/MoneySpec.kt"] })
  })

  test("a class that ran twice (in two test tasks) has both runs' files; data that can't be read means no map", () => {
    const twice = testMapOf([
      { testClass: "bank.domain.MoneySpec", bytes: exec("bank/domain/Money") },
      { testClass: "bank.domain.MoneySpec", bytes: exec("bank/app/Server") },
    ], sources)
    expect(twice?.["bank.domain.MoneySpec"]).toContain("app/src/main/java/bank/app/Server.java")
    expect(testMapOf([{ testClass: "bank.domain.MoneySpec", bytes: new Uint8Array([1, 2, 3]) }], sources)).toBeUndefined()
  })
})

describe("the embedded listener", () => {
  test("is a Java 8 class file named for its ServiceLoader entry", () => {
    const bytes = Buffer.from(LISTENER_BYTES, "base64")
    expect(bytes.readUInt32BE(0)).toBe(0xcafebabe)
    expect(bytes.readUInt16BE(6)).toBe(52)
    expect(bytes.includes(Buffer.from(LISTENER_CLASS.replaceAll(".", "/")))).toBe(true)
  })
})

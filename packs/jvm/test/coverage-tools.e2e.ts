import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cpSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { cli } from "../../../packages/cli/test/harness.ts"
import { TempRepo } from "../../../packages/core/test/temp-repo.ts"
import { jvmPack } from "../src/index.ts"

// Coverage on Gradle projects that apply no coverage plugin: Gauntlet brings
// Kover's JVM agent and CLI for Kotlin, and Gradle's built-in JaCoCo for Java
// (ADR 0007). Real Gradle; opt in with GAUNTLET_E2E=1. The projects are
// written here, with the Gradle wrapper copied from the Kotlin fixture.

const E2E = process.env.GAUNTLET_E2E === "1"
const FIXTURE = join(import.meta.dir, "..", "..", "..", "examples", "fixtures", "kotlin-service")
const TIMEOUT = 10 * 60 * 1000
const jvm = (args: string[]) => cli(args, [jvmPack])

const POLICY = (name: string) => `gauntlet "${name}"
use jvm
mode enforce
owners @platform

protect {
  tests "src/test/**"
}

suites { unit "src/test/**" }

gates {
  verify { unit, coverage ratchet >= 80% on changed }
}

review {
  review when protected changed
  auto   when all gates pass
}
`

const DEPENDENCIES = `repositories { mavenCentral() }

dependencies {
    testImplementation("org.junit.jupiter:junit-jupiter:6.1.3")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.withType<Test> { useJUnitPlatform() }
`

const PROJECTS = {
  kotlin: {
    tool: "kover",
    files: {
      "settings.gradle.kts": `rootProject.name = "kt"\n`,
      "build.gradle.kts": `plugins { kotlin("jvm") version "2.4.10" }\n\nkotlin { jvmToolchain(25) }\n\n${DEPENDENCIES}`,
      "src/main/kotlin/svc/Calc.kt": "package svc\n\nobject Calc {\n    fun add(a: Int, b: Int): Int = a + b\n}\n",
      "src/test/kotlin/svc/CalcTest.kt": "package svc\n\nimport org.junit.jupiter.api.Assertions.assertEquals\nimport org.junit.jupiter.api.Test\n\nclass CalcTest {\n    @Test\n    fun adds() {\n        assertEquals(3, Calc.add(1, 2))\n    }\n}\n",
    },
    covered: { "src/main/kotlin/svc/Calc.kt": "package svc\n\nobject Calc {\n    fun add(a: Int, b: Int): Int = a + b\n\n    fun twice(a: Int): Int = add(a, a)\n}\n", "src/test/kotlin/svc/TwiceTest.kt": "package svc\n\nimport org.junit.jupiter.api.Assertions.assertEquals\nimport org.junit.jupiter.api.Test\n\nclass TwiceTest {\n    @Test\n    fun doubles() {\n        assertEquals(4, Calc.twice(2))\n    }\n}\n" },
    uncovered: { "src/main/kotlin/svc/Calc.kt": "package svc\n\nobject Calc {\n    fun add(a: Int, b: Int): Int = a + b\n\n    fun sub(a: Int, b: Int): Int {\n        val result = a - b\n        return result\n    }\n}\n" },
  },
  java: {
    tool: "jacoco",
    files: {
      "settings.gradle.kts": `rootProject.name = "jv"\n`,
      "build.gradle.kts": `plugins { java }\n\njava { toolchain { languageVersion.set(JavaLanguageVersion.of(25)) } }\n\n${DEPENDENCIES}`,
      "src/main/java/svc/Calc.java": "package svc;\n\npublic class Calc {\n    public static int add(int a, int b) {\n        return a + b;\n    }\n}\n",
      "src/test/java/svc/CalcTest.java": "package svc;\n\nimport org.junit.jupiter.api.Test;\nimport static org.junit.jupiter.api.Assertions.assertEquals;\n\nclass CalcTest {\n    @Test\n    void adds() {\n        assertEquals(3, Calc.add(1, 2));\n    }\n}\n",
    },
    covered: { "src/main/java/svc/Calc.java": "package svc;\n\npublic class Calc {\n    public static int add(int a, int b) {\n        return a + b;\n    }\n\n    public static int twice(int a) {\n        return add(a, a);\n    }\n}\n", "src/test/java/svc/TwiceTest.java": "package svc;\n\nimport org.junit.jupiter.api.Test;\nimport static org.junit.jupiter.api.Assertions.assertEquals;\n\nclass TwiceTest {\n    @Test\n    void doubles() {\n        assertEquals(4, Calc.twice(2));\n    }\n}\n" },
    uncovered: { "src/main/java/svc/Calc.java": "package svc;\n\npublic class Calc {\n    public static int add(int a, int b) {\n        return a + b;\n    }\n\n    public static int sub(int a, int b) {\n        int result = a - b;\n        return result;\n    }\n}\n" },
  },
} as const

for (const [language, p] of Object.entries(PROJECTS)) {
  describe.skipIf(!E2E)(`coverage without a plugin (${language}, ${p.tool})`, () => {
    let repo: TempRepo
    let base = ""

    beforeAll(() => {
      repo = new TempRepo()
      for (const f of ["gradlew", "gradle"]) cpSync(join(FIXTURE, f), join(repo.dir, f), { recursive: true })
      repo.write({ ...p.files, ".gauntlet/policy.gx": POLICY(language) })
      base = repo.commit("trunk")
    })
    afterAll(() => repo?.cleanup())

    const check = async (name: string, files: Record<string, string>) => {
      repo.git("checkout", "-q", "-B", name, base)
      repo.write(files)
      repo.commit(name)
      const out = join(repo.dir, ".git", `out-${name}`)
      await jvm(["check", "--repo", repo.dir, "--policy-ref", base, "--out", out, "--no-record"])
      const report = JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8"))
      return { report, coverage: report.checks.find((c: { check: string }) => c.check === "coverage") }
    }

    test("tested new code passes the floor; untested new code fails it", async () => {
      const covered = await check("covered", p.covered)
      expect(covered.coverage.status).toBe("passed")
      expect(covered.report.decision.tier).toBe("auto")
      const uncovered = await check("uncovered", p.uncovered)
      expect(uncovered.coverage.status).toBe("failed")
    }, TIMEOUT)
  })
}

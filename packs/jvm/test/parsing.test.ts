import { describe, expect, test } from "bun:test"
import { parseDependencies } from "../src/dependencies.ts"
import { enclosingSymbol, parseKotlin, stripLineComment } from "../src/kotlin/syntax.ts"
import { parseCoverage, parseMutations } from "../src/reports.ts"
import { pitestTargets, sourceIndex } from "../src/sources.ts"

describe("dependencies", () => {
  test("Gradle Kotlin DSL: configurations and plugins, ignoring comments", () => {
    const text = `plugins {\n  kotlin("jvm") version "2.4.10"\n  id("dev.detekt") version "2.0.0"\n}\ndependencies {\n  // implementation("commented:out:1")\n  implementation("a:b:1")\n  testImplementation("org.junit.jupiter:junit-jupiter:6.1.3")\n  implementation(libs.arrow.core)\n}`
    expect(parseDependencies("build.gradle.kts", text)).toEqual([
      "a:b:1", "libs.arrow.core", "org.junit.jupiter:junit-jupiter:6.1.3", "plugin:dev.detekt:2.0.0", "plugin:org.jetbrains.kotlin.jvm:2.4.10",
    ])
  })

  test("version catalogs", () => {
    const toml = `[libraries]\narrow = { module = "io.arrow-kt:arrow-core", version.ref = "arrow" }\nktor = "io.ktor:ktor-server-core:3.1.0"\n[plugins]\nkover = { id = "org.jetbrains.kotlinx.kover", version = "0.9.11" }`
    expect(parseDependencies("gradle/libs.versions.toml", toml)).toEqual(["io.arrow-kt:arrow-core:arrow", "io.ktor:ktor-server-core:3.1.0", "plugin:org.jetbrains.kotlinx.kover:0.9.11"])
  })
})

describe("sources", () => {
  test("report paths map back to repository files", () => {
    const find = sourceIndex(["app/src/main/kotlin/svc/domain/Money.kt", "src/test/kotlin/svc/domain/MoneyTest.kt"])
    expect(find("svc/domain", "Money.kt")).toBe("app/src/main/kotlin/svc/domain/Money.kt")
    expect(find("svc/domain", "MoneyTest.kt")).toBeUndefined()
  })

  test("Pitest targets cover the file class and declared classes", () => {
    expect(pitestTargets("src/main/kotlin/svc/Fx.kt", "package svc\n\ndata class Rate(val x: Long)\nclass Fx\n")).toEqual(["svc.Fx*", "svc.FxKt*", "svc.Rate*"])
  })
})

describe("report parsers", () => {
  test("Pitest mutations", () => {
    const xml = `<mutations><mutation detected='true' status='KILLED'><sourceFile>Fx.kt</sourceFile><mutatedClass>svc.Fx</mutatedClass><lineNumber>7</lineNumber></mutation><mutation detected='false' status='SURVIVED'><sourceFile>Fx.kt</sourceFile><mutatedClass>svc.Fx</mutatedClass><lineNumber>8</lineNumber></mutation></mutations>`
    expect(parseMutations(xml).map((m) => `${m.className}:${m.line}:${m.detected}`)).toEqual(["svc.Fx:7:true", "svc.Fx:8:false"])
  })

  test("Kover line coverage", () => {
    const xml = `<report name="r"><package name="svc"><sourcefile name="Fx.kt"><line nr="3" mi="0" ci="2"/><line nr="4" mi="3" ci="0"/></sourcefile></package></report>`
    const [file] = parseCoverage(xml)
    expect(file?.packagePath).toBe("svc")
    expect([...file!.lines]).toEqual([[3, true], [4, false]])
  })
})

describe("fingerprint helpers", () => {
  test("enclosing symbol is the innermost class and function", () => {
    const tree = parseKotlin("class Fx {\n  fun convert() {\n    val x = 1\n  }\n}\n")
    expect(enclosingSymbol(tree, 3)).toBe("Fx.convert")
    expect(enclosingSymbol(tree, 1)).toBe("Fx")
  })

  test("comments are stripped, but not // inside strings", () => {
    expect(stripLineComment(`val x = 1 // note`)).toBe("val x = 1 ")
    expect(stripLineComment(`val u = "http://x" // note`)).toBe(`val u = "http://x" `)
  })
})

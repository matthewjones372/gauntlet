import { describe, expect, test } from "bun:test"
import { compilePolicy, formatDiagnostics } from "@gauntlet/dsl"
import { jvmSpec } from "@gauntlet/pack-jvm"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { embed } from "../src/embed.ts"
import { defaultPackage, invalidVars, render, TEMPLATES } from "../src/index.ts"

const kotlin = TEMPLATES.find((t) => t.name === "kotlin-service")!
const vars = { name: "payments-api", package: "com.acme.payments", owner: "@acme/payments" }
const text = (files: ReturnType<typeof render>, path: string) => new TextDecoder().decode(files.find((f) => f.path === path)!.content)

describe("kotlin-service", () => {
  test("the embedded files match the template directory (run `bun run generate` after editing it)", () => {
    const dir = join(import.meta.dir, "..", "kotlin-service")
    const walk = (d: string): string[] => readdirSync(d).sort().flatMap((e) => (statSync(join(d, e)).isDirectory() ? walk(join(d, e)) : [join(d, e)]))
    const files = walk(dir).map((f) => ({ path: relative(dir, f), bytes: readFileSync(f), executable: (statSync(f).mode & 0o111) !== 0 }))
    expect(readFileSync(join(import.meta.dir, "..", "src", "generated", "kotlin-service.ts"), "utf8")).toBe(embed(files))
  })

  test("every placeholder is filled and package directories follow the package", () => {
    const files = render(kotlin, vars)
    for (const f of files) {
      expect(f.path).not.toContain("__package__")
      expect(new TextDecoder().decode(f.content)).not.toMatch(/\{\{\w+\}\}/)
    }
    expect(files.map((f) => f.path)).toContain("src/main/kotlin/com/acme/payments/domain/Money.kt")
    expect(files.map((f) => f.path)).toContain(".gitignore")
    expect(text(files, "src/main/kotlin/com/acme/payments/domain/Money.kt")).toStartWith("package com.acme.payments.domain\n")
    expect(text(files, "settings.gradle.kts")).toContain(`rootProject.name = "payments-api"`)
    expect(text(files, "build.gradle.kts")).toContain(`targetClasses.set(listOf("com.acme.payments.*"))`)
    expect(files.find((f) => f.path === "gradlew")?.executable).toBe(true)
  })

  test("the wrapper jar survives byte for byte", () => {
    const jar = render(kotlin, vars).find((f) => f.path === "gradle/wrapper/gradle-wrapper.jar")!
    expect(Buffer.from(jar.content).equals(readFileSync(join(import.meta.dir, "..", "kotlin-service", "gradle", "wrapper", "gradle-wrapper.jar")))).toBe(true)
  })

  test("the policy compiles, enforces, and sets the strict bars", () => {
    const policy = text(render(kotlin, vars), ".gauntlet/policy.gx")
    const r = compilePolicy({ file: ".gauntlet/policy.gx", text: policy }, [jvmSpec])
    if (r._tag === "Invalid") throw new Error(formatDiagnostics(r.diagnostics, policy))
    const ir = r.compiled.ir
    expect(ir.mode).toBe("enforce")
    expect(ir.owners).toEqual(["@acme/payments"])
    expect(ir.protect.find((g) => g.kind === "tests")?.globs).toEqual(["src/test/**"])
    expect(ir.protect.find((g) => g.kind === "config")?.globs).toContain("*.gradle.kts")
    expect(ir.arch.length).toBeGreaterThan(0)
    expect(policy).toContain("coverage >= 90% on changed")
    expect(policy).toContain("mutation ratchet >= 80% on changed")
    expect(policy).toContain("kotlin.no-run-catching")
  })
})

describe("template values", () => {
  test("names, packages and owners are checked", () => {
    expect(invalidVars(vars)).toBeUndefined()
    expect(invalidVars({ ...vars, name: "Payments" })).toContain("name")
    expect(invalidVars({ ...vars, package: "com.Acme" })).toContain("package")
    expect(invalidVars({ ...vars, package: "com..acme" })).toContain("package")
    expect(invalidVars({ ...vars, owner: "acme" })).toContain("owner")
  })

  test("the default package comes from the name", () => {
    expect(defaultPackage("payment-service")).toBe("payment.service")
    expect(defaultPackage("svc")).toBe("svc")
    expect(defaultPackage("3d-render")).toBe("p3d.render")
    expect(invalidVars({ ...vars, package: defaultPackage("3d-render") })).toBeUndefined()
  })
})

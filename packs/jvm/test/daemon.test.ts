import { describe, expect, test } from "bun:test"
import { buildJvmArgs, daemonMarker } from "../src/gradle.ts"

// ADR 0020: the check's Gradle daemon runs with the build's own JVM arguments
// plus a marker no other build carries.

describe("the check's Gradle daemon", () => {
  test("uses the build's org.gradle.jvmargs, continuation lines included", () => {
    expect(buildJvmArgs("org.gradle.caching=true\norg.gradle.jvmargs=-Xmx2g -Dfile.encoding=UTF-8\n")).toBe("-Xmx2g -Dfile.encoding=UTF-8")
    expect(buildJvmArgs("org.gradle.jvmargs = -Xmx1g \\\n    -XX:+UseParallelGC\n")).toBe("-Xmx1g -XX:+UseParallelGC")
    expect(buildJvmArgs("org.gradle.jvmargs:-Xmx3g")).toBe("-Xmx3g")
  })

  test("falls back to Gradle's default when the build sets none", () => {
    expect(buildJvmArgs(undefined)).toBe("-Xmx512m -XX:MaxMetaspaceSize=384m")
    expect(buildJvmArgs("org.gradle.jvmargs=\n")).toBe("-Xmx512m -XX:MaxMetaspaceSize=384m")
  })

  test("the marker names the check's directory", () => {
    expect(daemonMarker("/tmp/gauntlet-abc/outputs")).toBe("-Dgauntlet.check=/tmp/gauntlet-abc/outputs")
  })
})

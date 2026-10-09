import type { Pack } from "@gauntlet/core"
import { spec } from "./catalog.ts"
import { doctor } from "./doctor.ts"
import { onboard } from "./onboard.ts"
import { parseDependencies } from "./dependencies.ts"
import { arch, build, coverage, lint, mutation, runSuite } from "./gates.ts"
import { stopDaemon } from "./gradle.ts"
import { kotlinDetector } from "./kotlin/detectors.ts"
import { tamper } from "./kotlin/tamper.ts"
import { enclosingSymbol, isKotlin, parseKotlin, stripLineComment } from "./kotlin/syntax.ts"

/** Detects a Kotlin Gradle project from its file list. */
export const detectJvm = (files: ReadonlyArray<string>): boolean =>
  files.some((f) => /^(settings|build)\.gradle(\.kts)?$/.test(f)) && files.some(isKotlin)

export const jvmPack: Pack = {
  spec,
  detect: detectJvm,
  readsCi: true,
  suiteWithCoverage: true,
  // An included build (\`includeBuild("events")\`) has its own settings file; a subproject doesn't.
  ownBuild: (files) => files.some((f) => /^settings\.gradle(\.kts)?$/.test(f)),
  onboard,
  doctor,
  // Test setup the suites depend on, put back to base before they run (ADR 0003).
  runnerConfig: [
    "settings.gradle.kts", "settings.gradle", "gradle.properties", "gradlew", "gradlew.bat", "gradle/**",
    "**/junit-platform.properties", "**/src/test/resources/junit-platform.properties",
  ],
  manifests: ["**/*.gradle.kts", "**/*.gradle", "gradle/libs.versions.toml"],
  dependencies: parseDependencies,
  detectors: [kotlinDetector],
  gates: { build, lint, arch, mutation, coverage },
  runSuite,
  // The check's own Gradle daemon ends with the check (ADR 0020).
  stop: ({ root }) => stopDaemon(root),
  reruns: true,
  tamper,
  locate: (path, lines, line) => (isKotlin(path) ? enclosingSymbol(parseKotlin(lines.join("\n")), line) : undefined),
  normalise: stripLineComment,
}

export { spec as jvmSpec } from "./catalog.ts"

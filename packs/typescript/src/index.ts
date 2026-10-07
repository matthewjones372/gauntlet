import type { Pack } from "@gauntlet/core"
import { spec } from "./catalog.ts"
import { doctor } from "./doctor.ts"
import { onboard } from "./onboard.ts"
import { parseDependencies } from "./dependencies.ts"
import { typescriptDetector } from "./detectors.ts"
import { arch, build, coverage, lint, mutation, runSuite } from "./gates.ts"
import { enclosingSymbol, parseTs, stripLineComment } from "./syntax.ts"
import { tamper } from "./tamper.ts"
import { isTsSource } from "./toolchain.ts"

/** Detects a TypeScript or JavaScript project from its file list. */
export const detectTypescript = (files: ReadonlyArray<string>): boolean => files.includes("package.json") && files.some(isTsSource)

export const typescriptPack: Pack = {
  spec,
  detect: detectTypescript,
  onboard,
  doctor,
  // Test, type-check, lint and mutation configuration, put back to base before anything runs (ADR 0003).
  runnerConfig: [
    "vitest.config.*", "vitest.workspace.*", "jest.config.*", "bunfig.toml", "tsconfig*.json",
    "stryker.config.*", "stryker.conf.*", ".strykerrc*", "biome.json", "biome.jsonc", "eslint.config.*", ".eslintrc*",
  ],
  manifests: ["package.json", "**/package.json"],
  dependencies: parseDependencies,
  detectors: [typescriptDetector],
  gates: { build, lint, arch, mutation, coverage },
  runSuite,
  reruns: true,
  tamper,
  locate: (path, lines, line) => (isTsSource(path) ? enclosingSymbol(parseTs(path, lines.join("\n")), line) : undefined),
  normalise: stripLineComment,
}

export { spec as typescriptSpec } from "./catalog.ts"

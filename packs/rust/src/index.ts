import type { Pack } from "@gauntlet/core"
import { spec } from "./catalog.ts"
import { parseDependencies } from "./dependencies.ts"
import { rustDetector } from "./detectors.ts"
import { doctor } from "./doctor.ts"
import { arch, build, coverage, lint, mutation, runSuite } from "./gates.ts"
import { onboard } from "./onboard.ts"
import { enclosingSymbol, parseRust, stripLineComment } from "./syntax.ts"
import { tamper } from "./tamper.ts"
import { isRust } from "./toolchain.ts"

/** Detects a Cargo project from its file list. */
export const detectRust = (files: ReadonlyArray<string>): boolean => files.includes("Cargo.toml") && files.some(isRust)

export const rustPack: Pack = {
  spec,
  detect: detectRust,
  onboard,
  doctor,
  // Test, lint and mutation configuration, put back to base before anything runs (ADR 0003).
  runnerConfig: [".config/nextest.toml", ".cargo/config.toml", ".cargo/config", ".cargo/mutants.toml", "clippy.toml", ".clippy.toml"],
  manifests: ["Cargo.toml", "**/Cargo.toml"],
  dependencies: parseDependencies,
  detectors: [rustDetector],
  gates: { build, lint, arch, mutation, coverage },
  runSuite,
  reruns: true,
  tamper,
  locate: (path, lines, line) => (isRust(path) ? enclosingSymbol(parseRust(lines.join("\n")), line) : undefined),
  normalise: stripLineComment,
}

export { spec as rustSpec } from "./catalog.ts"

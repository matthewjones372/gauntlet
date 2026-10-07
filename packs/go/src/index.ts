import type { Pack } from "@gauntlet/core"
import { spec } from "./catalog.ts"
import { parseDependencies } from "./dependencies.ts"
import { goDetector } from "./detectors.ts"
import { doctor } from "./doctor.ts"
import { arch, build, coverage, lint, mutation, runSuite } from "./gates.ts"
import { onboard } from "./onboard.ts"
import { enclosingSymbol, parseGo, stripLineComment } from "./syntax.ts"
import { tamper } from "./tamper.ts"
import { isGo } from "./toolchain.ts"

/** Detects a Go module from its file list. */
export const detectGo = (files: ReadonlyArray<string>): boolean => files.includes("go.mod") && files.some(isGo)

export const goPack: Pack = {
  spec,
  detect: detectGo,
  onboard,
  doctor,
  // Lint and mutation configuration, put back to base before anything runs (ADR 0003).
  runnerConfig: [".golangci.yml", ".golangci.yaml", ".golangci.toml", ".golangci.json", ".gremlins.yaml", ".gremlins.yml"],
  manifests: ["go.mod", "**/go.mod"],
  dependencies: parseDependencies,
  detectors: [goDetector],
  gates: { build, lint, arch, mutation, coverage },
  runSuite,
  reruns: true,
  tamper,
  locate: (path, lines, line) => (isGo(path) ? enclosingSymbol(parseGo(lines.join("\n")), line) : undefined),
  normalise: stripLineComment,
}

export { spec as goSpec } from "./catalog.ts"

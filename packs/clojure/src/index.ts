import type { Pack } from "@gauntlet/core"
import { spec } from "./catalog.ts"
import { parseDependencies } from "./dependencies.ts"
import { clojureDetector } from "./detectors.ts"
import { doctor } from "./doctor.ts"
import { arch, build, coverage, lint, runSuite } from "./gates.ts"
import { onboard } from "./onboard.ts"
import { enclosingSymbol, read, stripLineComment } from "./syntax.ts"
import { tamper } from "./tamper.ts"
import { buildTool, isClojure } from "./toolchain.ts"

/** Detects a Clojure project (deps.edn or project.clj) from its file list. */
export const detectClojure = (files: ReadonlyArray<string>): boolean => buildTool(files) !== undefined && files.some(isClojure)

export const clojurePack: Pack = {
  spec,
  detect: detectClojure,
  onboard,
  doctor,
  // Tool configuration that can change what runs or what is reported, put back to base (ADR 0003).
  runnerConfig: ["tests.edn", ".clj-kondo/**", "profiles.clj"],
  manifests: ["deps.edn", "project.clj"],
  dependencies: parseDependencies,
  detectors: [clojureDetector],
  // No mutation: listed in the spec, reported not executed (catalog.ts).
  gates: { build, lint, arch, coverage },
  runSuite,
  reruns: true,
  tamper,
  locate: (path, lines, line) => (isClojure(path) ? enclosingSymbol(read(lines.join("\n")), line) : undefined),
  normalise: stripLineComment,
}

export { spec as clojureSpec } from "./catalog.ts"

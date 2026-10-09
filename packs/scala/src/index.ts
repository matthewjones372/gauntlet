import type { Pack } from "@gauntlet/core"
import { spec } from "./catalog.ts"
import { parseDependencies } from "./dependencies.ts"
import { scalaDetector } from "./detectors.ts"
import { doctor } from "./doctor.ts"
import { arch, build, coverage, lint, mutation, runSuite } from "./gates.ts"
import { onboard } from "./onboard.ts"
import { enclosingSymbol, parseScala, stripLineComment } from "./syntax.ts"
import { tamper } from "./tamper.ts"
import { isScala, stopServer } from "./toolchain.ts"

/** Detects an sbt project from its file list. */
export const detectScala = (files: ReadonlyArray<string>): boolean => files.includes("build.sbt") && files.some(isScala)

export const scalaPack: Pack = {
  spec,
  detect: detectScala,
  readsCi: true,
  onboard,
  doctor,
  // The build definition in project/ (plugins, build.properties, autoplugins that can
  // change every test setting) and tool configuration, put back to base (ADR 0003).
  runnerConfig: ["project/**", ".jvmopts", ".sbtopts", ".scalafix.conf", "stryker4s.conf"],
  manifests: ["build.sbt", "*.sbt", "project/*.sbt"],
  dependencies: parseDependencies,
  detectors: [scalaDetector],
  gates: { build, lint, arch, mutation, coverage },
  runSuite,
  // The check's own sbt server ends with the check (ADR 0020).
  stop: stopServer,
  reruns: true,
  tamper,
  locate: (path, lines, line) => (isScala(path) ? enclosingSymbol(parseScala(lines.join("\n")), line) : undefined),
  normalise: stripLineComment,
}

export { spec as scalaSpec } from "./catalog.ts"

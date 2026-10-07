import type { Pack } from "@gauntlet/core"
import { spec } from "./catalog.ts"
import { doctor } from "./doctor.ts"
import { onboard } from "./onboard.ts"
import { parseDependencies } from "./dependencies.ts"
import { pythonDetector } from "./detectors.ts"
import { arch, build, coverage, lint, mutation, runSuite } from "./gates.ts"
import { enclosingSymbol, parsePython, stripLineComment } from "./syntax.ts"
import { tamper } from "./tamper.ts"
import { isPython } from "./toolchain.ts"

/** Detects a Python project from its file list. */
export const detectPython = (files: ReadonlyArray<string>): boolean =>
  files.some((f) => /^(pyproject\.toml|setup\.py|requirements[^/]*\.txt)$/.test(f)) && files.some(isPython)

export const pythonPack: Pack = {
  spec,
  detect: detectPython,
  onboard,
  doctor,
  // Test and tool configuration, put back to base before anything runs (ADR 0003).
  // conftest.py files can change which tests are collected and how they run.
  runnerConfig: ["pytest.ini", "setup.cfg", "tox.ini", ".coveragerc", "mypy.ini", ".mypy.ini", "ruff.toml", ".ruff.toml", "pyrightconfig.json", "**/conftest.py"],
  manifests: ["pyproject.toml", "**/pyproject.toml", "requirements*.txt", "**/requirements*.txt"],
  dependencies: parseDependencies,
  detectors: [pythonDetector],
  gates: { build, lint, arch, mutation, coverage },
  runSuite,
  reruns: true,
  tamper,
  locate: (path, lines, line) => (isPython(path) ? enclosingSymbol(parsePython(lines.join("\n")), line) : undefined),
  normalise: stripLineComment,
}

export { spec as pythonSpec } from "./catalog.ts"

import type { TestMap } from "@gauntlet/sarif"
import { posix } from "node:path"

// The TypeScript pack's test map (spec 0013). A test file is the "test class":
// a baseline runs each test file the suite ran on its own, with coverage, and
// maps it to the files that run loaded (any line executed). Vitest, Jest and
// bun (ADR 0027) name each test after its file, so integrity can tell a test
// selection left out from a deleted one.
//
// Coverage sees only the test's own process. A test that starts processes or
// workers, or loads a test helper Gauntlet can't follow, could reach any code:
// it maps to every file any test loaded, so it runs whenever mapped code changes.

/** Starts code coverage can't see: a subprocess, a worker, or an import whose target is computed. */
const UNSEEN = /\bchild_process\b|\bworker_threads\b|\bBun\.spawn|\bBun\.\$|\bexeca\b|\bnew\s+Worker\s*\(|import\s*\{[^}]*\$[^}]*\}\s*from\s*["']bun["']|\b(?:import|require)\s*\(\s*[^"'\s)]/

/** Relative imports and re-exports, static and dynamic, and `require`. */
const IMPORTS = /\bfrom\s*["'](\.[^"']*)["']|\bimport\s*["'](\.[^"']*)["']|\b(?:import|require)\s*\(\s*["'](\.[^"']*)["']\s*\)/g

const EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js", "/index.mjs"]

/** The file a relative import names: as written, with TypeScript's extension for a `.js` one, or with an extension or index added. */
export const resolveImport = (from: string, spec: string, files: ReadonlySet<string>): string | undefined => {
  const target = posix.normalize(posix.join(posix.dirname(from), spec))
  const swapped = target.replace(/\.(m|c)?js(x?)$/, ".$1ts$2")
  for (const t of [swapped, ...EXTENSIONS.map((e) => `${target}${e}`)]) if (files.has(t)) return t
  return undefined
}

/**
 * Whether a test file could reach code its coverage doesn't show: it, or a
 * test-side file it imports (helpers and fixtures, not main code, which
 * coverage sees), starts processes or workers, imports something computed,
 * or imports a relative path that names no file.
 */
export const reachesUnseen = (
  testFile: string,
  text: (path: string) => string | undefined,
  isMain: (path: string) => boolean,
  files: ReadonlySet<string>,
  /** Filled with the test-side files it imports, which a runner's coverage may leave out (bun's skips test files). */
  seen: Set<string> = new Set(),
): boolean => {
  const queue = [testFile]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const source = text(file)
    if (source === undefined) return true
    if (UNSEEN.test(source)) return true
    for (const m of source.matchAll(IMPORTS)) {
      const resolved = resolveImport(file, (m[1] ?? m[2] ?? m[3])!, files)
      if (resolved === undefined) return true
      if (!isMain(resolved) && /\.[cm]?[jt]sx?$/.test(resolved)) queue.push(resolved)
    }
  }
  return false
}

/**
 * The test file a test id belongs to: Jest's `<file> > <name>`, or Vitest's
 * `<file>.<name>` (the longest file that fits). Undefined when none does.
 */
export const testFileOf = (id: string, files: ReadonlySet<string>): string | undefined => {
  const named = id.indexOf(" > ")
  if (named > 0 && files.has(id.slice(0, named))) return id.slice(0, named)
  let found: string | undefined
  for (let i = id.indexOf("."); i >= 0; i = id.indexOf(".", i + 1)) if (files.has(id.slice(0, i))) found = id.slice(0, i)
  return found
}

/**
 * The map from each test file's own run: the files it loaded, or undefined
 * when its run failed or wrote no coverage. A test file whose run can't be
 * trusted, or that reaches code coverage can't see, maps to every file any
 * test loaded. Each test file also maps to itself, so editing it runs it.
 */
export const testMapOf = (
  runs: ReadonlyArray<{ readonly testFile: string; readonly loaded: ReadonlyArray<string> | undefined; readonly unseen: boolean }>,
): TestMap => {
  const everything = new Set(runs.flatMap((r) => [r.testFile, ...(r.loaded ?? [])]))
  return Object.fromEntries(
    [...runs].sort((a, b) => (a.testFile < b.testFile ? -1 : 1)).map((r) => [
      r.testFile,
      [...new Set([r.testFile, ...(r.loaded === undefined || r.unseen ? everything : r.loaded)])].sort(),
    ]),
  )
}

/** Vitest's and Jest's configuration, which a global setup in makes the map unsound: it runs outside every test file's process. */
export const RUNNER_CONFIG = /^(vitest|vite|jest)\.config\.[cm]?[jt]s$|^vitest\.workspace\.[cm]?[jt]s$|^package\.json$/
export const GLOBAL_SETUP = /\bglobalSetup\b/

/** What a bun project's bunfig.toml says that matters to its map. */
export interface Bunfig {
  /** `[test] preload`: run in every test file's own process, before the test file. */
  readonly preload: ReadonlyArray<string>
  /** A coverage setting bun lets win over the command line, so a test file's lcov wouldn't land where Gauntlet reads it. */
  readonly overrides: string | undefined
}

/** bunfig.toml's test settings, or why they can't be read. */
export const bunfigOf = (text: string): Bunfig | string => {
  let doc: unknown
  try {
    doc = Bun.TOML.parse(text)
  } catch {
    return "bunfig.toml couldn't be read"
  }
  const test = typeof doc === "object" && doc !== null && "test" in doc && typeof doc.test === "object" && doc.test !== null ? doc.test as Record<string, unknown> : {}
  const list = (v: unknown) => (v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)])
  const reporters = list(test["coverageReporter"])
  return {
    preload: list(test["preload"]),
    overrides: test["coverageDir"] !== undefined ? "coverageDir" : reporters.length > 0 && !reporters.includes("lcov") ? "coverageReporter" : undefined,
  }
}

/**
 * Whether bun's JUnit report for one test file's run says every test passed. A
 * bunfig coverage threshold fails a run whose tests all passed; a test that
 * failed, or a file that didn't load (then bun writes no report), doesn't count.
 */
export const bunPassed = (junit: string | undefined): boolean => {
  const head = junit === undefined ? undefined : /<testsuites\b[^>]*>/.exec(junit)?.[0]
  return head !== undefined && /\bfailures="0"/.test(head) && /\btests="[1-9]\d*"/.test(head) && !/\berrors="[1-9]/.test(head)
}

import type { TestMap } from "@gauntlet/sarif"
import { posix } from "node:path"

// The TypeScript pack's test map (spec 0013). A test file is the "test class":
// a baseline runs each test file the suite ran on its own, with coverage, and
// maps it to the files that run loaded (any line executed). Vitest, Jest and
// bun (ADR 0027) name each test after its file, so integrity can tell a test
// selection left out from a deleted one.
//
// Coverage sees only the test's own process. A test that runs this project's
// code in another process (a worker, `bun`/`node` on a script, its own CLI, a
// shell script that could start either), or loads a test helper Gauntlet can't
// follow, could reach any code: it maps to every file any test loaded, so it
// runs whenever mapped code changes. Starting a known external tool (`git`,
// `tar`, `java`, ...) by a literal name can't run this project's code, so it
// doesn't count.

/** Starts code coverage can't see whatever it runs: a worker, or an import whose target is computed. */
const UNSEEN = /\bworker_threads\b|\bnew\s+Worker\s*\(|\b(?:import|require)\s*\(\s*[^"'\s)]/

/**
 * Commands that are tools of their own, not a way to run this project's code:
 * no runtimes or interpreters (`bun`, `node`, `npx`, `tsx`, `python`), shells,
 * or tools that run a command they're given (`env`, `xargs`, `find`, `make`, `sed`).
 */
const EXTERNAL = new Set([
  "git", "gh", "tar", "gzip", "gunzip", "zip", "unzip", "true", "false", "echo", "printf", "cat", "ls", "cp", "mv", "rm", "ln", "mkdir",
  "rmdir", "chmod", "touch", "diff", "cmp", "patch", "grep", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "jq", "curl",
  "java", "javac", "jar", "sbt", "mvn", "gradle", "go", "cargo", "rustc", "clojure", "clj", "lein",
])

/** The string literal at `i` (after spaces): quoted, or a template with nothing interpolated. */
const literalAt = (s: string, i: number): string | undefined => {
  const m = /^\s*(?:"([^"\\\n]*)"|'([^'\\\n]*)'|`([^`\\$]*)`)/.exec(s.slice(i))
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined
}

/** The template literal at `i`, each interpolation as `\0`; undefined when it isn't one or can't be read. */
const templateAt = (s: string, i: number): string | undefined => {
  if (s[i] !== "`") return undefined
  let out = ""
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "\\") (out += s.slice(j, j + 2)), j++
    else if (s[j] === "`") return out
    else if (s[j] === "$" && s[j + 1] === "{") {
      let depth = 0
      for (j += 1; j < s.length; j++) {
        if (s[j] === "`") return undefined
        if (s[j] === "{") depth++
        else if (s[j] === "}" && --depth === 0) break
      }
      out += "\0"
    } else out += s[j]
  }
  return undefined
}

/**
 * A shell command line runs only an external tool: one command, named
 * literally, with no pipes, lists, substitutions or redirects. Bun's and
 * execa's `$` pass each interpolated value as one argument, so `\0` is fine past the command.
 */
const externalLine = (line: string | undefined): boolean =>
  line !== undefined && !/[|;&\n\r`<>(]|\$\(/.test(line) && EXTERNAL.has(line.trim().split(/\s+/)[0] ?? "")

/** After a callee at `i`: a call whose first argument is a literal external command, `cmd: [...]` or `[cmd, ...]` for Bun's spawn. */
const externalCall = (s: string, i: number, kind: "file" | "line" | "bun"): boolean => {
  const open = /^\s*\(\s*/.exec(s.slice(i))
  if (!open) return false
  const at = i + open[0].length
  // A shell takes an interpolated value as more of the command line, so it must have none.
  if (kind === "line") {
    const line = literalAt(s, at) ?? templateAt(s, at)
    return line !== undefined && !line.includes("\0") && externalLine(line)
  }
  if (kind === "file") return EXTERNAL.has(literalAt(s, at) ?? "")
  const array = /^(?:\[|\{\s*cmd\s*:\s*\[)/.exec(s.slice(at))
  return array !== null && EXTERNAL.has(literalAt(s, at + array[0].length) ?? "")
}

/** How each function a module exports starts a process: by a command and arguments, a command line, a template, never knowably, or not at all. */
const SPAWNERS: Record<string, { readonly names: Record<string, "file" | "line" | "template" | "bun" | "never">; readonly other: "never" | "none" }> = {
  child_process: { names: { spawn: "file", spawnSync: "file", execFile: "file", execFileSync: "file", exec: "line", execSync: "line", fork: "never" }, other: "never" },
  execa: { names: { execa: "file", execaSync: "file", execaCommand: "line", execaCommandSync: "line", $: "template", execaNode: "never" }, other: "never" },
  bun: { names: { spawn: "bun", spawnSync: "bun", $: "template" }, other: "none" },
}

const NAMED_IMPORT = /\bimport\s*(type\s+)?\{([^}]*)\}\s*from\s*["'](?:node:)?(child_process|execa|bun)["']/g

/**
 * Why a test-side file's own code could run code its coverage doesn't see, or
 * undefined when it can't. Every way it starts a process must be a call that
 * names a known external tool literally; anything else (a runtime, a shell, a
 * path, a computed command, a spawn function passed around, a changed `PATH`
 * a tool could be found on) counts.
 */
export const unseenIn = (source: string): string | undefined => {
  const computed = UNSEEN.exec(source)
  if (computed) return computed[0].trim()
  let rest = source
  const locals: Array<[string, "file" | "line" | "template" | "bun" | "never"]> = []
  for (const m of source.matchAll(NAMED_IMPORT)) {
    rest = rest.slice(0, m.index) + " ".repeat(m[0].length) + rest.slice(m.index + m[0].length)
    if (m[1]) continue
    const module = SPAWNERS[m[3]!]!
    for (const part of m[2]!.split(",").map((p) => p.trim()).filter((p) => p !== "" && !p.startsWith("type "))) {
      const [name, local = name] = part.split(/\s+as\s+/) as [string, string?]
      const kind = module.names[name] ?? (module.other === "never" && !/^[A-Z]/.test(name) ? "never" : undefined)
      if (kind !== undefined) locals.push([local, kind])
    }
  }
  // Any other way to reach a module that starts processes, or Bun's spawn other than called by name.
  const other = /["'](?:node:)?child_process["']|["']execa["']|\bimport\s+(?:\*\s+as\s+)?[\w$]+\s*(?:,\s*\{[^}]*\}\s*)?from\s*["']bun["']|\brequire\s*\(\s*["']bun["']|\}\s*=\s*Bun\b|\bBun\s*\[/.exec(rest)
  if (other) return other[0]
  const sites: Array<[number, number, "file" | "line" | "template" | "bun" | "never"]> = []
  for (const m of rest.matchAll(/\bBun\s*\.\s*(spawnSync|spawn|\$)/g)) sites.push([m.index, m.index + m[0].length, m[1] === "$" ? "template" : "bun"])
  for (const [local, kind] of locals) {
    const name = local.replace(/\$/g, "\\$")
    for (const m of rest.matchAll(new RegExp(`(?<![\\w$.])${name}(?![\\w$${local === "$" ? "{" : ""}])`, "g"))) sites.push([m.index, m.index + m[0].length, kind])
  }
  for (const [start, end, kind] of sites) {
    const external = kind === "never" ? false : kind === "template" ? externalLine(templateAt(rest, end)) : externalCall(rest, end, kind)
    if (!external) return rest.slice(start, end + 40).split("\n")[0]!.trim()
  }
  if (sites.length > 0) {
    // A tool named literally could still be a stand-in found on a changed PATH, or a command line through a shell.
    const path = /\bPATH["']?\s*[:=]|\bshell["']?\s*:/.exec(rest)
    if (path) return path[0]
  }
  return undefined
}

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
 * coverage sees), starts workers or processes other than known external tools
 * (`unseenIn`), imports something computed, or imports a relative path that
 * names no file.
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
    if (unseenIn(source) !== undefined) return true
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

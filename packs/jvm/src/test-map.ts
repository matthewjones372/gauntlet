import type { TestMap } from "@gauntlet/sarif"
import { packageOf } from "./sources.ts"

// The JVM pack's test map (spec 0013). A baseline runs the suite once more
// with JaCoCo's agent and Gauntlet's JUnit Platform listener, which writes
// JaCoCo's execution data each time a test class finishes. Here that data
// becomes, per test class, the source files whose classes ran any code.

/** Kotlin and Java sources in any source set, the build's own code and its tests. */
export const isSource = (path: string) => /(^|\/)src\/[^/]+\/(kotlin|java)\/.+\.(kt|java)$/.test(path)

/**
 * The classes (as the JVM names them, `bank/domain/Money$Companion`) that ran
 * any code, from a JaCoCo exec file (ExecutionDataWriter, format 0x1007).
 * Undefined for anything else, which can't be trusted.
 */
export const executedClasses = (bytes: Uint8Array): string[] | undefined => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const decoder = new TextDecoder()
  let at = 0
  // Every read checks it fits; a block that runs past the end makes the file untrustworthy.
  const fits = (n: number) => at + n <= bytes.length
  const u16 = (): number | undefined => (fits(2) ? (at += 2, view.getUint16(at - 2)) : undefined)
  const utf = (): string | undefined => {
    const n = u16()
    if (n === undefined || !fits(n)) return undefined
    at += n
    return decoder.decode(bytes.subarray(at - n, at))
  }
  const varint = (): number | undefined => {
    let value = 0
    for (let shift = 0; shift < 35 && fits(1); shift += 7) {
      const b = bytes[at++]!
      value |= (b & 0x7f) << shift
      if ((b & 0x80) === 0) return value >>> 0
    }
    return undefined
  }
  const ran = new Set<string>()
  let header = false
  while (at < bytes.length) {
    const block = bytes[at++]
    if (block === 0x01) {
      if (u16() !== 0xc0c0 || u16() !== 0x1007) return undefined
      header = true
    } else if (block === 0x10) {
      if (utf() === undefined || !fits(16)) return undefined
      at += 16
    } else if (block === 0x11) {
      if (!fits(8)) return undefined
      at += 8
      const name = utf()
      const probes = varint()
      if (name === undefined || probes === undefined || !fits(Math.ceil(probes / 8))) return undefined
      const width = Math.ceil(probes / 8)
      if (bytes.subarray(at, at + width).some((b) => b !== 0)) ran.add(name)
      at += width
    } else {
      return undefined
    }
  }
  return header ? [...ran].sort() : undefined
}

/** Declarations that name a class: Kotlin's and Java's, whatever their modifiers. */
const DECLARED = /^[ \t]*(?:[\w@]+[ \t]+)*?(?:class|object|interface|enum|record|@interface)[ \t]+(\w+)/gm

/** Finds the source file a JVM class name comes from: its own name, or its outer class's. */
export const classIndex = (sources: ReadonlyArray<{ readonly path: string; readonly text: string }>) => {
  const byName = new Map<string, string>()
  for (const s of sources) {
    const pkg = packageOf(s.text).replaceAll(".", "/")
    const stem = s.path.split("/").pop()!.replace(/\.(kt|java)$/, "")
    const facade = /@file:JvmName\("(\w+)"\)/.exec(s.text)?.[1]
    const names = [stem, `${stem}Kt`, ...(facade ? [facade] : []), ...[...s.text.matchAll(DECLARED)].map((m) => m[1]!)]
    for (const n of names) {
      const key = pkg === "" ? n : `${pkg}/${n}`
      if (!byName.has(key)) byName.set(key, s.path)
    }
  }
  return (jvmName: string): string | undefined => byName.get(jvmName.replace(/\$.*$/, ""))
}

/**
 * JaCoCo's \`includes\` for the build's own packages, so the agent leaves
 * libraries alone. Undefined when a file has no package: then it measures all.
 */
export const includesFor = (sources: ReadonlyArray<{ readonly text: string }>): string | undefined => {
  const packages = sources.map((s) => packageOf(s.text))
  if (packages.length === 0 || packages.includes("")) return undefined
  const kept: string[] = []
  for (const p of [...new Set(packages)].sort()) if (!kept.some((k) => p === k || p.startsWith(`${k}.`))) kept.push(p)
  return kept.map((p) => `${p}.*`).join(":")
}

/**
 * Code the compiler copies into its callers runs as theirs: a change to an
 * inline function or a constant reaches tests that never execute its file.
 * Such files are left out of the map, so a change to one runs every test.
 */
export const COPIED_INTO_CALLERS = /\binline\s+(?:fun|val|var)\b|\bconst\s+val\b|\bstatic\s+final\s+[\w<>[\]]+\s+\w+\s*=\s*(?:"|'|-?\d|true\b|false\b)/

/** The map from each test class's execution data. Undefined when any of it can't be read. */
export const testMapOf = (
  execs: ReadonlyArray<{ readonly testClass: string; readonly bytes: Uint8Array }>,
  sources: ReadonlyArray<{ readonly path: string; readonly text: string }>,
): TestMap | undefined => {
  const locate = classIndex(sources)
  const copied = new Set(sources.filter((s) => COPIED_INTO_CALLERS.test(s.text)).map((s) => s.path))
  const files = new Map<string, Set<string>>()
  for (const e of execs) {
    const ran = executedClasses(e.bytes)
    if (ran === undefined) return undefined
    const mine = files.get(e.testClass) ?? new Set<string>()
    for (const name of [e.testClass.replaceAll(".", "/"), ...ran]) {
      const file = locate(name)
      if (file !== undefined && !copied.has(file)) mine.add(file)
    }
    files.set(e.testClass, mine)
  }
  return Object.fromEntries([...files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, fs]) => [name, [...fs].sort()]))
}

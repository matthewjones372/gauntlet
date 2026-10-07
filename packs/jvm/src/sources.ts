import { isKotlin } from "./kotlin/syntax.ts"

// Mapping between reports that speak in packages and classes (Pitest,
// Kover) and repository paths.

const MAIN_SOURCE = /(^|\/)src\/main\/(kotlin|java)\//

export const isMainSource = (path: string) => MAIN_SOURCE.test(path) && (isKotlin(path) || path.endsWith(".java"))

/** Finds the repository path for `svc/domain` + `Money.kt` among the main source files. */
export const sourceIndex = (files: ReadonlyArray<string>) => {
  const bySuffix = new Map<string, string>()
  for (const f of files.filter(isMainSource)) {
    const m = MAIN_SOURCE.exec(f)!
    const suffix = f.slice(m.index + m[0].length)
    if (!bySuffix.has(suffix)) bySuffix.set(suffix, f)
  }
  return (packagePath: string, fileName: string) => bySuffix.get(packagePath === "" ? fileName : `${packagePath}/${fileName}`)
}

/** The package a Kotlin file declares. */
export const packageOf = (text: string): string => /^\s*package\s+([\w.]+)/m.exec(text)?.[1] ?? ""

/** Pitest target patterns for a source file: its file class and every top-level class it declares. */
export const pitestTargets = (path: string, text: string): string[] => {
  const pkg = packageOf(text)
  const prefix = pkg === "" ? "" : `${pkg}.`
  const stem = path.split("/").pop()!.replace(/\.(kt|java)$/, "")
  const declared = [...text.matchAll(/^(?:[\w ]*\s)?(?:class|object|interface|enum class|data class|sealed class|value class)\s+(\w+)/gm)].map((m) => m[1]!)
  return [...new Set([stem, `${stem}Kt`, ...declared])].sort().map((n) => `${prefix}${n}*`)
}

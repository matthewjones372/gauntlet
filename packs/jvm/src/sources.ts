import { isKotlin, ofType, parseKotlin, type Node } from "./kotlin/syntax.ts"

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

/** Methods the Kotlin compiler writes that no test can be expected to pin down: data classes' and `equals` & co. */
const GENERATED = ["component*", "copy", "copy$default", "equals", "hashCode", "toString"]

const capitalised = (name: string) => name.charAt(0).toUpperCase() + name.slice(1)

/** A property's JVM getter: `isActive` stays `isActive`, `limit` becomes `getLimit`. */
const getterOf = (name: string) => (/^is[A-Z]/.test(name) ? name : `get${capitalised(name)}`)
const setterOf = (name: string) => `set${capitalised(/^is[A-Z]/.test(name) ? name.slice(2) : name)}`

const propertyName = (decl: Node) =>
  decl.namedChildren.find((c) => c?.type === "variable_declaration")?.namedChildren.find((c) => c?.type === "identifier")?.text
    ?? decl.namedChildren.find((c) => c?.type === "identifier")?.text

/**
 * Pitest's `excludedMethods` for a change (spec 0011 §4, spec 0019 §2): the methods the Kotlin compiler generates, data
 * classes' and plain property accessors, which sit on their declaration's line, so a changed declaration would bring
 * them into the changed lines. Untouched methods aren't listed: Gauntlet's line filter drops their mutants. Pitest
 * matches by name across classes, so a name any changed file writes and touches is kept. With a changed Java file
 * nothing is skipped.
 */
export const pitestExclusions = (
  files: ReadonlyArray<{ readonly path: string; readonly text: string }>,
  changed: ReadonlyMap<string, ReadonlySet<number>>,
): string[] => {
  if (files.some((f) => !isKotlin(f.path))) return []
  const all = new Set<string>(GENERATED)
  const kept = new Set<string>()
  for (const f of files) {
    const lines = changed.get(f.path) ?? new Set<number>()
    const touched = (n: Node) => {
      for (let l = n.startPosition.row + 1; l <= n.endPosition.row + 1; l++) if (lines.has(l)) return true
      return false
    }
    const root = parseKotlin(f.text).rootNode
    for (const fn of ofType(root, "function_declaration")) {
      const name = fn.namedChildren.find((c) => c?.type === "identifier")?.text
      if (name && touched(fn)) kept.add(name)
    }
    for (const decl of [...ofType(root, "property_declaration"), ...ofType(root, "class_parameter")]) {
      const name = propertyName(decl)
      if (!name) continue
      all.add(getterOf(name))
      all.add(setterOf(name))
      for (const accessor of decl.namedChildren) {
        if (accessor?.type === "getter" && touched(accessor)) kept.add(getterOf(name))
        if (accessor?.type === "setter" && touched(accessor)) kept.add(setterOf(name))
      }
    }
  }
  return [...all].filter((n) => !kept.has(n)).sort()
}

/** Gauntlet's Pitest filter's entries for the changed lines (spec 0019 §1): `svc/domain/Money.kt:12`, by the package each file declares. */
export const pitestLines = (
  files: ReadonlyArray<{ readonly path: string; readonly text: string }>,
  changed: ReadonlyMap<string, ReadonlySet<number>>,
): string[] => {
  const out = new Set<string>()
  for (const f of files) {
    const pkg = packageOf(f.text)
    const at = `${pkg === "" ? "" : `${pkg.replaceAll(".", "/")}/`}${f.path.split("/").pop()!}`
    for (const l of changed.get(f.path) ?? []) out.add(`${at}:${l}`)
  }
  return [...out].sort()
}

/**
 * The Pitest tasks of the modules with changed main sources (spec 0019 §3), by the path before `src/main/`:
 * `app/src/main/...` is `:app:pitest`, `src/main/...` the root project's `:pitest`.
 */
export const pitestTasks = (paths: ReadonlyArray<string>): string[] =>
  [...new Set(paths.flatMap((p) => {
    const m = MAIN_SOURCE.exec(p)
    if (!m) return []
    const module = p.slice(0, m.index)
    return [module === "" ? ":pitest" : `:${module.replaceAll("/", ":")}:pitest`]
  }))].sort()

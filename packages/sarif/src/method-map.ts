// The test map's methods (spec 0017 §1): per test, the methods it executed at
// the recorded commit, so a test removed with the code it tested can be told
// from one removed while its code stays. A method is named by its file and its
// source-level name: `src/main/kotlin/svc/Fx.kt#Fx.fee`.

/** Test (as the tool names it, with its build's \`<folder>:\` prefix) to the methods it executed, as \`methodKey\`s. */
export type MethodMap = Readonly<Record<string, ReadonlyArray<string>>>

/** A method as the map names it: its repository path and its name, `Fx.fee`. */
export const methodKey = (path: string, name: string) => `${path}#${name}`

/** The path and name a \`methodKey\` holds. */
export const methodOf = (key: string): { readonly path: string; readonly name: string } => {
  const i = key.lastIndexOf("#")
  return i < 0 ? { path: key, name: "" } : { path: key.slice(0, i), name: key.slice(i + 1) }
}

/** Several maps as one: a test named in more than one executed every method any of them records for it. */
export const mergeMethodMaps = (maps: ReadonlyArray<MethodMap>): MethodMap => {
  const tests = new Map<string, Set<string>>()
  for (const map of maps) {
    for (const [name, methods] of Object.entries(map)) {
      const mine = tests.get(name) ?? new Set<string>()
      for (const m of methods) mine.add(m)
      tests.set(name, mine)
    }
  }
  return Object.fromEntries([...tests].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, ms]) => [name, [...ms].sort()]))
}

/** The same map with its paths and test names rewritten, for a build in a folder of the repository. */
export const renameMethodMap = (map: MethodMap, rename: { readonly path?: (p: string) => string; readonly test?: (t: string) => string }): MethodMap =>
  Object.fromEntries(Object.entries(map).map(([name, methods]) => [
    rename.test ? rename.test(name) : name,
    rename.path ? methods.map((k) => {
      const m = methodOf(k)
      return methodKey(rename.path!(m.path), m.name)
    }) : methods,
  ]))

// Which tests killed which mutants (spec 0016), as the mutation tools report
// it: Pitest's full mutation matrix, StrykerJS's killedBy and coveredBy.
// Recorded in the baseline so `gauntlet prune tests` can list tests that kill
// nothing, and tests whose every kill another test also makes.

export interface KillMap {
  /** Each mutant once, where it is (repository paths in a baseline). */
  readonly mutants: ReadonlyArray<{ readonly path: string; readonly line: number }>
  /**
   * Each test, as the mutation tool names it: the mutants it killed, as
   * indexes into \`mutants\`, and how many mutants it reached, killed or not.
   */
  readonly tests: Readonly<Record<string, KillMapTest>>
}

export interface KillMapTest {
  readonly killed: ReadonlyArray<number>
  readonly reached: number
}

/** Several maps as one: each map's mutants are kept apart, even on the same line. */
export const mergeKillMaps = (maps: ReadonlyArray<KillMap>): KillMap => {
  const mutants: { path: string; line: number }[] = []
  const tests: Record<string, KillMapTest> = {}
  for (const map of maps) {
    const offset = mutants.length
    mutants.push(...map.mutants)
    for (const [name, t] of Object.entries(map.tests)) {
      const seen = tests[name]
      const killed = t.killed.map((i) => i + offset)
      tests[name] = seen ? { killed: [...seen.killed, ...killed], reached: seen.reached + t.reached } : { killed, reached: t.reached }
    }
  }
  return { mutants, tests }
}

/** The same map with its paths and test names rewritten, for a build in a folder of the repository. */
export const renameKillMap = (map: KillMap, rename: { readonly path?: (p: string) => string; readonly test?: (t: string) => string }): KillMap => ({
  mutants: rename.path ? map.mutants.map((m) => ({ ...m, path: rename.path!(m.path) })) : map.mutants,
  tests: rename.test ? Object.fromEntries(Object.entries(map.tests).map(([name, t]) => [rename.test!(name), t])) : map.tests,
})

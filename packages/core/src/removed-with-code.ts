import { type MethodMap, methodOf } from "@gauntlet/sarif"
import { sameTest } from "./pruning.ts"

// Spec 0017 §1: a test that no longer runs went with its code when the map of
// the methods each test executed at base says so. It executed at least one
// method the change removes, and every method it executed that's still there is
// still executed by a test that still runs. A name match is the fallback, for a
// baseline without the map or a test the map doesn't name.

export type RemovalVerdict =
  /** It went with its code: it ran \`removed\`, which the change removes, and tests that stay run the rest (\`kept\`). */
  | { readonly kind: "with-its-code"; readonly removed: ReadonlyArray<string>; readonly kept: ReadonlyArray<string> }
  /** It was the last test of \`sole\`, which stays. */
  | { readonly kind: "last-test"; readonly sole: ReadonlyArray<string> }
  /** The change removes none of the code it ran. */
  | { readonly kind: "nothing-removed" }

/**
 * Whether a file's text at head still has a method of this name (`Fx.fee`'s
 * `fee`), read loosely so that doubt keeps a method: the name anywhere in the
 * file as a word, a constructor's class name, or a property for a JVM accessor
 * (`getRate`, `isOpen` for `rate`, `open`). A file that's gone has none.
 */
export const stillDeclared = (text: string | undefined, name: string): boolean => {
  if (text === undefined) return false
  const parts = name.split(".")
  const method = parts.at(-1) ?? name
  const owner = parts.at(-2)
  const word = (w: string) => new RegExp(`(?<![\\w$])${w.replace(/[$]/g, "\\$&")}(?![\\w$])`).test(text)
  if (method === "<init>" || method === "<clinit>") return owner === undefined || word(owner)
  if (method === "" || !/^[\w$]+$/.test(method)) return true
  const accessor = /^(?:get|set|is)([A-Z])(\w*)$/.exec(method)
  return word(method) || (accessor !== null && word(`${accessor[1]!.toLowerCase()}${accessor[2]}`))
}

/**
 * What the map says about each test that no longer runs, by the name it ran
 * under. A test the map doesn't name has no verdict: names decide for it.
 * \`gone\` says whether the change removes a method (a \`methodKey\`).
 */
export const judgeRemovedTests = (
  removed: ReadonlyArray<string>,
  map: MethodMap,
  gone: (key: string) => boolean,
): ReadonlyMap<string, RemovalVerdict> => {
  const named = new Map(Object.keys(map).map((k) => [sameTest(k), k]))
  const leaving = new Set(removed.flatMap((id) => named.get(sameTest(id)) ?? []))
  const stillRun = new Set(Object.entries(map).filter(([name]) => !leaving.has(name)).flatMap(([, methods]) => methods))
  const shown = (keys: ReadonlyArray<string>) => [...new Set(keys.map((k) => methodOf(k).name))].sort()
  const verdicts = new Map<string, RemovalVerdict>()
  for (const id of removed) {
    const name = named.get(sameTest(id))
    if (name === undefined) continue
    const ran = map[name]!
    const stays = ran.filter((k) => !gone(k))
    const sole = stays.filter((k) => !stillRun.has(k))
    const went = ran.filter(gone)
    verdicts.set(id,
      sole.length > 0 ? { kind: "last-test", sole: shown(sole) }
      : went.length === 0 ? { kind: "nothing-removed" }
      : { kind: "with-its-code", removed: shown(went), kept: shown(stays) })
  }
  return verdicts
}

const SHOWN = 5
const list = (xs: ReadonlyArray<string>) => (xs.length > SHOWN ? `${xs.slice(0, SHOWN).join(", ")} and ${xs.length - SHOWN} more` : xs.join(", "))

/** Why a test that no longer runs qualified, or didn't, for the report. */
export const describeRemoval = (id: string, v: RemovalVerdict): string => {
  switch (v.kind) {
    case "with-its-code":
      return v.kept.length === 0
        ? `Test ${id} no longer runs: it only tested ${list(v.removed)}, which this change removes. Check the feature was meant to go.`
        : `Test ${id} no longer runs: it tested ${list(v.removed)}, which this change removes, and tests that still run cover the rest of what it ran (${list(v.kept)}). Check the feature was meant to go.`
    case "last-test":
      return `Test ${id} ran at base and no longer runs: it was the last test of ${list(v.sole)}, which ${v.sole.length === 1 ? "stays" : "stay"}.`
    case "nothing-removed":
      return `Test ${id} ran at base and no longer runs, and this change removes none of the code it ran.`
  }
}

/** A deleted test file whose every test the map says went with its code. */
export const describeRemovedFile = (path: string, verdicts: ReadonlyArray<RemovalVerdict>): string => {
  const removed = [...new Set(verdicts.flatMap((v) => (v.kind === "with-its-code" ? v.removed : [])))].sort()
  return `Test file ${path} was removed along with the code its tests covered (${list(removed)}), and tests that still run cover the rest of what they ran. Check the feature was meant to go.`
}

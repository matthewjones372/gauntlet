// Test classes and the test ids that belong to them (spec 0013): a test id is
// its class's name, a dot and the test's own name.

/** The base's test ids that belong to classes selection left out (a nested class's tests, `Outer$Inner.x`, belong to `Outer`). */
export const excusedBySelection = (baseIds: ReadonlyArray<string>, deselected: ReadonlyArray<string>): string[] => {
  if (deselected.length === 0) return []
  const left = new Set(deselected)
  return baseIds.filter((id) => {
    for (let i = id.indexOf("."); i >= 0; i = id.indexOf(".", i + 1)) if (left.has(id.slice(0, i).replace(/\$.*$/, ""))) return true
    return false
  })
}

/** Optimal string alignment distance (edit distance with adjacent swaps). */
export const distance = (a: string, b: string): number => {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)))
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, d[i - 2]![j - 2]! + 1)
      d[i]![j] = best
    }
  }
  return d[a.length]![b.length]!
}

/** The closest candidates to `input`, nearest first, within a length-scaled limit. */
export const closest = (input: string, candidates: ReadonlyArray<string>): ReadonlyArray<string> => {
  const limit = Math.max(1, Math.floor(input.length / 3))
  return candidates
    .map((c) => ({ c, d: distance(input.toLowerCase(), c.toLowerCase()) }))
    .filter((x) => x.d <= limit)
    .sort((x, y) => x.d - y.d || x.c.localeCompare(y.c))
    .map((x) => x.c)
}

export const quoteList = (xs: ReadonlyArray<string>): string => xs.map((x) => `'${x}'`).join(", ")

/** "Did you mean 'x'?" when something is close, otherwise the fallback. */
export const didYouMean = (input: string, candidates: ReadonlyArray<string>, fallback: string): string => {
  const near = closest(input, candidates)
  if (near.length === 0) return fallback
  return near.length === 1 ? `Did you mean '${near[0]}'?` : `Did you mean one of ${quoteList(near.slice(0, 3))}?`
}

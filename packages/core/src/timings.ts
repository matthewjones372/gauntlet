// Time per gate (spec 0020 §7): what each gate took, from the run record. Kept
// out of the report files, which stay the same for the same inputs (invariant 4):
// the check prints it, and the pull request's comment shows the evidence job's.

/** A duration for people: 850ms, 12s, 3m 05s. */
export const took = (ms: number) =>
  ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`

/** Each gate's time in the order the gates ran, and the whole run's last; nothing when no gate ran. */
export const gateTimings = (durationsMs: Readonly<Record<string, number>>): ReadonlyArray<readonly [string, number]> => {
  const gates = Object.entries(durationsMs).filter(([k]) => k !== "total")
  if (gates.length === 0) return []
  return durationsMs.total === undefined ? gates : [...gates, ["total", durationsMs.total] as const]
}

/** "Time per gate: build 12s, unit 1m 05s; total 1m 20s", or undefined when no gate ran. */
export const timingLine = (durationsMs: Readonly<Record<string, number>>): string | undefined => {
  const all = gateTimings(durationsMs)
  if (all.length === 0) return undefined
  const gates = all.filter(([k]) => k !== "total").map(([k, ms]) => `${k} ${took(ms)}`).join(", ")
  return `Time per gate: ${gates}${durationsMs.total !== undefined ? `; total ${took(durationsMs.total)}` : ""}`
}

/** The collapsed section the pull request's comment ends with, or "" when no gate ran. */
export const timingSection = (durationsMs: Readonly<Record<string, number>>): string => {
  const all = gateTimings(durationsMs)
  if (all.length === 0) return ""
  return ["<details><summary>Time per gate</summary>", "", "| Check | Time |", "|---|---|", ...all.map(([k, ms]) => `| ${k} | ${took(ms)} |`), "", "</details>", ""].join("\n")
}

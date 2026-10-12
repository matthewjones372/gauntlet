import type { Report } from "./schema.ts"

// Protected files run as the base has them (ADR: protected files run as base),
// so a change's edit to its build configuration, fixtures or policy isn't what
// its own check ran. Saying so plainly saves people from reading "scalafix
// isn't applied" as Gauntlet ignoring the plugin the change just added.

export interface RanAsBase {
  readonly path: string
  /** The protect group's kind, `policy` for `.gauntlet/`. */
  readonly kind: string
  /** The change adds the file, so the run left it out rather than putting the base's back. */
  readonly leftOut: boolean
}

/**
 * The protected files the change edits that ran as the base has them. Tests
 * the change adds or edits run as the change has them, so they're not listed;
 * `.gauntlet/` is listed only when the policy came from the base (in CI), since
 * a local check judges with the working copy's.
 */
export const ranAsBase = (r: Report): ReadonlyArray<RanAsBase> => {
  const fromBase = r.policy.origin === "base" && !r.policy.firstAdoption
  const files = (r.facts?.protectedTouched ?? [])
    .filter((p) => p.action === "restored" || p.action === "removed")
    .filter((p) => p.kind !== "gauntlet" || fromBase)
    .map((p) => ({ path: p.path, kind: p.kind === "gauntlet" ? "policy" : p.kind, leftOut: p.action === "removed" }))
  // The policy's own edit is in the drift even where the facts don't list it.
  const drift = fromBase ? (r.policy.drift ?? []).filter((d) => !files.some((f) => f.path === d.path)).map((d) => ({ path: d.path, kind: "policy", leftOut: d.change === "added" })) : []
  // The policy last: the build files are the likelier explanation for a failing check.
  return [...files, ...drift].sort((a, b) => Number(a.kind === "policy") - Number(b.kind === "policy") || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** Required checks that failed or errored, which a build or tool file running as the base's could explain. */
export const checksTheBaseMayExplain = (r: Report, files: ReadonlyArray<RanAsBase>): ReadonlyArray<{ readonly check: string; readonly status: "failed" | "errored" }> =>
  files.some((f) => f.kind !== "policy" && f.kind !== "tests")
    ? (r.checks ?? []).filter((c) => !c.advisory && (c.status === "failed" || c.status === "errored")).map((c) => ({ check: c.check, status: c.status as "failed" | "errored" }))
    : []

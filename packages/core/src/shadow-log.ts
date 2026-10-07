import { Tier } from "@gauntlet/ir"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Git, type GitFailure } from "./git.ts"
import type { Report } from "./report/schema.ts"

// One record per `check`, kept as a git note on the judged commit under
// `refs/notes/gauntlet`. CI pushes the notes, so the history travels with
// the repository and `gauntlet report shadow` works offline (PLAN Q12).

export const SHADOW_REF = "gauntlet"

export const ShadowRecord = Schema.Struct({
  at: Schema.String,
  commit: Schema.String,
  base: Schema.String,
  irHash: Schema.String,
  mode: Schema.Literals(["shadow", "enforce"]),
  tier: Tier,
  wouldBlock: Schema.Boolean,
  reasons: Schema.Array(Schema.Struct({ tier: Tier, rule: Schema.String, reason: Schema.String, source: Schema.optionalKey(Schema.String) })),
  missing: Schema.Array(Schema.String),
  /** Per suite: how it ended and which tests failed or were flaky (M15), for `gauntlet report flaky`. */
  tests: Schema.optionalKey(Schema.Array(Schema.Struct({
    check: Schema.String,
    status: Schema.String,
    failed: Schema.Array(Schema.String),
    flaky: Schema.Array(Schema.String),
  }))),
})
export type ShadowRecord = typeof ShadowRecord.Type

export const shadowRecordOf = (report: Report, at: string): ShadowRecord => ({
  at,
  commit: report.policy.headSha,
  base: report.policy.baseSha,
  irHash: report.policy.irHash,
  mode: report.decision.mode,
  tier: report.decision.tier,
  wouldBlock: report.decision.wouldBlock,
  reasons: report.decision.nominations.map((n) => ({
    tier: n.tier,
    rule: n.rule,
    reason: n.reason,
    ...(n.source ? { source: `${n.source.file}:${n.source.line} ${n.source.text}` } : {}),
  })),
  missing: report.notExecuted.map((n) => n.what),
  ...(suiteOutcomes(report).length > 0 ? { tests: suiteOutcomes(report) } : {}),
})

/** Suites that ran, with their failing tests by id (the report's failure lines start with the id). */
const suiteOutcomes = (report: Report) =>
  report.checks.filter((c) => c.tests !== undefined).map((c) => ({
    check: c.check,
    status: c.status,
    failed: (c.failures ?? []).map((f) => f.split(": ")[0]!).sort(),
    flaky: [...(c.flaky ?? [])].sort(),
  }))

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(ShadowRecord))

export class ShadowLog extends Context.Service<ShadowLog, {
  readonly append: (repo: string, record: ShadowRecord) => Effect.Effect<void, GitFailure>
  /** The latest record for each commit, oldest first. */
  readonly read: (repo: string) => Effect.Effect<ReadonlyArray<ShadowRecord>, GitFailure>
  /** Every record, including repeated checks of one commit, oldest first. */
  readonly readAll: (repo: string) => Effect.Effect<ReadonlyArray<ShadowRecord>, GitFailure>
}>()("@gauntlet/core/ShadowLog") {}

export const ShadowLogLive = Layer.effect(
  ShadowLog,
  Effect.gen(function*() {
    const git = yield* Git
    const order = (records: ReadonlyArray<ShadowRecord>) =>
      [...records].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.commit < b.commit ? -1 : a.commit > b.commit ? 1 : 0))
    /** All records, each commit's in the order they were added. */
    const readRecords = (repo: string) =>
      Effect.gen(function*() {
        const all: ShadowRecord[] = []
        for (const commit of yield* git.notedCommits(repo, SHADOW_REF)) {
          const note = yield* git.readNote(repo, SHADOW_REF, commit)
          const records = Option.match(note, {
            onNone: () => [],
            onSome: (text) => text.split("\n").flatMap((l) => Option.match(decodeLine(l), { onNone: () => [], onSome: (r) => (r.commit === commit ? [r] : []) })),
          })
          all.push(...records.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)))
        }
        return all
      })
    return {
      append: (repo, record) => git.appendNote(repo, SHADOW_REF, record.commit, JSON.stringify(Schema.encodeSync(ShadowRecord)(record))),
      read: (repo) => readRecords(repo).pipe(Effect.map((all) => {
        const latest = new Map<string, ShadowRecord>()
        for (const r of all) latest.set(r.commit, r)
        return order([...latest.values()])
      })),
      readAll: (repo) => readRecords(repo).pipe(Effect.map(order)),
    }
  }),
)

export interface ShadowSummary {
  readonly runs: number
  readonly shadowRuns: number
  readonly wouldBlock: number
  readonly tiers: Readonly<Record<string, number>>
  readonly topReasons: ReadonlyArray<{ readonly reason: string; readonly count: number }>
  readonly topMissing: ReadonlyArray<{ readonly what: string; readonly count: number }>
  readonly since?: string
}

const top = (keys: ReadonlyArray<string>, n = 10) =>
  [...keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>())]
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
    .slice(0, n)

/** What the shadow period would have done, to tune the policy before enforcing. */
export const summariseShadow = (records: ReadonlyArray<ShadowRecord>, since?: string): ShadowSummary => {
  const kept = since ? records.filter((r) => r.at >= since) : records
  const tiers: Record<string, number> = { auto: 0, skim: 0, review: 0, owner: 0 }
  for (const r of kept) tiers[r.tier] = (tiers[r.tier] ?? 0) + 1
  // A reason is the policy line that fired, or the implicit rule's name: individual messages vary too much to count.
  const label = (x: ShadowRecord["reasons"][number]) => (x.rule === "policy" ? x.source ?? "policy rule" : x.source ? `${x.rule} (${x.source})` : x.rule)
  const reasonKeys = kept.flatMap((r) => [...new Set(r.reasons.filter((x) => x.rule !== "no-rule-matched" || r.reasons.length === 1).map(label))])
  return {
    runs: kept.length,
    shadowRuns: kept.filter((r) => r.mode === "shadow").length,
    wouldBlock: kept.filter((r) => r.wouldBlock).length,
    tiers,
    topReasons: top(reasonKeys).map(([reason, count]) => ({ reason, count })),
    topMissing: top(kept.flatMap((r) => [...new Set(r.missing)])).map(([what, count]) => ({ what, count })),
    ...(since ? { since } : {}),
  }
}

export const renderShadowSummary = (s: ShadowSummary): string => {
  if (s.runs === 0) return `No checks recorded${s.since ? ` since ${s.since}` : ""}. Records are git notes under refs/notes/${SHADOW_REF}; fetch them with: git fetch origin refs/notes/${SHADOW_REF}:refs/notes/${SHADOW_REF}\n`
  const pct = (n: number) => `${Math.round((n / s.runs) * 100)}%`
  return [
    `## Gauntlet shadow report${s.since ? ` since ${s.since}` : ""}`,
    "",
    `${s.runs} change${s.runs === 1 ? "" : "s"} checked (${s.shadowRuns} in shadow mode). ${s.wouldBlock} (${pct(s.wouldBlock)}) would have been blocked in enforce mode.`,
    "",
    "### Tiers",
    "",
    ...Object.entries(s.tiers).map(([tier, n]) => `- ${tier}: ${n} (${pct(n)})`),
    "",
    "### Most frequent reasons",
    "",
    ...s.topReasons.map((r) => `- ${r.count} × ${r.reason}`),
    ...(s.topMissing.length > 0 ? ["", "### Most often missing evidence", "", ...s.topMissing.map((m) => `- ${m.count} × ${m.what}`)] : []),
    "",
  ].join("\n")
}

export interface FlakySummary {
  readonly tests: ReadonlyArray<{ readonly test: string; readonly check: string; readonly times: number; readonly commits: ReadonlyArray<string> }>
  readonly records: number
}

/**
 * Tests that both passed and failed on identical code: classified flaky by a
 * rerun, or failing in one check of a commit while the same suite passed in
 * another check of that commit.
 */
export const summariseFlaky = (records: ReadonlyArray<ShadowRecord>): FlakySummary => {
  const found = new Map<string, { test: string; check: string; commits: Set<string>; times: number }>()
  const add = (test: string, check: string, commit: string) => {
    const key = `${check}\u0000${test}`
    const entry = found.get(key) ?? { test, check, commits: new Set<string>(), times: 0 }
    entry.commits.add(commit)
    entry.times++
    found.set(key, entry)
  }
  for (const r of records) for (const s of r.tests ?? []) for (const t of s.flaky) add(t, s.check, r.commit)
  const byCommit = new Map<string, ShadowRecord[]>()
  for (const r of records) byCommit.set(r.commit, [...(byCommit.get(r.commit) ?? []), r])
  for (const [commit, same] of byCommit) {
    const suites = same.flatMap((r) => r.tests ?? [])
    for (const s of suites) {
      const passedElsewhere = suites.some((o) => o !== s && o.check === s.check && o.status === "passed" && !o.failed.length)
      if (passedElsewhere) for (const t of s.failed) add(t, s.check, commit)
    }
  }
  return {
    records: records.length,
    tests: [...found.values()]
      .map((e) => ({ test: e.test, check: e.check, times: e.times, commits: [...e.commits].sort() }))
      .sort((a, b) => b.times - a.times || (a.test < b.test ? -1 : a.test > b.test ? 1 : 0)),
  }
}

export const renderFlaky = (s: FlakySummary): string =>
  s.tests.length === 0
    ? `No flaky tests in ${s.records} recorded check${s.records === 1 ? "" : "s"}.\n`
    : [
      "## Flaky tests",
      "",
      `Tests that both passed and failed on identical code, in ${s.records} recorded checks. Fix them, or quarantine them in the policy with an owner and a date.`,
      "",
      "| Test | Suite | Times | Commits |",
      "| --- | --- | --- | --- |",
      ...s.tests.map((t) => `| \`${t.test}\` | ${t.check} | ${t.times} | ${t.commits.map((c) => c.slice(0, 12)).join(", ")} |`),
      "",
    ].join("\n")

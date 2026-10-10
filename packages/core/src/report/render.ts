import { prettyCanonicalJson, type SourceRef } from "@gauntlet/ir"
import { type Log, type Run, SARIF_SCHEMA, SARIF_VERSION } from "@gauntlet/sarif"
import { Schema } from "effect"
import { Report, type ReportCheck } from "./schema.ts"

/** The report as canonical JSON: sorted keys, two-space indent, trailing newline. */
export const renderJson = (report: Report): string => prettyCanonicalJson(Schema.encodeSync(Report)(report))

/** Every check's SARIF run in one log, in a fixed order. */
export const renderEvidence = (runs: ReadonlyArray<Run>): string => {
  const key = (r: Run) => `${r.properties?.gauntlet?.check ?? ""}\0${r.tool.driver.name}`
  const log: Log = { version: SARIF_VERSION, $schema: SARIF_SCHEMA, runs: [...runs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)) }
  return prettyCanonicalJson(log)
}

// GitHub comments are capped at 65,536 characters; long lists are cut with a count.
const LIST_LIMIT = 40

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
const code = (s: string) => `\`${s.replace(/`/g, "'")}\``
const cite = (ref: SourceRef | undefined) => (ref ? `${code(`${ref.file}:${ref.line}`)} ${code(ref.text)}` : "")
const where = (f: { readonly path?: string; readonly line?: number }) => (f.path ? code(`${f.path}${f.line ? `:${f.line}` : ""}`) : "")

const capped = <A>(items: ReadonlyArray<A>, render: (a: A) => string): string[] => {
  const shown = items.slice(0, LIST_LIMIT).map(render)
  return items.length > LIST_LIMIT ? [...shown, `| … | ${items.length - LIST_LIMIT} more in gauntlet-report.json | | |`] : shown
}

const table = (header: string[], rows: string[]) =>
  rows.length === 0 ? [] : [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows, ""]

const STATUS: Record<Report["checks"][number]["status"], string> = {
  passed: "passed",
  failed: "**failed**",
  "not-executed": "not executed",
  errored: "**errored**",
}

const proofText = (c: Report["checks"][number]) => {
  const parts: string[] = []
  if (c.tests) parts.push(`${c.tests.executed} run, ${c.tests.failed + c.tests.errored} failed, ${c.tests.skipped} skipped`)
  if (c.proof) {
    parts.push(`exit ${c.proof.exitCode}`)
    const reports = Object.entries(c.proof.reports).sort(([a], [b]) => (a < b ? -1 : 1))
    if (reports.length > 0) parts.push(`${reports.length} report${reports.length === 1 ? "" : "s"} (${reports[0]![1].slice(0, 12)}…)`)
  }
  if (c.reason) parts.push(c.reason)
  return parts.join("; ")
}

const COMMENT_ONLY = "the change only edits comments or documentation"

/** A reason as a person would say it. */
const plainReason = (n: Report["decision"]["nominations"][number]): string | undefined => {
  if (n.reason.startsWith("The policy's ")) return undefined // The rules a policy matched say nothing on their own; the zones and files below do.
  switch (n.rule) {
    case "no-rule-matched": return "No rule in the policy says a change like this can merge on its own, so a person should look at it."
    case "missing-evidence":
    case "integrity-not-executed": return `Gauntlet has no evidence for one of its checks: ${n.reason.charAt(0).toLowerCase()}${n.reason.slice(1)}`
    default: return n.reason
  }
}

/** A nomination as a few words for "because ...", or undefined when it says nothing on its own. */
const because = (n: Report["decision"]["nominations"][number]): string | undefined => {
  if (n.reason.startsWith("The policy's ")) return undefined
  switch (n.rule) {
    case "gate-failed": return `${n.reason.split(":")[0]}`
    case "new-violation": return "it adds a lint finding"
    case "ratchet-regression": return "a score dropped below the baseline"
    case "integrity-forbid": return "it weakens or skips a test"
    case "integrity-flag": return "it has a risky pattern"
    case "missing-evidence":
    case "integrity-not-executed": return "a check didn't run"
    case "protected-changed": return / is a protected test /.test(n.reason) ? "it edits a protected test" : "it changes protected build configuration"
    case "gauntlet-changed": return "it changes Gauntlet's policy or baseline"
    case "no-rule-matched": return "no rule in the policy marks it as safe"
    case "flaky-test": return "a test is flaky"
    case "failing-on-base": return "tests fail that were already failing before it"
    case "reported-blocked": return "the agent reported it was blocked"
    default: return /dependency/i.test(n.reason) ? "it adds a dependency" : undefined
  }
}

const sentence = (parts: ReadonlyArray<string>) =>
  parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`

/**
 * The report's first lines, in plain words and in colour (a GitHub alert):
 * red when blocked, orange for an owner's careful review, purple for review,
 * green for a low-risk change. Then each thing a person should look at, the
 * zones with their owners and files among them.
 */
export const plainSummary = (r: Report): string[] => {
  const d = r.decision
  const owners = [...new Set([...d.owners, ...r.policy.owners])]
  const commentOnly = r.checks.length > 0 && r.checks.every((c) => c.reason?.startsWith(COMMENT_ONLY))
  const blockingNoms = d.nominations.filter((n) => n.blocking)
  const reviewNoms = d.nominations.filter((n) => !n.blocking && n.tier !== "auto" && n.tier !== "skim")
  const zoneWords = r.facts.zonesTouched.map((z) => `it touches the ${z.zone} zone`)
  const why = [...new Set([...(d.blocking || d.wouldBlock ? blockingNoms : []).flatMap((n) => because(n) ?? []), ...zoneWords, ...reviewNoms.flatMap((n) => because(n) ?? [])])]
  const [alert, title] = d.blocking ? ["CAUTION", "Blocked"]
    : d.wouldBlock ? ["WARNING", "Would be blocked (shadow mode, so nothing is blocked yet)"]
    : d.tier === "owner" ? ["WARNING", `Needs careful review by an owner${owners.length > 0 ? ` (${owners.join(", ")})` : ""}`]
    : d.tier === "review" ? ["IMPORTANT", "Needs review"]
    : ["TIP", "Low-risk change"]
  const lowRisk = alert === "TIP"
  const what = `It changes ${plural(r.facts.files.length, "file")} (${plural(r.facts.linesChanged, "line")})${commentOnly ? ", only comments or documentation, so nothing needed building or testing" : ""}.`
  const headline = lowRisk ? `**${title}**: it can merge without anyone's approval. ${what}` : `**${title}**${why.length > 0 ? ` because ${sentence(why)}` : ""}. ${what}`
  const blocking = blockingNoms.flatMap((n) => plainReason(n) ?? [])
  const zones = r.facts.zonesTouched.map((z) =>
    `It changes code in the **${z.zone}** zone${z.owners.length > 0 ? ` (owner ${z.owners.join(", ")})` : ""}: ${z.files.slice(0, 3).map(code).join(", ")}${z.files.length > 3 ? ` and ${z.files.length - 3} more` : ""}.`)
  const things = [...new Set([...blocking, ...zones, ...reviewNoms.flatMap((n) => plainReason(n) ?? [])])]
  return [
    `> [!${alert}]`,
    `> ${headline}`,
    ...(things.length > 0
      ? [">", `> ${blocking.length > 0 ? `${plural(blocking.length, "thing")} to fix${things.length > blocking.length ? `, and ${plural(things.length - blocking.length, "more thing")} to look at` : ""}:` : `${plural(things.length, "thing")} to look at:`}`, ">", ...things.map((t, i) => `> ${i + 1}. ${t}`)]
      : []),
    "",
  ]
}

/** The box an owner ticks in the pull request's report to approve its commit. */
export const APPROVE_BOX = "**Approve this change**"

/** The report as markdown, for a PR comment or a terminal. */
export const renderMarkdown = (r: Report): string => {
  const d = r.decision
  const verdict = d.blocking ? "blocks this change" : d.wouldBlock ? "would block this change in enforce mode" : "doesn't block"
  const lines: string[] = d.scope === "protect-only"
    ? [
      `## Gauntlet protect-only: ${d.blocking ? "failed" : "passed"}`,
      "",
      `**Protect-only ${d.blocking ? "failed" : "passed"}.** Only the verification boundary was checked: no zones, review levels, mutation or ratchets.`,
      "",
      ...verdictLines(r).map((l) => `${l}  `),
      "",
    ]
    : [
      `## Gauntlet: ${d.tier}`,
      "",
      ...plainSummary(r),
      `**Tier ${d.tier}.** Gauntlet ${verdict}. Mode ${d.mode}${r.policy.firstAdoption ? " (first adoption)" : ""}.`,
      "",
    ]
  lines.push(
    `Policy ${code(r.policy.irHash.slice(0, 12))} from the ${r.policy.origin === "base" ? "base" : "working copy"}; base ${code(r.policy.baseSha.slice(0, 12))}, head ${code(r.policy.headSha.slice(0, 12))}.`,
    "",
  )
  if (d.owners.length > 0) lines.push(`Suggested reviewers: ${d.owners.join(", ")}`, "")

  // Where a person should look: the zones the change touches, with their owners and files.
  if (d.scope !== "protect-only" && r.facts.zonesTouched.length > 0) {
    lines.push("### Needs your attention", "")
    for (const z of r.facts.zonesTouched) {
      const files = z.files.slice(0, 5).map(code).join(", ")
      lines.push(`- Zone **${z.zone}**${z.owners.length > 0 ? ` (owner ${z.owners.join(", ")})` : ""}: ${files}${z.files.length > 5 ? ` and ${z.files.length - 5} more` : ""}`)
    }
    lines.push("")
  }

  // A review or owner tier waits for an approval on GitHub; say exactly how to give it.
  if (d.scope !== "protect-only" && d.mode === "enforce" && !d.blocking && (d.tier === "review" || d.tier === "owner")) {
    const owners = [...new Set([...d.owners, ...r.policy.owners])]
    const who = d.tier === "owner" ? (owners.length > 0 ? `An owner (${owners.join(", ")})` : "An owner") : "A reviewer"
    lines.push(
      "### How to approve",
      "",
      `${who === "A reviewer" ? "An owner" : who}${owners.length > 0 && who === "A reviewer" ? ` (${owners.join(", ")})` : ""} ticks this box, and the \`gauntlet\` check turns green:`,
      "",
      `- [ ] ${APPROVE_BOX} (commit \`${r.policy.headSha.slice(0, 12)}\`)`,
      "",
      `Or approve the pull request in Files changed, Review changes, Approve (GitHub doesn't allow that on a pull request you opened, including one an agent opened for you), or comment \`/gauntlet approve ${r.policy.headSha.slice(0, 12)}\`. An approval counts for this commit only: a new push needs a new one.`,
      "",
    )
  }

  lines.push("### Why", "")
  lines.push(...table(["Tier", "Reason", "Source", "Blocks"], capped(d.nominations, (n) =>
    `| ${n.tier} | ${cell(n.reason)} | ${n.source ? cite(n.source) : code(n.rule)} | ${n.blocking ? "yes" : ""} |`)))

  if (d.overrides.length > 0) {
    lines.push("### Overrides", "")
    for (const o of d.overrides) lines.push(`- ${o.approver}, requested by ${o.requestedBy}: ${o.reason} (${o.honoured ? "honoured" : "not honoured"}: ${o.note})`)
    lines.push("")
  }

  if (r.remediation.length > 0) {
    lines.push("### How to fix", "")
    for (const fix of r.remediation) lines.push(`- **${fix.check}**: ${fix.fix}`)
    lines.push("")
  }

  if (r.checks.length > 0) {
    lines.push("### Checks", "")
    lines.push(...table(["Tier", "Check", "Status", "Evidence"], capped(r.checks, (c) =>
      `| ${c.tier}${c.advisory ? " (advisory)" : ""} | ${c.check} | ${STATUS[c.status]} | ${cell(proofText(c))} |`)))
    const failing = r.checks.filter((c) => c.failures && c.failures.length > 0)
    if (failing.length > 0) {
      lines.push("### Failing tests", "")
      for (const c of failing) lines.push(...c.failures!.map((f) => `- ${c.check}: ${code(f)}`))
      lines.push("")
    }
  }

  if (r.integrity.findings.length > 0) {
    lines.push("### Integrity", "")
    lines.push(...table(["Kind", "Check", "Where", "Finding"], capped(r.integrity.findings, (f) =>
      `| ${f.kind} | ${f.check} | ${where(f)} | ${cell(f.message)} |`)))
  }

  if (r.violations.length > 0) {
    lines.push("### New findings", "")
    lines.push(...table(["Check", "Rule", "Where", "Message"], capped(r.violations, (v) =>
      `| ${v.check} | ${code(v.ruleId)} | ${where(v)} | ${cell(v.message)} |`)))
  }

  const moved = r.ratchets.filter((x) => x.delta !== 0)
  if (moved.length > 0) {
    lines.push("### Ratchets", "")
    lines.push(...table(["Metric", "Base", "Head", "Change"], capped(moved, (x) =>
      `| ${x.metric}${x.file ? ` (${code(x.file)})` : ""} | ${x.base} | ${x.head} | ${x.delta > 0 ? "+" : ""}${x.delta}${x.regressed ? " **worse**" : ""} |`)))
  }

  const imported = r.imports.filter((i) => i.new.length > 0)
  if (imported.length > 0) {
    lines.push("### Imported findings", "")
    for (const i of imported) {
      lines.push(`- **${i.source}** (${i.trust === "caution" ? "caution only" : "evidence"}): ${i.new.length} new of ${i.total}`)
    }
    lines.push("")
  }

  if (r.notExecuted.length > 0) {
    lines.push("### Not executed", "", "Each of these is missing evidence and nominates review.", "")
    for (const n of r.notExecuted.slice(0, LIST_LIMIT)) lines.push(`- ${n.what}: ${n.why}`)
    if (r.notExecuted.length > LIST_LIMIT) lines.push(`- … ${r.notExecuted.length - LIST_LIMIT} more in gauntlet-report.json`)
    lines.push("")
  }

  const touched = [
    ...r.facts.zonesTouched.map((z) => `zone ${z.zone} (${z.files.length} file${z.files.length === 1 ? "" : "s"})`),
    ...(r.facts.protectedTouched.length > 0 ? [`${r.facts.protectedTouched.length} protected file${r.facts.protectedTouched.length === 1 ? "" : "s"}`] : []),
    ...(r.facts.dependencyChanges.length > 0 ? [`dependencies in ${r.facts.dependencyChanges.map((x) => code(x.manifest)).join(", ")}`] : []),
  ]
  lines.push("### Change", "", `${r.facts.files.length} file${r.facts.files.length === 1 ? "" : "s"}, ${r.facts.linesChanged} line${r.facts.linesChanged === 1 ? "" : "s"} changed.${touched.length > 0 ? ` Touches ${touched.join("; ")}.` : ""}`, "")

  if (r.policy.notes.length > 0) {
    lines.push("### Policy", "")
    for (const note of r.policy.notes) lines.push(`- ${note}`)
    lines.push("")
  }

  const agent = [r.agent.agent, r.agent.model, r.agent.session && `session ${r.agent.session}`].filter(Boolean)
  if (agent.length > 0) lines.push(`<sub>Written by ${agent.join(", ")}. Recorded only; agent identity never changes the decision.</sub>`, "")

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * Two lines that can't collapse into one green badge: the integrity verdict,
 * then the gate results. The GitHub check summary starts with them, and so does
 * a protect-only report (spec 0001).
 */
export const verdictLines = (r: Report): [string, string] => {
  // Integrity ratchets that dropped block like forbids, so they count with them.
  // Partial reports (hand-built in tests) may lack sections; a real report always has them.
  const findings = r.integrity?.findings ?? []
  const forbids = findings.filter((f) => f.kind === "forbid" || f.kind === "ratchet")
  const flags = findings.filter((f) => f.kind === "flag")
  const names = (fs: ReadonlyArray<{ readonly check: string }>) => [...new Set(fs.map((f) => f.check.replaceAll("-", " ")))].join(", ")
  const integrity = forbids.length > 0
    ? `Integrity: ${plural(forbids.length, "forbidden change")} (${names(forbids)})${flags.length > 0 ? `; ${plural(flags.length, "flag")} (${names(flags)})` : ""}.`
    : flags.length > 0
    ? `Integrity: no forbidden changes; ${plural(flags.length, "flag")} (${names(flags)}).`
    : "Integrity: no forbidden changes."
  const gates = (r.checks ?? []).filter((c) => !c.advisory)
  const by = (s: ReadonlyArray<ReportCheck["status"]>) => gates.filter((c) => s.includes(c.status))
  // A holdout gap is its own outcome, never folded into ordinary failures (ADR 0019).
  const gaps = by(["failed"]).filter((c) => c.holdoutGap === true)
  const failed = by(["failed"]).filter((c) => c.holdoutGap !== true)
  const missing = by(["not-executed", "errored"])
  const parts = [
    `${by(["passed"]).length} passed`,
    ...(failed.length > 0 ? [`${failed.length} failed (${failed.map((c) => c.check).join(", ")})`] : []),
    ...(gaps.length > 0 ? [`${plural(gaps.length, "holdout gap")} (${gaps.map((c) => c.check).join(", ")})`] : []),
    ...(missing.length > 0 ? [`${missing.length} not executed (${missing.map((c) => c.check).join(", ")})`] : []),
  ]
  return [integrity, gates.length > 0 ? `Gates: ${parts.join(", ")}.` : "Gates: none ran."]
}

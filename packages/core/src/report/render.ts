import { prettyCanonicalJson, type SourceRef } from "@gauntlet/ir"
import { type Log, type Run, SARIF_SCHEMA, SARIF_VERSION } from "@gauntlet/sarif"
import { Schema } from "effect"
import { Report } from "./schema.ts"

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

/** The report as markdown, for a PR comment or a terminal. */
export const renderMarkdown = (r: Report): string => {
  const d = r.decision
  const verdict = d.blocking ? "blocks this change" : d.wouldBlock ? "would block this change in enforce mode" : "doesn't block"
  const lines: string[] = [
    `## Gauntlet: ${d.tier}`,
    "",
    `**Tier ${d.tier}.** Gauntlet ${verdict}. Mode ${d.mode}${r.policy.firstAdoption ? " (first adoption)" : ""}.`,
    "",
    `Policy ${code(r.policy.irHash.slice(0, 12))} from the ${r.policy.origin === "base" ? "base" : "working copy"}; base ${code(r.policy.baseSha.slice(0, 12))}, head ${code(r.policy.headSha.slice(0, 12))}.`,
    "",
  ]
  if (d.owners.length > 0) lines.push(`Suggested reviewers: ${d.owners.join(", ")}`, "")

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

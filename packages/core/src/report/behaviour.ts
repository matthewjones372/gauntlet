import type { Link, RenderOptions } from "./render.ts"
import type { Report, ReportScenarios } from "./schema.ts"

// Spec 0012's `### Behaviour` section: a one-line count, a table, the details
// of each scenario, and a diagram of what reaches what with its links. GitHub
// comments stop at 65,536 characters and Mermaid stops being readable past
// about 30 nodes, so both are cut, with the rest in the report artifact.

type Scenario = ReportScenarios["scenarios"][number]
type Verdict = Scenario["verdict"]

/** Rows in the table and detail blocks shown; the rest are in gauntlet-report.json. */
export const SCENARIO_ROWS = 40
/** Lines of a scenario's text shown. */
const TEXT_LINES = 30
/** Nodes in the diagram. */
export const DIAGRAM_NODES = 30

const BLOCKING: ReadonlySet<Verdict> = new Set(["unbound", "not-run", "failing", "vacuous"])
const icon = (v: Verdict) => (BLOCKING.has(v) ? "❌" : v === "unchallenged" ? "⚠️" : "✅")
const code = (s: string) => `\`${s.replace(/`/g, "'")}\``
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`
const oneLine = (s: string, max = 160) => {
  const line = s.split("\n")[0]!.trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** A test's id without its package: \`svc.settlement.FxTest.FX-003 converts\` is \`FxTest.FX-003 converts\`. */
const shortTest = (id: string) => id.replace(/^([a-z_][\w]*\.)+(?=[A-Z])/, "")

const VERDICT_WORDS: Record<Verdict, string> = {
  unbound: "no test names it",
  "not-run": "its tests didn't run",
  failing: "a bound test failed",
  vacuous: "its tests can't fail",
  unchallenged: "reached, no mutant killed",
  proven: "proven",
  unaffected: "its tests don't reach this change",
  passing: "passed; whether it catches a bug isn't known",
}

const ran = (s: Scenario): string => {
  const executed = s.tests.filter((t) => t.status === "passed" || t.status === "failed")
  if (executed.length === 0) return s.tests.length === 0 ? "" : s.tests.some((t) => t.holdout) ? "holdout pending" : s.tests.some((t) => t.status === "skipped") ? "skipped" : "no"
  if (executed.some((t) => t.status === "failed")) return "✘"
  const assertions = executed.reduce((n, t) => n + (t.assertions ?? 0), 0)
  return executed.every((t) => t.holdout) ? "✔ holdout" : assertions > 0 ? `✔ ${plural(assertions, "assertion")}` : "✔"
}

const catches = (s: Scenario): string => {
  if (s.tests.length === 0) return ""
  if (s.holdout) return "holdout: not mutated"
  if (s.killers === "not-in-policy" || s.killers === "not-run") return "mutation not run"
  if (s.killers === "not-reported") return "not reported"
  const n = s.killed.length + s.reachedOnly.length
  return n === 0 ? "reaches no changed line" : `kills ${s.killed.length} of ${n}`
}

const testList = (s: Scenario) => (s.tests.length === 0 ? "none" : s.tests.map((t) => code(t.holdout ? t.id : shortTest(t.id))).join(", "))

/** The one-line count: how many proven, then every other verdict, then changed code with no scenario. */
const countLine = (b: ReportScenarios): string => {
  const count = (v: Verdict) => b.scenarios.filter((s) => s.verdict === v).length
  const others = (["unbound", "not-run", "failing", "vacuous", "unchallenged", "passing", "unaffected"] as const).filter((v) => count(v) > 0).map((v) => `${count(v)} ${v}`)
  const mutation = b.mutation === "not-in-policy" || b.mutation === "not-run" ? ["mutation wasn't run, so none can be proven"] : b.mutation === "not-reported" ? ["the mutation tool doesn't name killers, so none can be proven"] : []
  const none = b.noScenario.length > 0 ? [`changed code with no scenario: ${plural(b.noScenario.length, "function")}`] : []
  return [`${count("proven")} of ${plural(b.scenarios.length, "scenario")} proven`, ...others, ...mutation, ...none].join(" · ")
}

const changedInPr = (r: Report, path: string) => r.facts.files.some((f) => f.path === path || f.oldPath === path)

const details = (r: Report, s: Scenario, link: Link): string[] => {
  const folded = s.verdict === "proven" || s.verdict === "passing"
  const scenarioFile = changedInPr(r, s.file)
    ? `${link(s.file, s.line, "base")}, as the base has it: this pull request changes the file, and the base's version is the one judged (the head's is in ${link(s.file)})`
    : `${link(s.file, s.line, "base")}, unchanged`
  const tests = s.tests.length === 0
    ? ["- Test: none names it. Put the id in a test's name, such as `" + s.id + " " + s.name.toLowerCase() + "`."]
    : s.tests.map((t) => t.holdout
      // Holdouts are shown by id only, with no failure message (spec 0003).
      ? `- Test: ${code(t.id)} (holdout${t.status === "not-run" ? ", pending: it runs only in the evidence job" : `, ${t.status}`})`
      : `- Test: ${t.path ? `${link(t.path, t.line)}, ${changedInPr(r, t.path) ? "changed by this pull request" : "unchanged since base"}, ` : ""}${code(shortTest(t.id))}: ${t.status}${t.assertions !== undefined && t.status === "passed" ? `, ${plural(t.assertions, "assertion")}` : ""}${t.vacuous ? `; ${t.vacuous}` : ""}`)
  const killed = s.killed.map((m) => `- Catches: ${m.description ? code(oneLine(m.description, 80)) : "a mutant"} at ${link(m.path, m.line)}${m.method ? ` (${code(m.method)})` : ""}, killed by ${code(shortTest(m.killedBy ?? ""))}${m.message ? `: ${code(oneLine(m.message))}` : ""}`)
  const reached = s.reachedOnly.map((m) => `- Reached, not killed: ${m.description ? code(oneLine(m.description, 80)) : "a mutant"} at ${link(m.path, m.line)}${m.method ? ` (${code(m.method)})` : ""}`)
  const why = s.killers === "not-reported" ? ["- Catches: not reported: the mutation tool doesn't name the tests that kill each mutant"] : []
  return [
    `<details${folded ? "" : " open"}><summary>${icon(s.verdict)} ${s.id} · ${s.name} · ${s.verdict}</summary>`,
    "",
    "```gherkin",
    ...s.text.slice(0, TEXT_LINES),
    ...(s.text.length > TEXT_LINES ? [`# … ${s.text.length - TEXT_LINES} more lines in ${s.file}`] : []),
    "```",
    "",
    `- Scenario: ${scenarioFile}`,
    ...tests,
    ...killed,
    ...reached,
    ...why,
    "</details>",
    "",
  ]
}

/** A Mermaid label: quotes and brackets are Mermaid's, so they're left out. */
const label = (s: string, max = 32) => {
  const t = s.replace(/["[\]{}()<>|#;`]/g, "").trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/**
 * The diagram: a scenario to a changed function when a bound test killed
 * (solid) or reached (dotted) a mutant in it. Everything that isn't proven
 * first, then proven scenarios, up to the node limit; then "+N more". The
 * list under it carries the links, one line per node that isn't proven.
 */
const diagram = (b: ReportScenarios, link: Link): string[] => {
  const shown = b.scenarios.filter((s) => s.verdict !== "unaffected")
  const fnOf = (m: { readonly method?: string; readonly path: string }) => m.method ?? m.path
  const nodes: string[] = []
  const edges: string[] = []
  const fnIds = new Map<string, string>()
  const fnNode = (name: string, cls: string, text = name) => {
    const known = fnIds.get(name)
    if (known) return known
    const id = `F${fnIds.size + 1}`
    fnIds.set(name, id)
    nodes.push(`  ${id}["${label(text)}"]:::${cls}`)
    return id
  }
  const noScenario = new Set(b.noScenario.map((n) => n.function))
  let used = 0
  let left = 0
  const order = [...shown.filter((s) => s.verdict !== "proven"), ...shown.filter((s) => s.verdict === "proven")]
  order.forEach((s, i) => {
    const fns = [...new Set([...s.killed, ...s.reachedOnly].map(fnOf))].filter((f) => !fnIds.has(f))
    if (used + 1 + fns.length > DIAGRAM_NODES - (b.noScenario.length > 0 ? 1 : 0)) {
      left++
      return
    }
    used += 1 + fns.length
    const id = `S${i + 1}`
    const cls = BLOCKING.has(s.verdict) ? "bad" : s.verdict === "unchallenged" ? "warn" : "ok"
    nodes.push(`  ${id}["${label(`${s.id} ${s.name}`)}"]:::${cls}`)
    const killedIn = new Set(s.killed.map(fnOf))
    for (const f of new Set([...s.killed, ...s.reachedOnly].map(fnOf))) {
      edges.push(`  ${id} ${killedIn.has(f) ? "-->" : "-.->"} ${fnNode(f, noScenario.has(f) ? "bad" : "ok")}`)
    }
  })
  for (const n of b.noScenario) {
    if (fnIds.has(n.function)) continue
    if (used >= DIAGRAM_NODES - 1) {
      left++
      continue
    }
    used++
    fnNode(n.function, "bad", `${n.function}: no scenario`)
  }
  if (left > 0) nodes.push(`  More["+${left} more in gauntlet-report.json"]`)
  if (nodes.length === 0) return []
  const list = [
    ...order.filter((s) => s.verdict !== "proven").map((s) => {
      const reached = [...new Map(s.reachedOnly.map((m) => [fnOf(m), m])).values()]
      return reached.length > 0 && s.verdict === "unchallenged"
        ? `- **${s.id}** → ${reached.map((m) => `${link(m.path, m.line)} ${code(fnOf(m))}`).join(", ")}: ${VERDICT_WORDS[s.verdict]}`
        : `- **${s.id}** → ${VERDICT_WORDS[s.verdict]}`
    }),
    ...b.noScenario.map((n) => `- **No scenario** → ${link(n.path, n.line)} ${code(n.function)}`),
  ]
  return [
    "```mermaid",
    "flowchart LR",
    ...nodes,
    ...edges,
    "  classDef ok fill:#d4f4dd,color:#000",
    "  classDef warn fill:#fff3c4,color:#000",
    "  classDef bad fill:#fbd5d5,color:#000",
    "```",
    "",
    ...list.slice(0, SCENARIO_ROWS),
    ...(list.length > SCENARIO_ROWS ? [`- … ${list.length - SCENARIO_ROWS} more in gauntlet-report.json`] : []),
    "",
  ]
}

/** The section's lines, or none when the report has no verdicts. */
export const behaviourSection = (r: Report, link: Link, _opts: RenderOptions = {}): string[] => {
  const b = r.scenarios
  if (!b) return []
  // Worst first; the report's list is already in that order. Unaffected scenarios are a count, not rows.
  const rows = b.scenarios.filter((s) => s.verdict !== "unaffected")
  const shown = rows.slice(0, SCENARIO_ROWS)
  return [
    "### Behaviour",
    "",
    countLine(b),
    "",
    ...(shown.length > 0
      ? [
        "| | Scenario | Tests | Ran | Catches a bug on this change |",
        "|---|---|---|---|---|",
        ...shown.map((s) => `| ${icon(s.verdict)} | **${s.id}** ${cell(s.name)} | ${cell(testList(s))} | ${ran(s)} | ${catches(s)} |`),
        ...(rows.length > shown.length ? [`| … | ${rows.length - shown.length} more in gauntlet-report.json | | | |`] : []),
        "",
      ]
      : []),
    ...shown.flatMap((s) => details(r, s, link)),
    ...diagram(b, link),
  ]
}

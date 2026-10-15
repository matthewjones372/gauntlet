import type { Diagnostic } from "./diagnostic.ts"
import type { Span } from "./span.ts"

// Scenario files (spec 0012): Gherkin's syntax, read and never executed. The
// subset is `Feature`, `Background`, `Scenario` (or `Example`), `Scenario
// Outline` (or `Scenario Template`) with its `Examples` (or `Scenarios`),
// steps (`Given`, `When`, `Then`, `And`, `But`, `*`) with their data tables
// and doc strings, tags and `#` comments. Gauntlet's own parser, about the size
// of the DSL lexer: the subset is small, and a dependency in the compiled
// binary would nominate review on every pack.

/** A scenario's id: its tag of capitals, a dash and digits, such as \`@FX-003\`. */
export const SCENARIO_ID = /^@([A-Z][A-Z0-9]*-[0-9]+)$/

export interface Step {
  /** As written: Given, When, Then, And, But or \`*\`. */
  readonly keyword: string
  readonly text: string
  readonly line: number
  /** A data table or doc string under the step, as written (indent removed). */
  readonly argument?: ReadonlyArray<string>
}

export interface Scenario {
  /** The id without its \`@\`: \`FX-003\`. */
  readonly id: string
  readonly name: string
  readonly file: string
  /** The line and column of its \`Scenario\` keyword. */
  readonly line: number
  readonly column: number
  /** The feature it belongs to. */
  readonly feature: string
  /** Its tags as written, the id among them. */
  readonly tags: ReadonlyArray<string>
  readonly outline: boolean
  /** The feature's \`Background\` steps, which come before its own. */
  readonly background: ReadonlyArray<Step>
  readonly steps: ReadonlyArray<Step>
  /** An outline's \`Examples\` tables, each as written: one scenario, the table shown as is. */
  readonly examples?: ReadonlyArray<ReadonlyArray<string>>
}

export interface ScenarioFile {
  readonly scenarios: ReadonlyArray<Scenario>
  readonly diagnostics: ReadonlyArray<Diagnostic>
}

const STEP = /^(Given|When|Then|And|But|\*)(\s+|$)(.*)$/
const HEADER = /^(Feature|Background|Scenario Outline|Scenario Template|Scenario|Example|Examples|Scenarios|Rule):(.*)$/

const lineSpan = (line: number, column: number, length: number): Span => ({ line, column, endLine: line, endColumn: column + Math.max(1, length) })

interface Building {
  name: string
  line: number
  column: number
  length: number
  tags: { text: string; line: number; column: number }[]
  outline: boolean
  steps: Step[]
  examples: string[][]
}

/** Reads one scenario file. Scenarios without an id are reported and left out. */
export const parseScenarioFile = (file: string, text: string): ScenarioFile => {
  const diagnostics: Diagnostic[] = []
  const scenarios: Scenario[] = []
  const error = (code: string, span: Span, message: string, expected: string, fix: string) =>
    diagnostics.push({ severity: "error", code, file, span, message, expected, fix })

  let feature: string | undefined
  let background: Step[] = []
  let tags: { text: string; line: number; column: number }[] = []
  let current: Building | undefined
  // Where steps go: the background, the scenario, or nowhere (a feature's description).
  let section: "none" | "background" | "scenario" | "examples" = "none"
  // An open doc string: its fence, and the step it belongs to.
  let fence: { readonly mark: string; readonly lines: string[]; readonly indent: number } | undefined

  const steps = (): Step[] | undefined => (section === "background" ? background : section === "scenario" ? current?.steps : undefined)

  const finish = () => {
    if (!current) return
    const ids = current.tags.filter((t) => SCENARIO_ID.test(t.text))
    const span = lineSpan(current.line, current.column, current.length)
    if (ids.length === 0) {
      error("scenario-without-id", span, `Scenario '${current.name}' has no id, so no test can be bound to it.`,
        "a tag such as @FX-003 on the line above the scenario", "Add an id tag: capitals, a dash and a number, such as @FX-003.")
    } else if (ids.length > 1) {
      error("scenario-with-two-ids", lineSpan(ids[1]!.line, ids[1]!.column, ids[1]!.text.length),
        `Scenario '${current.name}' has two ids, ${ids.map((t) => t.text).join(" and ")}.`, "one id tag per scenario",
        "Keep one id; split the scenario if it states two behaviours.")
    } else {
      const examples = current.examples.filter((e) => e.length > 0)
      scenarios.push({
        id: ids[0]!.text.slice(1),
        name: current.name,
        file,
        line: current.line,
        column: current.column,
        feature: feature ?? "",
        tags: current.tags.map((t) => t.text),
        outline: current.outline,
        background,
        steps: current.steps,
        ...(current.outline ? { examples } : {}),
      })
    }
    current = undefined
  }

  const lines = text.split(/\r?\n/)
  lines.forEach((raw, i) => {
    const line = i + 1
    const trimmed = raw.trim()
    const column = raw.length - raw.trimStart().length + 1
    if (fence) {
      if (trimmed === fence.mark) {
        fence.lines.push(trimmed)
        fence = undefined
      } else fence.lines.push(raw.slice(Math.min(fence.indent, raw.length - raw.trimStart().length)))
      return
    }
    if (trimmed === "" || trimmed.startsWith("#")) return
    if (trimmed.startsWith("@")) {
      for (const m of trimmed.split(/\s#/)[0]!.matchAll(/@\S+/g)) tags.push({ text: m[0], line, column: column + m.index })
      return
    }
    const header = HEADER.exec(trimmed)
    if (header) {
      const keyword = header[1]!
      const name = header[2]!.trim()
      const span = lineSpan(line, column, keyword.length)
      const taken = tags
      tags = []
      switch (keyword) {
        case "Feature":
          finish()
          if (feature !== undefined) {
            error("two-features", span, "A scenario file has one `Feature`.", "a single Feature per file", "Move the second feature to a file of its own.")
          }
          for (const t of taken.filter((t) => SCENARIO_ID.test(t.text))) {
            error("feature-with-id", lineSpan(t.line, t.column, t.text.length), `${t.text} is on the feature: an id names one scenario.`,
              "id tags on scenarios only", "Move the id to the scenario it names.")
          }
          feature = name
          section = "none"
          return
        case "Background":
          finish()
          section = "background"
          background = []
          return
        case "Scenario":
        case "Example":
        case "Scenario Outline":
        case "Scenario Template":
          finish()
          if (feature === undefined) {
            error("scenario-outside-feature", span, "A scenario comes after a `Feature:` line.", "a Feature: line at the top of the file",
              "Start the file with `Feature: <what it's about>`.")
          }
          current = {
            name, line, column, length: keyword.length,
            tags: taken,
            outline: keyword === "Scenario Outline" || keyword === "Scenario Template",
            steps: [],
            examples: [],
          }
          section = "scenario"
          return
        case "Examples":
        case "Scenarios":
          if (!current?.outline) {
            error("examples-outside-outline", span, "`Examples` belong to a `Scenario Outline`.", "Examples after a Scenario Outline's steps",
              "Make the scenario a `Scenario Outline`, or remove the examples.")
            section = "none"
            return
          }
          current.examples.push([])
          section = "examples"
          return
        case "Rule":
          finish()
          error("unsupported-gherkin", span, "Gauntlet reads a subset of Gherkin, and `Rule` isn't part of it.",
            "Feature, Background, Scenario, Scenario Outline, Examples and steps", "Remove the `Rule:` line and keep its scenarios under the feature.")
          section = "none"
          return
      }
    }
    const step = STEP.exec(trimmed)
    if (step && section !== "examples") {
      const into = steps()
      if (!into) {
        error("step-outside-scenario", lineSpan(line, column, step[1]!.length), "A step belongs to a `Background` or a scenario.",
          "a Scenario: or Background: line before the steps", "Put the step under the scenario it describes.")
        return
      }
      into.push({ keyword: step[1]!, text: step[3]!.trim(), line })
      return
    }
    if (trimmed.startsWith("|")) {
      if (section === "examples") {
        current!.examples.at(-1)!.push(trimmed)
        return
      }
      const into = steps()
      const last = into?.at(-1)
      if (last) {
        into![into!.length - 1] = { ...last, argument: [...(last.argument ?? []), trimmed] }
        return
      }
    }
    if (trimmed.startsWith('"""') || trimmed.startsWith("```")) {
      const into = steps()
      const last = into?.at(-1)
      if (last) {
        const mark = trimmed.startsWith('"""') ? '"""' : "```"
        const lines = [trimmed]
        into![into!.length - 1] = { ...last, argument: lines }
        fence = { mark, lines, indent: column - 1 }
        return
      }
    }
    // Free text: a description under a Feature or Scenario line, before any step.
    const into = steps()
    if (section === "examples" || (into !== undefined && into.length > 0)) {
      error("unexpected-gherkin", lineSpan(line, column, trimmed.split(/\s/)[0]!.length), `Gauntlet doesn't read '${trimmed.slice(0, 40)}' here.`,
        "a step (Given, When, Then, And, But), a table row or a new Scenario", "Start the line with a step keyword, or make it a comment with #.")
    }
  })
  finish()
  if (fence) {
    error("unclosed-doc-string", lineSpan(lines.length, 1, 1), "A doc string isn't closed.", `a closing ${fence.mark}`, `Close it with ${fence.mark} on a line of its own.`)
  }
  return { scenarios, diagnostics }
}

/**
 * Reads every scenario file. Two scenarios with the same id are an error at
 * the second, naming the first; only the first is kept.
 */
export const readScenarios = (files: ReadonlyArray<{ readonly path: string; readonly text: string }>): ScenarioFile => {
  const scenarios: Scenario[] = []
  const diagnostics: Diagnostic[] = []
  const first = new Map<string, Scenario>()
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const parsed = parseScenarioFile(f.path, f.text)
    diagnostics.push(...parsed.diagnostics)
    for (const s of parsed.scenarios) {
      const seen = first.get(s.id)
      if (seen) {
        diagnostics.push({
          severity: "error",
          code: "duplicate-scenario-id",
          file: s.file,
          span: lineSpan(s.line, s.column, s.outline ? "Scenario Outline".length : "Scenario".length),
          message: `@${s.id} is also the id of '${seen.name}' at ${seen.file}:${seen.line}.`,
          expected: "a different id for each scenario",
          fix: `Give this scenario an id of its own, such as @${s.id.split("-")[0]}-${nextNumber(s.id, first)}.`,
        })
        continue
      }
      first.set(s.id, s)
      scenarios.push(s)
    }
  }
  return { scenarios, diagnostics }
}

/** The next unused number for an id's prefix, kept to the id's width. */
const nextNumber = (id: string, taken: ReadonlyMap<string, unknown>): string => {
  const [prefix, digits] = id.split("-") as [string, string]
  let n = Number(digits) + 1
  while (taken.has(`${prefix}-${String(n).padStart(digits.length, "0")}`)) n++
  return String(n).padStart(digits.length, "0")
}

/**
 * Whether a test's name, as its runner reports it, binds the scenario (spec
 * 0012 §3): the id appears in it as a word. \`FX-003 converts\` binds FX-003;
 * \`converts_FX003\`, \`FX-0031\`, \`FX-003-2\` and \`AFX-003\` don't.
 */
export const namesScenario = (testName: string, id: string): boolean => {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_]|-[0-9])`).test(testName)
}

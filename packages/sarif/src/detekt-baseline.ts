import { Data, Effect } from "effect"
import { XMLParser } from "fast-xml-parser"
import type { LegacyEntry } from "./schema.ts"

// detekt's baseline.xml lists grandfathered findings by detekt's own id
// ("RuleId:signature"). Gauntlet imports them as a legacy set kept in
// baseline.sarif, and hands them back to detekt as a generated baseline when
// it runs, so the repository's own baseline.xml is never trusted.

export class DetektBaselineInvalid extends Data.TaggedError("DetektBaselineInvalid")<{ readonly reason: string }> {}

const parser = new XMLParser({ isArray: (name) => name === "ID" })

export const parseDetektBaseline = (xml: string) =>
  Effect.gen(function*() {
    const doc = yield* Effect.try({
      try: () => parser.parse(xml, true) as Record<string, unknown>,
      catch: (e) => new DetektBaselineInvalid({ reason: String(e) }),
    })
    const root = doc.SmellBaseline as Record<string, { ID?: unknown[] } | ""> | undefined
    if (root === undefined) return yield* new DetektBaselineInvalid({ reason: "no <SmellBaseline> element" })
    const ids = ["ManuallySuppressedIssues", "CurrentIssues"].flatMap((section) => {
      const s = root[section]
      return s && typeof s === "object" ? (s.ID ?? []).map(String) : []
    })
    return [...new Set(ids)].sort().map((id): LegacyEntry => ({ tool: "detekt", id }))
  })

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** Renders a legacy set back into a detekt baseline.xml. */
export const renderDetektBaseline = (entries: ReadonlyArray<LegacyEntry>): string => {
  const ids = entries.filter((e) => e.tool === "detekt").map((e) => e.id).sort()
  return [
    `<?xml version="1.0" ?>`,
    `<SmellBaseline>`,
    `  <ManuallySuppressedIssues/>`,
    `  <CurrentIssues>`,
    ...ids.map((id) => `    <ID>${escape(id)}</ID>`),
    `  </CurrentIssues>`,
    `</SmellBaseline>`,
    ``,
  ].join("\n")
}

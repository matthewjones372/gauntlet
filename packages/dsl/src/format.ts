import type { Diagnostic } from "./diagnostic.ts"

const order = { error: 0, warning: 1, info: 2 } as const

export const sortDiagnostics = (ds: ReadonlyArray<Diagnostic>): Diagnostic[] =>
  [...ds].sort((a, b) =>
    a.span.line - b.span.line || a.span.column - b.span.column || order[a.severity] - order[b.severity] || a.code.localeCompare(b.code))

/**
 * Renders a diagnostic for a terminal or an agent:
 *
 *   .gauntlet/policy.gx:14:22  error[unknown-gate]  Unknown gate 'mutaton'.
 *      14 |   verify { unit, mutaton ratchet on changed }
 *         |                  ^^^^^^^
 *     expected: a gate from a used pack, or a suite declared in `suites`
 *     fix: Did you mean 'mutation'?
 */
export const formatDiagnostic = (d: Diagnostic, text: string): string => {
  const lines = text.split(/\r?\n/)
  const source = lines[d.span.line - 1] ?? ""
  const gutter = String(d.span.line).length
  const width = d.span.endLine === d.span.line ? Math.max(1, d.span.endColumn - d.span.column) : Math.max(1, source.length - d.span.column + 1)
  const out = [
    `${d.file}:${d.span.line}:${d.span.column}  ${d.severity}[${d.code}]  ${d.message}`,
    `  ${String(d.span.line).padStart(gutter)} | ${source}`,
    `  ${" ".repeat(gutter)} | ${" ".repeat(Math.max(0, d.span.column - 1))}${"^".repeat(width)}`,
    `  expected: ${d.expected}`,
    `  fix: ${d.fix}`,
  ]
  if (d.available && d.available.length > 0) out.push(`  available: ${d.available.join(", ")}`)
  return out.join("\n")
}

export const formatDiagnostics = (ds: ReadonlyArray<Diagnostic>, text: string): string =>
  sortDiagnostics(ds).map((d) => formatDiagnostic(d, text)).join("\n\n")

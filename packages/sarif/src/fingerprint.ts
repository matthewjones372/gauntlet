import { sha256 } from "@gauntlet/ir"
import { CTX_V1, CTX_V1_NOSYM, type Result, resultPath, resultRegion } from "./schema.ts"

// Fingerprints that survive unrelated edits (ADR 0004). None of them include
// the file path: the path is part of the match key instead, so a renamed file
// can be followed by mapping its old path to its new one before matching.

/** Lines either side of a result included in its context window. */
export const WINDOW = 2

/** Secondary keys used when the context changed but the finding didn't move far. */
export const SYMBOL_V1 = "gauntlet/symbol/v1"
export const LINE_V1 = "gauntlet/line/v1"

/** Finds the enclosing symbol (class, function) of a line. Packs supply one per language. */
export type SymbolLocator = (path: string, lines: ReadonlyArray<string>, line: number) => string | undefined

/** Normalises one line before hashing, for example to strip comments. Packs may supply one. */
export type LineNormaliser = (line: string) => string

const collapse: LineNormaliser = (line) => line.replace(/\s+/g, " ").trim()

export interface FingerprintOptions {
  readonly locate?: SymbolLocator
  readonly normalise?: LineNormaliser
}

export const contextWindow = (lines: ReadonlyArray<string>, startLine: number, endLine: number, normalise: LineNormaliser = collapse): string =>
  lines
    .slice(Math.max(0, startLine - 1 - WINDOW), Math.min(lines.length, endLine + WINDOW))
    .map((l) => collapse(normalise(l)))
    .filter((l) => l !== "")
    .join("\n")

/**
 * Adds Gauntlet's fingerprints to each result whose file and line are known.
 * Results without a location (or whose file can't be read) get none and are
 * compared by per-file counts instead.
 */
export const fingerprint = (
  results: ReadonlyArray<Result>,
  readLines: (path: string) => ReadonlyArray<string> | undefined,
  options: FingerprintOptions = {},
): Result[] =>
  results.map((r) => {
    const path = resultPath(r)
    const start = resultRegion(r)?.startLine
    const lines = path !== undefined ? readLines(path) : undefined
    if (path === undefined || start === undefined || lines === undefined || start < 1 || start > lines.length) return r
    const end = Math.max(start, resultRegion(r)?.endLine ?? start)
    const normalise = options.normalise ?? collapse
    const symbol = options.locate?.(path, lines, start)
    const window = contextWindow(lines, start, end, normalise)
    const own: Record<string, string> = {
      [symbol ? CTX_V1 : CTX_V1_NOSYM]: sha256(`${r.ruleId}\0${window}\0${symbol ?? ""}`),
      [LINE_V1]: sha256(`${r.ruleId}\0${collapse(normalise(lines[start - 1] ?? ""))}`),
      ...(symbol ? { [SYMBOL_V1]: sha256(`${r.ruleId}\0${symbol}`) } : {}),
    }
    return { ...r, partialFingerprints: { ...r.partialFingerprints, ...own } }
  })

export const contextKey = (r: Result): string | undefined => r.partialFingerprints?.[CTX_V1] ?? r.partialFingerprints?.[CTX_V1_NOSYM]

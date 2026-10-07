import { createHash } from "node:crypto"

/**
 * Canonical JSON: object keys sorted, `undefined` members dropped, no
 * whitespace. Arrays keep the order they are given; callers sort them first
 * wherever order carries no meaning.
 */
export const canonicalJson = (value: unknown): string => {
  // The IR schema only admits finite numbers, so JSON.stringify is exact here.
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex")

/** Canonical JSON, pretty-printed for files people diff (sorted keys, two-space indent, trailing newline). */
export const prettyCanonicalJson = (value: unknown): string => `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}\n`

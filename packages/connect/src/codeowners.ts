import type { PolicyIR } from "@gauntlet/ir"
import type { GeneratedFile } from "./files.ts"

// CODEOWNERS entries as a backstop for the tiers (ADR 0015 layer c):
// `.gauntlet/` and protected paths to the policy owners, zones to their owners.

/** Converts a Gauntlet glob to CODEOWNERS (gitignore-style) syntax. */
export const toCodeownersPattern = (glob: string): string => {
  let p = glob.replace(/\/\*\*$/, "/")
  if (!p.startsWith("*")) p = `/${p}`
  return p
}

export const codeowners = (ir: PolicyIR): GeneratedFile => {
  const owners = ir.owners.length > 0 ? ir.owners.join(" ") : undefined
  // In CODEOWNERS the last matching line wins, so `.gauntlet/` comes last.
  const lines: string[] = []
  if (owners) {
    for (const g of ir.protect.filter((g) => g.kind !== "gauntlet")) {
      lines.push(`# protect ${g.group}`)
      for (const glob of g.globs) lines.push(`${toCodeownersPattern(glob)} ${owners}`)
    }
  }
  for (const z of ir.zones.filter((z) => z.owners.length > 0)) {
    lines.push(`# zone ${z.name}`)
    for (const glob of z.globs) lines.push(`${toCodeownersPattern(glob)} ${z.owners.join(" ")}`)
  }
  lines.push("# The policy, its baseline and self-tests need a policy owner.")
  lines.push(owners ? `/.gauntlet/ ${owners}` : "# The policy names no owners (add `owners @team` to .gauntlet/policy.gx), so none are listed.")
  return { path: ".github/CODEOWNERS", content: `${lines.join("\n")}\n`, mode: "block" }
}

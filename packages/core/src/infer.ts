import { globMatches } from "@gauntlet/dsl"

// What `gauntlet init` infers from a repository's layout for a strict first
// policy: zones for code that usually needs its owners (money, security,
// schema migrations), and arch rules when the code is layered. Folder names
// only, so the same files always give the same suggestions.

export interface InferredZone {
  readonly name: string
  readonly why: string
  readonly globs: ReadonlyArray<string>
  readonly rules: ReadonlyArray<string>
}

export interface InferredArch {
  readonly inner: string
  readonly outer: ReadonlyArray<string>
}

const ZONES = [
  { name: "money", why: "payments, billing and money code", dirs: /^(payments?|billing|invoices?|invoicing|ledgers?|money|finance|wallets?|checkout|settlements?|settlement|pricing|refunds?)$/, rules: [/\.no-floating-money$/] },
  { name: "security", why: "authentication, authorisation and secrets", dirs: /^(auth|authn|authz|authentication|authorization|authorisation|security|crypto|secrets?|permissions|iam|sessions?|oauth|sso)$/, rules: [] },
  { name: "migrations", why: "database schema migrations", dirs: /^(migrations?|migrate|db-migrations|flyway|liquibase)$/, rules: [] },
] as const

const OUTER = /^(infra|infrastructure|adapters?|persistence|db|database|api|web|http|controllers?|ui|cli|app|server)$/

/** Directory paths (without the file) of the files Gauntlet would judge as code. */
const codeDirs = (files: ReadonlyArray<string>, protectedGlobs: ReadonlyArray<string>) =>
  [...new Set(files
    .filter((f) => !protectedGlobs.some((g) => globMatches(g, f)) && !/(^|\/)(node_modules|vendor|target|build|dist|\.[^/]+)\//.test(f) && f.includes("/"))
    .map((f) => f.slice(0, f.lastIndexOf("/"))))].sort()

/** Zones for folders whose names say what they hold; each folder becomes a glob. */
export const inferZones = (files: ReadonlyArray<string>, protectedGlobs: ReadonlyArray<string>, packRules: ReadonlyArray<string>, owned: boolean): InferredZone[] => {
  const dirs = codeDirs(files, protectedGlobs)
  return ZONES.flatMap((z) => {
    // The shallowest matching folder on each path: src/payments/stripe is covered by src/payments.
    const roots = dirs.flatMap((d) => {
      const parts = d.split("/")
      const at = parts.findIndex((p) => z.dirs.test(p))
      return at < 0 ? [] : [parts.slice(0, at + 1).join("/")]
    })
    const globs = [...new Set(roots)].sort().map((r) => `${r}/**`)
    // Without an owner, a zone must not reach protected files (an unowned zone over them doesn't compile).
    const safe = owned ? globs : globs.filter((g) => !files.some((f) => globMatches(g, f) && protectedGlobs.some((p) => globMatches(p, f))))
    if (safe.length === 0) return []
    return [{ name: z.name, why: z.why, globs: safe, rules: packRules.filter((r) => z.rules.some((re) => re.test(r))).sort() }]
  })
}

/** An arch rule when the code has a domain (or core, model) folder with outer layers beside it: src/svc/{domain,infra,api}. */
export const inferArch = (files: ReadonlyArray<string>, protectedGlobs: ReadonlyArray<string>): InferredArch | undefined => {
  const dirs = codeDirs(files, protectedGlobs)
  for (const inner of ["domain", "core", "model"]) {
    const parents = [...new Set(dirs.flatMap((d) => {
      const parts = d.split("/")
      const at = parts.indexOf(inner)
      return at < 0 ? [] : [parts.slice(0, at).join("/")]
    }))]
    const outer = [...new Set(parents.flatMap((parent) => dirs.flatMap((d) => {
      const rest = parent === "" ? d : d.startsWith(`${parent}/`) ? d.slice(parent.length + 1) : undefined
      const sibling = rest?.split("/")[0]
      return sibling && OUTER.test(sibling) ? [sibling] : []
    })))].sort()
    if (outer.length > 0) return { inner, outer }
  }
  return undefined
}

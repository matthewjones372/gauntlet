import { globMatches } from "@gauntlet/dsl"
import type { PolicyIR } from "@gauntlet/ir"
import { Effect, FileSystem, Path } from "effect"
import type { DiffFacts } from "./diff-facts.ts"
import { Git } from "./git.ts"
import { testPathMatcher } from "./integrity.ts"
import { isDocumentation } from "./no-behaviour.ts"

// Spec 0009 §2: sensitive code outside every zone. The signs are the areas
// setup asks about (money; authentication, permissions and secrets; personal
// data; contracts other systems depend on; data stores and migrations), read
// from names and imports only, never guessed from what code does. On a check
// only the change's new files and new top-level symbols count; `gauntlet
// doctor` reads the project as it is. Always a suggestion: nothing here changes
// a decision, and the agent is told to ask the person, never to edit the policy.

export type SensitiveArea = "money" | "security" | "personal-data" | "contracts" | "data"

interface Signs {
  readonly area: SensitiveArea
  /** How the note says it, after "which". */
  readonly why: string
  /** Matched against names split into lowercase words: `RefundService` reads "refund service". */
  readonly names?: RegExp
  /** Matched against import lines. */
  readonly imports?: RegExp
  /** Matched against annotation lines. */
  readonly annotations?: RegExp
  /** Matched against the file's path. */
  readonly paths?: RegExp
}

const SIGNS: ReadonlyArray<Signs> = [
  {
    area: "money",
    why: "handles money",
    names: /\b(refunds?|ledgers?|payments?|payouts?|invoices?|invoicing|billing|wallets?|settlements?|money|currenc(y|ies)|checkout|chargebacks?|finance)\b/,
    imports: /\b(stripe|braintree|adyen|paypal|javax\.money|org\.javamoney|joda\.money|plaid)\b/i,
  },
  {
    area: "security",
    why: "handles authentication, permissions or secrets",
    names: /\b(auth|authn|authz|authenticat\w*|authori[sz]\w*|security|permissions?|jwt|oauth2?|passwords?|credentials?|secrets?|bcrypt|crypto|encrypt\w*|decrypt\w*|rbac|acl|sso|saml|api key)\b/,
    imports: /(jsonwebtoken|\bjwt\b|io\.jsonwebtoken|com\.auth0|nimbusds|\bbcrypt\b|BCrypt|org\.mindrot|springframework\.security|\bpassport\b|argon2|javax\.crypto|golang\.org\/x\/crypto|\bcryptography\b|\bpasslib\b|oauthlib|next-auth|keycloak)/,
  },
  {
    area: "personal-data",
    why: "handles personal data",
    names: /\b(pii|personal data|gdpr|ssn|social security( number)?|date of birth|national id|tax id|passport number|kyc)\b/,
  },
  {
    area: "contracts",
    why: "is a contract other systems depend on (an API, schema or event)",
    annotations: /^@(RestController|Controller|RequestMapping|(Get|Post|Put|Delete|Patch)Mapping|Path|WebServlet|GrpcService|KafkaListener)\b/,
    imports: /(org\.apache\.kafka|\bkafkajs\b|confluent_kafka|org\.apache\.avro|io\.grpc|google\.protobuf|\bfastapi\b|@nestjs\/common)/,
    paths: /\.(proto|avsc|graphqls?)$|(^|\/)(openapi|swagger|asyncapi)[^/]*\.(ya?ml|json)$/i,
  },
  {
    area: "data",
    why: "is a data store or migration",
    names: /\bmigrations?\b/,
    annotations: /^@(Entity|Table|MappedSuperclass|Document)\b/,
    imports: /(org\.flywaydb|\bliquibase\b|\balembic\b|\bknex\b|\btypeorm\b|\bsequelize\b|@prisma\/client|\bsqlalchemy\b|gorm\.io|jakarta\.persistence|javax\.persistence|exposed\.sql|\bmongoose\b)/,
    paths: /(^|\/)(migrations?|db\/migrate|flyway|liquibase|alembic)\/|(^|\/)V\d+(_\d+)*__\w+\.sql$/i,
  },
]

/** Files whose names and imports can be read: code and the schemas other systems read. */
const READABLE = /\.(kt|java|scala|groovy|go|py|ts|tsx|js|jsx|mjs|cjs|rs|clj|cljs|cljc|rb|cs|php|swift|sql|proto|avsc|graphqls?)$|(^|\/)(openapi|swagger|asyncapi)[^/]*\.(ya?ml|json)$/i
const GENERATED = /(^|\/)(node_modules|vendor|target|build|dist|out|generated|\.[^/]+)\//

/** `RefundService`, `refund_service` or `refund-service.ts` as "refund service". */
export const words = (name: string): string =>
  name.replace(/\.[A-Za-z0-9]+$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/).filter((w) => w !== "").join(" ").toLowerCase()

const IMPORT = /^\s*(import\b|from\s+\S+\s+import\b|using\s|use\s|require\b|.*\brequire\(|#include\b|\(ns\b|\(:require\b)/
const SYMBOL = /^(?:export\s+)?(?:default\s+)?(?:(?:public|private|internal|protected|abstract|sealed|data|final|open|static|async|inline|value|enum|pub(?:\([a-z]+\))?|case|annotation)\s+)*(?:class|interface|object|trait|enum|record|struct|type|fun|func|def|function|fn|module|impl)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/
const CLOJURE_SYMBOL = /^\((?:defn-?|def|defprotocol|defrecord|deftype|defmulti)\s+([\w\-?!*]+)/

/** A top-level declaration's name: one at the start of its line. */
export const topLevelSymbol = (line: string): string | undefined => (SYMBOL.exec(line) ?? CLOJURE_SYMBOL.exec(line))?.[1]

/** The import lines of a file, Go's `import ( … )` block included. */
const importLines = (lines: ReadonlyArray<string>): string[] => {
  const out: string[] = []
  let block = false
  for (const line of lines) {
    if (block) {
      if (/^\s*\)/.test(line)) block = false
      else out.push(line)
      continue
    }
    if (/^import\s*\($/.test(line.trim())) {
      block = true
      continue
    }
    if (IMPORT.test(line)) out.push(line)
  }
  return out
}

const byNames = (names: ReadonlyArray<string>) => SIGNS.find((s) => s.names && names.some((n) => s.names!.test(words(n))))

/** The first area a new file shows signs of: its path, its imports and annotations, then its names. */
const fileArea = (path: string, lines: ReadonlyArray<string>): Signs | undefined => {
  const imports = importLines(lines)
  const annotations = lines.map((l) => l.trim()).filter((l) => l.startsWith("@"))
  const names = [...path.split("/"), ...lines.flatMap((l) => topLevelSymbol(l) ?? [])]
  return SIGNS.find((s) => s.paths?.test(path)) ??
    SIGNS.find((s) => (s.imports && imports.some((l) => s.imports!.test(l))) || (s.annotations && annotations.some((l) => s.annotations!.test(l)))) ??
    byNames(names)
}

export interface SensitiveFinding {
  readonly path: string
  /** A new top-level symbol in a file that already existed. Absent for a new file. */
  readonly symbol?: string
  readonly area: SensitiveArea
  readonly why: string
}

/** Paths that are no one's sensitive code: in a zone, tests, protected, documentation, generated or unreadable. */
const candidate = (ir: PolicyIR) => {
  const isTest = testPathMatcher(ir)
  const protectedGlobs = ir.protect.flatMap((g) => g.globs)
  return (path: string) =>
    READABLE.test(path) && !GENERATED.test(path) && !isTest(path) && !isDocumentation(path)
    && !protectedGlobs.some((g) => globMatches(g, path))
    && !ir.zones.some((z) => z.globs.some((g) => globMatches(g, path)))
}

/** A change's new files and new top-level symbols that look sensitive and are outside every zone. */
export const sensitiveInChange = (ir: PolicyIR, facts: Pick<DiffFacts, "files" | "addedLines">): SensitiveFinding[] => {
  const outside = candidate(ir)
  const found: SensitiveFinding[] = []
  for (const f of facts.files) {
    if (!outside(f.path)) continue
    const added = (facts.addedLines.get(f.path) ?? []).map((l) => l.text)
    if (f.status === "added") {
      const signs = fileArea(f.path, added)
      if (signs) found.push({ path: f.path, area: signs.area, why: signs.why })
      continue
    }
    if (f.status !== "modified" && f.status !== "renamed") continue
    // Only declarations at the start of a line: a new class, not a new local variable.
    for (const symbol of new Set(added.flatMap((l) => topLevelSymbol(l) ?? []))) {
      const signs = byNames([symbol])
      if (signs) found.push({ path: f.path, symbol, area: signs.area, why: signs.why })
    }
  }
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : (a.symbol ?? "") < (b.symbol ?? "") ? -1 : 1))
}

/** Every file of the project as it is that looks sensitive and is outside every zone (for `gauntlet doctor`). */
export const sensitiveInProject = (ir: PolicyIR, files: ReadonlyArray<{ readonly path: string; readonly text: string }>): SensitiveFinding[] => {
  const outside = candidate(ir)
  return files.filter((f) => outside(f.path)).flatMap((f) => {
    const signs = fileArea(f.path, f.text.split(/\r?\n/))
    return signs ? [{ path: f.path, area: signs.area, why: signs.why }] : []
  }).sort((a, b) => (a.path < b.path ? -1 : 1))
}

/** The zones that already hold code of an area, going by their names and paths: where to suggest adding it. */
export const zonesFor = (ir: PolicyIR, area: SensitiveArea): string[] =>
  ir.zones.filter((z) => byNames([z.name, ...z.globs.flatMap((g) => g.split("/"))])?.area === area).map((z) => z.name)

const ask = (ir: PolicyIR, area: SensitiveArea): string => {
  const zones = zonesFor(ir, area)
  if (zones.length > 0) return `Add it to ${zones.map((z) => `\`${z}\``).join(" or ")}, or make a new zone?`
  return ir.zones.length > 0 ? "Add it to a zone, or make a new one?" : "Make a zone for it?"
}

/** Words every such note has, so the agent's summary can pass them on. */
export const OUTSIDE_EVERY_ZONE = "outside every zone"

/** What the report and the agent's summary say about one finding. */
export const describeFinding = (ir: PolicyIR, f: SensitiveFinding): string =>
  `This adds ${f.symbol !== undefined ? `\`${f.symbol}\` in \`${f.path}\`` : `\`${f.path}\``}, which ${f.why}, ${OUTSIDE_EVERY_ZONE}. ${ask(ir, f.area)}`

/** How many findings a check names one by one before counting the rest. */
const MAX_NOTES = 5

/** The notes for a change: one per finding, then a count of the rest. */
export const sensitiveNotes = (ir: PolicyIR, found: ReadonlyArray<SensitiveFinding>): string[] => [
  ...found.slice(0, MAX_NOTES).map((f) => describeFinding(ir, f)),
  ...(found.length > MAX_NOTES
    ? [`This adds ${found.length - MAX_NOTES} more file${found.length - MAX_NOTES === 1 ? "" : "s"} or symbol${found.length - MAX_NOTES === 1 ? "" : "s"} that look sensitive, ${OUTSIDE_EVERY_ZONE}: ${found.slice(MAX_NOTES).map((f) => `\`${f.symbol ?? f.path}\``).join(", ")}. Add them to a zone, or make a new one?`]
    : []),
]

/** Larger files are left out of doctor's reading: generated or data, not code someone wrote. */
const MAX_BYTES = 256 * 1024

/** Reads the project's files at `repo` and finds the sensitive ones outside every zone. */
export const scanProject = (repo: string, ir: PolicyIR) =>
  Effect.gen(function*() {
    const git = yield* Git
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const outside = candidate(ir)
    const files: { path: string; text: string }[] = []
    for (const p of (yield* git.listWorkingFiles(repo)).filter(outside)) {
      const text = yield* fs.readFileString(path.join(repo, p)).pipe(Effect.orElseSucceed(() => ""))
      if (text.length <= MAX_BYTES) files.push({ path: p, text })
    }
    return sensitiveInProject(ir, files)
  })

/** What doctor calls each area's files. */
const LABELS: Readonly<Record<SensitiveArea, string>> = {
  money: "money code",
  security: "authentication, permissions or secrets",
  "personal-data": "personal data",
  contracts: "contracts other systems depend on",
  data: "data stores or migrations",
}

/** Doctor's rows: one per area, naming its files, informational only. */
export const doctorRows = (ir: PolicyIR, found: ReadonlyArray<SensitiveFinding>): Array<{ readonly what: string; readonly ok: boolean; readonly optional: true; readonly detail: string }> =>
  SIGNS.flatMap((s) => {
    const paths = found.filter((f) => f.area === s.area).map((f) => f.path)
    if (paths.length === 0) return []
    const zones = zonesFor(ir, s.area)
    const where = zones.length > 0 ? `Add to ${zones.map((z) => `\`${z}\``).join(" or ")}, or make a new zone?` : ir.zones.length > 0 ? "Add to a zone, or make a new one?" : "Make a zone for them?"
    const named = paths.length <= 5 ? paths.join(", ") : `${paths.slice(0, 5).join(", ")} and ${paths.length - 5} more`
    return [{ what: `${OUTSIDE_EVERY_ZONE}: ${s.area}`, ok: false, optional: true as const, detail: `${paths.length} file${paths.length === 1 ? "" : "s"} that look${paths.length === 1 ? "s" : ""} like ${LABELS[s.area]}: ${named}. ${where}` }]
  })

import { describe, expect, test } from "bun:test"
import { irHash } from "@gauntlet/ir"
import {
  agentSummary, buildReport, decide, doctorRows, renderAgentSummary, renderMarkdown, sensitiveInChange, sensitiveInProject, topLevelSymbol, zoneNotes,
} from "../src/index.ts"
import type { DiffFacts } from "../src/diff-facts.ts"
import { cleanEvidence, compiled, noFacts } from "./fixtures.ts"

// Spec 0009 §2: a change that adds code that looks sensitive (by its names and
// imports) outside every zone is told so, as a suggestion that never changes
// the decision. Doctor lists the same for the project as it is.

const policy = (zones = `zone payments { paths "src/payments/**" owner @pay }\n`) => compiled(`gauntlet "x"
use jvm
mode enforce
owners @p
protect { tests "src/test/**" }
${zones}suites { unit "src/test/**" }
gates { verify { unit } }
review {
  owner when zone touched
  auto when all gates pass
}
`)

type Added = Record<string, string>
/** A change that adds these files and adds these lines to existing ones. */
const change = (added: Added, modified: Added = {}): Pick<DiffFacts, "files" | "addedLines"> & DiffFacts => {
  const lines = (text: string) => text.split("\n").map((t, i) => ({ line: i + 1, text: t }))
  return noFacts({
    files: [
      ...Object.entries(added).map(([path, text]) => ({ path, status: "added" as const, added: text.split("\n").length, removed: 0 })),
      ...Object.entries(modified).map(([path, text]) => ({ path, status: "modified" as const, added: text.split("\n").length, removed: 0 })),
    ],
    addedLines: new Map([...Object.entries(added), ...Object.entries(modified)].map(([p, t]) => [p, lines(t)])),
  })
}
const found = (facts: Pick<DiffFacts, "files" | "addedLines">, ir = policy().ir) => sensitiveInChange(ir, facts).map((f) => `${f.path}${f.symbol ? `#${f.symbol}` : ""}: ${f.area}`)

describe("signs in a change's new files", () => {
  test("names: a refund service outside every zone handles money", () => {
    expect(found(change({ "src/refunds/RefundService.kt": "package refunds\n\nclass RefundService {\n  fun refund() {}\n}\n" }))).toEqual(["src/refunds/RefundService.kt: money"])
  })

  test("imports and annotations, whatever the file is called", () => {
    expect(found(change({
      "src/web/Tokens.kt": "import io.jsonwebtoken.Jwts\n\nclass Tokens\n",
      "src/web/Hashing.java": "import org.mindrot.jbcrypt.BCrypt;\n\npublic class Hashing {}\n",
      "src/web/Orders.kt": "package web\n\n@RestController\nclass Orders\n",
      "src/data/Customer.kt": "import jakarta.persistence.Entity\n\n@Entity\nclass Customer\n",
      "svc/user.go": "package svc\n\nimport (\n\t\"fmt\"\n\t\"github.com/golang-jwt/jwt/v5\"\n)\n",
      "app/events.py": "from confluent_kafka import Producer\n",
    }))).toEqual([
      "app/events.py: contracts",
      "src/data/Customer.kt: data",
      "src/web/Hashing.java: security",
      "src/web/Orders.kt: contracts",
      "src/web/Tokens.kt: security",
      "svc/user.go: security",
    ])
  })

  test("paths: migrations, schemas and API descriptions", () => {
    expect(found(change({
      "db/migrations/V3__add_refunds.sql": "create table refunds (id int);\n",
      "api/orders.proto": "syntax = \"proto3\";\n",
      "docs-site/openapi.yaml": "openapi: 3.0.0\n",
    }))).toEqual(["api/orders.proto: contracts", "db/migrations/V3__add_refunds.sql: data", "docs-site/openapi.yaml: contracts"])
  })

  test("personal data by name", () => {
    expect(found(change({ "src/profile/PiiRedactor.ts": "export class PiiRedactor {}\n" }))).toEqual(["src/profile/PiiRedactor.ts: personal-data"])
  })

  test("inside a zone, tests, protected files, docs and plain code say nothing", () => {
    expect(found(change({
      "src/payments/RefundService.kt": "class RefundService\n",
      "src/test/RefundServiceTest.kt": "import io.jsonwebtoken.Jwts\nclass RefundServiceTest\n",
      "docs/auth.md": "# Auth\n",
      "src/orders/Orders.kt": "package orders\n\nclass Orders {\n  val author = \"x\"\n}\n",
      "build/generated/Payment.kt": "class Payment\n",
    }))).toEqual([])
  })

  test("words are read whole: an author isn't auth, a token in a lexer isn't a secret", () => {
    expect(found(change({ "src/blog/Author.kt": "class Author\n", "src/parse/TokenStream.kt": "class TokenStream\n" }))).toEqual([])
  })
})

describe("signs in a change's new top-level symbols", () => {
  test("a new class in an existing file outside every zone", () => {
    expect(found(change({}, { "src/orders/Orders.kt": "class RefundPolicy {\n  val ledger = 1\n}" }))).toEqual(["src/orders/Orders.kt#RefundPolicy: money"])
  })

  test("only declarations at the start of a line, not new local names or imports in an existing file", () => {
    expect(found(change({}, { "src/orders/Orders.kt": "import io.jsonwebtoken.Jwts\n  fun refund() {}\n  val payment = 1" }))).toEqual([])
  })

  test("the forms of a top-level declaration", () => {
    expect(["export class Ledger {", "data class Invoice(", "func (s *Server) Refund() {", "def charge_payment():", "pub fn settle() {", "(defn refund [x]", "  class Indented", "val x = 1"].map(topLevelSymbol))
      .toEqual(["Ledger", "Invoice", "Refund", "charge_payment", "settle", "refund", undefined, undefined])
  })
})

describe("the note, in the report and the agent's summary", () => {
  test("names the file, what it handles and the zone that fits", () => {
    const notes = zoneNotes({ ir: policy().ir, facts: change({ "src/orders/RefundService.kt": "class RefundService\n" }), used: [] })
    expect(notes).toEqual(["This adds `src/orders/RefundService.kt`, which handles money, outside every zone. Add it to `payments`, or make a new zone?"])
  })

  test("a symbol in an existing file, and no zone that fits", () => {
    const notes = zoneNotes({ ir: policy().ir, facts: change({}, { "src/orders/Orders.kt": "class JwtVerifier" }), used: [] })
    expect(notes).toEqual(["This adds `JwtVerifier` in `src/orders/Orders.kt`, which handles authentication, permissions or secrets, outside every zone. Add it to a zone, or make a new one?"])
  })

  test("with no zones at all", () => {
    const notes = zoneNotes({ ir: policy("").ir, facts: change({ "src/x/Ledger.kt": "class Ledger\n" }), used: [] })
    expect(notes).toEqual(["This adds `src/x/Ledger.kt`, which handles money, outside every zone. Make a zone for it?"])
  })

  test("a folder setup would have made a zone of keeps its note, and its files aren't named again", () => {
    const notes = zoneNotes({ ir: policy().ir, facts: change({ "billing/total.go": "package billing\n\nfunc Total() {}\n" }), used: [] })
    expect(notes).toEqual(["This change adds billing/**, which looks like payments, billing and money code but isn't in a zone. To protect it, run /gauntlet-setup in Claude Code (or add a zone to .gauntlet/policy.gx)."])
  })

  test("many findings: five named, the rest counted", () => {
    const files = Object.fromEntries(["A", "B", "C", "D", "E", "F", "G"].map((n) => [`src/x/${n}Ledger.kt`, `class ${n}Ledger\n`]))
    const notes = zoneNotes({ ir: policy().ir, facts: change(files), used: [] })
    expect(notes.length).toBe(6)
    expect(notes.at(-1)).toBe("This adds 2 more files or symbols that look sensitive, outside every zone: `src/x/FLedger.kt`, `src/x/GLedger.kt`. Add them to a zone, or make a new one?")
  })

  test("never changes the decision; the agent is told to ask the person, not to edit the policy", () => {
    const { ir, sourceMap } = policy()
    const sensitive = change({ "src/orders/RefundService.kt": "class RefundService\n" })
    const plain = change({ "src/orders/Orders.kt": "class Orders\n" })
    const evidence = cleanEvidence()
    const decision = decide({ ir, sourceMap, facts: sensitive, evidence, mode: "enforce" })
    expect(decision.tier).toBe(decide({ ir, sourceMap, facts: plain, evidence, mode: "enforce" }).tier)
    expect(decision.tier).toBe("auto")
    const notes = zoneNotes({ ir, facts: sensitive, used: [] })
    const report = buildReport({
      gauntletVersion: "0.1.0",
      policy: { ir, sourceMap, irHash: irHash(ir), origin: "base", firstAdoption: false, drift: [], notes },
      facts: sensitive, checks: [], ratchets: [], integrity: evidence.integrity, violations: [], advice: [], imports: [], decision,
    })
    expect(renderMarkdown(report)).toContain(`- ${notes[0]}`)
    const summary = renderAgentSummary(agentSummary(report, "/out"))
    expect(summary).toContain(`Tell the person (don't change the policy yourself):\n- ${notes[0]}`)
  })
})

describe("doctor, for the project as it is", () => {
  test("every file outside every zone, by area", () => {
    const ir = policy().ir
    const files = [
      { path: "src/payments/Pay.kt", text: "class Pay\n" },
      { path: "src/refunds/RefundService.kt", text: "class RefundService\n" },
      { path: "src/web/Tokens.kt", text: "import io.jsonwebtoken.Jwts\nclass Tokens\n" },
      { path: "src/orders/Orders.kt", text: "class Orders\n" },
      { path: "src/test/LedgerTest.kt", text: "class LedgerTest\n" },
    ]
    const found = sensitiveInProject(ir, files)
    expect(found.map((f) => `${f.path}: ${f.area}`)).toEqual(["src/refunds/RefundService.kt: money", "src/web/Tokens.kt: security"])
    expect(doctorRows(ir, found)).toEqual([
      { what: "outside every zone: money", ok: false, optional: true, detail: "1 file that looks like money code: src/refunds/RefundService.kt. Add to `payments`, or make a new zone?" },
      { what: "outside every zone: security", ok: false, optional: true, detail: "1 file that looks like authentication, permissions or secrets: src/web/Tokens.kt. Add to a zone, or make a new one?" },
    ])
  })

  test("nothing to list when every such file is in a zone", () => {
    expect(doctorRows(policy().ir, sensitiveInProject(policy().ir, [{ path: "src/payments/Ledger.kt", text: "class Ledger\n" }]))).toEqual([])
  })
})

// Embeds the example policies for the `get_examples` tool, so they ship in the
// compiled binary. Run `bun run generate` after editing examples/policies/valid.
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { examplesModule } from "../src/examples-module.ts"

const dir = join(import.meta.dir, "..", "..", "..", "examples", "policies", "valid")
const examples = readdirSync(dir).filter((f) => f.endsWith(".gx")).sort().map((f) => ({ name: f.replace(/\.gx$/, ""), text: readFileSync(join(dir, f), "utf8") }))
writeFileSync(join(import.meta.dir, "..", "src", "generated", "examples.ts"), examplesModule(examples))

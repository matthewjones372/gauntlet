// Embeds each template directory into src/generated/<name>.ts, so templates
// ship inside the compiled binary. Run `bun run generate` after editing one.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { embed } from "../src/embed.ts"

const root = join(import.meta.dir, "..")
for (const name of ["kotlin-service"]) {
  const dir = join(root, name)
  const walk = (d: string): string[] =>
    readdirSync(d).sort().flatMap((e) => (statSync(join(d, e)).isDirectory() ? walk(join(d, e)) : [join(d, e)]))
  const files = walk(dir).map((f) => ({ path: relative(dir, f), bytes: readFileSync(f), executable: (statSync(f).mode & 0o111) !== 0 }))
  writeFileSync(join(root, "src", "generated", `${name}.ts`), embed(files))
}

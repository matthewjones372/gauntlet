import type { TemplateFile } from "./embed.ts"
import { FILES as KOTLIN_SERVICE } from "./generated/kotlin-service.ts"

// Project templates for `gauntlet new`: a greenfield project with strict
// defaults (high mutation and coverage bars, arch rules, protected tests,
// enforce mode). Paths may contain `__package__`; text may contain {{name}},
// {{package}} and {{owner}}.

export type { TemplateFile } from "./embed.ts"

export interface Template {
  readonly name: string
  readonly description: string
  readonly files: ReadonlyArray<TemplateFile>
}

export const TEMPLATES: ReadonlyArray<Template> = [
  { name: "kotlin-service", description: "Kotlin on Gradle with a functional core, property tests, detekt, Kover and Pitest", files: KOTLIN_SERVICE },
]

export interface TemplateVars {
  readonly name: string
  readonly package: string
  readonly owner: string
}

/** Why the values can't be used, or undefined when they're fine. */
export const invalidVars = (v: TemplateVars): string | undefined =>
  !/^[a-z][a-z0-9-]*$/.test(v.name) ? `name '${v.name}' must be lowercase letters, digits and dashes, starting with a letter`
  : !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(v.package) ? `package '${v.package}' must be dot-separated lowercase identifiers, such as com.acme.payments`
  : !/^@[A-Za-z0-9-]+(\/[A-Za-z0-9._-]+)?$/.test(v.owner) ? `owner '${v.owner}' must be a GitHub user or team, such as @alice or @acme/payments`
  : undefined

/** The package for a project name: `payment-service` becomes `payment.service`. */
export const defaultPackage = (name: string) => name.replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "").replace(/(^|\.)(\d)/g, "$1p$2")

export interface RenderedFile {
  readonly path: string
  readonly content: Uint8Array
  readonly executable: boolean
}

// Stored without the dot, so the template's own ignore rules don't apply in this repository.
const DOTFILES: Readonly<Record<string, string>> = { gitignore: ".gitignore" }

export const render = (t: Template, v: TemplateVars): RenderedFile[] =>
  t.files.map((f) => {
    const path = (DOTFILES[f.path] ?? f.path).replaceAll("__package__", v.package.replaceAll(".", "/"))
    const content = f.text !== undefined
      ? new TextEncoder().encode(f.text.replaceAll("{{name}}", v.name).replaceAll("{{package}}", v.package).replaceAll("{{owner}}", v.owner))
      : Uint8Array.from(Buffer.from(f.base64 ?? "", "base64"))
    return { path, content, executable: f.executable === true }
  }).sort((a, b) => a.path.localeCompare(b.path))

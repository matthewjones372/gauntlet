// Dependencies from sbt build files, for the `dependency added` condition:
// every `"org" %% "name" % "version"` module and addSbtPlugin(...).

const MODULE = /"([\w.\-]+)"\s*%%?%?\s*"([\w.\-]+)"\s*%\s*"([^"]+)"/g

export const parseDependencies = (_path: string, text: string): string[] =>
  [...new Set([...text.replace(/\/\/.*$/gm, "").matchAll(MODULE)].map((m) => `${m[1]}:${m[2]}@${m[3]}`))].sort()

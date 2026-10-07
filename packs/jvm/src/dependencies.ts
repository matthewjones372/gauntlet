// Dependency coordinates from Gradle build files and version catalogs, for
// the `dependency added` condition. A change that only edits comments or
// formatting adds nothing.

const CONFIGURATIONS = "implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|testCompileOnly|kapt|ksp|annotationProcessor|classpath|detektPlugins"

export const parseDependencies = (path: string, text: string): string[] => {
  const code = text.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n")
  if (path.endsWith(".toml")) {
    const out = [
      ...[...code.matchAll(/=\s*"([\w.\-]+:[\w.\-]+:[\w.\-+]+)"/g)].map((m) => m[1]!),
      ...[...code.matchAll(/module\s*=\s*"([\w.\-]+:[\w.\-]+)"[^}\n]*?version(?:\.ref)?\s*=\s*"([^"]+)"/g)].map((m) => `${m[1]}:${m[2]}`),
      ...[...code.matchAll(/id\s*=\s*"([\w.\-]+)"[^}\n]*?version(?:\.ref)?\s*=\s*"([^"]+)"/g)].map((m) => `plugin:${m[1]}:${m[2]}`),
    ]
    return [...new Set(out)].sort()
  }
  const out = [
    ...[...code.matchAll(new RegExp(`\\b(?:${CONFIGURATIONS})\\s*\\(\\s*"([^"]+)"`, "g"))].map((m) => m[1]!),
    ...[...code.matchAll(/\bid\s*\(\s*"([^"]+)"\s*\)\s*version\s*"([^"]+)"/g)].map((m) => `plugin:${m[1]}:${m[2]}`),
    ...[...code.matchAll(/\bkotlin\s*\(\s*"([^"]+)"\s*\)\s*version\s*"([^"]+)"/g)].map((m) => `plugin:org.jetbrains.kotlin.${m[1]}:${m[2]}`),
    ...[...code.matchAll(new RegExp(`\\b(?:${CONFIGURATIONS})\\s*\\(\\s*(libs\\.[\\w.]+)`, "g"))].map((m) => m[1]!),
  ]
  return [...new Set(out)].sort()
}

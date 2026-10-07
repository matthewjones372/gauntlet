// Drives a built gauntlet binary through real commands: the embedded assets
// (grammars, init script, templates, examples), policy compilation, hooks and
// the MCP server. Usage: bun scripts/smoke.ts dist/gauntlet-<target>
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = join(import.meta.dir, "..")
// A step that depends on an earlier failed one fails on its own; git in a missing directory is skipped.
const git = (cwd: string, ...args: string[]) => {
  if (existsSync(cwd)) Bun.spawnSync(["git", "-c", "user.name=smoke", "-c", "user.email=smoke@gauntlet.invalid", "-c", "commit.gpgsign=false", ...args], { cwd })
}

/** Runs every smoke step against `binary`; returns the failures, each with the command's output. */
export const smoke = async (binary: string, log: (line: string) => void = console.log): Promise<string[]> => {
  const work = mkdtempSync(join(tmpdir(), "gauntlet-smoke-"))
  const failures: string[] = []
  const run = (name: string, args: string[], expect: { code?: number; out?: string; stdin?: string; cwd?: string } = {}) => {
    const r = Bun.spawnSync([binary, ...args], { cwd: existsSync(expect.cwd ?? work) ? expect.cwd ?? work : work, stdin: expect.stdin === undefined ? "ignore" : new TextEncoder().encode(expect.stdin) })
    const out = `${r.stdout.toString()}${r.stderr.toString()}`
    const ok = r.exitCode === (expect.code ?? 0) && (expect.out === undefined || out.includes(expect.out))
    log(`${ok ? "ok  " : "FAIL"}  ${name}`)
    if (!ok) failures.push(`${name}: exit ${r.exitCode}\n${out.slice(0, 2000)}`)
    return out
  }

  try {
    const version = /GAUNTLET_VERSION = "([^"]+)"/.exec(await Bun.file(join(root, "packages/cli/src/version.ts")).text())?.[1] ?? "?"
    run("--version", ["--version"], { out: version })
    run("doctor", ["doctor", "--repo", root])

    run("new kotlin-service", ["new", "kotlin-service", join(work, "payments-api"), "--owner", "@acme/payments"], { out: "mode enforce" })
    run("validate the generated policy", ["validate", "--repo", join(work, "payments-api")], { out: "is valid" })
    run("explain --coverage", ["explain", "--coverage", "--repo", join(work, "payments-api")], { out: "src/main/kotlin/payments/api/domain/Money.kt  zone core" })

    const py = join(work, "py-service")
    cpSync(join(root, "examples/fixtures/py-service"), py, { recursive: true, filter: (s) => !/\/(\.gauntlet|\.venv)(\/|$)/.test(s) })
    git(py, "init", "-q", "-b", "main")
    git(py, "add", "-A")
    git(py, "commit", "-qm", "project")
    run("init --template drafts a policy", ["init", "--repo", py, "--template", "--dry-run"], { out: "use python" })

    const app = join(work, "payments-api")
    git(app, "add", "-A")
    git(app, "commit", "-qm", "project")
    run("pre-tool-use denies a protected file", ["hook", "pre-tool-use"], { cwd: app, stdin: JSON.stringify({ cwd: app, tool_name: "Edit", tool_input: { file_path: join(app, "build.gradle.kts") } }), out: `"permissionDecision":"deny"` })
    run("pre-tool-use allows a new test", ["hook", "pre-tool-use"], { cwd: app, stdin: JSON.stringify({ cwd: app, tool_name: "Write", tool_input: { file_path: join(app, "src/test/kotlin/NewTest.kt") } }) })
    run("stop hook respects stop_hook_active", ["hook", "stop"], { cwd: app, stdin: JSON.stringify({ cwd: app, stop_hook_active: true }) })

    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "validate", arguments: {} } },
    ]
    const mcp = run("mcp over stdio", ["mcp", "--repo", app], { cwd: app, stdin: requests.map((r) => JSON.stringify(r)).join("\n") + "\n", out: "report_blocked" })
    if (!mcp.includes(`\\"valid\\":true`) && !mcp.includes(`"valid":true`)) failures.push(`mcp validate didn't report a valid policy:\n${mcp.slice(0, 2000)}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }

  return failures
}

if (import.meta.main) {
  const binary = resolve(process.argv[2] ?? "")
  const failures = await smoke(binary)
  if (failures.length > 0) {
    console.error(`\n${failures.join("\n\n")}`)
    process.exit(1)
  }
  console.log(`\n${binary} passed the smoke test.`)
}

import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { hookCli } from "./agent-harness.ts"
import { baseRepo, cli } from "./harness.ts"
import { fakeForge, type ForgeCall, ownerCli } from "./owner-harness.ts"

// `gauntlet grant <pr> <path>... --reason` (spec 0015): the owner lets the
// agent change protected paths for one pull request. Claude Code's hook then
// allows those edits on that pull request's branch, and the check judges the
// change as owner tier, naming the grant: reviewed, not hidden. A grant never
// covers approving, applies to one pull request, and lapses once it merges.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const REASON = "the timing test moves into a budget, which needs the build script"

/** An open pull request from `feature`, one commit on main. */
const openPr = () => {
  const s = baseRepo()
  repos.push(s.r)
  s.r.write({ "src/main/App.kt": "class App { val x = 1 }\n" })
  const head = s.r.commit("start the feature")
  const pr = { number: 7, state: "OPEN", title: "Budget the timing test", url: "https://github.com/o/r/pull/7", headRefOid: head, headRefName: "feature", baseRefOid: s.base, baseRefName: "main" }
  return { ...s, head, pr }
}

const grant = (r: TempRepo, pr: ReturnType<typeof openPr>["pr"], calls: ForgeCall[], args: string[], session?: { env: Record<string, string>; interactive: boolean }) =>
  ownerCli(["grant", "7", ...args, "--repo", r.dir], { forge: fakeForge(pr, "platform", calls), ...(session ? { session } : {}) })

const notes = (r: TempRepo, sha: string) => {
  try {
    return r.git("notes", "--ref", "gauntlet-grants", "show", sha)
  } catch {
    return ""
  }
}

const edit = async (r: TempRepo, file: string) => {
  const res = await hookCli(["hook", "pre-tool-use"], JSON.stringify({ cwd: r.dir, tool_name: "Edit", tool_input: { file_path: join(r.dir, file) } }))
  return res.out === "" ? "allowed" : JSON.parse(res.out).hookSpecificOutput.permissionDecision
}

describe("gauntlet grant", () => {
  test("records the grant on the pull request's head and pushes it", async () => {
    const { r, head, pr } = openPr()
    const calls: ForgeCall[] = []
    const res = await grant(r, pr, calls, ["scripts/build.sh", "--reason", REASON, "--head", head])
    expect(res.code).toBe(0)
    expect(JSON.parse(notes(r, head))).toEqual({ pr: 7, branch: "feature", headSha: head, paths: ["scripts/build.sh"], reason: REASON, approver: "@platform" })
    expect(calls.filter((c) => c.op !== "fetch")).toEqual([{ op: "push", refspec: "refs/notes/gauntlet-grants" }])
    expect(res.out).toContain("The agent may change scripts/build.sh in #7 (branch feature) until it merges or closes.")
  }, 60_000)

  test("refuses paths the agent may already change, or that aren't one protected file", async () => {
    const { r, head, pr } = openPr()
    const calls: ForgeCall[] = []
    const refused = async (path: string, why: string) => {
      const res = await grant(r, pr, calls, [path, "--reason", REASON, "--head", head])
      expect(res.code).toBe(2)
      expect(res.err).toContain(why)
    }
    await refused("src/main/App.kt", "src/main/App.kt isn't protected")
    await refused("src/test/AddTest.txt", "src/test/AddTest.txt is a test, which the agent may already change")
    await refused(".git/refs/notes/gauntlet-overrides", "a grant can't name .git/ (where approvals and overrides live)")
    await refused("scripts/../.git/config", "give each path from the repository's root, without '..'")
    await refused("scripts/*", "name each file: a grant doesn't take patterns")
    const short = await grant(r, pr, calls, ["scripts/build.sh", "--reason", "ok", "--head", head])
    expect(short.err).toContain("give a reason of at least 10 characters")
    expect(calls.filter((c) => c.op !== "fetch")).toEqual([])
    expect(notes(r, head)).toBe("")
  }, 60_000)

  test("refuses when the head moved since the owner looked", async () => {
    const { r, head, pr } = openPr()
    const calls: ForgeCall[] = []
    const res = await grant(r, { ...pr, headRefOid: "f".repeat(40) }, calls, ["scripts/build.sh", "--reason", REASON, "--head", head])
    expect(res.code).toBe(2)
    expect(res.err).toContain(`#7's head is now ffffffffffff, not ${head.slice(0, 12)}`)
  }, 60_000)
})

describe("an agent can't grant", () => {
  for (const marker of ["CLAUDECODE", "GAUNTLET_AGENT"]) {
    test(`with ${marker} set nothing is granted`, async () => {
      const { r, head, pr } = openPr()
      const calls: ForgeCall[] = []
      const res = await grant(r, pr, calls, ["scripts/build.sh", "--reason", REASON, "--head", head], { env: { [marker]: "1" }, interactive: true })
      expect(res.code).toBe(2)
      expect(res.err).toContain(`granting is the owner's decision, and ${marker} is set`)
      expect(calls).toEqual([])
      expect(notes(r, head)).toBe("")
      expect(await edit(r, "scripts/build.sh")).toBe("deny")
    }, 60_000)
  }

  test("and the hook refuses its commands that would grant", async () => {
    const { r } = openPr()
    for (const command of [`gauntlet grant 7 scripts/build.sh --reason '${REASON}'`, "git notes --ref gauntlet-grants add -m '{}' HEAD", "git push origin refs/notes/gauntlet-grants"]) {
      const res = await hookCli(["hook", "pre-tool-use"], JSON.stringify({ cwd: r.dir, tool_name: "Bash", tool_input: { command } }))
      expect(JSON.parse(res.out).hookSpecificOutput.permissionDecision).toBe("deny")
    }
  }, 60_000)
})

describe("with a grant", () => {
  test("the hook allows the granted edit on that pull request's branch, and nothing else", async () => {
    const { r, head, pr } = openPr()
    expect(await edit(r, "scripts/build.sh")).toBe("deny")
    await grant(r, pr, [], ["scripts/build.sh", "--reason", REASON, "--head", head])
    expect(await edit(r, "scripts/build.sh")).toBe("allowed")
    // Still on that branch after the agent commits more.
    r.write({ "src/main/App.kt": "class App { val x = 2 }\n" })
    r.commit("more work")
    expect(await edit(r, "scripts/build.sh")).toBe("allowed")
    // Only the paths it names, and never Gauntlet's own state.
    expect(await edit(r, "scripts/lint.sh")).toBe("deny")
    expect(await edit(r, ".gauntlet/policy.gx")).toBe("deny")
    // Not on another branch.
    r.git("checkout", "-q", "-b", "elsewhere", "main")
    expect(await edit(r, "scripts/build.sh")).toBe("deny")
  }, 60_000)

  test("it lapses once the pull request merges", async () => {
    const { r, head, pr } = openPr()
    await grant(r, pr, [], ["scripts/build.sh", "--reason", REASON, "--head", head])
    r.git("checkout", "-q", "main")
    r.git("merge", "-q", "--no-ff", "--no-edit", "feature")
    r.git("checkout", "-q", "feature")
    expect(await edit(r, "scripts/build.sh")).toBe("deny")
  }, 60_000)

  test("the check judges the granted change as owner tier, naming the grant", async () => {
    const { r, base, head, pr } = openPr()
    await grant(r, pr, [], ["scripts/build.sh", "--reason", REASON, "--head", head])
    r.write({ "scripts/build.sh": "echo building\nexit 0\n" })
    r.commit("the build script, as granted")
    await cli(["check", "--repo", r.dir, "--base", base, "--out", join(r.dir, "out"), "--no-record"])
    const report = JSON.parse(readFileSync(join(r.dir, "out", "gauntlet-report.json"), "utf8"))
    expect(report.decision.tier).toBe("owner")
    expect(report.decision.nominations.find((n: { rule: string }) => n.rule === "granted")).toMatchObject({
      tier: "owner",
      blocking: false,
      reason: `scripts/build.sh is protected (config); @platform granted the agent changing it in #7: ${REASON}`,
    })
  }, 60_000)

  test("without one, the same change is judged as before", async () => {
    const { r, base } = openPr()
    r.write({ "scripts/build.sh": "echo building\nexit 0\n" })
    r.commit("the build script")
    await cli(["check", "--repo", r.dir, "--base", base, "--out", join(r.dir, "out"), "--no-record"])
    const report = JSON.parse(readFileSync(join(r.dir, "out", "gauntlet-report.json"), "utf8"))
    expect(report.decision.tier).toBe("review")
    expect(report.decision.nominations.some((n: { rule: string }) => n.rule === "granted")).toBe(false)
  }, 60_000)
})

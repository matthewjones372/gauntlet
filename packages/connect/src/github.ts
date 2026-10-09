import type { PolicyIR } from "@gauntlet/ir"
import { CI_REPORTS_PREFIX } from "./ci-reports.ts"
import { codeowners } from "./codeowners.ts"
import type { GeneratedFile } from "./files.ts"
import { ACTIONS, CLOJURE_TOOLS, GO_TOOLS, pinned } from "./pins.ts"

// `gauntlet connect github` (ADR 0015): layered enforcement.
//   a. org: a workflow in a separate policy repo, required by a ruleset, pinned by SHA
//   b. repo: a pull_request_target workflow; PR code runs only in a job with no secrets
//   c. CODEOWNERS as a backstop
//   d. a PR check and comment with the tier and the report
// Merging stays with GitHub. Gauntlet reports, and never merges or approves.

export interface GithubOptions {
  readonly mode: "repo" | "org"
  readonly ir: PolicyIR
  /** Repository files, to set up the right toolchains. */
  readonly files: ReadonlyArray<string>
  readonly gauntletVersion: string
  /** Where the Linux x64 binary for that version is downloaded from. */
  readonly downloadUrl: string
  /** sha256 of that binary. Without it the workflow verifies against the release's checksums file. */
  readonly sha256?: string
  readonly javaVersion?: string
  /**
   * Build Gauntlet from the base commit's own source instead of downloading a
   * release: for the Gauntlet repository, which judges itself. Never from the
   * pull request's source, which would let a change rewrite its own judge.
   */
  readonly fromSource?: boolean
  /** Judge pull requests with `--protect-only` (spec 0001): the verification boundary, pass or fail. */
  readonly protectOnly?: boolean
  /**
   * The project's own CI setup (\`.gauntlet/ci.yml\`): steps the evidence job runs
   * before the checks, which then run each build's tools as its CI does (\`--ci\`).
   */
  readonly ciSetup?: ReadonlyArray<Readonly<Record<string, unknown>>>
  /**
   * The project's CI keeps its test and coverage reports (ADR 0024): the evidence
   * job waits for its run on the same commit and reads them instead of running
   * the tests again.
   */
  readonly reuseCi?: boolean
}

const BUILDING = "steps.needs.outputs.build != 'false'"

/** A generated step that runs only when the change needs building (a step's text, its first line \`- name:\`). */
const onlyWhenBuilding = (step: string) => {
  const [first, ...rest] = step.split("\n")
  return [first, `  if: \${{ ${BUILDING} }}`, ...rest].join("\n")
}

/** A project setup step that runs only when the change needs building, keeping its own condition. */
const withBuildCondition = (step: Readonly<Record<string, unknown>>) => {
  const own = typeof step.if === "string" ? step.if.replace(/^\$\{\{\s*|\s*\}\}$/g, "") : undefined
  return { ...step, if: own ? `\${{ (${own}) && ${BUILDING} }}` : `\${{ ${BUILDING} }}` }
}

const indent = (text: string, spaces: number) => text.split("\n").map((l) => (l === "" ? l : `${" ".repeat(spaces)}${l}`)).join("\n")

/** Toolchain setup steps for the packs the policy uses. */
export const toolchainSteps = (options: GithubOptions): string[] => {
  // With builds in folders (ADR 0022), each build's own files say which tools it needs.
  const o = options.ir.builds === undefined ? options : {
    ...options,
    files: [...new Set(options.ir.builds.flatMap((b) => b.dir === "." ? options.files : options.files.filter((f) => f.startsWith(`${b.dir}/`)).map((f) => f.slice(b.dir.length + 1))))],
  }
  const steps: string[] = []
  if (o.ir.packs.includes("jvm") || o.ir.packs.includes("scala") || o.ir.packs.includes("clojure")) {
    steps.push(`- name: Set up Java\n  uses: ${pinned(ACTIONS.setupJava)}\n  with:\n    distribution: temurin\n    java-version: "${o.javaVersion ?? "21"}"`)
  }
  if (o.ir.packs.includes("jvm")) steps.push(`- name: Set up Gradle\n  uses: ${pinned(ACTIONS.setupGradle)}\n  with:\n    cache-disabled: true`)
  // sbt itself; the launcher fetches the version project/build.properties names.
  if (o.ir.packs.includes("scala")) steps.push(`- name: Set up sbt\n  uses: ${pinned(ACTIONS.setupSbt)}`)
  if (o.ir.packs.includes("clojure")) {
    // The project's build tool, and clj-kondo when the policy gates lint.
    const lint = o.ir.gates.some((t) => t.checks.some((c) => c.kind === "gate" && c.name === "lint"))
    const tool = o.files.includes("deps.edn") ? `cli: "${CLOJURE_TOOLS.cli}"` : `lein: "${CLOJURE_TOOLS.lein}"`
    steps.push(`- name: Set up Clojure\n  uses: ${pinned(ACTIONS.setupClojure)}\n  with:\n    ${tool}${lint ? `\n    clj-kondo: "${CLOJURE_TOOLS.cljKondo}"` : ""}`)
  }
  if (o.ir.packs.includes("typescript")) {
    if (o.files.includes("bun.lock") || o.files.includes("bun.lockb")) steps.push(`- name: Set up Bun\n  uses: ${pinned(ACTIONS.setupBun)}`)
    else {
      steps.push(`- name: Set up Node\n  uses: ${pinned(ACTIONS.setupNode)}\n  with:\n    node-version: "24"`)
      if (o.files.includes("pnpm-lock.yaml") || o.files.includes("yarn.lock")) steps.push(`- name: Enable pnpm and yarn\n  run: corepack enable`)
    }
  }
  if (o.ir.packs.includes("python")) {
    if (o.files.includes("uv.lock")) steps.push(`- name: Set up uv\n  uses: ${pinned(ACTIONS.setupUv)}\n  with:\n    enable-cache: false`)
    else steps.push(`- name: Set up Python\n  uses: ${pinned(ACTIONS.setupPython)}\n  with:\n    python-version: "3.13"`)
    if (o.files.includes("poetry.lock")) steps.push(`- name: Install Poetry\n  run: pipx install poetry`)
  }
  if (o.ir.packs.includes("rust")) {
    steps.push(`- name: Set up Rust\n  uses: ${pinned(ACTIONS.rustToolchain)}\n  with:\n    components: clippy, llvm-tools-preview`)
    const gates = new Set(o.ir.gates.flatMap((t) => t.checks.flatMap((c) => (c.kind === "gate" ? [c.name] : c.kind === "suite" ? ["suite"] : []))))
    const tools = [...(gates.has("suite") ? ["cargo-nextest"] : []), ...(gates.has("coverage") ? ["cargo-llvm-cov"] : []), ...(gates.has("mutation") ? ["cargo-mutants"] : [])]
    if (tools.length > 0) steps.push(`- name: Install cargo tools\n  uses: ${pinned(ACTIONS.installAction)}\n  with:\n    tool: ${tools.join(",")}`)
  }
  if (o.ir.packs.includes("go")) {
    steps.push(`- name: Set up Go\n  uses: ${pinned(ACTIONS.setupGo)}\n  with:\n    go-version-file: go.mod\n    cache: false`)
    const gates = new Set(o.ir.gates.flatMap((t) => t.checks.flatMap((c) => (c.kind === "gate" ? [c.name] : []))))
    const tools = (["lint", "mutation"] as const).filter((g) => gates.has(g)).map((g) => GO_TOOLS[g])
    if (tools.length > 0) steps.push(`- name: Install Go tools\n  run: |\n${tools.map((t) => `    go install ${t}`).join("\n")}\n    echo "$(go env GOPATH)/bin" >> "$GITHUB_PATH"`)
  }
  return steps
}

const SOURCE_DIR = ".gauntlet-source"

const installStep = (o: GithubOptions, base: string, bunReady = false) => {
  if (o.fromSource) {
    return [
      `- name: Check out Gauntlet's source at the base commit\n  uses: ${pinned(ACTIONS.checkout)}\n  with:\n    ref: ${base}\n    path: ${SOURCE_DIR}\n    persist-credentials: false`,
      ...(bunReady ? [] : [`- name: Set up Bun\n  uses: ${pinned(ACTIONS.setupBun)}`]),
      `- name: Build Gauntlet from the base commit
  run: |
    cd ${SOURCE_DIR}
    bun install --frozen-lockfile
    bun build --compile packages/cli/src/main.ts --outfile "$RUNNER_TEMP/gauntlet"
    cd ..
    rm -rf ${SOURCE_DIR}`,
    ].join("\n")
  }
  const verify = o.sha256
    ? `echo "${o.sha256}  $RUNNER_TEMP/gauntlet" | sha256sum -c -`
    : `curl -fsSL "$(dirname "$GAUNTLET_URL")/checksums.txt" | grep " gauntlet-linux-x64$" | sed "s#gauntlet-linux-x64#$RUNNER_TEMP/gauntlet#" | sha256sum -c -`
  return `- name: Install Gauntlet ${o.gauntletVersion}
  run: |
    curl -fsSL "$GAUNTLET_URL" -o "$RUNNER_TEMP/gauntlet"
    ${verify}
    chmod +x "$RUNNER_TEMP/gauntlet"`
}

const header = (what: string) => `# Generated by \`gauntlet connect github\`. ${what}
# Every pull request is judged by the policy, baseline and protected files of
# its base commit (ADR 0003). The evidence job runs the pull request's code with
# a read-only token and no secrets. The status job never runs pull request code:
# it recomputes everything that needs no execution itself (policy, diff facts,
# protected changes, integrity findings), takes only test and tool outcomes from
# the evidence job, and posts the report and the required \`gauntlet\` check.`

const evidenceJob = (o: GithubOptions, refs: { readonly base: string; readonly head: string; readonly checkoutRef: string; readonly condition: string }) => `evidence:
  if: ${refs.condition}
  runs-on: ubuntu-latest
  timeout-minutes: 90
  permissions:
    contents: read${o.reuseCi ? "\n    actions: read" : ""}
  steps:
    - name: Check out the change, without credentials
      uses: ${pinned(ACTIONS.checkout)}
      with:
        ref: ${refs.checkoutRef}
        fetch-depth: 0
        persist-credentials: false
${indent(installStep(o, refs.base, false), 4)}${o.protectOnly ? "" : `
    # A change to comments or documentation only has nothing to build (ADR 0023): skip the tools and setup too.
    - name: Does the change need building?
      id: needs
      env:
        BASE: ${refs.base}
        HEAD: ${refs.head}
      run: echo "build=$("$RUNNER_TEMP/gauntlet" needs-build --policy-ref "$BASE" --head "$HEAD")" >> "$GITHUB_OUTPUT"`}
${indent(toolchainSteps(o).filter((t) => !(o.fromSource && t.includes("setup-bun"))).map(onlyWhenBuilding).join("\n"), 4)}${o.ciSetup && o.ciSetup.length > 0 ? `
    # The project's own CI setup, from .gauntlet/ci.yml, so its builds build here as in its CI.
${indent(o.ciSetup.map((s) => `- ${JSON.stringify(withBuildCondition(s))}`).join("\n"), 4)}` : ""}
${o.reuseCi && !o.protectOnly ? `    # What the project's own CI already ran isn't run again (ADR 0024): wait for its run on this commit and take its reports.
    - name: Take the project's CI reports for this commit
      id: ci
      if: \${{ ${BUILDING} }}
      env:
        GH_TOKEN: \${{ github.token }}
        HEAD: ${refs.head}
      run: |
        mkdir -p ci-reports
        for i in $(seq 1 120); do
          runs=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs?head_sha=$HEAD&per_page=50" --jq '[.workflow_runs[] | select(.name != "gauntlet")]')
          if [ "$(echo "$runs" | jq 'length')" -gt 0 ] && [ "$(echo "$runs" | jq '[.[] | select(.status != "completed")] | length')" = "0" ]; then break; fi
          sleep 30
        done
        for id in $(echo "$runs" | jq -r '.[].id'); do
          for name in $(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$id/artifacts" --jq '.artifacts[] | select(.name | startswith("${CI_REPORTS_PREFIX}")) | .name'); do
            gh run download "$id" --repo "$GITHUB_REPOSITORY" --name "$name" --dir "ci-reports/$name" || true
          done
        done
        echo "source=$(echo "$runs" | jq -r '.[0].html_url // ""')" >> "$GITHUB_OUTPUT"
` : ""}    - name: Check the change with the base commit's policy
      env:
        BASE: ${refs.base}
        HEAD: ${refs.head}${o.reuseCi && !o.protectOnly ? `
        CI_SOURCE: \${{ steps.ci.outputs.source }}` : ""}
      run: |
        ${o.reuseCi && !o.protectOnly ? `reports=""; if [ -n "$(ls -A ci-reports 2>/dev/null)" ]; then reports="--ci-reports ci-reports --ci-source $CI_SOURCE"; fi
        ` : ""}"$RUNNER_TEMP/gauntlet" check --policy-ref "$BASE" --head "$HEAD" --out gauntlet-out --no-record${o.protectOnly ? " --protect-only" : runsHoldouts(o) ? " --holdouts" : ""}${o.ciSetup !== undefined ? " --ci" : ""}${o.reuseCi && !o.protectOnly ? " $reports" : ""} || true
        # When the change edits .gauntlet/, prove the proposed policy still catches tampering.
        if ! git diff --quiet "$BASE" "$HEAD" -- .gauntlet; then
          "$RUNNER_TEMP/gauntlet" selftest --base "$HEAD" --json > gauntlet-out/selftest.json || true
        fi
    - name: Keep the evidence
      uses: ${pinned(ACTIONS.uploadArtifact)}
      with:
        name: gauntlet-evidence
        path: gauntlet-out
        retention-days: 30`

const statusJob = (o: GithubOptions, refs: { readonly base: string; readonly head: string; readonly pr: string; readonly record: string }) => `status:
  needs: [evidence]
  # Runs again when an owner comments \`/gauntlet approve <commit>\` or ticks the box in Gauntlet's report
  # (an author can't approve their own pull request).
  if: always() && (github.event_name != 'issue_comment' || (github.event.issue.pull_request && (startsWith(github.event.comment.body, '/gauntlet approve') || (github.event.action == 'edited' && startsWith(github.event.comment.body, '<!-- gauntlet-report -->') && contains(github.event.comment.body, '- [x] **Approve this change**')))))
  runs-on: ubuntu-latest
  timeout-minutes: 30
  permissions:
    contents: write
    pull-requests: write
    checks: write
    actions: read
  env:
    GH_TOKEN: \${{ github.token }}
    BASE: ${refs.base}
    HEAD: ${refs.head}
    PR: ${refs.pr}
  steps:
    # On a comment the event names no commits: this checks out and builds the default branch, which is trusted too.
    - name: Check out the base (trusted code only)
      uses: ${pinned(ACTIONS.checkout)}
      with:
        ref: ${refs.base}
        fetch-depth: 0
${indent(installStep(o, refs.base), 4)}
    - name: Find the pull request's commits (a comment event doesn't carry them)
      if: github.event_name == 'issue_comment'
      run: gh pr view "$PR" --repo "$GITHUB_REPOSITORY" --json baseRefOid,headRefOid --jq '"BASE=\\(.baseRefOid)\\nHEAD=\\(.headRefOid)"' >> "$GITHUB_ENV"
    - name: Fetch the change's commits and Gauntlet's notes (nothing is run)
      run: |
        git fetch --no-tags origin "+refs/pull/$PR/head:refs/remotes/pr/head"
        git fetch --no-tags origin "+refs/notes/gauntlet:refs/notes/gauntlet" "+refs/notes/gauntlet-overrides:refs/notes/gauntlet-overrides" || true
    - name: Find the evidence for this commit
      run: |
        if [ "\${{ github.event_name }}" != "pull_request_target" ]; then
          run_id=$(gh run list --repo "$GITHUB_REPOSITORY" --workflow "\${{ github.workflow }}" --commit "$HEAD" --event pull_request_target --status completed --limit 1 --json databaseId --jq '.[0].databaseId')
        else
          run_id="\${{ github.run_id }}"
        fi
        mkdir -p evidence
        gh run download "$run_id" --repo "$GITHUB_REPOSITORY" --name gauntlet-evidence --dir evidence || true
    - name: Fetch reviews and owner team members
      env:
        TEAMS_TOKEN: \${{ secrets.GAUNTLET_TEAMS_TOKEN }}
        TICKED_BY: \${{ github.event.sender.login }}
        TICKED_BODY: \${{ github.event.comment.body }}
      run: |
        gh api --paginate "repos/$GITHUB_REPOSITORY/pulls/$PR/reviews" --jq '.[] | {user: .user.login, state: .state, commitId: .commit_id}' | jq -s . > reviews.json
        gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$PR/comments" --jq '.[] | {user: .user.login, body: .body}' | jq -s . > comments.json
        # A ticked box in Gauntlet's report counts as from whoever ticked it; only an owner's counts.
        if [ "\${{ github.event_name }}" = "issue_comment" ] && [ "\${{ github.event.action }}" = "edited" ]; then
          jq --arg u "$TICKED_BY" --arg b "$TICKED_BODY" '. + [{user: $u, body: $b}]' comments.json > comments.next && mv comments.next comments.json
        fi
        echo '{}' > teams.json
        # Team owners can only be checked with a token that may read org teams.
        if [ -n "$TEAMS_TOKEN" ]; then
          for team in $("$RUNNER_TEMP/gauntlet" explain --ir --repo . | jq -r '[.ir.owners[], .ir.zones[].owners[]] | unique[] | select(contains("/"))'); do
            org="\${team#@}"; slug="\${org#*/}"; org="\${org%%/*}"
            members=$(GH_TOKEN="$TEAMS_TOKEN" gh api --paginate "orgs/$org/teams/$slug/members" --jq '.[].login' | jq -R . | jq -s .)
            jq --arg t "$team" --argjson m "$members" '. + {($t): $m}' teams.json > teams.next && mv teams.next teams.json
          done
        fi
    - name: Decide
      run: |
        "$RUNNER_TEMP/gauntlet" github-status --repo . --policy-ref "$BASE" --head "$HEAD" \\
          --evidence evidence/gauntlet-report.json --reviews reviews.json --teams teams.json --comments comments.json --out gauntlet-out ${refs.record}${o.protectOnly ? " --protect-only" : ""}
    - name: Post the report and the check
      run: |
        body=$(printf '<!-- gauntlet-report -->\\n%s' "$(cat gauntlet-out/gauntlet-report.md)")
        comment=$(gh api "repos/$GITHUB_REPOSITORY/issues/$PR/comments" --paginate --jq '.[] | select(.body | startswith("<!-- gauntlet-report -->")) | .id' | head -n 1)
        if [ -n "$comment" ]; then
          gh api -X PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$comment" -f body="$body" > /dev/null
        else
          gh api -X POST "repos/$GITHUB_REPOSITORY/issues/$PR/comments" -f body="$body" > /dev/null
        fi
        gh api -X POST "repos/$GITHUB_REPOSITORY/check-runs" \\
          -f name=gauntlet -f head_sha="$HEAD" -f status=completed \\
          -f conclusion="$(jq -r .conclusion gauntlet-out/status.json)" \\
          -f "output[title]=$(jq -r .title gauntlet-out/status.json)" \\
          -f "output[summary]=$(jq -r .summary gauntlet-out/status.json)" > /dev/null
    - name: Push Gauntlet's shadow history
      if: github.event_name == 'pull_request_target'
      run: git push origin refs/notes/gauntlet || true`

/** Org mode: no write token on fork pull requests, so the verdict is the job's own result. */
const verdictJob = (o: GithubOptions, refs: { readonly base: string; readonly head: string }) => `verdict:
  needs: [evidence]
  if: always()
  runs-on: ubuntu-latest
  timeout-minutes: 30
  permissions:
    contents: read
  env:
    BASE: ${refs.base}
    HEAD: ${refs.head}
  steps:
    - name: Check out the base (trusted code only)
      uses: ${pinned(ACTIONS.checkout)}
      with:
        ref: ${refs.base}
        fetch-depth: 0
${indent(installStep(o, refs.base), 4)}
    - name: Fetch the change's commits (nothing is run)
      run: git fetch --no-tags origin "$HEAD" || git fetch --no-tags origin "+refs/pull/\${{ github.event.pull_request.number }}/head:refs/remotes/pr/head"
    - name: Get the evidence
      uses: ${pinned(ACTIONS.downloadArtifact)}
      with:
        name: gauntlet-evidence
        path: evidence
    - name: Decide
      run: |
        echo '[]' > reviews.json
        echo '{}' > teams.json
        "$RUNNER_TEMP/gauntlet" github-status --repo . --policy-ref "$BASE" --head "$HEAD" \\
          --evidence evidence/gauntlet-report.json --reviews reviews.json --teams teams.json --out gauntlet-out${o.protectOnly ? " --protect-only" : ""}
        cat gauntlet-out/gauntlet-report.md >> "$GITHUB_STEP_SUMMARY"
        # Review and owner tiers are enforced by the ruleset's code owner review; only blocking fails here.
        test "$(jq -r .conclusion gauntlet-out/status.json)" != failure`

/** b + d: the single-repository workflow. */
export const repoWorkflow = (o: GithubOptions): string => `${header("Single-repository mode.")}

name: gauntlet

on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review]
  pull_request_review:
    types: [submitted, dismissed]
  issue_comment:
    types: [created, edited]

permissions: {}

concurrency:
  group: gauntlet-\${{ github.event.pull_request.number || github.event.issue.number }}-\${{ github.event_name }}
  cancel-in-progress: true

${o.fromSource ? "" : `env:\n  GAUNTLET_URL: "${o.downloadUrl}"\n\n`}jobs:
${indent(evidenceJob(o, {
  base: "${{ github.event.pull_request.base.sha }}",
  head: "${{ github.event.pull_request.head.sha }}",
  checkoutRef: "${{ github.event.pull_request.head.sha }}",
  condition: "github.event_name == 'pull_request_target'",
}), 2)}

${indent(statusJob(o, {
  base: "${{ github.event.pull_request.base.sha }}",
  head: "${{ github.event.pull_request.head.sha }}",
  pr: "${{ github.event.pull_request.number || github.event.issue.number }}",
  record: "--record",
}), 2)}
`

/** a: the workflow kept in a separate policy repository and required by an org ruleset. */
export const orgWorkflow = (o: GithubOptions): string => `${header("Organisation mode: this file lives in your policy repository and an org ruleset requires it, pinned by SHA.")}

name: gauntlet

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  merge_group:

permissions: {}

concurrency:
  group: gauntlet-\${{ github.repository }}-\${{ github.event.pull_request.number || github.event.merge_group.head_sha }}
  cancel-in-progress: true

${o.fromSource ? "" : `env:\n  GAUNTLET_URL: "${o.downloadUrl}"\n\n`}jobs:
${indent(evidenceJob(o, {
  base: "${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}",
  head: "${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha }}",
  checkoutRef: "${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha }}",
  condition: "always()",
}), 2)}

${indent(verdictJob(o, {
  base: "${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}",
  head: "${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha }}",
}), 2)}
`

const RULESET_SCRIPT = `#!/bin/sh
# Generated by \`gauntlet connect github --mode org\`. Creates the org ruleset
# that requires the Gauntlet workflow from your policy repository, pinned to
# its current commit. Run with a token that can administer org rulesets:
#   ./apply-ruleset.sh <org> <policy-repo>
set -eu
org="$1"
repo="$2"
repo_id=$(gh api "repos/$org/$repo" --jq .id)
sha=$(gh api "repos/$org/$repo/commits/HEAD" --jq .sha)
gh api -X POST "orgs/$org/rulesets" --input - <<JSON
{
  "name": "gauntlet",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] },
    "repository_name": { "include": ["~ALL"], "exclude": ["$repo"] }
  },
  "rules": [
    { "type": "workflows", "parameters": { "workflows": [ { "path": ".github/workflows/gauntlet.yml", "repository_id": $repo_id, "sha": "$sha" } ] } },
    { "type": "pull_request", "parameters": { "require_code_owner_review": true, "required_approving_review_count": 1, "dismiss_stale_reviews_on_push": true, "require_last_push_approval": true, "required_review_thread_resolution": false } }
  ]
}
JSON
echo "Ruleset created; the workflow is pinned to $sha. Re-run after changing the policy repository's workflow."
`

const readme = (o: GithubOptions) => `# Gauntlet on GitHub

Generated by \`gauntlet connect github --mode ${o.mode}\`.

${o.mode === "repo"
  ? `## What was set up

- \`.github/workflows/gauntlet.yml\`: on every pull request, an **evidence** job runs the change (no secrets, read-only token) and a **status** job (trusted, never runs pull request code) posts the report comment and the \`gauntlet\` check. Reviews re-run the status job, so an approval can satisfy a review or owner tier.
- \`.github/CODEOWNERS\`: \`.gauntlet/\`, protected paths and zones, so GitHub asks the right people.

## Make it required

In the repository's branch ruleset for the default branch, require the status check **gauntlet**, require pull requests with code owner review, dismiss stale approvals on push, and require approval of the most recent push.`
  : `## What was set up

- \`policy-repo/.github/workflows/gauntlet.yml\`: commit this to a dedicated policy repository that only policy owners can change.
- \`policy-repo/apply-ruleset.sh\`: creates an org ruleset that requires that workflow in every repository, pinned to the policy repository's current commit, and requires code owner review.
- \`.github/CODEOWNERS\` in this repository.

Org required workflows run on \`pull_request\` and \`merge_group\`, so merge queues are covered too.`}

## Risks, and how they are handled

- **Secrets and pull_request_target.** \`pull_request_target\` runs with access to secrets. The evidence job never references a secret, checks out without persisted credentials and has a read-only token. Only the status job has write permissions, and it never runs pull request code: it reads the change's files through git, and never executes them.
- **Forged evidence.** The evidence job runs the change's own code, which could tamper with its own test results. The status job therefore recomputes everything that needs no execution from the base policy and git: diff facts, protected and \`.gauntlet/\` changes, and every integrity finding (deleted, skipped or weakened tests, suppressions, test references in main code). Only test and tool outcomes come from the evidence job, and a check the base policy requires that the evidence doesn't report counts as not executed. Running suites under a separate user or container is planned.
- **Cache poisoning.** The workflows disable dependency and Gradle caches (\`cache-disabled\`, \`enable-cache: false\`), and Gauntlet ignores mutation caches in enforce mode.
- **Artifacts.** The status job reads only \`gauntlet-report.json\` from the evidence artifact, decodes it against Gauntlet's schema, and uses only gate outcomes from it.
- **Team owners.** Approval by a member of an \`@org/team\` owner can only be checked with a token that may read org teams. Add it as the \`GAUNTLET_TEAMS_TOKEN\` secret; without it, only individual owners' approvals count.
- **Overrides.** \`gauntlet override\` records a note; the status job honours it only if the named approver is an owner and has approved the exact head commit. Push notes with \`git push origin refs/notes/gauntlet-overrides\`.
`

/** The policy has holdouts with files, which only the evidence job runs (ADR 0019). */
const runsHoldouts = (o: GithubOptions) => o.ir.suites.some((s) => s.kind === "holdout" && (s.globs?.length ?? 0) > 0)

export const github = (o: GithubOptions): ReadonlyArray<GeneratedFile> => [
  ...(o.mode === "repo"
    ? [{ path: ".github/workflows/gauntlet.yml", content: repoWorkflow(o), mode: "replace" as const }]
    : [
      { path: "policy-repo/.github/workflows/gauntlet.yml", content: orgWorkflow(o), mode: "replace" as const },
      { path: "policy-repo/apply-ruleset.sh", content: RULESET_SCRIPT, mode: "replace" as const, executable: true },
    ]),
  codeowners(o.ir),
  { path: ".github/GAUNTLET.md", content: readme(o), mode: "replace" },
]

/** The repository ruleset `gauntlet connect github --require-check` creates: the default branch needs the `gauntlet` check. */
export const requireCheckRuleset = (o: { readonly adminBypass: boolean }) => ({
  name: "gauntlet",
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  // Repository role 5 is admin: with the bypass, admins can still push to the default branch directly.
  bypass_actors: o.adminBypass ? [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }] : [],
  rules: [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: "gauntlet" }] } }],
})

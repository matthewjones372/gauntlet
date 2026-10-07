# 0015. Layered enforcement on GitHub

Status: accepted (implemented in M10)

## Context
A workflow file in the PR's own repository can be edited by the PR. Enforcement has to come from somewhere the agent can't change, and that differs between organisations and single repositories.

## Decision
`gauntlet connect github` generates four layers:

a. **Org or enterprise:** a workflow in a separate policy repo, required through a ruleset, pinned by SHA, triggered on `pull_request` and `merge_group`.

b. **Single repo:** a `pull_request_target` workflow. A trusted job loads the policy, holdouts and baseline from the base SHA. The PR's code runs in a separate job with no secrets and read-only permissions, and hands back results as an artifact that the trusted job validates. The generated docs list the risks (secret exposure, cache poisoning, artifact trust) and how each is handled.

c. **CODEOWNERS** for `.gauntlet/`, protected paths and zone owners, as a backstop.

d. **A PR check** that posts the tier and the report, and suggests reviewers.

Merging stays with GitHub rulesets, required reviewers and merge queues. Gauntlet reports and suggests. It never merges or approves.

## Consequences
- Options a and b are both generated with clear guidance, and teams pick based on what they can administer.
- GitLab and Bitbucket can follow the same layered model later.

## Implementation (M10)
- **Two jobs.** The evidence job checks out the PR head with a read-only token, no secrets and `persist-credentials: false`, runs `gauntlet check --policy-ref <base>` and uploads `gauntlet-report.json`. It never fails the workflow; its report is only input.
- **Trusted recomputation.** The status job checks out the base and runs `gauntlet github-status`. It recomputes diff facts, protected changes, zones, integrity findings, dependency changes and the review decision from git, with the base policy. It takes only what needs execution from the evidence: gate and suite outcomes, violations and ratchet values. A forged report can claim a gate passed, but it can't hide a protected change, an integrity finding or a zone, and a check missing from it counts as not executed. Forging a gate pass is the residual risk in single-repo mode; option a, CODEOWNERS and the review tiers cover it, and `.github/GAUNTLET.md` says so.
- **The check.** Blocking fails unless an override is honoured: the override names this head and policy hash, and its approver is a policy or tier owner who approved this exact commit. Shadow mode is neutral. Auto and skim succeed. Review needs any approval of the head commit; owner needs one from a decision owner or policy owner (teams resolved by the workflow). A later review by the same user supersedes an earlier approval, and a new push needs a new one.
- **Org mode** runs on `pull_request` and `merge_group`, where fork PRs get a read-only token, so a verdict job fails the workflow instead of posting a check run; the ruleset's code-owner review rule covers the review and owner tiers.
- **Pins.** Every action is pinned to a commit SHA with the tag in a comment; the binary is checked against a pinned sha256 or the release's checksums file.
- **Agents.** `gauntlet connect claude-code` adds a Stop hook (blocks while the change would be blocked, respects `stop_hook_active`, never traps the agent when Gauntlet can't run), a PreToolUse hook (denies edits to existing protected files and the policy; new test files are allowed), matching `permissions.deny` rules, the MCP server and agent instructions, and a managed-settings example with `allowManagedHooksOnly`. Existing files are merged, never clobbered; an unreadable settings file is refused.

# FAQ

Back to the [README](../README.md).

**Does Gauntlet replace my tests?**
No. Your tests, linters and other checks still decide whether the code is
correct. Gauntlet makes sure they ran, unweakened, and that their results are
genuine.

**How is this different from mutation testing or coverage ratchets?**
Those measure how strong your tests are, and Gauntlet uses them as checks. The
difference is that Gauntlet also protects them: their configuration comes from
the base branch, their results are read only from runs Gauntlet started, and
their numbers can't drop below the baseline.

**What's the smallest thing I can try?**
`gauntlet check --protect-only`, or [the GitHub-only path](getting-started.md#github-only-in-five-minutes). It
checks only that the tests and their configuration weren't weakened and that
the results are genuine, with no zones, review levels, mutation or baseline.

**What happens in shadow mode?**
Every check runs and every change gets a result, but nothing is blocked. Each
result is recorded, and `gauntlet report shadow` summarises what would have
been blocked, so you can tune the policy before switching to `mode enforce`.

**Do I need an AI model or an API key?**
No. Decisions are deterministic and need no model. `/gauntlet-setup` runs in
your own Claude Code session; only the optional authoring agent
(`gauntlet author`) uses a separate model key.

**Which coding agents does it work with?**
Claude Code today. Codex, Cursor, Copilot and Gemini adapters are planned.
Without an agent, Gauntlet still works as a CLI and as a GitHub check.

**Can the agent just turn Gauntlet off?**
Locally, the hooks and deny rules live in `.claude/settings.json`; teams can
copy the generated managed-settings example so agents can't disable them. On
GitHub the check uses the base branch's policy and workflow, so a pull request
can't weaken the rules it's judged by.

**Is it slow?**
A check runs your real build and tests, so it takes about as long as they do,
plus mutation testing where you gate it. A repeated check of an unchanged
working tree reuses the last result.

## Other things worth knowing

- **Check a branch yourself:** `gauntlet check` (add `--working-tree` for
  uncommitted changes).
- **When your code changes:** if a change adds something that looks sensitive
  but isn't in a zone (say, a new `billing/` folder), the report says so. Run
  `/gauntlet-setup` again any time to review the policy.
- **Missing tools:** `gauntlet doctor` lists what your project needs.
- **Windows:** use [WSL 2](https://learn.microsoft.com/windows/wsl/install).
  Run `wsl --install` in PowerShell once, then follow [Getting started](getting-started.md) in the
  **Ubuntu** app, with your project inside Ubuntu (not under `/mnt/c/`).
- **Installing by hand:** download `gauntlet-darwin-arm64`,
  `gauntlet-darwin-x64` or `gauntlet-linux-x64` from the
  [releases page](https://github.com/matthewjones372/gauntlet/releases), check
  it against `checksums.txt`, make it executable and put it on your `PATH` as
  `gauntlet`.

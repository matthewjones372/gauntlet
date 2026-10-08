# Getting started

Back to the [README](../README.md).

## With Claude Code

1. **Install** (see [Installing by hand](faq.md#other-things-worth-knowing) if you'd rather not pipe to `sh`):

   ```bash
   curl -fsSL https://raw.githubusercontent.com/matthewjones372/gauntlet/main/install.sh | sh
   ```

2. **Set up your project.** In its folder, on your main branch:

   ```bash
   gauntlet setup
   ```

   If a check's tool is missing (mypy, Ruff or mutmut in a uv or Poetry
   project, for example), it says "I'll install these for you", shows the
   command and asks first. Pass `--yes` to skip the question.

3. **Agree the rules with Claude.** Open Claude Code in the same folder and type
   `/gauntlet-setup`. It describes what your project already has, recommends a
   policy and asks you about each decision. When you're done, run the command
   it gives you:

   ```bash
   gauntlet apply
   ```

Claude Code now runs Gauntlet before it says a task is done, and its deny rules
stop it editing protected files or the policy. Nothing is blocked until you say
so: this path starts in shadow mode, which only reports. Add
`gauntlet connect github` to check pull requests too.

## GitHub only, in five minutes

This uses `--protect-only` ([spec 0001](specs/0001-protect-only.md)): the
verification boundary and nothing else. The policy, protected tests and test
configuration come from the base commit and are restored before anything runs;
the gates run in fresh evidence directories; and only output from processes
Gauntlet started counts. There are no zones, review levels, mutation testing or
ratchets, and no baseline to record. The check passes or fails, even if the
policy says `mode shadow`.

1. **Install**, as in the section above.

2. **Draft a policy and the workflow:**

   ```bash
   gauntlet init
   gauntlet connect github --protect-only
   ```

   `init` writes `.gauntlet/policy.gx` for your language: which tests to
   protect and which checks to run. `connect github` writes a two-job workflow:
   one job runs the pull request's code with a read-only token and no secrets;
   the other never runs pull request code and posts the `gauntlet` check.

3. **Commit and push** `.gauntlet` and `.github`, then in your repository's
   settings, add the `gauntlet` check to the default branch's ruleset as a
   required status check.

4. **Try to cheat.** Open a pull request that replaces an assertion in a test
   with `assertTrue(true)` (in Go, delete the `t.Errorf`; in Python, `assert
   True`). The check fails. Its summary starts with two lines that can't merge
   into one green badge:

   ```text
   Integrity: 1 forbidden change (weakened assertions).
   Gates: 2 passed, 1 failed (unit).
   ```

   The original test ran, because protected tests are restored from the base,
   so the bug the edit was hiding is still reported.

## Who this is for

- Teams letting AI coding agents (Claude Code today) change code that matters,
  who want to merge agent changes without re-reading every line.
- Anyone who has seen an agent "fix" a failing test by changing the test.
- Maintainers who want a review rule they can state, such as "payments code
  always needs its owner", enforced the same way for agents and people.

You probably don't need it for throwaway prototypes, or if every change already
gets a careful human review.

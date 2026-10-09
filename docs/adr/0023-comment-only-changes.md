# 0023. A change to comments or documentation only runs no checks

Status: accepted

## Context
A pull request that only tidied a comment ran the whole pipeline: the project's build, every test suite, coverage and mutation, and in GitHub the project's own setup. On tweet-street that meant Nix, three sibling checkouts and local publishing, all to judge a comment. ADR 0012 says a check that can't prove it ran never passes, but here there is nothing for a check to find: the code is the same.

## Decision
- A change needs no checks when every changed file is documentation (Markdown, reStructuredText, AsciiDoc, LICENSE and the like) or a modified source file whose code, with comments removed and whitespace collapsed, is the same at the base and the head.
- It's deliberately narrow. These count as code: added, deleted or renamed files; plain text (it can be a fixture or data); languages Gauntlet doesn't know; and any changed comment that tools act on (suppressions, `@ts-` and lint directives, `go:` build tags, formatter and coverage switches).
- `check` then records each check as passed with the reason "the change only edits comments or documentation, so there's nothing for this check to run". Integrity checks, protected paths, zones and review rules apply as ever. `--protect-only` always runs.
- `gauntlet needs-build` prints `false` for such a change. The GitHub workflow asks it first and skips the toolchain and the project's own setup (`.gauntlet/ci.yml`). Anything unclear means `true`.

## Consequences
- A comment change is judged in seconds and reaches auto when the review rules allow it.
- A comment-only change can still be wrong (a misleading comment); that's review's job, as it always was.

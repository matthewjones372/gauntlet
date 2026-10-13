The agent deletes its attempt record (`.git/gauntlet/attempts/<branch>.json`),
hoping for a fresh count. The witness ref still names it, so the record counts
as missing: already at both limits. The next blocked stop is exhausted, which
is a failure, never more attempts.

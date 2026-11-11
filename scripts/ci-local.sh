#!/usr/bin/env bash
# Run what CI runs (.github/workflows/ci.yml, job "quality") on a clean copy of a commit, on Linux.
#
#   npm ci  ->  npm run plugins:setup  ->  npm run typecheck  ->  npm test  ->  npm run lint
#
# Why: the project is developed on Windows and CI runs Ubuntu 24.04 with Node 26. Tests that behave differently on Linux
# (a 12-hour clock, file modes, shell scripts, path separators) only fail in CI, and every failed push mails the owner.
# Run this before pushing instead (fork addition, 2026-11-03). On Windows, `npm run ci:local` runs it inside WSL
# (docs/development.md says how to set that up); on Linux and macOS it runs directly.
#
# Usage: scripts/ci-local.sh [repo-root]
#   LH_CI_REF=<commit>   what to test (default HEAD: exactly what a push would send; commit first)
#   LH_CI_DIR=<dir>      where the clean copy and its node_modules live (default ~/.cache/lh-ci)
#   LH_CI_WORKTREE=1     test the working tree instead, uncommitted changes included
#                        (on Windows its line endings are CRLF, so a result can differ from CI's)
#
# Every step runs even if an earlier one fails, so one run shows everything that is wrong. Exit 0 only when all pass.
set -uo pipefail

REPO="$(cd "${1:-$(dirname "$0")/..}" && pwd)"
REF="${LH_CI_REF:-HEAD}"
WORK="${LH_CI_DIR:-$HOME/.cache/lh-ci}"
SRC="$WORK/src"
EXPORT="$WORK/export"
LOGS="$WORK/logs"

# what the CI runner has, as far as the tests can tell
export CI=true
export NEXT_TELEMETRY_DISABLED=1
export TZ=UTC
export LANG=C.UTF-8
export LC_ALL=C.UTF-8

mkdir -p "$SRC" "$LOGS"
rm -rf "$EXPORT" && mkdir -p "$EXPORT"

echo "== CI, locally: $(git -c safe.directory='*' -C "$REPO" rev-parse --short "$REF" 2>/dev/null || echo "$REF") on $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -s), node $(node -v), npm $(npm -v)"

# the commit exactly as a fresh checkout has it (git archive: repository line endings, no untracked files)
if [ "${LH_CI_WORKTREE:-}" = "1" ]; then
	(cd "$REPO" && git -c safe.directory='*' ls-files -z -co --exclude-standard | tar --null -T - -cf -) | tar -x -C "$EXPORT"
else
	git -c safe.directory='*' -C "$REPO" archive "$REF" | tar -x -C "$EXPORT"
fi

# keep node_modules and .next between runs; everything else is replaced by the commit
rsync -a --delete --exclude node_modules --exclude .next "$EXPORT/" "$SRC/"
rm -rf "$EXPORT"

cd "$SRC"
failed=()
step() { # step <name> <command...>
	local name="$1"
	shift
	local log="$LOGS/${name// /-}.log"
	local t0=$SECONDS
	printf '\n== %s ... ' "$name"
	if "$@" >"$log" 2>&1; then
		printf 'ok (%ss)\n' "$((SECONDS - t0))"
		return 0
	fi
	printf 'FAILED (%ss), log: %s\n' "$((SECONDS - t0))" "$log"
	failed+=("$name")
	return 1
}

# npm ci only when the lockfile changed since the last run
lock_sum="$(sha256sum package-lock.json | cut -d' ' -f1)"
if [ ! -d node_modules ] || [ "$(cat "$WORK/lock.sha" 2>/dev/null)" != "$lock_sum" ]; then
	if step "npm ci" npm ci --no-audit --no-fund; then echo "$lock_sum" >"$WORK/lock.sha"; else rm -f "$WORK/lock.sha"; fi
else
	echo "== npm ci ... skipped (package-lock.json unchanged since the last run)"
fi

# the source plugins' own dependencies and SDKs (upstream v0.6.0: CI runs this before typecheck), again only when a plugin lockfile changed
plugin_sum="$(cat plugins/*/package-lock.json | sha256sum | cut -d' ' -f1)"
if [ ! -d plugins/ui-showcase/node_modules ] || [ "$(cat "$WORK/plugins.sha" 2>/dev/null)" != "$plugin_sum" ]; then
	if step "plugins:setup" npm run plugins:setup; then echo "$plugin_sum" >"$WORK/plugins.sha"; else rm -f "$WORK/plugins.sha"; fi
else
	echo "== plugins:setup ... skipped (plugin lockfiles unchanged since the last run)"
fi

step "typecheck" npm run typecheck
step "tests" npm test
step "lint" npm run lint

# the tests are what fails: say which
if [[ " ${failed[*]:-} " == *" tests "* ]]; then
	echo
	grep -E '^ℹ (tests|pass|fail|skipped) ' "$LOGS/tests.log" | sed 's/^ℹ /   /'
	echo "   failing tests:"
	grep -E '^ +✖ ' "$LOGS/tests.log" | sed -E 's/ \([0-9.]+ms\)$//' | sort -u | sed 's/^ */     - /' | head -30
fi
if [[ " ${failed[*]:-} " == *" typecheck "* ]]; then
	echo
	grep -E 'error TS' "$LOGS/typecheck.log" | head -15
fi
if [[ " ${failed[*]:-} " == *" lint "* ]]; then
	echo
	grep -vE '^npm |^>|^$' "$LOGS/lint.log" | head -20
fi

echo
if [ "${#failed[@]}" -eq 0 ]; then
	echo "== all green: CI should pass for this commit"
	exit 0
fi
echo "== NOT green: ${failed[*]}. Logs are in $LOGS"
exit 1

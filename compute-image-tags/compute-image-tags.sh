#!/usr/bin/env bash
# Computes the tags argocd-config-updater expects a Docker build to publish.
#
# Inputs (environment): EVENT_NAME, REF_NAME, DEFAULT_BRANCH, PR_NUMBER,
# COMMIT (optional), RUN_NUMBER, RUN_ATTEMPT. Runs inside a checkout of the
# commit being built. Outputs are appended to $GITHUB_OUTPUT, or printed when
# it is unset.
#
# The mutable tag is the default branch's name for a push to it and `pr-N` for
# a pull request; other events (merge queues, release branches) do not publish.
# The immutable tag is
# `<mutable>---<first-parent depth>-<commit year.month>.b<run number>.<attempt>-g<sha>`:
# the zero-padded depth makes tags of one mutable stream sort in commit order,
# the month lets a retention policy age tags out without reading each one's
# image, the run number and attempt make every job execution write its own tag
# (so a tag is never overwritten, even by a re-run), and the `-g<sha>` suffix
# is what maps a tag back to its commit. Nothing between the depth and the
# `-g<sha>` suffix contains a `-`, which some consumers rely on.
set -euo pipefail

if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
  echo "::error::The checkout is shallow, so the commit depth would be wrong; check out with fetch-depth: 0." >&2
  exit 1
fi

mutable=""
case "${EVENT_NAME:-}" in
  push)
    if [ -n "${DEFAULT_BRANCH:-}" ] && [ "${REF_NAME:-}" = "$DEFAULT_BRANCH" ]; then
      mutable="$DEFAULT_BRANCH"
    fi
    ;;
  pull_request | pull_request_target)
    if [ -z "${PR_NUMBER:-}" ]; then
      echo "::error::PR_NUMBER is required for a ${EVENT_NAME} event." >&2
      exit 1
    fi
    mutable="pr-${PR_NUMBER}"
    ;;
esac

immutable=""
if [ -n "$mutable" ]; then
  depth="$(git rev-list --first-parent --count HEAD)"
  commit="${COMMIT:-$(git rev-parse HEAD)}"
  month="$(TZ=UTC git show -s --format=%cd --date=format-local:%Y.%m "$commit")"
  immutable="$(printf '%s---%07d-%s.b%07d.%02d-g%s' "$mutable" "$depth" "$month" \
    "${RUN_NUMBER:?RUN_NUMBER is required}" "${RUN_ATTEMPT:?RUN_ATTEMPT is required}" "$commit")"
fi
tree="$(git rev-parse 'HEAD^{tree}')"

{
  echo "mutable=${mutable}"
  echo "immutable=${immutable}"
  echo "publish=$([ -n "$mutable" ] && echo true || echo false)"
  echo "tree=${tree}"
} | tee -a "${GITHUB_OUTPUT:-/dev/null}"

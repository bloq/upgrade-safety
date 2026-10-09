#!/bin/sh
# Tags a release whose commit carries the built dist, so consumers install from git without building it:
#   "@bloq/upgrade-safety": "github:bloq/upgrade-safety#v0.1.1"
# The release commit sits on top of HEAD on no branch, so main keeps source only. Pushing the tag is left to you.
set -eu

tag="v$(node -p "require('./package.json').version")"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Commit or stash your changes first" >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "$tag already exists: bump the version first" >&2
  exit 1
fi
git fetch -q origin main
if ! git merge-base --is-ancestor HEAD origin/main; then
  echo "HEAD is not on origin/main: release only what is merged" >&2
  exit 1
fi

pnpm build
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export GIT_INDEX_FILE="$tmp/index"
git read-tree HEAD
git add -f dist
# commit-tree ignores commit.gpgSign, so sign the release commit and tag explicitly where commits are signed.
sign=""
[ "$(git config --bool commit.gpgSign)" = "true" ] && sign=1
commit=$(git commit-tree "$(git write-tree)" -p HEAD ${sign:+-S} -m "chore: release $tag")
unset GIT_INDEX_FILE
git tag -a ${sign:+-s} "$tag" "$commit" -m "$tag"
echo "Tagged $tag ($(git rev-parse --short "$commit")). Push it with: git push origin $tag"

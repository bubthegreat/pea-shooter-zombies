#!/usr/bin/env bash
# Next patch version after the highest vX.Y.Z tag (0.1.0 when there are no tags).
set -euo pipefail
latest=$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n1 || true)
if [ -z "$latest" ]; then echo "0.1.0"; exit 0; fi
IFS=. read -r major minor patch <<<"${latest#v}"
echo "${major}.${minor}.$((patch + 1))"

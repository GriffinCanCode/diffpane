#!/bin/sh
set -eu

version='@VERSION@'
app="$HOME/Applications/Diffpane.app"

case "${1:-}" in
  --help|-h)
    printf '%s\n' 'diffpane [DIRECTORY|FILE]' 'View full files and live Git changes. Defaults to the current directory.'
    exit 0 ;;
  --version)
    printf 'diffpane %s\n' "$version"
    exit 0 ;;
esac
target="${1:-$PWD}"
if [ "$#" -gt 1 ] || [ "$target" != "${target#-}" ]; then
  printf '%s\n' 'usage: diffpane [DIRECTORY|FILE]' >&2
  exit 1
fi
case "$target" in /*) ;; *) target="$PWD/$target" ;; esac
folder="$target"
if [ -f "$target" ]; then folder=$(dirname "$target"); fi
git -C "$folder" rev-parse --show-toplevel >/dev/null
exec /usr/bin/open -n "$app" --args "$target"

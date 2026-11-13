#!/bin/sh
set -eu

version='@VERSION@'
app="$HOME/Applications/Diffpane.app"
command_name=${0##*/}

case "${1:-}" in
  --help|-h)
    printf '%s\n' "$command_name [DIRECTORY|FILE]" 'View full files and live Git changes.' \
      'Opens the current Git project by default, or the welcome screen outside a Git project.'
    exit 0 ;;
  --version)
    printf '%s %s\n' "$command_name" "$version"
    exit 0 ;;
esac
target="${1:-$PWD}"
if [ "$#" -gt 1 ] || [ "$target" != "${target#-}" ]; then
  printf 'usage: %s [DIRECTORY|FILE]\n' "$command_name" >&2
  exit 1
fi
case "$target" in /*) ;; *) target="$PWD/$target" ;; esac
folder="$target"
if [ -f "$target" ]; then folder=$(dirname "$target"); fi
if [ "$#" -gt 0 ]; then
  git -C "$folder" rev-parse --show-toplevel >/dev/null
elif ! git -C "$folder" rev-parse --show-toplevel >/dev/null 2>&1; then
  exec /usr/bin/open -n "$app"
fi
exec /usr/bin/open -n "$app" --args "$target"

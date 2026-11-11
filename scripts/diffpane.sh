#!/bin/sh
set -eu

mode='@MODE@'
version='@VERSION@'
app="$HOME/Applications/Diffpane.app"
if [ "$mode" = box ]; then
  # Box links commands into PATH from each version's install directory.
  launcher=$(/usr/bin/readlink -f "$0")
  payload="$(/usr/bin/dirname "$launcher")/../share/diffpane"
  app="$payload/Diffpane.app"
  archive="$app.zip"
fi

prepare_app() {
  if [ "$mode" != box ] || [ -x "$app/Contents/MacOS/Diffpane" ]; then return; fi
  staging=$(/usr/bin/mktemp -d "$payload/.install.XXXXXXXX")
  trap '/bin/rm -rf "$staging"' EXIT
  trap 'exit 1' HUP INT TERM
  /usr/bin/ditto -x -k "$archive" "$staging"
  /usr/bin/codesign --verify --deep --strict -R 'anchor apple generic' "$staging/Diffpane.app"
  /bin/mv -n "$staging/Diffpane.app" "$payload/"
  test -x "$app/Contents/MacOS/Diffpane"
  /bin/rm -rf "$staging"
  trap - EXIT HUP INT TERM
}

case "${1:-}" in
  --help|-h)
    printf '%s\n' 'diffpane [DIRECTORY|FILE]' 'View full files and live Git changes. Defaults to the current directory.'
    exit 0 ;;
  --version)
    printf 'diffpane %s\n' "$version"
    exit 0 ;;
  --check)
    # Box gives installation checks 15 seconds. Inspect the archive directory
    # here and extract and verify the signed bundle on the first launch.
    if [ "$mode" = box ]; then
      /usr/bin/unzip -Z -1 "$archive" \
        'Diffpane.app/Contents/MacOS/Diffpane' \
        'Diffpane.app/Contents/Resources/app.asar.unpacked/resources/howmany/howmany'
      exit 0
    fi ;;
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
prepare_app
exec /usr/bin/open -n "$app" --args "$target"

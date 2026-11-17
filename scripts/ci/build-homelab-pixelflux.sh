#!/usr/bin/env bash
set -euo pipefail

# Build the wheel used by the Fedora x86_64 package, using Pixelflux's own
# manylinux recipe to build and bundle its pinned codec libraries.
if [[ $# != 1 ]]; then
    echo "Usage: $0 OUTPUT_DIRECTORY" >&2
    exit 2
fi
output_dir=$(realpath -m -- "$1")
repo_root=$(git rev-parse --show-toplevel)
patch="$repo_root/infra/packaging/patches/pixelflux-2.2.3-live-eis-region.patch"
upstream="https://github.com/selkies-project/pixelflux.git"
revision="5c78910e524539a2b801433303ee61dd04f42a51"

build_dir=$(mktemp -d)
trap 'rm -rf -- "$build_dir"' EXIT
git init --quiet "$build_dir/source"
git -C "$build_dir/source" fetch --quiet --depth=1 "$upstream" "$revision"
git -C "$build_dir/source" checkout --quiet --detach FETCH_HEAD
test "$(git -C "$build_dir/source" rev-parse HEAD)" = "$revision"

cd "$build_dir/source"
git apply --check "$patch"
git apply "$patch"

# Use the Rust toolchain from the previously tested Fedora build. Make a
# targeted change to the pinned upstream wheel recipe so codec setup and
# manylinux library exclusions are kept intact.
python3 - <<'PY'
from pathlib import Path

config = Path("pyproject.toml")
text = config.read_text()
old = "/tmp/rustup-init -y --profile minimal &&"
if text.count(old) != 1:
    raise SystemExit("The pinned Pixelflux wheel recipe changed")
config.write_text(text.replace(old, "/tmp/rustup-init -y --profile minimal --default-toolchain 1.99.1 &&"))
PY

PIXELFLUX_ENABLE_GPL=1 CIBW_BUILD=cp314-manylinux_x86_64 \
    python3 -m cibuildwheel --output-dir "$build_dir/wheelhouse"
shopt -s nullglob
wheels=("$build_dir"/wheelhouse/pixelflux-2.2.3-cp314-cp314-manylinux*_x86_64.whl)
if (( ${#wheels[@]} != 1 )); then
    echo "Expected exactly one Pixelflux 2.2.3 CPython 3.14 manylinux x86_64 wheel" >&2
    exit 1
fi
mkdir -p -- "$output_dir"
install -m644 -- "${wheels[0]}" "$output_dir/"
sha256sum "$output_dir/${wheels[0]##*/}"

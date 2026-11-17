#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
set -euo pipefail

if [[ $# != 2 ]]; then
    printf 'Usage: %s PATCHED_WHEEL_DIRECTORY OUTPUT_DIRECTORY\n' "$0" >&2
    exit 2
fi
[[ $(uname -m) == x86_64 ]]
repo=$(cd -- "$(dirname -- "$0")/../.." && pwd -P)
engine=${CONTAINER_ENGINE:-docker}
image=registry.fedoraproject.org/fedora@sha256:98b558564d3510363f0f706a44b1ee9de461b030373d741c5729ae3f24d8cb26
version=2.2.1
iteration=2.fc.homelab
name="selkies-$version-$iteration.x86_64.rpm"
mkdir -p -- "$2"
destination=$(cd -- "$2" && pwd -P)
test ! -e "$destination/$name"
test ! -e "$destination/SHA256SUMS"

# Preserve the exact released Python and browser payload on this maintenance
# branch. Rebuilding that payload requires retesting the browser adaptations.
if [[ $(git -C "$repo" rev-parse 'HEAD:src' 'HEAD:addons' 'HEAD:pyproject.toml' 'HEAD:scripts/ci/build-web.sh') != $'5aeede54b9937871ee3f3d41db2c0f204480410d\n3a91e1fde0b3b684bc96b96d8d47091237dbc9b3\na98468846f04d785c7fa7c44a677b70f297711eb\n29b1973a89f4e5eb72e95bbcaa87fe37400831ba' ]] ||
   [[ -n $(git -C "$repo" status --porcelain --untracked-files=all -- src addons pyproject.toml scripts/ci/build-web.sh) ]]; then
    printf 'The packaged Selkies Python or browser sources differ from 2.2.1.\n' >&2
    exit 1
fi

shopt -s nullglob
pixelflux_wheels=("$1"/pixelflux-2.2.3-cp314-cp314-manylinux*x86_64.whl)
if [[ ${#pixelflux_wheels[@]} != 1 ]]; then
    printf 'Expected one patched Pixelflux 2.2.3 CPython 3.14 x86_64 wheel.\n' >&2
    exit 1
fi

stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
mkdir -- "$stage/wheels" "$stage/rpm"
cp -- "${pixelflux_wheels[0]}" "$stage/wheels/"

download_wheel() {
    local url=$1 sha256=$2
    local filename=${url##*/}
    curl --fail --location --retry 3 --max-time 120 --proto '=https' \
        "$url" --output "$stage/wheels/$filename"
    (cd -- "$stage/wheels" && printf '%s  %s\n' "$sha256" "$filename" | sha256sum --check)
}
download_wheel \
    https://files.pythonhosted.org/packages/40/33/ece2923d078b414bed7c1e74e15ba83be34f77ecfc5092d58103bda3f210/selkies-2.2.1-py3-none-any.whl \
    18503b5c1491a04194f0a45fa10c547ffe5b4a24f33496ce5d56e97370a6a3cd
download_wheel \
    https://files.pythonhosted.org/packages/10/76/6bbd59ed0dd92696d29f3fadddff4c3517731b0ca414ed5e4b9041a746b9/pcmflux-2.2.1-cp314-cp314-manylinux_2_28_x86_64.whl \
    cc703adcefcf0fc6e8daecb5c4e2bac9f2cfb4de16b9deafef8ea13201daf09b

module_sha256=$(python3 - "${pixelflux_wheels[0]}" <<'PY'
import hashlib
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as wheel:
    (module,) = (
        name
        for name in wheel.namelist()
        if name.startswith("pixelflux.cpython-314-") and name.endswith(".so")
    )
    print(hashlib.sha256(wheel.read(module)).hexdigest())
PY
)
official_pixelflux=971aa5daa249f7f431c3f189bbd1205ddf013678957c84e466111dcd06c9fe65
if printf '%s  %s\n' "$official_pixelflux" "${pixelflux_wheels[0]}" | sha256sum --check --status; then
    printf 'The stock Pixelflux wheel cannot be used for this release.\n' >&2
    exit 1
fi

"$engine" run --rm --platform linux/amd64 \
    --volume "$repo:/repo:ro,z" --volume "$stage/wheels:/dist:ro,z" --volume "$stage/rpm:/out:z" \
    --env "SELKIES_VERSION=$version" --env 'DISTRO_TAG=fc' --env "SELKIES_RPM_ITERATION=$iteration" \
    "$image" /bin/sh /repo/infra/packaging/rpm.sh

artifact="$stage/rpm/selkies-$version-fc-x86_64.rpm"
test -f "$artifact"
mv -- "$artifact" "$stage/rpm/$name"

# shellcheck disable=SC2016
"$engine" run --rm --platform linux/amd64 \
    --volume "$repo/scripts/ci/verify-package.sh:/verify.sh:ro,z" --volume "$stage/rpm:/out:ro,z" \
    --env 'INSTALL=dnf install -y -q /out/*.rpm' --env "EXPECTED_MODULE_SHA256=$module_sha256" \
    --env "EXPECTED_RELEASE=$version-$iteration" \
    "$image" /bin/sh -eu -c '
        /bin/sh /verify.sh
        test "$(rpm -q --qf "%{VERSION}-%{RELEASE}" selkies)" = "$EXPECTED_RELEASE"
        /opt/selkies/bin/python3 -c "
import hashlib
from importlib.metadata import version
import os
from pathlib import Path
import pixelflux

assert version(\"selkies\") == \"2.2.1\"
assert version(\"pixelflux\") == \"2.2.3\"
assert version(\"pcmflux\") == \"2.2.1\"
assert hashlib.sha256(Path(pixelflux.__file__).read_bytes()).hexdigest() == os.environ[\"EXPECTED_MODULE_SHA256\"]
"
    '

install -m 0644 -- "$stage/rpm/$name" "$destination/$name"
(cd -- "$destination" && sha256sum -- "$name" > SHA256SUMS)

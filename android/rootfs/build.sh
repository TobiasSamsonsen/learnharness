#!/usr/bin/env bash
# Builds the Linux guest the Android app unpacks on first run (docs/android/m12-plan.md, step 1):
# Ubuntu base + Node + libatomic1/zstd/ca-certificates, as one tarball. The claude CLI is NOT in it: the app installs the
# pinned version from npm on the phone (owner decision, 2026-10-28), so nothing proprietary is redistributed.
#
#   sudo android/rootfs/build.sh <output-dir>
#
# Run natively on an arm64 Linux host (the ubuntu-24.04-arm runner), as root: it chroots to install packages.
# Writes <output-dir>/learnharness-rootfs-linux-arm64.tar.gz, its .sha256 and rootfs-version.txt.
set -euo pipefail

out="${1:?usage: build.sh <output-dir>}"

# The pins. Changing any of them changes the version string below, which is what makes installed apps update.
UBUNTU_VERSION="24.04.3"
NODE_VERSION="26.12.1"
REVISION="r2"                 # bump when this script changes what ends up in the tarball

asset="learnharness-rootfs-linux-arm64.tar.gz"
work="$(mktemp -d)"
root="$work/rootfs"
trap 'umount "$root/proc" "$root/dev" 2>/dev/null || true; rm -rf "$work"' EXIT
mkdir -p "$out" "$root"

echo "== Ubuntu base $UBUNTU_VERSION"
ubuntu_dir="https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release"
ubuntu_file="ubuntu-base-${UBUNTU_VERSION}-base-arm64.tar.gz"
curl -fsSL -o "$work/$ubuntu_file" "$ubuntu_dir/$ubuntu_file"
curl -fsSL -o "$work/SHA256SUMS" "$ubuntu_dir/SHA256SUMS"
(cd "$work" && grep " \*\?$ubuntu_file\$" SHA256SUMS | sha256sum -c -)
tar -xzf "$work/$ubuntu_file" -C "$root"

echo "== Node $NODE_VERSION"
node_file="node-v${NODE_VERSION}-linux-arm64.tar.xz"
curl -fsSL -o "$work/$node_file" "https://nodejs.org/dist/v${NODE_VERSION}/$node_file"
curl -fsSL -o "$work/SHASUMS256.txt" "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
(cd "$work" && grep " $node_file\$" SHASUMS256.txt | sha256sum -c -)
mkdir -p "$root/opt/node"
tar -xJf "$work/$node_file" -C "$root/opt/node" --strip-components=1

echo "== packages"
cp /etc/resolv.conf "$root/etc/resolv.conf"
mount --bind /dev "$root/dev"
mount -t proc proc "$root/proc"
in_root() { chroot "$root" /usr/bin/env -i HOME=/root PATH=/opt/node/bin:/usr/sbin:/usr/bin:/sbin:/bin DEBIAN_FRONTEND=noninteractive "$@"; }
in_root apt-get update
# libatomic1: Node needs it. zstd: the app unpacks the server bundle (.tar.zst) inside the guest. ca-certificates: TLS for tools that use the system store.
in_root apt-get install -y --no-install-recommends libatomic1 zstd ca-certificates
in_root npm --version
in_root node --version

echo "== clean up"
in_root apt-get clean
umount "$root/proc" "$root/dev"
# the guest has no resolv.conf of its own on Android; the app writes the phone's resolvers at every start
rm -f "$root/etc/resolv.conf"
printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > "$root/etc/resolv.conf"
rm -rf "$root/var/lib/apt/lists/"* "$root/tmp/"* "$root/root/.npm" "$root/root/.cache" "$root/var/cache/apt/"*
# the learner's home is bound over /root at run time; the rootfs only needs the empty mount point
find "$root/root" -mindepth 1 -delete
# the other mount points the app binds in (Guest.kt): the server bundle and the download staging area
mkdir -p "$root/opt/lh/server" "$root/staging"

echo "== pack"
# --hard-dereference: no hard links in the archive. The empty dev/proc/sys mount points stay, their contents do not.
tar -czf "$out/$asset" --hard-dereference --numeric-owner \
	--exclude='./proc/*' --exclude='./dev/*' --exclude='./sys/*' -C "$root" .
(cd "$out" && sha256sum "$asset" > "$asset.sha256")
echo "${UBUNTU_VERSION}+node${NODE_VERSION}+${REVISION}" > "$out/rootfs-version.txt"
ls -l "$out"
cat "$out/rootfs-version.txt"

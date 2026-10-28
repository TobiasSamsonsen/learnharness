#!/usr/bin/env python3
"""Fetch proot for the Android shell (docs/android/m12-plan.md, step 1).

The APK ships proot and its loader as lib*.so files, because Android only lets an app execute files from its
native library directory. They come from the official Termux packages (the same proot the Termux setup ran), each
checked against a pinned sha256, and are written to src/main/jniLibs/arm64-v8a/, which is git-ignored: nothing from
here is committed. proot is GPL-2.0 and libtalloc GPL-3.0, so a release also needs the source offer (m12-plan step 8).

  python android/app/scripts/fetch-proot.py

Only the Python standard library is used.
"""
import hashlib
import io
import os
import sys
import tarfile
import urllib.request

REPO = "https://packages.termux.dev/apt/termux-main/"
# name -> (path in the Termux repo, sha256 of the .deb as listed in the repo's Packages index)
DEBS = {
	"proot": ("pool/main/p/proot/proot_5.1.107.101_aarch64.deb", "a28355e9be257e1f87f4e9294b3118470d4fd7a5442fed8b278f4443c83407d7"),
	"libtalloc": ("pool/main/libt/libtalloc/libtalloc_2.5.0_aarch64.deb", "556591f43bb773ad8777e1a29522640866a55f95dab71914418b94a8c58ad5a7"),
	"libandroid-shmem": ("pool/main/liba/libandroid-shmem/libandroid-shmem_0.7_aarch64.deb", "0da3a24d558b93c92bcf8d611e0826a99ff96e396b148e6cdf33b47c47c57ff6"),
}
PREFIX = "data/data/com.termux/files/usr/"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "main", "jniLibs", "arm64-v8a")


def deb_files(deb: bytes) -> dict:
	"""The files of a .deb's data.tar.* (an ar archive), by path with the leading './' removed."""
	if deb[:8] != b"!<arch>\n":
		raise SystemExit("not a .deb")
	i = 8
	while i < len(deb):
		name = deb[i:i + 16].decode().strip()
		size = int(deb[i + 48:i + 58])
		data = deb[i + 60:i + 60 + size]
		i += 60 + size + (size & 1)
		if name.startswith("data.tar"):
			tar = tarfile.open(fileobj=io.BytesIO(data))
			return {m.name[2:] if m.name.startswith("./") else m.name: tar.extractfile(m).read() for m in tar.getmembers() if m.isfile()}
	raise SystemExit("no data.tar in the .deb")


def fetch(name: str) -> dict:
	path, sha = DEBS[name]
	with urllib.request.urlopen(REPO + path, timeout=60) as r:
		deb = r.read()
	got = hashlib.sha256(deb).hexdigest()
	if got != sha:
		raise SystemExit(f"{name}: sha256 {got} does not match the pinned {sha}")
	return deb_files(deb)


def main() -> None:
	os.makedirs(OUT, exist_ok=True)
	proot = fetch("proot")
	talloc = fetch("libtalloc")
	shmem = fetch("libandroid-shmem")

	binary = proot[PREFIX + "bin/proot"]
	# proot is linked against libtalloc.so.2; an APK can only ship lib*.so, so the NEEDED entry is renamed in place
	# to the (shorter) libtalloc.so, which is the file shipped below. Android's linker matches by file name.
	old, new = b"libtalloc.so.2\x00", b"libtalloc.so\x00\x00\x00"
	if binary.count(old) != 1:
		raise SystemExit("unexpected proot binary: libtalloc.so.2 is not referenced exactly once")
	files = {
		"libproot.so": binary.replace(old, new),
		"libproot-loader.so": proot[PREFIX + "libexec/proot/loader"],
		"libtalloc.so": talloc[PREFIX + "lib/libtalloc.so.2.5.0"],
		"libandroid-shmem.so": shmem[PREFIX + "lib/libandroid-shmem.so"],
	}
	for name, data in files.items():
		with open(os.path.join(OUT, name), "wb") as f:
			f.write(data)
		print(f"{name}: {len(data)} bytes")


if __name__ == "__main__":
	sys.exit(main())

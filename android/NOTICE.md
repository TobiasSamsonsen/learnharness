# Third-party software in the Android app

DRAFT for the owner to review before any release (docs/android/m12-plan.md, step 8). It lists what the app ships or
downloads, where the source is, and which pieces carry source-offer obligations. Licenses are stated as the packagers
publish them; confirm each against the linked source before publishing a build.

## Shipped inside the APK (`src/main/jniLibs`, fetched by `android/app/scripts/fetch-proot.py`)

| Component | Version | Source | License (per the Termux package) |
|---|---|---|---|
| proot | 5.1.107.101 (Termux build) | https://github.com/termux/proot , package `proot_5.1.107.101_aarch64.deb` at https://packages.termux.dev/apt/termux-main/ | GPL-2.0 |
| proot loader | same package | same | GPL-2.0 |
| libtalloc | 2.5.0 | https://www.samba.org/ftp/talloc/ , package `libtalloc_2.5.0_aarch64.deb` | see the package's copyright file (Termux lists GPL-3.0; upstream talloc states LGPL-3.0-or-later) |
| libandroid-shmem | 0.7 | https://github.com/termux/libandroid-shmem , package `libandroid-shmem_0.7_aarch64.deb` | see the package's copyright file |

The only change made to these binaries is renaming proot's dependency entry `libtalloc.so.2` to `libtalloc.so` in place
(a seven-byte edit, `android/app/scripts/fetch-proot.py`), because an APK can only carry `lib*.so` file names.
Everything is checked against the sha256 of the official Termux package before use.

**Source offer.** proot is GPL-2.0: anyone who receives the APK is entitled to the complete corresponding source of the
binaries above. The links above are the upstream source and the packaged build; the owner decides how the written offer
is worded and where it is shown (an in-app "Open-source notices" page is the usual place).

## Downloaded on first run (not part of the APK)

| Component | Where it comes from |
|---|---|
| Ubuntu base 24.04.3 (arm64) | https://cdimage.ubuntu.com/ubuntu-base/ , verified against the published `SHA256SUMS`; its packages carry their own licenses (`/usr/share/doc/*/copyright` inside the guest) |
| Node.js 26.12.1 | https://nodejs.org/dist/ , verified against `SHASUMS256.txt`; MIT and bundled components, see `LICENSE` in the tarball |
| libatomic1, zstd, ca-certificates | Ubuntu archive, installed by `android/rootfs/build.sh` |
| `@anthropic-ai/claude-code` (version pinned in the app, `Release.CLAUDE_VERSION`) | installed on the phone with `npm install` from the npm registry; Anthropic's terms apply, not an open-source license. It is not part of any release asset of this repository |
| learnharness server bundle | built by `.github/workflows/android-server.yml` from this repository (AGPL-3.0-only, see `LICENSE`) |

# Verifying a release

Every release on the [Releases page](https://github.com/bv4ts/luady/releases)
carries three files, and a signed statement from GitHub that they were built by
this repository's release workflow from the tagged commit:

| File | What it is |
|------|------------|
| `luady-<version>.tar.gz` | The built tree: the built website and hub, the package files, the kit for servers, `NOTICE` and the licences |
| `luady-<version>-source.tar.gz` | The source of the tagged commit, as `git archive` writes it |
| `SHA256SUMS` | The SHA-256 checksum of both archives |

Check them before you unpack or run anything. The examples use version `0.1.0`;
replace it with the one you downloaded.

## 1. Download

With the [GitHub CLI](https://cli.github.com/):

```sh
gh release download v0.1.0 --repo bv4ts/luady
```

Or download the three files from the release page in a browser.

## 2. Check the checksums

This catches a damaged or incomplete download.

```sh
# Linux
sha256sum --check SHA256SUMS

# macOS
shasum -a 256 --check SHA256SUMS
```

On Windows (PowerShell), compare the hash of each archive with its line in
`SHA256SUMS`:

```powershell
(Get-FileHash luady-0.1.0.tar.gz -Algorithm SHA256).Hash.ToLower()
Get-Content SHA256SUMS
```

Every archive must print `OK` (or show the same hash as its line).

## 3. Check the attestation

This is the check that proves where the file came from. It needs the GitHub CLI,
signed in (`gh auth login`).

```sh
gh attestation verify luady-0.1.0.tar.gz --repo bv4ts/luady \
  --signer-workflow bv4ts/luady/.github/workflows/release.yml \
  --source-ref refs/tags/v0.1.0
```

Run it for `luady-0.1.0-source.tar.gz` too. A good result says
`Verification succeeded!` and names the repository, the workflow and the tag. If it
fails, do not use the file, and report it as described in [SECURITY.md](../SECURITY.md).

What the attestation proves: this exact file, byte for byte, was produced by the
`release.yml` workflow of `bv4ts/luady`, running on that tag. What it does not
prove: that the code is free of bugs. The source is open, so you can read it.

## 4. Optional: compare the source archive with the tag

The source archive is built from the tag with `git archive`. To see that it holds
nothing else:

```sh
mkdir from-release from-git
tar -xzf luady-0.1.0-source.tar.gz -C from-release
git clone --quiet --branch v0.1.0 https://github.com/bv4ts/luady.git luady-git
git -C luady-git archive --prefix=luady-0.1.0-source/ v0.1.0 | tar -x -C from-git
diff -r from-release from-git && echo "identical"
```

## 5. Run the built tree

`luady-<version>.tar.gz` holds the built hub and website without their dependencies. You need Node.js 22.12 or newer
(see [What you need](getting-started.md#what-you-need)). Unpack it, install what the hub runs on, and start it:

```sh
tar -xzf luady-0.1.0.tar.gz
cd luady-0.1.0
npm ci --omit=dev
npm start
```

The first start prints a setup code in the terminal, as [the setup wizard](setup-wizard.md#before-you-start)
describes. The other commands (`npm run luady -- <command>`, `npm run doctor`) work from this folder too. The demo is not
part of this tree: use a clone for `npm run demo`.

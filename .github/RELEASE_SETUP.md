# Release setup

The release pipeline lives in [`.github/workflows/release.yml`](workflows/release.yml).
It is triggered by pushing a tag matching `v*` and builds signed desktop
bundles for macOS (Apple Silicon + Intel), Windows, and Linux, then publishes
a **draft** GitHub Release with the bundles attached.

> The build succeeds even when none of the signing secrets below are set — it
> just produces unsigned (and un-notarized) bundles. Add the secrets when you
> are ready to ship signed builds.

## Release procedure

1. Bump the version in `package.json`, `src-tauri/Cargo.toml`, and
   `src-tauri/tauri.conf.json` so they all agree (e.g. `0.2.0`).
2. Commit, then tag and push:

   ```sh
   git tag v0.2.0
   git push --tags
   ```

3. The `Release` workflow runs the matrix and creates a **draft** release named
   `Marklee v0.2.0`. Review the attached bundles, then publish the release from
   the GitHub UI. (Drafts let you sanity-check assets before they go public; set
   `releaseDraft: false` in the workflow if you prefer auto-publishing.)

## Repository secrets

Add these under **Settings → Secrets and variables → Actions → New repository
secret**. All are optional; missing secrets only disable the corresponding
signing/notarization step.

### Updater signature (recommended for any public release)

Tauri signs each bundle with an Ed25519 key so the (future) auto-updater can
verify downloads. Generate the keypair once:

```sh
bun run tauri signer generate -w ~/.tauri/marklee_updater.key
```

This prints a **public key** (put it in `tauri.conf.json` under
`plugins.updater.pubkey` when you add the updater plugin) and writes the
**private key** to the file. Then:

| Secret | How to obtain |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of `~/.tauri/marklee_updater.key` (the private key file). On macOS: `pbcopy < ~/.tauri/marklee_updater.key`. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password you entered when running `tauri signer generate` (empty string if you chose no password). |

### macOS code-signing (Developer ID Application)

Requires a paid Apple Developer account.

1. In Xcode or the Apple Developer portal, create/download a **Developer ID
   Application** certificate and install it in your login keychain.
2. Export it from **Keychain Access → right-click the cert → Export…** as a
   `.p12` (set a password).
3. Base64-encode the `.p12`:

   ```sh
   base64 -i DeveloperID_Application.p12 | pbcopy
   ```

| Secret | How to obtain |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64 of the exported `.p12` (from the command above). |
| `APPLE_CERTIFICATE_PASSWORD` | The password you set when exporting the `.p12`. |
| `APPLE_SIGNING_IDENTITY` | The certificate's common name, e.g. `Developer ID Application: Jung Hoon Son (TEAMID)`. Find it with `security find-identity -v -p codesigning`. |

### macOS notarization (notarytool)

Notarization staples Apple's approval so Gatekeeper won't block the app.

1. Sign in to <https://appleid.apple.com> → **Sign-In and Security → App-Specific
   Passwords → Generate** an app-specific password for "notarytool".
2. Find your Team ID at <https://developer.apple.com/account> → **Membership**.

| Secret | How to obtain |
| --- | --- |
| `APPLE_ID` | Your Apple Developer account email. |
| `APPLE_APP_SPECIFIC_PASSWORD` | The app-specific password generated above (format `xxxx-xxxx-xxxx-xxxx`). Mapped to `APPLE_PASSWORD` in the workflow. |
| `APPLE_TEAM_ID` | Your 10-character Apple Team ID. |

### Windows Authenticode (optional)

Only needed to sign Windows installers (removes SmartScreen warnings). Requires
a code-signing certificate from a CA. Configure the signing command in
`src-tauri/tauri.conf.json` under `bundle.windows.signCommand` /
`certificateThumbprint`, and supply the certificate via these secrets:

| Secret | How to obtain |
| --- | --- |
| `WINDOWS_CERTIFICATE` | Base64 of your code-signing `.pfx`. |
| `WINDOWS_CERTIFICATE_PASSWORD` | The password for the `.pfx`. |

Leave both unset to ship unsigned Windows bundles.

# Secrets and safe publishing

## Secret boundary

Production Gorelo and optional OpenCode keys belong only in private Railway runtime variables. Never commit keys, tokens, passwords, private certificates, `.env` files, email exports, attachment retry records, or customer data. `VITE_*` variables are public build inputs, not a secret store. Entra client/tenant IDs and public hostnames are not credentials, but other deployers must use their own registration and URLs.

Localhost mode stores its user-entered Gorelo key in browser/WebView storage. Anyone who can inspect that trusted profile may extract it. Production must use server-managed keys with Entra authentication and assigned `Gorelo.User` roles.

Role assignment grants the app's capabilities through one shared organisation Gorelo key; it does not preserve a user's individual Gorelo permissions or isolate customers. Assign only trusted operators and restrict key permissions where supported.

## Before committing or sharing

1. Inspect `git status --short` and review staged filenames and diffs privately. Avoid `git add .` until you understand every included file. Do not paste a sensitive diff into an issue or chat.
2. Confirm local credentials, certificates, retry data, archives and email exports are ignored. Ignore patterns do not protect files already tracked or content hidden inside an archive.
3. Run [Gitleaks](https://github.com/gitleaks/gitleaks) against **all Git history**: `gitleaks git --redact --log-opts="--all" .`. Check untracked working files separately with `gitleaks dir --redact .` from a clean source-only copy. Do not upload scan reports without reviewing them.
4. Run `npm test` and `npm run build`. The added CI secret-scan job uses full Git history, redacts detected values, and has no production credentials. Require the test/build and secret-scan jobs in branch protection and enable Railway's Wait for CI in your service settings.
5. Enable GitHub secret scanning and push protection where your repository/account supports them. These require GitHub settings; adding this document or CI does not enable them. CI runs **after upload**, so it does not prevent a secret from reaching GitHub in the first place. Scan locally before pushing, and use a pre-commit hook if appropriate.

No scanner can certify that every Gorelo/OpenCode key or customer detail has been removed. Review bespoke key formats and docs manually. Do not whitelist unexplained findings, add production values as scan fixtures, or test a suspected exposed key against a live API.

`.gitleaksignore` contains one reviewed historical false positive: a public Entra Application (client) ID in the original deployment notes. Its fingerprint exempts only that exact commit/file/line finding, not API keys, future changes, or UUIDs generally.

## Before making a repository public

Keep the repository private until current files **and every historical commit/ref** have been reviewed. Review deployment notes, screenshots, source archives, workflow logs/artifacts, issues and PRs separately. Internal infrastructure addresses, backup paths and public registration IDs are not API keys, but may still be unsuitable for publication. Replacing a document at HEAD does not remove its earlier versions. The project's original code and documentation use the [MIT License](LICENSE); retain its notice and verify third-party asset rights before redistribution.

Prefer the allowlisted source-only candidate workflow in [PUBLIC_RELEASE.md](PUBLIC_RELEASE.md) for a separate future public repository. Keep the existing production repository/history private. Exporting is not publication approval or a guarantee that arbitrary API keys or private details will be detected.

## Runtime audit and attachment storage

Production requires a server-managed Gorelo key, Entra authentication with assigned roles, and absolute persistent retry/audit directories. The application cannot verify that a configured path is actually a persistent Railway volume. Follow [the deployment guide](deploy-railway.md) and verify mounts, private permissions, backups, log monitoring, rotation and retention before release.

Validated mutations record verified actor IDs, server-generated correlation, ticket UUID and classified outcome. Audit attempts must persist before an external mutation starts. An outcome-log failure after an external write is indeterminate, never evidence that the write failed. Logs omit email bodies, attachment contents, API keys and retry tokens; infrastructure access logs are a separate responsibility. Avoid logging full request URLs, since retry-status URLs contain opaque tokens.

Payload bytes expire seven days after the retry record's last update; retries can extend retention. Confirmed/uncertain receipts remain to prevent blind replays. Audit logs and byte-free receipts grow until managed by administrators. Memory-only storage is development-only, loses receipts on restart, and retains byte-free receipts for that process's lifetime. Local files are not tamper-proof or a substitute for central audit collection.

## If a secret was committed

Revoke/rotate it at the provider first and update private runtime configuration. Assume it is exposed even if the repository was private. Remove it from current files, then coordinate history cleanup and cache/artifact removal; rewriting history affects every clone and requires explicit coordination. Do not force-push, delete history, or make the repository public as an automatic cleanup step. Check access/audit logs where available without copying keys into reports.

Report suspected vulnerabilities or exposure privately to the repository owner. Never put the secret or customer data in a public issue.

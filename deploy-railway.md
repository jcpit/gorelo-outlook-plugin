# Deploy your own Gorelo for Outlook on Railway

> Disclaimer: This is not an official Gorelo tool and is not affiliated with or endorsed by Gorelo. Use at your own risk. No warranty is provided. Review permissions and data handling, and test with non-sensitive email before using it in production.

We deployed this add-in on Railway. Sign up using [our Railway referral link](https://railway.com?referralCode=URuhGI) to get **$20 in Railway credits upon signup**. This is a referral link; Railway hosting is billed separately.

This guide creates an independent deployment using **your own** Gorelo key, Microsoft tenant and app registration, hostname, and storage. Do not copy the author's production identifiers. No Microsoft client secret or Graph mail permission is needed; selected mail is read through Office.js.

## Upgrade an existing deployment (one codebase)

Maintain one canonical GitHub repository and deploy its reviewed release branch
to the existing Railway service. The source exporter produces disposable release
snapshots, not a second codebase to maintain. You do not need a new project,
service, Microsoft registration, hostname or installed Outlook manifest for an
image update.

1. Record the current successful deployment/commit for rollback. Check that the
   service still tracks your intended repository and branch, with Wait for CI.
2. Keep the existing keys, tenant/client IDs, Gorelo API region, CORS origin,
   volume and replica settings unchanged. In particular, do not replace a working
   regional API URL with the US West example further down this guide.
3. Verify the existing persistent volume is mounted at `/app/retry-data` and
   supports private UID/GID 1000 writes and Linux file/directory syncing. Back up
   existing receipts and configuration through your approved private process.
4. Add only the new non-secret runtime variable
   `AUDIT_LOG_DIR=/app/retry-data/audit`. Keep the existing
   `ATTACHMENT_RETRY_DIR=/app/retry-data` and root-entrypoint setting if used.
   Apply the setting without automatically deploying an unreviewed revision.
5. Run the tests, build, secret scan and candidate-container storage checks, then
   release the reviewed commit through the current GitHub integration. Do not
   upload a copied source folder or reinstall a generic example manifest.
6. Verify the deployed commit, health, unauthenticated API rejection, persistent
   storage and assigned-user Outlook read access. The server now prepares and
   syncs a private, empty audit log before listening; failed storage preflight
   prevents startup. Health is still liveness, not continual storage monitoring.
   No real Gorelo ticket is created by this check. Deliberate business test writes
   require an approved safe target.

Roll back to the recorded successful deployment on the same service if needed.
Preserve the volume, keys, authentication and receipts; do not delete storage or
fall back to an unauthenticated origin. Continue below only for a **new** independent
installation.

## 1. Prepare source and hosting

1. Create a private fork/copy of the repository. Original project code and documentation use the [MIT License](LICENSE); retain its notice. Review [SECURITY.md](SECURITY.md) and scan the entire history before sharing or making it public. Third-party asset permissions and notices still require review before redistribution.
2. In Railway, create a project/service from your GitHub repository. Select the deployment branch (normally `main`), use the root `Dockerfile`, and enable **Wait for CI**. Confirm GitHub integration can read your repository. No GitHub API-key/deployment secret is required.
3. Choose a stable HTTPS hostname under your control. Railway can supply a hostname, or configure a custom domain using the DNS target Railway gives **your** service. Finish DNS and TLS setup before configuring Microsoft sign-in. Use this same origin throughout the steps below.
4. Configure one always-on replica, healthcheck path `/healthz`, and a persistent volume mounted at `/app/retry-data`. Both retry receipts and private audit logs live on this volume. Size, monitor, and back it up for your workload. Do not copy another installation's retries or customer data.

## 2. Register the Microsoft application

In your own Microsoft Entra admin center:

1. Create a single-tenant app registration. Record its **Directory (tenant) ID** and **Application (client) ID**; these are public identifiers, not secrets.
2. Set the API's `requestedAccessTokenVersion` to `2` in the app manifest.
3. Expose an API with Application ID URI `api://YOUR_CLIENT_ID` and a delegated scope named `access_as_user` (admin consent only).
4. Add your own exposed delegated permission to the app and grant tenant administrator consent. The requested scope must be exactly `api://YOUR_CLIENT_ID/access_as_user`.
5. Add a **Single-page application** broker redirect URI `brk-multihub://YOUR_HOSTNAME` (hostname only, without `https://` or a path), following Microsoft's [NAA registration guidance](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/enable-nested-app-authentication-in-your-add-in). Use the hostname from step 1. Do not create a client secret.
6. Create an enabled app role allowing **Users/Groups**, with value exactly `Gorelo.User`. In the Enterprise application, assign it to each intended user's actual Outlook Microsoft account. Set **Assignment required** to **Yes**. Scope/admin consent alone does not authorize a user; the API also requires this role.

The API verifies the token's signature, tenant, issuer, audience, authorized client, delegated scope, and role. Never disable these checks to work around a failed sign-in.

Assign this role only to trusted operators: every assigned user acts through the **same organisation-wide Gorelo API key**, not their individual Gorelo permissions. This app does not enforce per-customer/client isolation or map Microsoft users to narrower Gorelo access. Use the narrowest key permissions Gorelo supports; do not offer this shared deployment to customer users expecting tenant/client isolation.

## 3. Set Railway runtime variables

Use Railway's private Variables UI for actual key values. Do not paste values into GitHub, chat, a shell command, a Docker build argument, or a manifest. Treat service collaborators with variable access as trusted administrators.

Set these non-secret configuration values:

```dotenv
NODE_ENV=production
PORT=5173
LISTEN_HOST=0.0.0.0
STATIC_DIR=/app/dist
GORELO_BASE_URL=https://api.usw.gorelo.io
CORS_ORIGIN=https://YOUR_HOSTNAME
REQUIRE_SERVER_KEY=true
REQUIRE_ENTRA_AUTH=true
ENTRA_TENANT_ID=YOUR_TENANT_ID
ENTRA_CLIENT_ID=YOUR_CLIENT_ID
ATTACHMENT_RETRY_DIR=/app/retry-data
AUDIT_LOG_DIR=/app/retry-data/audit
```

Choose the API region matching your Gorelo account; the URL above is the US West example. Do not add a trailing path to `GORELO_BASE_URL` or `CORS_ORIGIN`. Leave `DEMO_MODE` unset/false.

Add `GORELO_API_KEY` separately as a private runtime variable. Optionally add `OPENCODE_API_KEY` only if you want AI suggestions and approve sending the email subject and up to 2,500 plain-text body characters to OpenCode Zen. Do not prefix either secret with `VITE_`.

Production refuses to start without a server Gorelo key, both Entra IDs, and absolute retry/audit paths; demo mode and caller-managed production keys are refused. An absolute path alone does not prove persistence: verify your volume mount in Railway.

The API runs as UID/GID 1000. If Railway mounts the new volume root-owned and the app cannot write to it, set `RAILWAY_RUN_UID=0` for the container entrypoint: `server/container-entry.mjs` prepares the private retry and audit directories and drops to UID/GID 1000 **before** starting the API. Verify the resulting API process and storage ownership; do not replace the entrypoint or run the API as root.

## 4. Create your Outlook manifest

Copy `manifest.remote.xml` to a file for your own deployment. Replace **every** occurrence of the reserved example hostname `gorelo-outlook.example.com` with your HTTPS hostname, including icon URLs, app domains, support URL, task-pane URL, and form source location. The manifest contains URLs/metadata only, never API keys.

Choose a new add-in `<Id>` UUID for an independent installation, especially if you also have the author's add-in installed. Keep your new ID stable for future updates and increment `<Version>` when needed. Keep permissions at `ReadItem`; the integration does not require Graph mail access.

Validate your customized manifest (this command may download Microsoft's validator):

```bash
npx office-addin-manifest validate manifest.your-deployment.xml
```

## 5. Deploy and verify without writes

Commit only reviewed source/configuration to your branch, open a pull request, and ensure CI tests, build, and secret scan pass. Merge to the branch connected to Railway. Confirm Railway deployed the expected Git commit and reports healthy status.

Run these checks with your own hostname (do not add a key):

```bash
curl --fail https://YOUR_HOSTNAME/healthz
curl -i https://YOUR_HOSTNAME/api/options
```

Health should return `200`; the unauthenticated business API must return `401`. `/api/auth-config` intentionally exposes only public Microsoft registration settings. A normal browser shows an Outlook-only message, not an interactive demo.

Sideload your customized manifest through [Outlook's add-in management](https://aka.ms/olksideload), or deploy it through Microsoft 365 admin center → Integrated apps. Your administrator may need to allow custom add-ins. Use a supported NAA Outlook client; on Windows, Microsoft's minimum is Microsoft 365 Outlook version 2409 / build 18025.20000, with current supported builds preferred.

Open a message in Outlook, launch **Create Gorelo ticket**, and use **Sign in with Microsoft** if prompted. Confirm an assigned user can read tickets/assets and an unassigned user is refused. Browser sign-in alone does not test Outlook's embedded authentication. Unsupported clients must fail closed. Only after read-only validation should you deliberately create a safe test ticket and inspect its metadata and attachments.

## Updates, storage, and rollback

Use pull requests and required CI checks; merge to the connected branch to release. Check Railway's deployed SHA and health after each release. Railway variables and the persistent volume are separate from Git; backing up the source does not back up configuration or customer data. Attachment retry bytes expire seven days after the record's last update, checked on access and hourly while running; retries can extend retention. Receipts persist for duplicate protection and backups have separate retention; protect storage and backups accordingly.

Security audit records append to `/app/retry-data/audit/security-audit.jsonl` with private directory/file permissions (0700/0600). Records identify the verified Microsoft tenant/object ID, operation, ticket UUID, server-generated request ID and outcome. Only validated mutation attempts and outcomes are recorded, not every read, sign-in rejection or invalid request. Local development records explicitly identify the actor as local; they do not establish an individual user's identity.

The app syncs each audit record to disk before proceeding; an unavailable attempt log prevents the external write. If outcome logging fails after a write, the response is explicitly indeterminate: inspect Gorelo before retrying. Protect logs and backups, restrict Railway collaborators, monitor storage/errors, and arrange access-controlled off-host collection and rotation/retention to meet your policy. Logs and byte-free retry receipts are not automatically deleted and can grow indefinitely. Do not delete receipts casually: doing so weakens duplicate protection. A private local file is not a tamper-proof central audit service.

Persistent audit/retry writes require Linux filesystem directory-sync support and fail closed if it is unavailable. Verify storage on your actual service; synthetic tests cannot establish your host's power-loss guarantees.

Before upgrading an existing installation to this revision, add `AUDIT_LOG_DIR` on the mounted volume and verify permissions. Missing configuration will intentionally prevent startup. Test the upgrade privately before merging to the deployment branch.

For code rollback, select a previously verified deployment in Railway and verify authentication and read access again. Do not disable Entra auth, publish an unprotected legacy origin, or move secrets into the frontend as a workaround. Do not run `railway up` from an unreviewed copied folder; CLI uploads are a separate deployment path that can bypass the GitHub review workflow.

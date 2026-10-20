# Generic Docker deployment template

This source candidate is not a live deployment or an authorization to publish.
Review [PUBLIC_RELEASE.md](PUBLIC_RELEASE.md) before distributing it. For the
supported hosted setup, see [deploy-railway.md](deploy-railway.md).

`docker-compose.remote.yml` is a loopback-only starting point, not a complete
public deployment. Supply credentials privately on the deployment host through
an untracked `.env` (see `.env.example`), restrict its permissions, and never
paste it into logs, tickets, or source control. Do not run `docker compose config`
in shared output: interpolation can reveal credentials.

Before making the service reachable:

1. Choose your own HTTPS hostname; `gorelo-outlook.example.com` is a reserved
   documentation placeholder. Update `CORS_ORIGIN` and every URL in
   `manifest.remote.xml` to the same origin. Select your actual Gorelo API region.
2. Configure application-level Entra authentication as described in the hosted
   guide. Set `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `REQUIRE_ENTRA_AUTH=true`,
   and `GORELO_API_KEY` privately in the deployment environment. A server-side Gorelo key is not user
   authentication. Do not expose an unprotected origin or disable authentication
   to resolve Outlook sign-in problems. The application does not independently
   validate arbitrary gateway JWTs. Loopback binding does not protect requests
   forwarded by a tunnel or reverse proxy.
3. Keep the origin private and use a trusted HTTPS proxy. Provision proxy,
   DNS, certificates, secrets, tenant IDs and storage outside this repository.
   Review and test the Outlook embedded authentication flow before rollout.
4. Generate a new installation UUID with
   `node -e "console.log(require('node:crypto').randomUUID())"` and replace the
   example `<Id>` in `manifest.remote.xml`. Do not reuse another installation's ID.
   Use your own provider/support metadata and approved branding.
5. Provision `./attachment-retries` as a private directory writable by container
   UID/GID 1000 before starting. The API runs as that non-root user; a newly
   auto-created root-owned bind mount may prevent writes. Never solve this by
   granting world access or running the API as root.
6. Build and start only after reviewing the configuration:

   ```bash
   docker compose -f docker-compose.remote.yml up --build -d
   docker compose -f docker-compose.remote.yml ps
   ```

Verify `/healthz` returns 200 and unauthenticated `/api/auth-mode` returns 401.
The public static pane and `/api/auth-config` must be loadable by Outlook; they
contain no business data or keys. Authenticated reads must work only for intended
assigned users. A gateway may add protection, but never replaces application
Entra validation. Validate the customized manifest using your approved Microsoft
Office manifest tooling, then sideload it for a controlled test. Ticket creation
and attachment uploads change Gorelo data: obtain approval for a safe test target.

Runtime retry storage may contain email and attachment content. Protect it,
define retention and backups, and never add it to the public source candidate.
The template also stores security audit events under the private retry volume
at `audit/security-audit.jsonl`; restrict access and define retention for these
logs as well. They are runtime data, never public source.
This generic template has not been deployed or validated against your tenant.

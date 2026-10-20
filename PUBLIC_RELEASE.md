# Public release checklist

This repository starts from a reviewed source-only snapshot. Private development
history and retired unverified font binaries are not imported. This checklist
also applies to future releases: running the exporter does not change repository
visibility. Never push private history into a public repository or assume an
ignore file makes existing commits safe.

Maintain one canonical codebase. These exports are generated release snapshots,
not a second fork to maintain or a second deployed service. The canonical source
is `jcpit/gorelo-outlook-plugin`; the existing Railway service tracks its `main`
branch. Keep the former private repository as a historical reference, not an
independent implementation. Updating production does not itself publish source.

## Decisions required before publication

- The owner selected the [MIT License](LICENSE) for original project code and
  documentation. Retain its copyright and license notice in source and
  substantial distributions. This does not license third-party assets or
  authorize repository publication.
- The owner confirms that community add-ons and continued use of the Gorelo
  logo are permitted. Retain the unofficial-tool disclaimer; this is not Gorelo
  endorsement or a grant of artwork rights to downstream users.
- Current font binaries are unmodified official Adobe Source Sans 3 assets,
  pinned by commit and hashes, with complete notices/OFL. Browser-visible
  credits and browser/direct-runtime dependency licence texts are included.
  Retain applicable notices for the distribution; see
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for review scope and limits.
- Verify that every publicly reachable commit and reference excludes private
  development data and retired unverified assets. This clean standalone
  repository does not import the former private commits or pull requests.
  Replacing files in a working tree alone does not remove historical copies.
- Review all fixtures, documentation, examples, registration metadata, and
  support links for customer, operator, or internal deployment information.
- Approve the destination owner, repository name, visibility and initial commit
  contents separately. This workflow does not create a repository or push code.

## Build a clean candidate

Run from the reviewed working tree, including reviewed uncommitted changes:

```bash
node --test scripts/public-source.test.mjs
node --test scripts/licenses.test.mjs
node scripts/public-source.mjs /absolute/existing/parent/new-candidate
```

The destination must not exist and must be outside the source tree. Its parent
must already exist without symlink components. The exporter copies only its
explicit file allowlist, fails on missing files or selected symlinks, validates
binary signatures and scans selected bytes for common secret shapes. It never
copies `.git`, `.env`, runtime retry data, certificates, archives, dependencies,
build output, customer files, or local reports. It does not delete anything.
If a copy fails midway, the new candidate may be partial: inspect it privately
and use a different new destination for the next attempt.

The tripwire cannot identify every secret or private datum. Review the exact
allowlist and exported contents manually and run an independent secret scanner.
Do not add broad directory-copy rules to accommodate new files.

## Validate the candidate privately

Use an approved, installed Gitleaks release (the CI workflow also pins a scanner
image). From the candidate directory, without initializing Git:

```bash
gitleaks dir --redact --no-banner .
npm ci
npm test
node --test scripts/public-source.test.mjs
npm run build
npm audit
```

Scan with redaction enabled; never paste scanner reports containing credentials.
Review any suppression in `.gitleaksignore` individually, and inspect binary
assets and filenames as well as text. Confirm no internal hosts, real tenant or
installation identifiers, customer content, production configuration, or private
history remain. Audit findings require human triage, not automatic remediation.

Dependency installation and build create generated files in this validation
directory. Do not publish that whole directory afterward: re-export the reviewed
source into a fresh directory and repeat the redacted source scan. Only after
all approvals may the owner initialize a new, source-only repository and review
its staged file list and first commit. Do not rewrite or publish private history.

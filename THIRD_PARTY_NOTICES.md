# Third-party credits and notices

The project's original code and documentation use the [MIT License](LICENSE).
This inventory does not grant trademark rights, relicense third-party material,
or certify that redistribution requirements are complete. Browser-visible credits
are in [public/credits.html](public/credits.html), linked from every app state.
Vite copies that page and the full `public/licenses/` documents into `dist`,
which the Docker image serves without requiring sign-in. Retain them when
redistributing source or built artifacts.

## Verified Adobe Source Sans 3 fonts

`public/source-sans3-regular.ttf`, `source-sans3-semibold.ttf`, and
`source-sans3-bold.ttf` are unmodified static fonts from Adobe's official
**Source Sans 3 release 3.052R**, designed by **Paul D. Hunt** and licensed under
the **SIL Open Font License 1.1**. They replace the previous unverified font files.
They are self-hosted; no external font service is required.

Pinned upstream commit: `ed1808970eb3c7301c9a523bee26473ba0bb62fa` in
<https://github.com/adobe-fonts/source-sans>. The upstream files are
`TTF/SourceSans3-Regular.ttf`, `TTF/SourceSans3-Semibold.ttf`, and
`TTF/SourceSans3-Bold.ttf`. Only their delivery filenames differ; bytes and
embedded font names are unchanged.

The [full font notices, source mapping, hashes and OFL](public/licenses/source-sans-3-OFL.md)
preserve the exact embedded copyright notice:

> © 2023 Adobe (http://www.adobe.com/), with Reserved Font Name ‘Source’

The complete matching upstream licence retains its 2010–2022 copyright notice.
Both notices are preserved without rewriting either. SHA-256 checks pin all
three font files and the complete licence text. Font software remains OFL,
not MIT; retain the notices and licence when redistributing it, do not sell the
fonts alone, and follow the reserved-name rules for modified versions. No Adobe
endorsement is implied.

## Font Awesome Free icons

`src/icons.ts` renders SVG paths from `@fortawesome/free-solid-svg-icons` 6.7.2.
Font Awesome Free by Fonticons, Inc.: <https://fontawesome.com/>.

The installed package's `LICENSE.txt` identifies icons as CC BY 4.0, non-font
code as MIT, and fonts (if distributed) as SIL OFL 1.1. Copyright 2024 Fonticons,
Inc. Complete package notices are reproduced unchanged in
[npm-dependencies.md](public/licenses/npm-dependencies.md); the app's credits page
also links the icon license and identifies the creator. The eight icons are
envelope, ticket, computer, arrow-right, arrow-left, circle-check, paperclip and
triangle-exclamation. Their path data is unmodified; the app sets display size
and color. No Font Awesome font binary or Pro asset is intentionally shipped.

- Icon license: <https://creativecommons.org/licenses/by/4.0/>
- Upstream terms: <https://fontawesome.com/license/free>
- Package notice after installation:
  `node_modules/@fortawesome/free-solid-svg-icons/LICENSE.txt`

## Gorelo branding and add-in icons

`public/gorelo-mark.svg`, `public/gorelo-mark.png`, `public/icon.svg` and the
`public/icon-*.png` assets include existing branding. The Gorelo name, logo and
related artwork identify the compatible service and remain the property of
their respective rights holders. This is not an official Gorelo tool and is
not affiliated with or endorsed by Gorelo. The project owner confirms that
community add-ons and continued use of the Gorelo logo are permitted. This
records the owner's approval, not an independent legal opinion or a grant of
Gorelo's rights to downstream users. Attribution is not a grant of trademark or
artwork rights; check the terms for your own use.

## Microsoft Authentication Library

MSAL Browser and MSAL Common for JavaScript are © Microsoft Corporation. All
rights reserved. Both use the MIT License. Their complete installed license
texts and locked versions are preserved in
[npm-dependencies.md](public/licenses/npm-dependencies.md).

## Other dependencies

[npm-dependencies.md](public/licenses/npm-dependencies.md) reproduces the full
installed license files for all direct runtime dependencies, MSAL Common and
Font Awesome common types, with package versions, SPDX metadata and upstream
links. This includes Express, jose, sanitize-html and Zod. Installed server
dependencies retain their upstream notices inside `node_modules` in the runtime
image. This bounded document is not a full review of all transitive packages,
development tools or OS packages; retain their notices for the intended distribution.

Run `npm run licenses:update` after reviewing dependency changes and commit the
updated document. `npm run licenses:check` (also run by `npm run build`) rejects
missing/stale notices, changed locked versions or unreviewed direct dependencies
without rewriting files. `npm run test:licenses` verifies notice preservation.
The source exporter explicitly includes the credits page and full license texts.

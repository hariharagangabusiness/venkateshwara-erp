# Working with this repo

- After building and end-to-end testing a requested change on the `claude/got-push-qutr7d` branch, push it, open a PR against `main`, and **merge it automatically** — do not wait for a separate "merge it" confirmation. This is a standing instruction from the repo owner (given 2026-09-29).
- Still ask for confirmation before *building* anything non-trivial when asked to (per the user's own "provide your understanding first" requests) — the auto-merge default only applies once work is built, tested, and ready to ship.
- After merging, resync the local branch with `origin/main` before starting the next task.

## Built: Word template customization for the Offer Word (.docx) export (2026-09-30)

Picked back up and shipped same day, using Option B (native Word template via `docxtemplater`) with an easy on/off switch, per the repo owner's choice.

- `lib/offerDocxTemplate.js` — merge-data builder, template renderer, upload-time validator (dry-run render against sample data, so a bad `{tag}` is caught before it's ever saved active), and the downloadable starter `.docx` (every recognized placeholder + the `{#items}`/`{/items}` table-row loop already placed and explained inline).
- `lib/settings.js`'s `offer_docx_template` (`template_path` + `active`) mirrors the PDF template's own active-flag pattern — off by default.
- `routes/offers.js`: `GET/POST/DELETE /offers/docx-template` (Admin-only, upload/toggle/reset) + `GET /offers/docx-template/starter`. `GET /:id/docx` uses the template only when `active` and a `template_path` exist; a render failure (edited-since-validated template, missing file) falls straight back to `lib/offerDocx.js`'s original fixed-layout generator rather than ever handing back a broken file — that generator is never removed, it's both the default and the permanent fallback.
- Admin UI: "Offer Word (.docx) Template (Optional Override)" panel in Offer Field Options, next to the existing Offer PDF Template panel.
- Scope: header/project-data fields + the priced Scope-of-Supply table + simple paragraph-loop blocks for tech specs/bought-out/terms.
- **Equipment References now support text + picture** (2026-09-30, same-day follow-up): a `{#equipment_references}...{/equipment_references}` paragraph loop with `{title}`, `{%image}`, `{summary}` — the `{%image}` tag is `docxtemplater-image-module-free` (new MIT dependency), driven by the same `image_data_uri` the PDF already uses. A reference with no picture renders text-only (the module skips the image call entirely for a falsy tag value); a picture that fails to decode/size renders a 1×1 placeholder rather than failing the whole document. `docxtemplater-image-module-free` pulls in the old, critical-CVE `xmldom` package — neutralized via `package.json`'s `overrides` aliasing `xmldom` to the already-present, maintained `@xmldom/xmldom` fork (the same one `docxtemplater` core itself uses). Scope-of-Supply items still have no per-item picture in the native template (a picture per table row is a heavier layout change and wasn't asked for) — only Equipment References got this.

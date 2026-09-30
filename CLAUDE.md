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
- Scope: header/project-data fields + the priced Scope-of-Supply table + simple paragraph-loop blocks for tech specs/bought-out/terms. No per-item pictures in the native template (that stays PDF-only) — kept the merge data plain strings/numbers so no image-handling module was needed.

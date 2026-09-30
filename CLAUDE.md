# Working with this repo

- After building and end-to-end testing a requested change on the `claude/got-push-qutr7d` branch, push it, open a PR against `main`, and **merge it automatically** — do not wait for a separate "merge it" confirmation. This is a standing instruction from the repo owner (given 2026-09-29).
- Still ask for confirmation before *building* anything non-trivial when asked to (per the user's own "provide your understanding first" requests) — the auto-merge default only applies once work is built, tested, and ready to ship.
- After merging, resync the local branch with `origin/main` before starting the next task.

## On hold: Word template customization for the Offer Word (.docx) export (2026-09-30)

The repo owner wants this kept in mind for a future session, not built yet.

**Current state**: two separate things already exist and should not be confused with each other:
- The PDF's body already supports an admin-uploaded Word template: `POST /offers/pdf-template/convert-docx` converts an uploaded `.docx` to HTML via `mammoth`; `PUT /offers/pdf-template/custom-body` marks it active (`offers` settings' `custom_body_active`/`custom_body_html` in `lib/offerPdf.js`). This works today, admin-facing UI lives in the Offer PDF Layout Designer page.
- The "Download Word" button (`GET /offers/:id/docx`, `lib/offerDocx.js`) generates a `.docx` with a **fixed, hardcoded layout** — deliberately built with no template/override support ("a leaner rendering... no custom PDF-template/layout override", per that file's own comment).

**The open question**: should the Word (.docx) output also become admin-customizable via an uploaded template, the way the PDF already is? A PDF is rendered HTML/CSS via a real browser, so any HTML template works for it; a `.docx` is a different file format (OOXML) entirely, so this isn't a small extension — it needs a genuinely different technical approach. Three options were laid out for the owner to pick from when they're ready:

- **Option A** — Convert the *same* existing HTML template (the one already used for the PDF) to Word automatically via an HTML→DOCX library (e.g. `html-to-docx`, a new dependency). One template drives both outputs, but HTML→DOCX conversion has real fidelity risk on complex layouts.
- **Option B** (recommended if real Word branding is wanted) — A separate, native Word template: the admin designs the actual template as a real `.docx` in Microsoft Word with `{placeholder}` tags and a repeatable item-row table, filled in via `docxtemplater` (a new dependency, the standard library for this). Best fidelity, but a second template to maintain alongside the PDF one.
- **Option C** (recommended if the Word file is just an internal editable draft, not a customer-facing branded document) — leave `lib/offerDocx.js` exactly as it is; do nothing further. Matches how the pre-existing PO Word export also has no template system.

No dependency has been added yet for either A or B. When this is picked back up, get the owner's choice of option first, then plan the concrete build from there.

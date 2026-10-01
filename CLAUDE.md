# Working with this repo

- After building and end-to-end testing a requested change on the `claude/got-push-qutr7d` branch, push it, open a PR against `main`, and **merge it automatically** — do not wait for a separate "merge it" confirmation. This is a standing instruction from the repo owner (given 2026-09-29).
- Still ask for confirmation before *building* anything non-trivial when asked to (per the user's own "provide your understanding first" requests) — the auto-merge default only applies once work is built, tested, and ready to ship.
- After merging, resync the local branch with `origin/main` before starting the next task.

## Removed: Offer Word (.docx) export (2026-09-30)

Built and shipped same day (fixed-layout export, then a native-template admin-branding system via `docxtemplater`, then Equipment Reference pictures on top of that) - then removed entirely at the repo owner's request the same day, after two real problems surfaced:

- An admin uploaded the native template's own starter file unedited and activated it - since the starter's explanatory notes are real paragraphs in that `.docx`, they rendered into real customer-facing offers alongside the correctly-merged data, reading as a broken/"non-compiled" document.
- Separately, the owner asked whether the Word output could instead directly mirror the PDF's actual design (Option A, revisited). Investigated and hit a hard technical wall: the HTML→DOCX library available (`html-to-docx`) does not read `<style>` stylesheets/CSS classes at all - only inline `style="..."` attributes with a narrow supported property set (no `text-decoration`, no flexbox, no `position:fixed`/`transform` for the watermark) - so genuine parity was not achievable without rewriting `lib/offerPdf.js`'s body-HTML generation and still shipping with disclosed visual gaps. Not pursued.

Given both paths had real problems, the owner chose to drop the feature rather than keep patching it. Removed: the "Download Word" button, `GET /:id/docx`, all `/offers/docx-template*` routes, `lib/offerDocx.js`, `lib/offerDocxTemplate.js`, the "Offer Word (.docx) Template" admin panel, and the `docx`-adjacent dependencies that only that code used (`docxtemplater`, `docxtemplater-image-module-free`, `pizzip`, and the `xmldom` override that neutralized a critical CVE in the image module's own dependency - moot once that module is gone). `docx` itself stays - `lib/poDocx.js` and `lib/annexureDocx.js` (Purchase Order Word export) still use it, unaffected. The Offer PDF (`lib/offerPdf.js`) is completely untouched by any of this and remains the only export format for Offers.

## Offer PDF footer: no page numbers, corrected address block (2026-09-30)

`DEFAULT_OFFER_DESIGN_TOKENS.show_page_numbers` in `lib/settings.js` is now `false` - Puppeteer's `pageNumber`/`totalPages` footer classes were misaligning the footer's flex layout, so "Page X of Y" is dropped rather than fixed in place. `lib/offerPdf.js`'s `COMPANY_ADDRESS_LINES` (the static footer address/GST/phone/email block) corrected to match the repo owner's supplied reference image - the previous text had misplaced punctuation (stray semicolons inside the quoted building-type labels) and a wrong phase/plot phrase.

## Employee bulk-upload: upsert on employee_code (2026-10-01)

`POST /hr/employees/bulk-upload` (`routes/hr.js`) now upserts instead of insert-only - a row whose `employee_code` matches an existing employee UPDATEs it instead of being rejected with "already exists - skipped", so re-uploading the same filled template after changing a field (e.g. `date_of_joining`) actually applies the change. Same "blank cell never overwrites an existing value" rule as the Vendor/Item Master bulk-uploads (`routes/masters.js`) - a partial re-export/re-import can't accidentally wipe a field the file didn't carry. A row with a blank `employee_code` has nothing to match against, so it's always inserted as new, same as before. The response now includes `updated` alongside `inserted`/`skipped`/`errors` - the frontend's shared `uploadTemplateFile()` helper already displays it automatically whenever present, no UI change needed.

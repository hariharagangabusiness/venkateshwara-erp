# Backlog — Pending / Not Yet Built

Running list of features the repo owner has discussed/requested but that haven't been scoped-and-built yet. This is separate from `CLAUDE.md`, which only logs what's *already shipped* (with its own standing confirm-before-building rule). When an item below gets picked up, scope it per that rule, build/test/ship it as usual, log it in `CLAUDE.md`, and move/remove it from this file in the same round.

Reviewed every Saturday 6PM IST (see the recurring reminder) so the owner can pick what fits that week's available capacity.

## Open items

- **Admin-editable content for outbound document/action emails** (raised 2026-10-14) — today only the Service Request auto-acknowledgement email has an editable template (`service_ack_mail` setting); every other outbound email (PO, Sales Invoice, Proforma, BG follow-up, SOA, approval-outcome notification, welcome, password reset, backup) is a hardcoded string in the backend. Needs scoping: which emails, one shared template store vs. per-document settings blocks, and whether it needs the same rich-text formatting (bold/color/size) the PO document template got.
- **Leave** (raised earlier, details TBD — repo owner to confirm/fill in exact scope)
- *(others discussed earlier — repo owner to list; this file will be updated once confirmed)*

## From the 2026-10-02 Purchase/Store gap review (six-phase list, still partly open)

Phase A (Accounts Payable) and Phase D/E (Returns & Rejections / Dispatch & Packing) have since shipped. Still unbuilt from that original list:
- Demand Planning
- Production & Consumption (RM Requirement Sheet, BOM/Production Voucher, Batch Creation, Consumption Slip)
- Purchase Schedule
- Reporting (the phase-F reporting rollup across the above)

## Explicitly deferred (not forgotten, just not now)

- AI-driven email parsing/NLP for the Service inbound-mail pipeline (richer extraction than today's regex-based name/phone guessing) — deferred after a cost/risk write-up (new external API dependency, cost, latency, non-determinism feeding an approval queue; this app has zero AI/LLM integration today).

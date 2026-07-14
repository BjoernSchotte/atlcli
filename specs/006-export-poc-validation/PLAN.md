# Export-PoC Validation — Success Criteria, Scroll Reference Test, Benchmarks

Status: **Planned**

Spec ID: `006-export-poc-validation`
Depends on: `004-docx-export`, `005-pdf-export` (validates their output; 002/003 transitively)
Related strategy: FAHRPLAN Phase 1 Task 1.5 · `TYPST-EXPORT-ANGLE.md` §7.5 Erfolgskriterien · `EXPORT-QUALITY-ANGLE.md` §6 (20-point benchmark), §7 item 4
Origin: FAHRPLAN Phase 1 — "Erfolgskriterien prüfen"

---

## 1. Overview

Phase 1 ends with evidence, not vibes. This spec turns the FAHRPLAN 1.5 success criteria
into an executable validation protocol and produces a single results document —
`RESULTS.md` in this directory — that is the go/no-go artifact for Phase 2. Almost
everything here is **joint E2E work**: it needs Björn's Chrome, the real mayflower
Confluence, a real customer-style Word template, and (for the reference test) access to a
Scroll Word Exporter output.

The four normative criteria (FAHRPLAN 1.5 / TYPST §7.5), plus the quality-dimension
extension from EXPORT-QUALITY §7 item 4 ("not just parity — where are we visibly
better?"):

1. **Reference test vs. Scroll:** same page, same template — once through Scroll Word
   Exporter, once through the extension; styles, header/footer, TOC and placeholder
   resolution visually equivalent.
2. **Correctness:** callouts, tables, code and embedded images correct in the output.
3. **Performance:** typical page (~2,000 words, ~5 images) exports in **< 10 s**, no
   local install, no token configuration.
4. **Privacy:** network log during export shows exclusively `*.atlassian.net` calls.

### Goals

- A reproducible **reference page** ("feature zoo") and test protocol, so the benchmark
  can be re-run after any later change.
- Side-by-side Scroll-vs-extension comparison scored per criterion, deviations itemized.
- Performance measured (median of 3 runs) for DOCX and PDF separately.
- Privacy verified with a captured network log.
- The applicable subset of the EXPORT-QUALITY §6 20-point benchmark scored
  (single-page criteria only), with the ✅/🏆/🟰/❌ verdicts backed by artifacts.
- `RESULTS.md` with a clear **pass / pass-with-notes / fail** verdict per criterion and a
  derived Phase-2 input list (deferred bugs, edge cases, measured limits).

### Non-goals

- No new product code (bug fixes triggered by findings go through 004/005 with regression
  tests per CLAUDE.md, then re-run the affected protocol section here).
- No multi-page criteria, no scheduling, no Phase-2 benchmark rows (page-tree TOC etc.).
- No automated visual-diff tooling — human side-by-side review with a structured
  checklist is the PoC-appropriate instrument.

---

## 2. Validation protocol

### 2.1 Test assets (Task 1)

- **Reference page** in `DOCSY` (kept for the PoC's lifetime, deleted at Phase-1 close):
  ~2,000 words, headings H1–H4, all four callouts + one titled panel, a merged-cell
  table, a plain table wide enough to break across a page, nested lists, 2 code blocks
  (TypeScript, YAML), 5 images (mixed PNG/JPEG, one > 1 MB), one ```mermaid flowchart,
  status macros, internal + external links, labels set (for `$scroll.pagelabels`).
  Page source stored as `reference-page.storage.xml` in this dir (re-creatable).
- **Reference template:** a realistic mayflower .docx template using at minimum
  `$scroll.title`, `$scroll.content`, `$scroll.space.name`, `$scroll.exportdate`,
  `$scroll.exporter.fullName` in body/header/footer + a native TOC field. Björn provides
  or approves it; stored (or referenced, if confidential) from this dir.
- **Scroll access:** one export of the reference page through Scroll Word Exporter with
  that template. **F1 resolved (Björn, 2026-07-14): a Scroll instance is available**
  (existing installation/customer) — criterion 1 runs as a true A/B against a real
  Scroll export. Logistics (which site, replicating the reference page there) are
  settled in the Task 1 session.
- **Frozen reference set:** page (storage source), template, Scroll output, extension
  output, and **all version identifiers** (Scroll Word Exporter product version,
  extension commit, Chrome version) are archived together as one immutable set in this
  dir — that's what makes the A/B citable and re-runnable later.
- **Anonymized regression fixture:** if the reference material contains customer data
  (template or replicated page content), derive an anonymized equivalent (same structure,
  scrubbed content/branding) as a **permanent regression fixture** that can live in the
  repo unrestricted; the original set stays local. The fixture is what post-Phase-1
  changes re-run against.

### 2.2 Measurement rules

- Timing: from export-button click to download-ready (the report's duration field, 004/005),
  median of 3 runs, warm compiler for PDF runs 2–3 (cold-start noted separately).
  Machine + Chrome version recorded.
- Network: DevTools network log (panel + offscreen contexts!) captured for one full DOCX
  and one full PDF export; every request host listed. Any non-`*.atlassian.net` request =
  criterion 4 **fail** (extension-internal `chrome-extension://` resources excluded).
- Visual comparison: printed/PDF'd side-by-side, per-item checklist (§2.3), each item
  `match / minor deviation / major deviation` with screenshot evidence for deviations.

### 2.3 Comparison checklist (criterion 1 + 2, DOCX)

Cover & styles · header/footer placeholder resolution · TOC entries + populate-on-open ·
heading hierarchy/numbering · body typography (template styles applied) · callout
rendering · both tables (merge correctness, header repeat) · lists · code blocks
(extension: colored 🏆 expected) · images (placement, size, quality) · links ·
placeholder values byte-comparable where deterministic (title, space, labels).

### 2.4 Quality-proof verification (PDF, EXPORT-QUALITY §6 subset)

Rows 2, 3 (🏆 expected: Typst-computed page numbers), 4, 7, 8, 9, 11, 12, 13, 14, 15
(tagged/UA-1 reference), 17, 18, 19, 20 — scored in `RESULTS.md` with the same
✅/🏆/🟰/❌ legend so the table is directly comparable to the research benchmark.

---

## 3. Task breakdown

### Task 1 — Test assets **[E2E: user]**

- [ ] Reference page created in DOCSY per §2.1; storage source archived in this dir
- [ ] Reference template provided/approved by Björn; placeholder inventory documented
- [ ] Scroll export of the reference page produced on the available Scroll instance (F1 ✅) and archived; if the reference page must be replicated on that site, replication + later cleanup included
- [ ] Frozen reference set assembled per §2.1: page source, template, both outputs, Scroll product version, extension commit, Chrome version — one immutable archive
- [ ] If customer data is involved: anonymized regression fixture derived and committed; original set kept local only

### Task 2 — Reference test DOCX vs. Scroll **[E2E: user]**

- [ ] Extension export of the reference page with the reference template produced
- [ ] §2.3 checklist scored side-by-side, deviations screenshotted and itemized
- [ ] Placeholder resolution compared value-by-value
- [ ] Verdict for criterion 1 recorded (visually equivalent: yes/no + deviation list)

### Task 3 — Correctness sweep (criterion 2) **[E2E: user]**

- [ ] DOCX: callouts/tables/code/images checklist all `match` or deviations dispositioned (fix-now via 004 vs. Phase-2 backlog)
- [ ] PDF: same sweep on the 005 output incl. §2.4 quality rows
- [ ] Every `major deviation` either fixed (with regression test in 004/005) and re-run, or explicitly accepted by Björn in `RESULTS.md`

### Task 4 — Performance (criterion 3)

- [ ] DOCX: median of 3 < 10 s on the reference page — measured values recorded
- [ ] PDF: median of 3 recorded; < 10 s target — if missed, cold/warm split + bottleneck analysis (fetch vs. serialize vs. compile) documented instead of hand-waving
- [ ] Zero-install/zero-config confirmed: fresh Chrome profile + load unpacked + logged-in Atlassian session is the *entire* setup (walked through once, steps listed)

### Task 5 — Privacy (criterion 4)

- [ ] Network logs captured for one DOCX and one PDF export (all extension contexts)
- [ ] Host inventory in `RESULTS.md`: only `*.atlassian.net` (+ `chrome-extension://`) — explicitly confirming no CDN font/WASM loads (005's bundling promise)
- [ ] Repeated in a network-throttled run to catch lazy loaders that only fire under specific conditions

### Task 6 — RESULTS.md + Phase-2 handoff

- [ ] `RESULTS.md`: per-criterion verdict (pass / pass-with-notes / fail) with evidence links, the §2.4 benchmark table, measured numbers, environment
- [ ] Phase-2 input list: deferred deviations, measured limits (bundle size from 005, perf ceilings), edge-case backlog (merged cells etc.)
- [ ] Test resources cleaned up: reference page deleted from DOCSY (source stays archived here), any restricted test pages from 003 removed
- [ ] FAHRPLAN owner (Björn) sign-off that Phase 1 is done / what gates Phase 2

---

## 4. Test plan

This spec *is* a test plan; its own quality bar:

- Every verdict in `RESULTS.md` links evidence (screenshot, log, timing table) — no unbacked ✅.
- Protocol reproducibility: a second run of Tasks 2–5 from the archived assets must be possible without re-deriving decisions.
- Deviation → fix loops go through the owning spec (004/005) **with a regression test**, never patched ad hoc during a session (CLAUDE.md rule).

## 5. Definition of done

- Tasks 1–6 checked; `RESULTS.md` committed with all four criteria dispositioned.
- All majors fixed-and-retested or explicitly accepted.
- Test data cleaned up; Björn's sign-off recorded.
- Phase-2 input list handed into the next planning round (FAHRPLAN Phase 2).

## 6. Risks and open questions

1. **F1 — Scroll reference availability**: ✅ resolved (Björn, 2026-07-14) — instance/customer available; true A/B. Residual logistics: reference page may need to be replicated on the Scroll-equipped site (data-sensitivity check before copying content there).
2. **Template confidentiality:** if the mayflower template can't live in the repo, store a placeholder-equivalent synthetic template here and keep the real one local — protocol notes which was used.
3. **PDF < 10 s is the shakiest number** (WASM compile + 5 images). The protocol deliberately separates cold/warm and stages the bottleneck analysis so a miss produces an actionable Phase-2 item, not just a red X.
4. **Subjectivity of "visually equivalent":** mitigated by the itemized checklist + three-level scale + screenshots; final arbiter is Björn in the joint session.

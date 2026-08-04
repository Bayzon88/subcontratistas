# Proposed Packages

This is the dependency decision record for the rework. It is organised by *problem*, not by package, because most of the interesting answers are "no package" — and the reasoning for a rejection is worth as much as the reasoning for an adoption. Every measurement labelled **measured** was taken on this machine (macOS, Node v24.15.0, this repo's `node_modules`, 2026‑07‑31); every version number and download count labelled **as of 2026** comes from package research and should be re-checked at install time rather than trusted verbatim.

Read alongside `02-shortcomings.md` (what is broken), `03-expected-output.md` (what the deliverable must contain), and `05-implementation-plan.md` (the order to do it in). Details of the current code are in `01-current-state.md`.

---

## The bar a dependency has to clear

This app runs **once a month, for one operator, on one self-hosted box**. There is no framework, no auth, no database, and there should not be. Every dependency is a thing that can break during the one week a year it matters, and a thing nobody will remember to update.

A package earns its place only if it clears all three of these:

1. **The problem is genuinely subtle.** Calendar arithmetic, OOXML serialisation, zip entry handling. Not "I would have to write a `for` loop."
2. **Getting it wrong fails silently.** A hand-rolled date parser that quietly yields year 0205 is worse than no parser; a hand-rolled RUC check digit that is wrong throws a visible test failure.
3. **A maintained package actually gets the edge cases right.** Several candidates below fail this — they are abandoned, or they solve a different problem than the one the name suggests.

Constraints that eliminate otherwise-good packages before we start:

| Constraint | Source | Consequence |
|---|---|---|
| CommonJS everywhere | every `require()` in `src/*.js` | ESM-only packages (`tinypool`, `read-excel-file`, `@office-kit/xlsx`, `valibot`) need a dynamic `import()` or an ESM migration |
| No build step | `package.json` has no `build` script; CI runs `npm run build --if-present` | anything needing a transform pipeline (vitest, TypeScript) drags in a toolchain this repo deliberately does not have |
| Node 22 on the runner | `.github/workflows/subcontratistas.yml` pins `node-version: [22.x]` | `node:test` is available; `@office-kit/xlsx`'s `node >= 22` is satisfiable but leaves no headroom |
| The deliverable is the template | `src/template.xlsx` carries 6 pivot sheets over one cache | any writer that re-serialises pivot parts is disqualified — see §B |

---

## Decision summary

| # | Problem | Recommendation | Verdict | Why |
|---|---|---|---|---|
| A | Read `.xlsx`, header not at A1 | SheetJS `sheet_to_json(ws, { range, defval })` — capability already installed | **adopt (already have it)** | Anchoring is one option, not a library swap. Verified working. |
| B | Write into the template, keep formulas + `Tabla2` + 6 pivot sheets | Keep `xlsx-populate@1.21.0`, **pinned exactly** | **keep** | Only library that provably preserves the pivot parts byte-identically. Verified by SHA-1. |
| C | Resize `Tabla2`, fill formula columns down | ~30 lines against `jszip@3.10.1` (already in the tree) | **keep hand-rolled** | Four string substitutions in a 9,655-byte part. A parser adds risk, not safety. |
| D | Recalculate headlessly so the file has cached values | LibreOffice as a **CI smoke test only**, never in the pipeline | **consider** | Calc mangles pivot caches. Compute the volatile columns in JS instead. |
| E | Day-first date parsing + Excel serial conversion | `dayjs` + `customParseFormat` for text; `XLSX.SSF.parse_date_code` for serials | **adopt** | Strict mode rejects `09/10/205` and `31/02/2026`; SSF is already installed and handles the 1900 leap bug. |
| F | Row validation with error accumulation | `zod` | **adopt** | `safeParse` returns *every* failing field with a path — that is the `Errores` sheet the operator has never had. |
| G | Header normalization / fuzzy matching | 7 lines of `normalize('NFD')` + an explicit alias table | **keep hand-rolled** | Normalization solves every observed case. Fuzzy matching cannot be made safe here — proof in §G. |
| H | RUC check digit / DNI shape | ~10 lines + a unit test | **keep hand-rolled** | Every npm candidate is abandoned with double-digit weekly downloads. |
| I | Safe zip extraction | `adm-zip@0.6.0` (upgrade in place) + your own guards | **adopt** | Clears a HIGH advisory `npm audit` reports today; one call site. |
| J | Logging + operator run report | The `Errores` sheet (no package) first; `consola` or `pino` optional, within-run only | **consider** | The missing capability is data in the artifact, not prettier stdout. |
| K | Testing | `node:test` + a hand-written fixture corpus | **keep built-in** | The suite is now the *primary* correctness gate, which argues for fewer moving parts, not more. Zero deps, zero config, ships inside the Node 22 CI already pins. |
| L | Concurrency / event-loop responsiveness | Tune SheetJS read options + move work off the request | **keep hand-rolled** | Measured whole job ≈ 30 s of CPU. A worker pool saves 20 seconds a month. |

Net: **two genuinely new runtime dependencies** (`dayjs`, `zod`), **one transitive promoted to direct** (`jszip`, already resident via xlsx-populate), **one upgrade** (`adm-zip` 0.5.10 → ^0.6.0), **one registry change** (`xlsx` → the `@e965/xlsx` alias), and **six removals** (`@google-cloud/local-auth`, `googleapis`, `lodash`, `axios`, `exceljs`, `ejs`). The dependency count goes down.

---

## A. Reading `.xlsx` when the header is not at A1

### The problem

`src/excelConsolidation.js:131-133` calls `reader.utils.sheet_to_json(...)` with default options. Defaults mean "header is row 1, table starts at A1". Any preamble row, merged title, logo, or leading blank column and the whole workbook yields garbage keys. This is owner goal #1 and it is factual.

### The recommendation: no new package — use `range`

**Measured on this machine**, against a synthetic sheet with a 3-row preamble and a leading blank column:

```
default sheet_to_json  → keys: ["__EMPTY_1"],  4 rows   ← the exact failure mode
anchored at B4         → keys: [" ruc ","EMPRESA"],  2 rows
```

The anchoring loop is short and uses only APIs already installed:

```js
const XLSX = require("xlsx");

function findAnchor(ws) {                      // first cell whose value normalizes to "RUC"
  const R = XLSX.utils.decode_range(ws["!ref"]);
  for (let r = R.s.r; r <= R.e.r; r++)
    for (let c = R.s.c; c <= R.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell && norm(cell.v) === "RUC") return { anchor: { r, c }, end: R.e };
    }
  return null;                                  // -> fail loudly, name the subcontratista
}

const hit = findAnchor(ws);
if (!hit) throw new MissingHeaderError(folderName, filePath);
const rows = XLSX.utils.sheet_to_json(ws, {
  range: XLSX.utils.encode_range({ s: hit.anchor, e: hit.end }),
  defval: null,      // fixes the omitted-empty-cell data loss (evidence §7)
  raw:    true,      // keep serials as numbers; convert deliberately in §E
});
```

Two gotchas the anchoring does **not** fix, both confirmed in the run above:

- The header comes back **verbatim and untrimmed** — my test returned the literal key `" ruc "`. Normalization (§G) is still yours to write.
- `sheet_to_json` still suffixes duplicate headers `_1`/`_2`. Detect the collision and reject the workbook rather than letting a phantom `ESTADO_1` column exist.

### Runners-up

| Candidate | Why it lost |
|---|---|
| `read-excel-file` (as of 2026: v9.3.5, MIT, the most actively maintained of the family) | Genuinely good at date-cell detection via `numFmt` inspection, but its README states schema mode requires "the first row should be a header row" — the exact constraint we are trying to escape. ESM-only against a CJS app. Treats formula cells with no cached `<v>` as empty, which would make it **unable to read this app's own output** (§B: the writer strips cached values). |
| `exceljs@4.4.0` | Already installed and unused. Reads fine, returns real `Date` objects — but see §B: it must not touch this workbook, and having two Excel libraries in the pipeline for no gain is worse than having one. |
| `node-xlsx` | A thin wrapper that re-exports `xlsx@0.18.5`. Inherits both CVEs. Strictly worse. |
| `xlsx-js-style` | A 2022 fork of SheetJS 0.18.x, frozen, same CVEs. |
| Hand-roll from `unzipper` + `fast-xml-parser` | You would be reimplementing sharedStrings resolution, the styles→numFmt chain that identifies a date, inline strings, shared and array formulas, and the 1900 leap-year bug. SheetJS has 13 years of edge cases in it. No. |

---

## B. Writing into the existing template — the highest-risk decision

### The problem

`src/template.xlsx` is 67 OOXML parts. Among them: `xl/tables/table1.xml` (the `Tabla2` Excel Table, 35 columns, 17 `<calculatedColumnFormula>` elements), one pivot cache (`xl/pivotCache/pivotCacheDefinition1.xml` + `pivotCacheRecords1.xml`), 13 pivot table parts feeding 6 report sheets, plus styles carrying `numFmtId 14` on the date columns. **Measured** in the last generated report, `xl/worksheets/sheet4.xml` (the `Cuadro` sheet) contains **170,254 `<f>` elements**, of which **8,823 are `t="array"`** and **5,070 are `t="shared"`**.

Any writer that re-serialises those parts can silently destroy the deliverable. The report is not the data; the report is the six pivot sheets the client reads.

### The recommendation: keep `xlsx-populate@1.21.0`, and pin it exactly

Not "it's fine", but a specific, mechanical guarantee — **verified by SHA-1 on this machine**, comparing `src/template.xlsx` against `src/reportes/Reporte_Subcontratistas_MAYO_2026.xlsx`:

```
parts: template=67  report=66
only difference in the part list:  ./xl/calcChain.xml  (absent from the report)

xl/tables/table1.xml                      tpl=6b8c5bc851e2  rep=6b8c5bc851e2  MATCH
xl/pivotCache/pivotCacheDefinition1.xml   tpl=82174b01a0a5  rep=82174b01a0a5  MATCH
xl/pivotCache/pivotCacheRecords1.xml      tpl=19dd4018ef90  rep=19dd4018ef90  MATCH
xl/pivotTables/pivotTable1.xml            tpl=b98d784016d0  rep=b98d784016d0  MATCH
xl/pivotTables/pivotTable5.xml            tpl=aa21e94727ee  rep=aa21e94727ee  MATCH
```

**Why** it survives matters more than the fact that it does, because "it worked last month" is not an argument. The mechanism is in the library source:

- `node_modules/xlsx-populate/lib/Workbook.js` keeps the input as a live JSZip archive and calls `this._zip.file(path, …)` for **exactly nine paths**: each worksheet, each worksheet's rels, `[Content_Types].xml`, `docProps/app.xml`, `docProps/core.xml`, `xl/_rels/workbook.xml.rels`, `xl/sharedStrings.xml`, `xl/styles.xml`, `xl/workbook.xml`. Everything else — pivot tables, pivot cache, theme, metadata, tables — rides through as an untouched zip entry.
- `node_modules/xlsx-populate/lib/Sheet.js:17-26` lists `tableParts` in its `nodeOrder` array, i.e. the sheet-level `<tableParts>` node is round-tripped as an **opaque node**, never re-modelled.

That is structurally stronger than any "we support pivot tables" feature claim, because xlsx-populate never parses them at all. The hardest problem in this app is already solved; the breakage described in `02-shortcomings.md` is entirely in *your* clearing and row-count logic.

### The honest risk assessment

**What is actually at risk.** Not the pivots — the nine parts xlsx-populate *does* rewrite. `xl/styles.xml` and `xl/sharedStrings.xml` are the exposure. If a future edit to the template introduces a styles feature the library does not model, that is where corruption would appear, and it would appear as a "needs repair" dialog rather than as wrong numbers.

**Two integrity defects in today's output, both verified by unzipping the report:**

1. **Dangling `calcChain` relationship.** `xl/calcChain.xml` is dropped, but `xl/_rels/workbook.xml.rels` still carries `<Relationship Id="rId15" … Target="calcChain.xml"/>` and `[Content_Types].xml` still declares the `calcChain+xml` override. Excel silently repairs this; stricter consumers may not. Drop both when you drop the part (a jszip patch, §C).
2. **Missing `<dimension>`.** The template's `sheet4.xml` opens with `<dimension ref="A1:AU8824"/>`; the generated report has **no `<dimension>` element at all**. Excel tolerates it. Note it and move on — do not fix it by switching libraries.

**Real costs, measured on this machine:**

| Operation | Time | Memory |
|---|---|---|
| `XlsxPopulate.fromFileAsync('src/template.xlsx')` | 875 ms | heapUsed 413 MB / RSS 636 MB |
| `outputAsync()` | 1,071 ms | RSS peak **933 MB** |

`sheet4.xml` is 43.9 MB uncompressed in the template and 44.0 MB in the output. Budget ~1 GB and ~2 s per report. That is fine for a monthly single-operator run, but it **rules out concurrent runs** and is an independent reason (alongside §L) to move the pipeline off the request thread.

**The maintenance risk, stated plainly.** As of 2026, `xlsx-populate` was last published 2020-03-01 and its repository was last pushed 2024-03-12, with ~157 open issues. It is unmaintained. It works today on Node 24 (measured above) and Node 22 (the CI runner). Mitigations, in order of cost:

- **Pin it exactly** — `"xlsx-populate": "1.21.0"`, no caret. There will be no fixes; there is nothing to gain from a range.
- **Add the OOXML structural assertions** (§K): after every generated report, assert the part list, assert `Tabla2`'s `ref` matches the row count, and assert the 13 pivot parts and the pivot cache still SHA-1-match the template. The `ref` check alone is what would have caught the ghost-row defect years ago.
- **Know your exit.** If it ever breaks, the migration target is `@office-kit/xlsx` (below), not exceljs.

### Runners-up, and why each one loses

| Candidate | Verdict | Reason |
|---|---|---|
| `exceljs@4.4.0` | **Hard no** | It destroys pivot tables. Issue exceljs/exceljs#261 ("Losing formatting/pivot table from loaded file", opened 2017) is still open as of 2026; last release was v4.4.0 in Oct 2023. Migrating the writer to exceljs would **silently delete all 6 pivot sheets** — the deliverable — with no error. It is already installed and unused here; remove it. |
| `xlsx` / `@e965/xlsx` as the writer | **Hard no** | SheetJS CE explicitly does not write styling, pivot tables, or conditional formatting (those are SheetJS Pro). A template round-trip through it strips the report's entire presentation layer. |
| `@protobi/exceljs` (as of 2026: 4.4.0-protobi.10, MIT, actively developed) | **Shelve** | It genuinely solves the general problem: since 4.4.0-protobi.9 it stores raw XML for `xl/pivotTables/*` and the pivot cache and replays it on write. But it is not *your* problem — xlsx-populate already achieves byte-identical preservation on this exact template, so the headline feature buys nothing while costing a 9-dependency library, a pre-release version specifier, and a rewrite of `src/excelReporting.js`. Its own README says "We recommend using official exceljs if you don't need these specific features", and its stated goal is to sunset once upstream merges — you would be pinning to a package designed to disappear. Its FORK.md also documents "pivot tables can be created OR preserved, not both simultaneously". Keep it on the shelf as the fallback if you ever need pivots *plus* something only ExcelJS can do (streaming writes, chart generation). |
| `@office-kit/xlsx` (as of 2026: v0.9.0, MIT, 3 runtime deps, ESM, Node ≥22) | **Consider later** | Architecturally the best fit on paper: it claims byte-identical passthrough for pivot tables and customXml while fully modelling Tables, calculated columns and all four formula kinds, plus a fixed-memory streaming writer that would directly address the 933 MB peak measured above. But the repo was created in 2026, has ~20 GitHub stars and 2 published versions, and its own README opens with "Status: pre-1.0 alpha … APIs may shift before 1.0" — and lists "Template-based fidelity preservation → xlsx-populate" under where existing libraries still win. Do not make a monthly regulatory report the production canary. **Revisit trigger:** 1.0.0 shipped, six months of releases, and a third-party report of a pivot-bearing template surviving a round-trip. |
| `xlsx-template`, `excel4node`, `officegen` | No | Placeholder substitution for small templates; archived in 2022; write-only with no template round-trip, respectively. |

### The fallback: abandon the template entirely

Worth stating explicitly because it is the only option that eliminates OOXML risk outright. Compute all 17 derived columns in JS and emit a flat workbook.

**What you would lose:** the six pivot sheets *are* the deliverable, and there is no JS library that writes pivot tables (SheetJS CE excludes them; exceljs added only limited write-only support in Oct 2023). You would also move ownership of the `Hoja1!$A$2:$B$61` district→zone table (56 curated entries) and the `Hoja1!$L$5:$M$9` contratista→EPC map out of the workbook the business maintains and into code only you can change. That is a governance regression, not just an engineering one.

**Verdict: no — but adopt the hybrid.** The evidence points hard at one specific split:

- **Compute in JS, write as literal values:** `Edad` (V), `Rango Edades` (W), `Bajas2` (AH), `Altas` (AI), `BajasAntiguas` (AG). All five are anchored on `TODAY()` or `TODAY()-30`, and V/W are marked `ca="1"` volatile. That is why a May report reopened in July silently reclassifies itself, and why `Reporte_Subcontratistas_FEBRERO_2026.xlsx` carries a `#VALUE!` bucket with 36 workers in it. Writing literals against an explicit operator-supplied period kills that entire bug class permanently.
- **Leave as formulas:** the 12 lookup/count columns (S, T, U, X, Y, Z, AA, AB, AC, AD, AE, AF). They depend on the business-maintained lookup tables and on whole-column `COUNTIF`/`SUMPRODUCT`, and they are period-independent.

The pivots keep working because they read values, not formulas. And once V/W/AG/AH/AI are literals, the headless-recalculation question in §D drops off the critical path entirely.

---

## C. Resizing `Tabla2` and filling the formula columns down

### The problem

`Tabla2` stays hard-coded at `ref="A1:AI8824"` in every generated report. Consequences: 3,757 ghost rows in `MAYO_2026` that still evaluate all 17 formula columns, and a hard ceiling of 8,823 worker rows.

### The recommendation: no package — ~30 lines against `jszip@3.10.1`

**jszip is already in the tree** as a direct dependency of xlsx-populate (`node_modules/jszip`, v3.10.1, MIT OR GPL-3.0-or-later). Promote it to a direct dependency in `package.json` so your use of it is declared rather than accidental; that is not a new install.

`xl/tables/table1.xml` is **9,655 bytes** and contains **exactly four refs**:

```xml
<table … ref="A1:AI8824">
  <autoFilter ref="A1:AI8824"/>
  <sortState ref="A2:AI8824"><sortCondition ref="C1:C8824"/></sortState>
```

Rewriting all four to the real last row is a pure string substitution on one small part. Nothing else in the archive needs to change **for the table**, and — crucially — the pivot cache does not need touching either, because `pivotCacheDefinition1.xml` declares `<cacheSource type="worksheet"><worksheetSource name="Tabla2"/></cacheSource>`. It binds to the **table name**, not to a range. Resize `Tabla2` and every pivot follows.

```js
const JSZip = require("jszip");

async function patchWorkbook(buf, { lastRow }) {
  const zip = await JSZip.loadAsync(buf);
  const end = 1 + lastRow;                       // header + n data rows

  let table = await zip.file("xl/tables/table1.xml").async("string");
  table = table.replace(/ref="A1:AI\d+"/g,  `ref="A1:AI${end}"`)
               .replace(/ref="A2:AI\d+"/g,  `ref="A2:AI${end}"`)
               .replace(/ref="C1:C\d+"/g,   `ref="C1:C${end}"`);
  zip.file("xl/tables/table1.xml", table);

  // Pivots rebuild on open instead of showing last month's cache. Verified absent today.
  const pcd = "xl/pivotCache/pivotCacheDefinition1.xml";
  let cache = await zip.file(pcd).async("string");
  if (!/refreshOnLoad=/.test(cache))
    cache = cache.replace("<pivotCacheDefinition ", '<pivotCacheDefinition refreshOnLoad="1" ');
  zip.file(pcd, cache);

  // Drop the dangling calcChain relationship + content-type override (§B).
  // …same pattern on xl/_rels/workbook.xml.rels and [Content_Types].xml

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
```

**Three details that will bite you:**

1. **`refreshOnLoad` is genuinely absent today.** Verified: `pivotCacheDefinition1.xml` in the template reads `refreshedBy="Alvaro" refreshedDate="45566.353735300923" … recordCount="5070"` — 1 October 2024 — with no `refreshOnLoad` attribute. That single missing attribute is why five of fourteen archived reports still display September‑2024 numbers. One string replace fixes it.
2. **`<calcPr>` has no `fullCalcOnLoad`.** Verified: `xl/workbook.xml` reads `<calcPr calcId="191029"/>` in both template and report. If you keep any period-dependent formulas, add `fullCalcOnLoad="1"` here too.
3. **One computed column is a real array formula.** `Trabajdores Unicos Zona Influencia` carries `<calculatedColumnFormula array="1">` — verified in `table1.xml`. If you ever regenerate rows rather than reusing the template's existing 8,823, you must preserve the `t="array"` / `ref` attributes on that column and keep shared-formula `si` groups consistent (or expand them to plain `<f>`).

**You do not need to mirror the 17 formulas in JS.** `table1.xml` already carries the canonical text for each in `<calculatedColumnFormula>` — e.g. `EPC/CJV` is `IFERROR(VLOOKUP(Tabla2[[#This Row],[CONTRATISTA PRNCIPAL]],Hoja1!$L$5:$M$9,2,FALSE),"CJV")`. Read them from the template at run time; that makes the template self-describing instead of something JS has to stay in sync with.

**Clearing the surplus rows:** xlsx-populate's `Sheet` has no row-delete API (verified — it has `Sheet.delete()` for whole sheets, and `Cell.clear()`). Use `cell.clear()` across A..AI on rows `lastRow+2 … 8824`, which removes the `<c>` elements rather than writing `""` into them, then shrink the `ref`. That is the fix for the 3,757 ghost rows.

### Runners-up

- `exceljs`'s `worksheet.addTable()` / `table.commit()` — unusable, because loading the workbook destroys the pivots (§B).
- `fflate` (as of 2026: zero deps, faster and lighter than jszip) — genuinely better in isolation, but jszip is already resident in memory via xlsx-populate. Adding fflate buys nothing on a monthly job.
- `fast-xml-parser` for a parse–mutate–serialise cycle — see §"not adding". A regex over four known refs is *more* predictable than round-tripping XML through a different serialiser's attribute ordering and entity escaping.

---

## D. Recalculating formulas headlessly

### The problem

The generated report has cached `<v>` values stripped from rewritten formula cells and no `xl/calcChain.xml`. Nothing downstream can read real numbers without an Excel round-trip. That is why the only way anyone discovers a broken report is by opening it.

### The recommendation: LibreOffice as a **CI smoke test**, never as a pipeline step

`libreoffice --headless --convert-to xlsx`, optionally wrapped by `libreoffice-convert` (as of 2026: v1.8.2, MIT, a thin `child_process` wrapper over `soffice`). **I could not test this** — LibreOffice is not installed on this machine — so this is research, not measurement, and you should benchmark before trusting it.

Two reasons it must not be in the pipeline:

1. **Recalculation is not automatic.** LibreOffice's default on loading a foreign format is "Never recalculate". Forcing it requires editing `registrymodifications.xcu` or driving a Basic macro — brittle infrastructure for a monthly job.
2. **Decisive: Calc does not treat `pivotCacheRecords` the way Excel does.** Pushing a workbook with 13 pivot tables and a multi-megabyte pivot cache through Calc and back out to `.xlsx` is a real risk of shipping a corrupted compliance report. There is also the structured-reference surface: Calc does understand `Tabla2[[#This Row],[FECHA NACIMIENTO]]`, but round-tripping **170,254 formula elements** (measured) through a different engine's parser and serialiser is a large uncontrolled change.

**Where it is actively worth having:** a smoke test. After generating a report, convert a *copy* headlessly and assert the process exits 0 with no repair diagnostics. That catches the "Excel says the file needs repair" class of regression — the dangling `calcChain` rel, a malformed `Tabla2` ref — which is currently undetectable until the operator opens the file.

**The better answer is upstream.** If you take the §B hybrid and write `Edad`, `Rango Edades`, `Bajas2`, `Altas` and `BajasAntiguas` as literal values, and set `refreshOnLoad="1"` (§C), then the acceptance test in `03-expected-output.md` — *read the delivered file with SheetJS and get the same headline numbers a human sees* — becomes achievable without any recalculation engine at all.

### Runners-up

| Candidate | Why it lost |
|---|---|
| `hyperformula` (as of 2026: v3.3.0, actively developed, ~2,750 stars) | **Cannot parse this template.** All 17 computed columns use `Tabla2[[#This Row],[…]]`, and HyperFormula does not support the `[#This Row]` / `[#All]` / `[#Data]` structured-reference keywords. The tracking issues (handsontable/hyperformula#126 and #241) have been open since early 2020. Separately, the licence is a trap: npm reports `GPL-3.0-only`, GitHub reports NOASSERTION, and its `LICENSE.txt` says the applicable licence is determined by the licence key you apply. Workable for an internal non-distributed tool, but that should be a deliberate decision, not one inherited from a dependency choice. |
| `@formulajs/formulajs` | A *function library*, not an evaluator — no parser, no cell references, no table references. If you are calling `VLOOKUP()` by hand you are writing JS, so it adds nothing over plain code. (Never install the unscoped `formulajs` — 2016 abandonware.) |
| `fast-formula-parser` | Has a real grammar; last published 2020. Abandoned. |
| `xlsx-calc` | Evaluates SheetJS workbooks in place, but partial function coverage and no claim to structured references or array formulas — and there are 8,823 `<f t="array">` elements here (measured). |
| Excel via COM/AppleScript | Highest fidelity; requires an Excel-licensed host, which defeats the Linux pm2 runner. |

**If your real goal is "assert in CI that the report is correct":** do not evaluate the template. Compute the handful of metrics anyone actually checks — headcount, Altas, Bajas, Zona de Influencia share — directly from the consolidated JSON *before* it is written, and assert on those. That is a dozen lines and covers every number in the acceptance table in `03-expected-output.md`.

---

## E. Day-first date parsing and Excel serial conversion

### The problem

Owner goal #2. Roughly 200 of 5,065 rows carry text dates: `"04/07/1994"`, `"14/2/1989"`, `"3/5/1965"`, `"30/1/26"`, plus the malformed `"09/10/205"`. `src/excelConsolidation.js` has **no date handling at all** — whatever SheetJS produced goes straight through into date-formatted columns F/M/O. Those rows produce `#VALUE!` in `Edad` and `Rango Edades` (neither is wrapped in `IFERROR`) and fall into the `IFERROR(…,"No aplica")` fallback for `Bajas2`/`Altas`, i.e. they are silently dropped from the Altas/Bajas counts.

There are two distinct sub-problems and they get different answers.

### E1. Text → calendar date: adopt `dayjs` + `customParseFormat`

As of 2026: `dayjs@1.11.x`, MIT, very actively maintained, CommonJS (`type: commonjs`) — matches this app's `require()` style with zero interop work. The package is ~680 KB on disk but almost all of that is locale files Node never loads; the two files actually required are `dayjs.min.js` (~7 KB) and `plugin/customParseFormat.js` (~4 KB).

```js
const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/customParseFormat"));

const FORMATS = ["DD/MM/YYYY","D/M/YYYY","D/M/YY","DD-MM-YYYY","D-M-YYYY","DD.MM.YYYY","D.M.YYYY"];

function parseTextDate(raw, { allowTwoDigitYear }) {
  const s = String(raw).trim();                    // strict mode rejects untrimmed input
  const fmts = allowTwoDigitYear ? FORMATS : FORMATS.filter(f => !/YY$/.test(f));  // see the rule below
  const d = dayjs(s, fmts, true);                  // 3rd arg = STRICT
  return d.isValid() ? { y: d.year(), m: d.month() + 1, d: d.date() } : null;
}
```

Why dayjs rather than the alternatives — research verified all of these against the exact strings in the evidence file:

- It is the only candidate that takes an **ordered array of candidate formats natively**; the others need a hand-written loop.
- Strict mode enforces **token width**, which is what actually rejects the garbage: `09/10/205`, `31/02/2026`, `32/01/2026` and `13/13/2020` are all rejected, while `04/07/1994`, `14/2/1989`, `3/5/1965`, `30/1/26`, `15-03-2020` and `15.03.2020` all parse day-first and correctly.

| Runner-up | Why it lost |
|---|---|
| `date-fns` (as of 2026: v4.4.x, MIT, the most-downloaded of the family) | **Silently invents ancient years.** Its `yyyy` token is not width-strict: `parse('09/10/205','dd/MM/yyyy')` yields **year 0205** and `parse('30/1/26','dd/MM/yyyy')` yields **year 0026**. Both are valid-looking `Date` objects that convert to Excel serials Excel cannot represent. That is precisely the silent-corruption class this rework exists to eliminate. The documented workaround is a round-trip guard (`format(parsed, fmt) === input`) — extra hand-rolled code to buy back strictness dayjs gives for free. |
| `luxon` (as of 2026: v3.7.x, MIT, zero runtime deps) | The only real rival, and the closest call in this document. Its `yyyy` **is** width-strict, its `invalidReason` / `invalidExplanation` messages are the best of the four and directly usable in an operator error report, and it is the only library with a configurable two-digit-year pivot (`Settings.twoDigitCutoffYear`, global — passing it to `fromFormat` has no effect). It lost on three counts: no native ordered-format-list API, its `yy` token is *not* width-strict (`fromFormat('09/10/205','dd/MM/yy')` → year 0205), and the domain rule below neutralises its pivot advantage. **If you would rather configure than write a rule, swap it in** — the surrounding code is identical. |
| `chrono-node` | **Wrong tool.** It extracts dates from natural language rather than validating a whole string, and it is aggressively lenient by design: under `chrono.es` it resolves `'hoy'`, `'mañana'`, `'lunes'`, `'15 de marzo'` (inventing the year from the run date) and `'30/1/26 aprox'`. A worker whose `FECHA NACIMIENTO` cell says `hoy` would silently get age 0. Worse, because it anchors on the run date, re-running in a different month gives a different answer — the same bug class as `TODAY()-30`. Its one legitimate use is a **report-only** last tier that turns "unparseable" into "looks like it might mean X — confirm with the subcontratista". Never auto-accepted. If you do add it, use `chrono.es` explicitly; the default export is `chrono.en` and flips day/month on every `dd/mm` value in this dataset. |
| Hand-rolling | Defensible — the format set is closed and one regex `/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/` covers every observed shape. But you would then hand-roll calendar validation for `31/02` and leap years, which is exactly the boring, easy-to-get-wrong part a ~11 KB dependency removes. |

**The two-digit-year rule is yours, not the library's**, because the correct pivot is a property of the *column*, not of the string. All three libraries pivot differently and all three are wrong for at least one column (dayjs uses the JS `Date` rule: `26`→2026, `68`→**2068**, `69`→1969). Only one two-digit shape was observed in the entire corpus (`30/1/26`, a recent date), so:

- **`FECHA NACIMIENTO`: reject two-digit years outright** → error report. There is no way to distinguish `3/5/65` meaning 1965 from a typo, and a birth date feeds the `Edad` and `Rango Edades` pivots this whole report exists to produce.
- **`FECHA INICIO DE LABORES` / `FECHA CESE/BAJA`: accept**, expanding to the current century. A hire date of `26` cannot mean 1926.

Layer a **domain plausibility check** on top regardless — this is what actually catches errors, and it is ~10 lines:

| Column | Accept range | Rationale |
|---|---|---|
| `FECHA NACIMIENTO` | `[today − 80y, today − 16y]` | mirrors the template's own `Edad` guards, which flag <18 and >80 as `"Corregir"` |
| `FECHA INICIO DE LABORES EN OBRA` | `[project start, today + 1 month]` | `FEBRERO_2026` contains a cese date of 46235 = 2026‑08‑01, a *future* date |
| `FECHA CESE/BAJA` | same | |

### E2. Calendar date → Excel serial: no package, you already have both halves

**Reading.** `XLSX.SSF` is already exposed by the installed `xlsx@0.18.5` — **measured on this machine**:

```
SSF.parse_date_code(34456) → { y:1994, m:5, d:2, H:0, M:0, S:0 }
SSF.parse_date_code(60)    → { y:1900, m:2, d:29 }        ← Excel's fictitious leap day, correctly reproduced
SSF.is_date('dd/mm/yyyy')  → true
```

`parse_date_code` returns **components, not a `Date`**, which sidesteps the timezone trap entirely. That matters: SheetJS with `cellDates: true` builds *local-midnight* `Date` objects, so `.toISOString().slice(0,10)` shifts by a day on a host in a positive-offset timezone. Nobody has audited the pm2 box's `TZ`.

The naive hand-rolled formula `new Date(Date.UTC(1899,11,30) + n*86400000)` is off by one for every serial ≤ 60 (it gives serial 1 → 1899‑12‑31). For serials ≥ 61 the two agree exactly, so the 1900 bug cannot realistically affect a worker birth date — but a stray 0, a blank coerced to a number, or a mistyped small value would silently become 1899/1900 instead of being flagged.

**Writing.** `xlsx-populate` already handles it: `lib/dateConverter.js` `dateToNumber(date)` explicitly adjusts for `incorrectLeapDate` (verified in source), and `Cell.value()` converts any `Date` you pass into a serial automatically.

```js
// read side — no Date, no timezone
const { y, m, d } = XLSX.SSF.parse_date_code(serial);

// write side — local-time Date, matching xlsx-populate's own local-based converter
cell.value(new Date(y, m - 1, d));      // NOT new Date(Date.UTC(...))
```

**Pick one timezone convention and hold it.** xlsx-populate's `dateConverter` is local-based (`new Date(1900,0,0)`, `setHours(0,0,0,0)` — verified in source), and SheetJS `cellDates` is local-based too. They are consistent **only if you stay in local time end to end**. The safest pattern is above; alternatively pin `TZ=America/Lima` in the pm2 environment and stop thinking about it.

Three more notes:

- **Read the 1904 flag rather than assuming it.** `wb.Workbook.WBProps.date1904` — **measured `false`** on `src/Formato Reporte subcontratas.xlsx`. Peruvian subcontratistas on Windows Excel will effectively always be 1900-system, but a workbook authored on legacy Mac Excel would be off by exactly 1,462 days, which looks like plausible data. One explicit check costs nothing and makes the failure loud.
- **Truncate the time component.** **1,280 cells** in the last run carry fractional serials — 643 in `FECHA NACIMIENTO` (F), 637 in `FECHA INICIO DE LABORES EN OBRA` (O), none in `FECHA CESE/BAJA` (M) — across 850 distinct values, at two offsets: **586 at `.791666…` (19:00)** and **694 at `.833333…` (20:00)**, e.g. `45575.833333333336`. All 1,280 sit inside the 643-row header-shift block and none anywhere else, so this is one broken export rather than a general phenomenon — but date-only truncation is required regardless, before any equality comparison against the period bounds.
- **Stop writing `""` into `FECHA CESE/BAJA`.** `src/excelConsolidation.js:257-259` force-writes an empty *string* into a date-formatted column; that is why the template's `Bajas2` needs its load-bearing `IFERROR(…,"No aplica")` wrapper. Leave the cell genuinely empty. `.value(date)` writes only `<v>` and does not touch the cell style — fine here, because columns F/M/O already carry `numFmtId 14`.
- `ssf@0.11.2` (Apache-2.0) is the same code standalone if you ever leave the SheetJS family.

---

## F. Row schema validation with error accumulation

### The problem

There is no validation layer at all. The `switch` statements in `src/excelConsolidation.js:150-256` fall through to `parseInt()` and write `NaN` into the workbook, which breaks the pivots silently. The observed damage is concrete: `ESTADO` contains `184` and `160`; `TIPO DE CONTRATO LABORAL` contains `0`, `0.03`, `5`, `10`, `11`, `14`; `GENERO` contains the literal string `"undefined"` ten times (from `String(undefined).toLowerCase()` at line 181), which materialised as a **third gender column** in the `OCTUBRE_2025` pivots and silently broke the `+F53/$F$60` percentage formula.

Validation must never throw on the first failure — the whole point is a per-row, per-field list the operator can act on.

### The recommendation: `zod`

As of 2026: `zod@4.x`, MIT, zero runtime dependencies, dual ESM/CJS with `main: ./index.cjs`, so `require('zod')` works as-is. Very actively maintained.

Research benchmarked it on 5,065 synthetic rows shaped like this data: **11.9 ms** for the full corpus, finding 1,423 bad rows and 1,575 issues. Performance is a non-issue at this scale.

What earns the dependency is not the parsing — it is that `safeParse` collects **all** failing fields in one pass by default, each with a usable `path`, `code` and `message`:

```
path=["RUC"]                code=invalid_format
path=["Nro. DNI / CE"]      code=invalid_format
path=["FECHA NACIMIENTO"]   code=invalid_type
path=["GENERO"]             code=invalid_value
```

That maps one-to-one onto the `Errores` sheet described in `03-expected-output.md` — columns (archivo, subcontratista, fila, celda, columna, valor crudo, motivo). It also replaces the hand-rolled `switch` normalization declaratively, which fixes two confirmed bugs at the same time: `GENERO`'s switch compares a lowercased string against numeric `case 1:` branches (unreachable), and `TIPO DE CONTRATO LABORAL`'s switch runs on the **untrimmed raw** string, unlike every other switch.

```js
const z = require("zod");

const RowSchema = z.object({
  "RUC":            z.preprocess(asText, z.string().regex(/^\d{11}$/).refine(rucCheckDigit, "check digit"))
                     .nullable(),
  "Nro. DNI / CE":  z.preprocess(asText, z.string().min(8)).nullable(),
  "FECHA NACIMIENTO": z.preprocess(asDate, z.date()).nullable(),
  "GENERO":         z.enum(["masculino", "femenino"]).nullable(),
  "ESTADO":         z.preprocess(asEstadoCode, z.union([z.literal(1), z.literal(2), z.literal(3)])).nullable(),
  // …
});

const result = RowSchema.safeParse(row);
if (!result.success) errores.push(...result.error.issues.map(i => ({
  archivo: row.__file, fila: row.__sourceRow, celda: a1(row.__sourceRow, i.path[0]),
  columna: i.path[0], valorCrudo: row[i.path[0]], motivo: i.message,
})));
```

**Use `z.preprocess`, not `z.coerce`.** You want the *raw* cell value available for the error report, and `z.coerce.number('')` quietly yields `0`.

**Keep the A1 address alongside each row.** An issue at `path=['FECHA NACIMIENTO']` should report as "F1743 in `MCON PERU/personal.xlsx`". That is what makes the report actionable rather than merely accurate. Preserve `errorEnArchivo` as the file-level key — it already exists in `readFileToJson` and is deleted before it reaches the output by the cleanup loop at `src/excelConsolidation.js:60-66`.

### Runners-up

| Candidate | Why it lost |
|---|---|
| `valibot` (as of 2026: v1.x, MIT, zero deps) | Genuinely competitive and research measured it **faster** — 3.1 ms vs zod's 11.9 ms on the same corpus, with identical issue counts and equally good paths. It lost on one thing only: it is ESM-first (`main: ./dist/index.mjs`, no CJS entry), which forces an ESM migration or a dynamic `import()` in a codebase that is entirely `require()`. **If you convert to ESM anyway, valibot is the better pick.** |
| `ajv` | JSON Schema is a poor fit for coercion pipelines, `allErrors: true` is off by default and carries a documented DoS caveat, and you would author schemas in JSON instead of JS. Its enormous download count is transitive-dependency noise. |
| `yup` | Smaller, but `abortEarly: false` is opt-in, error paths are stringly-typed, and it is the least actively released of the three. |
| `superstruct` | Last published 2024. Stale. |
| Hand-rolling | Defensible — 18 fields, simple rules. But you would be rebuilding issue collection, path tracking and coercion ordering, which is precisely the code that already went wrong in the `switch` statements. |

---

## G. Header normalization and fuzzy matching

### The problem

`dataColumns.indexOf(key)` at `src/excelConsolidation.js:66` is exact, case-sensitive, accent-sensitive and whitespace-sensitive. `"DISTRITO SEGUN DNI"`, `"Distrito segun DNI "` and `"RUC "` all fail to match, the key is deleted by the cleanup loop, and the column comes out **silently blank**.

### The recommendation: no package — 7 lines plus an explicit alias table

```js
const norm = s => String(s)
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")  // strip accents
  .replace(/\s+/g, " ").trim().toUpperCase();
```

Research ran exactly that against the real variants: `"DISTRITO SEGUN DNI"`, `"Distrito segun DNI "`, `"DISTRITO SEGÚN DNI"` and `"  distrito  según   dni"` **all collapse to the same string**, and `"RUC "` / `"Ruc"` both collapse to `"RUC"`. That is every formatting case the owner raised, with zero dependencies and zero fuzzy-matching risk.

Build a `Map` from normalized header → canonical column, seeded with the 18 canonical names plus a **hand-maintained alias table**. The one case normalization cannot solve is the codebase's existing alias — `CONTRATISTA PRINCIPAL` vs the canonical typo `CONTRATISTA PRNCIPAL` — because that is a genuine spelling difference, not a formatting one. It belongs in an explicit table where it is greppable, reviewable, and where the run report can log "accepted alias X as Y". A fuzzy matcher would resolve it by accident and give you no audit trail.

This is also where owner goal #1 lands: **anchor on the first cell whose normalized value is `"RUC"`, use that cell's row as the header row and its column as the left edge, then map the remaining headers through the same normalizer.** Header-row anchoring and header-variant tolerance become one mechanism (§A).

### On "did you mean" hints: `fastest-levenshtein`, optional

As of 2026: MIT, ~21 KB unpacked, zero dependencies, ships both CJS and ESM. Last published 2022 — stale by date, but it is a single pure function implementing a fixed algorithm, with no API to drift.

Research measured pairwise Levenshtein distances across the 18 canonical headers after normalization. The minimum inter-header distance is **3** (`RUC` vs `HPT`), so a threshold of **distance ≤ 2 is provably unambiguous** — it can never map one canonical column onto another — and `distance('CONTRATISTA PRNCIPAL','CONTRATISTA PRINCIPAL') = 1` sits comfortably inside it.

But the same measurement is why it must never auto-apply: `distance('FECHA NACIMIENTO','FECHA DE NACIMIENTO') = 3`. The single most plausible real-world header variant falls **outside** the provably-safe threshold, and widening to 3 would make `RUC` and `HPT` interchangeable. Distance matching cannot replace the alias table; it can only decorate the error message.

**Verdict: optional polish.** If you skip it, the error report must still list every unrecognised header verbatim alongside the 18 canonical names, which gets the operator ~90% of the way there. Hand-rolling Levenshtein is ~15 lines and equally fine.

### Runners-up

- `remove-accents`, `diacritics` — exist solely to do the NFD strip. One line of built-in JS.
- `fuse.js` — a ranked full-text search engine. It **always returns a best match with a score and never says "no"**, which is the opposite of what a schema mapper needs.
- `didyoumean2` — drags in `@babel/runtime`, `fastest-levenshtein` *and* `lodash.deburr` for what is one `Map` lookup.
- `string-similarity` — author-deprecated, last published 2021.

---

## H. Peruvian RUC / DNI validation

### The problem

Neither is validated anywhere. 659 of 5,065 rows have no RUC; 723 have no DNI; and numeric coercion is destroying leading zeros (`09994533` → `9994533`).

### The recommendation: hand-roll it — ~10 lines and a unit test

The SUNAT RUC check digit: weights `[5,4,3,2,7,6,5,4,3,2]` against the first 10 digits, sum, `r = 11 - (sum % 11)`, map `10 → 0` and `11 → 1`, compare to digit 11. DNI is `/^\d{8}$/` after zero-padding.

Research verified an implementation against three known-real Peruvian RUCs (SUNAT `20131312955`, Telefónica del Perú `20100017491`, Backus `20100113610` — all pass), then ran it over the distinct RUC values in `src/ReporteConsolidado.xlsx` — 4,406 populated cells, 148 distinct raw values, 147 after trimming, **146 distinct non-blank trimmed values**: **122 pass, 23 fail the check digit, 1 fails the format check.** That is ~16% of distinct RUCs carrying a real data error today, entirely invisible to the current pipeline. Four of the failures are the near-consecutive run `20504039123 / …125 / …127 / …130` — for that prefix the only valid check digit is `0`, so these look like fabricated or incremented placeholders.

**There is no maintained package.** Every candidate is an abandoned single-maintainer project with double-digit weekly downloads: `ruc-peru` (last published 2021, and it is an *API client* that queries SUNAT over the network — a network call per row is a non-starter), `peru-utils` (2023), `validate-ruc` (2015), `@kembec/sunat-utils` (2024). Taking any of them is strictly worse than owning 8 lines you can unit-test. The generic `validator` package has no Peruvian identifier support, and the Spanish-DNI packages (`better-dni`, `dni-js`, `@polgubau/validar-dni`) implement the Spanish letter-suffix algorithm — a completely different scheme that would reject every valid Peruvian DNI.

**The leading-zero problem is upstream of validation and matters more.** 1,356 DNI cells arrive as *numbers*, so `09994533` is already `9994533` before your code sees it. Read the cell as text (or zero-pad to 8) **before** validating. Research measured the length distribution over 4,342 non-empty DNI values: **4 at 7 characters** (the leading-zero casualties), **4,202 at exactly 8**, **134 at 9**, **2 at 10**. Only the 134 nine-digit values are the plausible CE (Carné de Extranjería) population — typically 9 digits with leading zeros; the 7- and 10-character values are damage, not a second document type. **DNI validation must be conditional on document type**, not a blanket 8-digit rule; flag the 9-digit values as CE, not as errors.

Also worth knowing: the template's `ValidarDNI` column (AA) does not validate the DNI — it is a copy-paste of the `Validar Genero` formula. Real DNI validation has to happen in JS regardless of whether you fix the template formula.

---

## I. Safe zip extraction

### The problem

`src/app.js` calls `AdmZip.extractAllTo(src/subcontratistas, true)` with `adm-zip@0.5.10` installed: no size limit, no entry-count limit, no type validation, and `express-fileupload` buffering the whole upload in memory with no cap.

### The recommendation: upgrade to `adm-zip@0.6.0` and add your own guards

**Verified by running `npm audit` in this repo:**

```
adm-zip | high | range <0.6.0 | fixAvailable {"name":"adm-zip","version":"0.6.0","isSemVerMajor":true}
  GHSA-xcpc-8h2w-3j85 — Crafted ZIP file triggers 4GB memory allocation
```

The live exposure is **not** zip-slip, it is memory. Given the app already peaks near **933 MB RSS** during report generation (measured, §B), a 4 GB allocation is an immediate OOM on the pm2 runner.

Worth correcting the evidence file's traversal concern with what the installed code actually does: **verified** at `node_modules/adm-zip/adm-zip.js:606`, `extractAllTo` routes every entry through `sanitize(targetPath, canonical(entry.entryName.toString()))`. The *library* mitigates path traversal even though the *app* asks for nothing. 0.6.0 keeps that behaviour. So this is a memory fix, not a traversal fix — but it is still a HIGH with a one-call-site remedy.

The guards that remain yours regardless of library:

```js
const MAX_ZIP_BYTES     = 200 * 1024 * 1024;
const MAX_ENTRIES       = 500;
const MAX_UNCOMPRESSED  = 1024 * 1024 * 1024;

const zip = new AdmZip(uploadedFilePath);
const entries = zip.getEntries();
if (entries.length > MAX_ENTRIES) throw new UploadRejected("too many entries");
const total = entries.reduce((n, e) => n + e.header.size, 0);
if (total > MAX_UNCOMPRESSED) throw new UploadRejected("zip bomb");

for (const e of entries) {
  if (e.entryName.startsWith("__MACOSX/") || path.basename(e.entryName).startsWith("._")) continue;
  if (e.isDirectory) continue;
  if (!e.entryName.toLowerCase().endsWith(".xlsx")) { warn(e.entryName); continue; }
  zip.extractEntryTo(e, targetDir, /* maintainEntryPath */ true, /* overwrite */ true);
}
```

The `__MACOSX/` skip is not hypothetical: macOS zips always add that folder, and `consolidateExcelFile` is handed the *array* from `readdirSync` and string-concatenates it into a path — it only works because the array happens to have one element. Two top-level entries silently corrupt the path.

**0.6.0 is a semver-major bump.** Check the `extractAllTo` signature and error behaviour before shipping. Since it is one call site, this is a 20-minute change. Fix the two adjacent defects in the same commit: `${uploadDestination}${uniqueFilename}` needs `path.join` (its absence is why the 0-byte `subcontratistas1741059493565_Febrero-2025` file is committed in the repo root), and stop passing an array where a string is expected.

### Runners-up

| Candidate | Why it lost |
|---|---|
| `yauzl` | The correctness benchmark — it does no automatic extraction at all, forcing you to validate every `entry.fileName` yourself, which is exactly the discipline you want. Cost: a callback-based streaming API, so ~40 lines of glue. A reasonable choice; it loses only because the adm-zip upgrade is a one-line diff. |
| `node-stream-zip` | The best middle ground if you want off adm-zip entirely: promise API, random access, `extract()` with path checks, zero deps, no advisories as of 2026. |
| `unzipper` | Fine post-0.8.13, but drags in bluebird + fs-extra + graceful-fs. |
| `extract-zip` | yauzl-based and safe, but has not been published since 2020. |
| `decompress` | **Disqualified.** Carries GHSA-mp2f-45pm-3cg9 (**CRITICAL**, zip-slip) and GHSA-h39j-r5qq-r9mm, both with no patched version, last published 2020. Never use it. |

---

## J. Logging and the operator run report

### The problem

`console.log("Error with: " + directory)` in `src/excelConsolidation.js:75` is the entire diagnostic for an entire subcontratista's workforce vanishing — and `console.clear()` is called per-directory at line 284, inside the server process, wiping even that. The critical missing capability is not prettier output; it is that **a failed workbook is currently indistinguishable from a subcontratista with zero workers.** The output looks complete.

### The recommendation: split it in two

**(a) The operator report — generate it as data, not logs. No package.** An extra `Errores` sheet written into the output workbook (or a sibling CSV) with columns *(archivo, subcontratista, fila, celda, columna, valor crudo, motivo)*, driven off the zod issue list from §F. You are already writing `.xlsx`; this is a data problem and needs a data answer that ships inside the artifact the operator opens. A log file on the pm2 host solves nothing for someone working in Excel.

**(b) The process log — optional, and a within-run developer convenience only.** One structured line per workbook, emitted to stdout (pm2 already captures it) so that a developer watching a run of ~100 workbooks can see which one is being read and which one failed, in order, while the run is still going. **Nothing depends on this outliving the run, and no retention period is set for it** — the owner has decided that keeping historical logs is not required (`03-expected-output.md` §8.1, `05-implementation-plan.md` §7 step 9), so there is no `logs/` directory, no dated files, no rotation and no archive.

That decision removes the argument that used to settle this row. Newline-delimited JSON was worth a dependency when it made "which subcontratistas failed in the last six months" a grep; there is now no such history to grep, and the only reader is a person watching one run. What is left is a narrower comparison: `pino` (as of 2026: v10.x, MIT, CJS, actively maintained) still buys one machine-readable object per workbook — subcontratista, archivo, rows read, rows rejected, reason — which is the shape `03-expected-output.md` §8.1 describes for the optional log and which stays parseable if the run is piped somewhere during a debugging session; `consola` (zero dependencies) buys readable output with no transitive tree at all. **On cost alone the dependency-free option wins, and plain `console` is fully defensible for a once-a-month single-operator tool** — take `pino` only if you actually want the per-workbook object, and never treat it as a deliverable. Either way this is the last item in `05-implementation-plan.md` Phase 5, after items 1–8.

### Runners-up

| Candidate | Why it lost / when it wins |
|---|---|
| `consola` (as of 2026: MIT, **zero dependencies**, dual ESM/CJS) | Not really a runner-up any more — with no log history to grep it is the co-favourite: zero deps against pino's transitive tree, nicer human-readable output out of the box, and for a single-operator tool nobody greps, the structured-JSON advantage is largely theoretical. **If you want one line changed and no dependency tree, take consola.** |
| `winston` | Heavier configuration for no benefit here. |
| `pino-pretty` | Dev-only if you take pino; do not ship it (it adds a further dependency tree). |
| Plain `console` | Genuinely defensible for a once-a-month single-operator tool — **provided** you delete the `console.clear()` call and stop swallowing errors. |

**Honest ranking:** (1) stop swallowing errors — `src/excelReporting.js:61-63` catches, logs, and returns normally, so `src/app.js` still answers `200 OK` and offers a download for a report that was never written; (2) build the `Errores` sheet; (3) *maybe* add a logger. Steps 1 and 2 need no dependency and deliver almost all the value. Whichever you pick, emit a per-run summary the operator can read: files seen, files parsed, files that failed and why, rows in, rows rejected, rows written.

---

## K. Testing

### The problem

Zero tests, no test script (`package.json` has `"test": "echo \"Error: no test specified\" && exit 1"`), no fixtures. The rework touches date coercion, header anchoring, checksum validation and dedup — all pure functions over messy real inputs. That is the ideal shape for tests, and the absence of them is why the current defects went unnoticed for years.

**This decision carries more weight than it did when it was first written.** Nothing is retained between runs — no archived inputs, no logs, no reproducing a past month — so the test suite is not a supplement to some other proof of correctness, it *is* the offline proof. `05-implementation-plan.md` §4 splits verification in two: (1) the fixture corpus, the pure-function case tables and the structural assertions on the generated workbook, all of which live in this runner; and (2) the parallel-run cutover, where one operator upload is processed by both pipelines in the same job and the two outputs are diffed. Everything in part (1) is a dependency question, so re-argue it on those terms.

### The recommendation: `node:test` — and the case gets *stronger*, not weaker, now that the suite is the primary gate

Zero dependencies, zero config, present in Node 22 (the CI runner) and Node 24 (this machine). Add, matching `05-implementation-plan.md` Phase 0 task 1:

```json
"scripts": {
  "test":     "node --test src/test/",
  "test:cov": "node --test --experimental-test-coverage src/test/"
}
```

Research verified it end-to-end here: a fixture test that reads `src/Formato Reporte subcontratas.xlsx` via SheetJS and asserts the row count (4,808 — **I reproduced that count independently**) passes in ~1 s (1,076 ms), and `--experimental-test-coverage` produces a per-file line/branch/function table in the same run.

CI already runs `npm ci` then `npm run build --if-present`; inserting `npm test` is a one-line change with `node:test` and a toolchain decision with anything else.

**Why "load-bearing gate" argues for the built-in runner rather than against it.** The instinct is that a more serious gate deserves a more serious tool. It does not, and the three reasons are specific to this repo:

1. **The gate has to run unattended, on a self-hosted runner, on a job nobody watches.** A runner that ships inside the Node binary cannot go unmaintained, cannot break on a transitive update, and cannot need a lockfile bump to keep working. A ~20-package devDependency tree is one more thing that can break during the one week a year this matters — and a flaky gate is not a gate, it is a thing people learn to re-run until it passes.
2. **Nothing in the suite uses what vitest's dependency tree buys.** The three kinds of test the plan actually specifies are: pure functions over `src/test/cases/*.json` case tables (in → expected out); ~21 hand-written `.xlsx` fixtures parsed with SheetJS; and structural assertions that unzip the generated workbook with `jszip` (§C) and check parts, refs and SHA-1s. No JSX, no browser env, no bundler resolution, and **no mocking** — the pure functions take values and the I/O ones take paths, so the fixtures *are* the test doubles. Vitest's transform pipeline, `vi.mock` ESM interception, watch UI and browser mode are all answers to problems this suite does not have.
3. **Memory is the real operational constraint, and the built-in runner exposes the knob.** The template round-trip peaks at **933 MB RSS** (measured, §B). `node --test` runs *files* in parallel by default (roughly one per core), so the moment the structural assertions are split across more than one file the runner will try to hold several template round-trips at once and OOM the box. **Run the workbook-level tests with `--test-concurrency=1`, or keep them in a single file**; tests *within* a file already run sequentially. That is a one-flag fix here and an inherited pool-configuration problem in any runner that owns its own worker pool.

What the built-in runner gives that this suite genuinely uses: subtests with `t.skip` / `t.todo`, which is exactly how the plan's pending structural checks (`05-implementation-plan.md` Phase 0 task 4, checks (c)–(g)) stay visible and claimed by a later phase instead of being commented out; coverage behind one flag; a spec and a TAP reporter, so CI output is readable without a plugin; and `assert.deepStrictEqual` against a committed expected-output JSON, which is the whole assertion vocabulary needed.

Where it is genuinely thinner than vitest: module mocking, and snapshot support (`t.assert.snapshot`) that is still experimental. Neither bites, because the expected-output JSON files beside each fixture are the snapshots — hand-written, reviewed in the diff, and deliberately *not* auto-regenerated, which is the property you want from a file that is the assertion.

**Fixture strategy matters more than the runner choice, and it is now the whole offline story.** Commit ~21 **hand-written, kilobyte-scale** `.xlsx` fixtures with synthetic identities, five to twenty rows each, one pathology per file — authored from knowledge of the pathology, using `src/ReporteConsolidado.xlsx` and `src/template.xlsx` as reference for *shape only* (the 18 canonical column names and their order, the value vocabularies, the sheet naming, the number formats). Nothing is carved out of a real month. The full corpus table is `05-implementation-plan.md` Phase 0 task 2; the pathologies each package decision in this document depends on are:

- header not in row 1 / not in column A, and `EMPRESA` positioned **left of** `RUC` (§A anchoring)
- columns in a different order; a duplicate header name (to exercise the `_1` collision, §A)
- `CONTRATISTA PRINCIPAL` spelled correctly; `DISTRITO SEGUN DNI` unaccented, and `Distrito segun DNI ` with a trailing space (§G normalization and the alias table)
- a sheet **not** named `Cuadro`, and a workbook where `Cuadro` is missing entirely
- the column-shifted workbook — A–D absent, a RUC number sitting in `APELLIDOS Y NOMBRES` (§A, the 643-row block in miniature)
- text dates in every observed shape (`04/07/1994`, `14/2/1989`, `3/5/1965`, `30/1/26`) plus the malformed years (`09/10/205`, `05/09/20258`, `10-11-202-6`) — this fixture is what proves the §E dayjs verdict and is the one that fails loudly under `date-fns`
- fractional serials at `.791666…` and `.833333…` plus serial 60 (§E2, the 1900 leap day)
- a DNI with a leading zero, a 9-digit CE, and RUCs that pass and fail the mod-11 check (§H)
- out-of-domain `ESTADO` / `TIPO DE CONTRATO LABORAL` / `GENERO` values (§F, the input class that produced the `"undefined"` third gender column)
- the older input format with **no `HPT` column**; dirty text columns (leading space, embedded CRLF, doubled internal space)
- four **container** fixtures: a folder with two `.xlsx`, a folder with zero, a folder holding a `~$` Excel lock file, and a zip carrying a `__MACOSX/` entry with a `._` resource fork (§I)

Each fixture ships with its expected output as JSON beside it — that file is the assertion, and writing it is part of authoring the fixture.

Do **not** commit more multi-megabyte workbooks — the repo already carries tens of MB of binary `.xlsx` in `src/` and `src/reportes/`. Fixtures should be kilobytes, and the whole corpus should come to a few hundred kilobytes.

**Write the structural assertions first**, because they need no historical file and no retained input: unzip the generated workbook with `jszip` (§C) and assert that `Tabla2`'s `ref` matches the real row count, that there are zero empty-string rows inside the table, zero `#VALUE!`, zero `NaN` and zero occurrences of the literal `"undefined"`, that every populated cell in date columns F/M/O is numeric, that the 13 pivot parts and the pivot cache are still SHA-1-identical **to `src/template.xlsx`** — the template is the reference, never a past report — and that no relationship or content-type override points at an absent part. Those are what make the ghost-row and 8,823-row-ceiling defects impossible to reintroduce silently.

**The second half of the verification needs no dependency either.** `tools/diff-reports.js` — the parallel-run diff that compares the old and new pipeline's output over `Cuadro!A:R` plus the pivot totals — is a plain Node script over SheetJS and `jszip`, both already installed. It is a deliverable of Phase 0, not a scratch script, but it is not a devDependency and it does not run inside the test runner: it runs once a month against two in-flight outputs.

### Runner-up

`vitest` (as of 2026: v4.x, MIT, ~20 direct dependencies including vite). Excellent tool, wrong project — and promoting the suite to primary gate does not change that verdict, because every advantage it has is orthogonal to what this suite does. Vite transform pipeline: this is CJS with no bundler. ESM-first module mocking: nothing is mocked. Watch UI: `node --test --watch` exists, and a monthly job is not a TDD inner loop. Browser mode: there is no browser. What it would add is a build-tool dependency tree in a repo that deliberately has no build step, in front of the one check that has to keep working unattended. Take it only if you convert to ESM and TypeScript, at which point the transform pipeline starts paying for itself. (`jest` loses harder on the same grounds and additionally needs `babel-jest` to see this code at all.)

---

## L. Concurrency and event-loop responsiveness

### The problem

The commit history (`increase timeout`, `update timeout` ×4, `fix server timeout issue`) shows this has been fought repeatedly. `req.setTimeout(6000000)` is set *inside* the handler, after the socket is established. None of the fixes addressed the cause.

### The recommendation: no package — tune the read options and get off the request thread

**Measured on this machine**, parsing the actual format handed to subcontratistas (`src/Formato Reporte subcontratas.xlsx`, 2.4 MB, 4,808-row `Cuadro`):

| Read | Time |
|---|---|
| `XLSX.readFile(path)` — defaults | **391 ms** |
| `XLSX.readFile(path, { sheets: ['Cuadro'], cellFormula: false, cellStyles: false, cellDates: true })` | **262 ms** |

That is a **33% cut for one options object and no dependency** — roughly 39 s → 26 s across 100 workbooks. Add the template round-trip (875 ms open + 1,071 ms write, measured) and the whole monthly job is **≈ 30 seconds of CPU**.

A 4-way pool might get that to ~10 s. **Saving 20 seconds once a month does not justify** a worker pool, the structured-clone serialisation of every parsed workbook across the thread boundary, or the debugging cost when one worker dies mid-run and the operator gets a partial report.

The reason the server *appears* to hang for minutes is not throughput — it is that `XLSX.readFile` is **synchronous**, so the event loop is blocked solid for the entire run and cannot even serve a progress ping. Two zero-dependency changes fix it:

```js
// 1. non-blocking read, with a yield between workbooks
const buf = await fs.promises.readFile(file);
const wb  = XLSX.read(buf, { sheets: ["Cuadro"], cellFormula: false, cellStyles: false, cellDates: true });
await new Promise(setImmediate);            // let the event loop breathe

// 2. accept the upload, return a job id, run the job, report over SSE
```

The SSE endpoint is the missing half: `src/views/progress.ejs` and `public/js/index.js` are **already written against a `/progress` endpoint that does not exist server-side**. Building it is cheaper than a worker pool and is what the operator actually wants.

### Runners-up

- `piscina` (as of 2026: MIT, ships CJS, Node ≥20) — the drop-in choice if you ever need a pool.
- `tinypool` (as of 2026: MIT, ~50 KB, zero deps) — lighter, but **ESM-only**, which conflicts with this CJS codebase.
- `node:worker_threads` directly — same objection, plus you hand-roll the pool.

**Revisit trigger:** a measured run exceeding a few minutes *after* the read options are tuned. It will not happen — this is 50–100 subcontratistas on one project.

---

## Proposed final `package.json` dependency set

```jsonc
{
  "name": "reporte-subcontratistas",          // current name is "firebaseproject" — stale
  "engines": { "node": ">=22" },              // matches the CI matrix; currently undeclared
  "scripts": {
    "dev":      "node --watch src/app.js",
    "test":     "node --test src/test/",      // node:test — see §K, no devDependency needed
    "test:cov": "node --test --experimental-test-coverage src/test/"
  },
  "dependencies": {
    "xlsx":           "npm:@e965/xlsx@^0.20.3",  // reader. Alias keeps require('xlsx') unchanged; clears both HIGH CVEs. See the note below before committing to the mirror.
    "xlsx-populate":  "1.21.0",                  // template writer. PINNED EXACTLY — unmaintained, and the only thing that preserves the 6 pivot sheets (§B).
    "jszip":          "^3.10.1",                 // post-write OOXML patch: Tabla2 ref, refreshOnLoad, calcChain rel (§C). Already in the tree via xlsx-populate; declare it.
    "dayjs":          "^1.11",                   // strict day-first text-date parsing (§E). ~11 KB actually loaded.
    "zod":            "^4",                      // per-row validation with full issue accumulation -> the Errores sheet (§F).
    "adm-zip":        "^0.6.0",                  // upgrade: clears GHSA-xcpc-8h2w-3j85 (4 GB alloc), which npm audit reports HIGH today (§I).
    "express":        "^4",                      // keep; run `npm audit fix` — express/body-parser/path-to-regexp/qs/cookie/send/serve-static all report fixAvailable: true.
    "express-fileupload": "^1.4",                // keep, but CONFIGURE limits: { limits: { fileSize: 200e6 }, abortOnLimit: true, useTempFiles: true }.
    "dotenv":         "^16"                      // keep; no advisories.
  }
}
```

`dayjs/plugin/customParseFormat` ships inside `dayjs`; it is not a separate install.

### Dependencies to REMOVE

| Package | Installed | Reason |
|---|---|---|
| `@google-cloud/local-auth` | 2.1.0 | Never `require`d anywhere in `src/` or `public/`. Dead. |
| `googleapis` | 105.0.0 | Never `require`d. Dead, and `npm audit` reports it MODERATE with a semver-major fix to v173 — a large upgrade for code that does not exist. |
| `lodash` | 4.17.21 | `require`d as `_` at `src/excelConsolidation.js:5` and **never called** (verified: zero `_.` call sites). `npm audit` reports it HIGH. Note it will remain in the tree as a dependency of `xlsx-populate` — removing it from *your* `dependencies` removes your ownership of it, not the package. |
| `axios` | 1.5.1 | **Verified dead server-side**: `require`d at `src/app.js:5` and never used. The browser loads axios from cdnjs (`src/index.html:95`) and uses it in `public/js/index.js:55,83`. `npm audit` attributes roughly thirty advisories to this version, including SSRF, prototype-pollution and credential-leak findings. Deleting one unused `require` removes all of them. **Highest-value removal on this list.** |
| `exceljs` | 4.4.0 | Installed and never `require`d. Keep it out permanently: §B establishes it would silently destroy the six pivot sheets if anyone were tempted to use it. `npm audit` also flags it MODERATE with a *downgrade* to 3.4.0 as the only offered "fix". |
| `ejs` | 3.1.9 | **Reasoned call: remove.** Its only uses are `app.set('view engine','ejs')` and the dead `/ejs` route at `src/app.js:38` rendering `progress.ejs`. The progress feature that page was written for needs an **SSE endpoint plus client-side DOM updates**, not a server-side template engine — one static HTML page and one `/progress` route is strictly simpler. `npm audit` also flags `<3.1.10` MODERATE. Delete the route, the `views/` directory and the dependency together. |

**Verdicts on the two you should keep:** `xlsx-populate` — keep, pinned exactly (§B). `xlsx` — keep the *library*, change the *registry* (below).

**Baseline for comparison.** `npm audit` on this repo today reports **23 vulnerabilities: 1 critical, 12 high, 7 moderate, 3 low**. The removals above plus `npm audit fix` plus the two upgrades (`adm-zip`, `xlsx`) clear all but a handful, and every remaining one has a declared fix path.

---

## Packages we are deliberately NOT adding

This section answers owner goal #3 directly: these are the places where the problem looked complex enough to warrant a package and, on inspection, was not.

| Package | The tempting pitch | Why not |
|---|---|---|
| `exceljs` / `@protobi/exceljs` / `@office-kit/xlsx` | "A modern, maintained Excel library" | The workbook has 13 pivot tables over one shared cache. exceljs destroys them (open since 2017). The Protobi fork genuinely fixes that but buys nothing xlsx-populate does not already do byte-identically here, and is designed to sunset. `@office-kit/xlsx` is architecturally right and pre-1.0 with 2 published versions — do not be its production canary. §B. |
| `hyperformula` | "Evaluate the template's formulas in JS" | It cannot parse `Tabla2[[#This Row],[…]]`; structured references have been open issues since 2020. Plus a dual-licence arrangement you should not inherit by accident. §D. |
| `@formulajs/formulajs` | "Excel functions in JS" | A function library with no parser and no cell references. If you are calling `VLOOKUP()` by hand you are writing JS. |
| `libreoffice-convert` | "Recalculate headlessly" | Calc mishandles `pivotCacheRecords`; running a 13-pivot workbook through it risks shipping a corrupted compliance report. Valuable as a **CI smoke test only**. §D. |
| `chrono-node` | "Spanish-aware, handles messy dates" | It *invents* data rather than refusing it, and anchors on the run date — the same non-determinism as `TODAY()-30`. §E. |
| `date-fns` | "The most popular date library" | Silently produces year 0205 from `09/10/205` and year 0026 from `30/1/26`. Precisely the failure class this rework exists to remove. §E. |
| `excel-date-to-js` and friends | "Excel serial → Date" | A dependency for four lines, and it lacks the 1904 handling that `XLSX.SSF` — already installed — has. §E2. |
| `ruc-peru`, `peru-utils`, `validate-ruc`, `@kembec/sunat-utils` | "Peruvian identifier validation" | All abandoned, all double-digit weekly downloads, and the most-named one is a *network* API client. The check digit is 8 lines. §H. |
| `fuse.js`, `didyoumean2`, `string-similarity` | "Fuzzy header matching" | Fuse always returns a best match and never says "no". The safe Levenshtein threshold (≤2) provably cannot reach `FECHA DE NACIMIENTO` → `FECHA NACIMIENTO` (distance 3), so fuzzy matching cannot replace the alias table. §G. |
| `remove-accents`, `diacritics` | "Accent folding" | `String.prototype.normalize('NFD')` plus one regex. One line. |
| `fast-xml-parser` | "Patch the OOXML properly" | For four known refs in a 9,655-byte part, a regex is *more* predictable than parse-mutate-serialise, which can re-emit attribute order, entity escaping and namespace prefixes differently and create exactly the corruption you are avoiding. It also has a long advisory history (including a CRITICAL DOCTYPE entity-name injection) and, as of 2026, is no longer dependency-light. §C. |
| `piscina`, `tinypool` | "Parallelise the 100 workbook parses" | Measured total job ≈ 30 s of CPU. A pool saves ~20 seconds a month at the cost of serialisation and partial-failure semantics. §L. |
| `vitest` | "A real test runner — and the suite is the primary correctness gate now" | Exactly why not: the gate has to run unattended on a self-hosted runner, so it wants fewer moving parts. `node:test` covers pure functions, fixture files and the structural workbook assertions completely, with zero dependencies, no build step, and a `--test-concurrency` knob that matters at 933 MB RSS per template round-trip. Nothing in the suite mocks a module or needs a transform. §K. |
| `winston`, `pino-pretty` | "Proper logging" | The missing capability is the `Errores` sheet inside the artifact, not stdout formatting. If you want a logger, `consola` (zero deps) or `pino` (a structured object per workbook, for the duration of the run only) — not both, not either urgently. §J. |
| Any framework, ORM, database, auth, container runtime | — | Out of scope by owner constraint, and unjustified: one operator, one run per month, one output file. |

---

## The `xlsx@0.18.5` situation

This is the one dependency where the right answer is not obvious and the tradeoff is about supply chain, not code.

**The facts, verified by running `npm audit` in this repo:**

```
xlsx | high | range * | fixAvailable false
  GHSA-4r6h-8v6p-xvw6 — Prototype Pollution in SheetJS   (needs >= 0.19.3)
  GHSA-5pgg-2g8v-p4x9 — SheetJS ReDoS                    (needs >= 0.20.2)
```

`fixAvailable: false` and `range: *` are not saying "unfixable" — they are saying **there is no fixed version on the npm registry**. SheetJS stopped publishing to npm after 0.18.5 (March 2022) and moved distribution to their own registry at `cdn.sheetjs.com`. GitHub's advisory database therefore lists no first-patched version in the npm ecosystem for either advisory. Both are fixed in 0.20.3, which exists — just not on npm.

**Practical exposure here is low but not zero.** The inputs are workbooks from ~50–100 known subcontratistas, uploaded by one operator, on an internal tool. This is not a public service. But the app *does* parse untrusted-ish binary from external parties, and a prototype-pollution primitive in a process that also writes files is not something to leave standing indefinitely.

### The three migration options

| Option | How | Pros | Cons |
|---|---|---|---|
| **1. Alias the community mirror** (recommended) | `"xlsx": "npm:@e965/xlsx@^0.20.3"` in `dependencies`; `require('xlsx')` is unchanged | Clears both advisories. Stays in the npm registry, so `npm audit` and dependabot keep working. Zero code changes. As of 2026: Apache-2.0, published mid-2024, no runtime deps (the tarball is the CDN bundle) | **You are trusting an unaffiliated third party's npm token.** `@e965/xlsx` is a republisher (`github.com/e965/sheetjs-npm-publisher`) whose GitHub Action pulls fresh versions from SheetJS's own git and publishes when the version differs. Transparent and automated, but one individual is in the trust path |
| **2. Install from the SheetJS CDN tarball** | `npm i https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` | **Zero third-party trust** — the bytes come from SheetJS directly. Clears both advisories | No registry means no `npm audit` coverage, no dependabot, and a URL dependency in `package-lock.json` that a future `npm ci` on a network-restricted runner may not resolve. Verify the tarball hash and pin it |
| **3. Leave SheetJS entirely** | See §A runners-up | Removes the question | Nothing in the ecosystem is both actively developed and suitable: `read-excel-file` requires a row-1 header and is ESM-only; `node-xlsx` and `xlsx-js-style` re-export the same vulnerable 0.18.x code; `exceljs` is stalled and unusable for the write side anyway. And you would lose `XLSX.SSF` (§E2), which is the cleanest serial-to-components converter available |

**Recommendation: option 1, with eyes open**, because keeping `npm audit` and dependabot working on a once-a-month tool that nobody watches is worth more than eliminating one automated republisher from the trust path. Option 2 is the correct choice if your threat model includes npm account compromise; in that case, vendor the tarball into the repo and check the hash.

**One caveat either way:** SheetJS CE itself is now largely static — its tags top out at v0.20.3 and the GitHub mirror was last pushed in 2024. Moving to 0.20.3 clears the two known advisories; it does not buy you an actively developed reader. That is acceptable, because the reader's job here is narrow (§A) and the format is frozen — but it means "upgrade xlsx" is a one-time fix, not an ongoing maintenance channel.

**Do this upgrade in its own commit**, before any behavioural change, and run the full fixture suite from §K across it — the reader pathologies (text dates, fractional serials, the leading-zero DNI, the sheet-name and header variants) are exactly what a parser upgrade would move. 0.18.5 → 0.20.3 spans two minor versions of a parser you depend on for 5,000 rows a month.

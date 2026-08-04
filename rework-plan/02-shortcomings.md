# Implementation Shortcomings

This is the defect register for the `subcontratistas` app: every confirmed fault in the pipeline that turns ~100 subcontractor workbooks into the monthly *Reporte Social - RRHH*, ranked by what it does to the correctness of the delivered report. Everything here was verified against the repo and the raw OOXML of the generated workbooks; where a number appears, it came from a file in this repo. The register exists to be worked through in order — `05-implementation-plan.md` sequences it, `03-expected-output.md` defines what "correct" would have looked like, and `04-proposed-packages.md` covers which of these are worth a dependency. The headline: today's pipeline can produce a report that is wrong in five independent ways at once, and every one of those ways is silent.

## Severity scale

| Severity | Definition |
|---|---|
| **CRITICAL** | Silently produces a **wrong report the operator will trust**. No error, no warning, output looks complete. |
| **HIGH** | Data loss or the wrong file delivered, but usually noticeable — eventually, by someone. |
| **MEDIUM** | Correctness risk, fragility, or operational pain. Bites under conditions that have not yet occurred or are hand-worked around. |
| **LOW** | Hygiene, dead code, cosmetics. No effect on the numbers. |

Two notes on how severity was assigned. First, "the operator will trust it" is the discriminator: `BUG-36` delivers the wrong month's file, which sounds like HIGH — but because `public/js/index.js:89` renames the download client-side to the month the operator expected, the wrong file arrives wearing the right name. That is CRITICAL. Second, several MEDIUM defects are only MEDIUM because a CRITICAL one upstream masks them; fixing the CRITICAL will promote them.

## The register

| ID | Group | Area | Defect | Severity |
|---|---|---|---|---|
| BUG-01 | A | `excelConsolidation.js:131` | A workbook with no sheet named exactly `Cuadro` drops an entire subcontratista, logged only to a cleared console | **CRITICAL** |
| BUG-02 | A | `excelConsolidation.js:131` | Header assumed at row 1 / cell A1; any preamble or leading blank column yields garbage | **CRITICAL** |
| BUG-03 | A | `excelConsolidation.js:66` | Header matching is exact, case-, accent- and whitespace-sensitive → column silently blank | **CRITICAL** |
| BUG-04 | A | `excelConsolidation.js:131` | No header-shift detection: 643 rows in the last run have a RUC in the name column and count as **1 worker** | **CRITICAL** |
| BUG-05 | A | `excelConsolidation.js:131` | No `defval` (empty cells vanish); duplicate headers silently suffixed `_1`/`_2` | HIGH |
| BUG-55 | A | `excelConsolidation.js:9-28` | A workbook on the older format has no `HPT` column; the whole column comes out blank and understates the `# Horas` measure with no warning | MEDIUM |
| BUG-06 | B | `excelConsolidation.js` (absent) | No date normalization anywhere; ~200 of 5,065 rows reach the template as **text** | **CRITICAL** |
| BUG-07 | B | template `Cuadro!V`,`W` | Text dates → `#VALUE!` in `Edad`/`Rango Edades`, visible in the deliverable (36 workers, FEBRERO_2026) | HIGH |
| BUG-08 | B | template `Cuadro!AH`,`AI` | Unparseable dates fall into `IFERROR(…,"No aplica")` → silently **not** an Alta or Baja | **CRITICAL** |
| BUG-09 | B | `excelConsolidation.js:257-259` | `""` force-written into the date-formatted `FECHA CESE/BAJA`; `"-"`, `"---"`, `"ACTIVO"` never normalized | HIGH |
| BUG-10 | C | `excelReporting.js:35-40` | 3,757 ghost rows of `""` remain inside `Tabla2` and drive every `COUNTIF`/`SUMPRODUCT`/pivot | **CRITICAL** |
| BUG-11 | C | `excelReporting.js` (absent) | `Tabla2` `ref` frozen at `A1:AI8824` → hard 8,823-row ceiling, silent truncation beyond it | HIGH |
| BUG-12 | C | `excelReporting.js:35` | `row < lastRow` — the final previous-run row is never cleared | MEDIUM |
| BUG-13 | C | `excelReporting.js:45-48` | Column placement relies on JS object key-enumeration order | MEDIUM |
| BUG-14 | C | output OOXML | Cached `<v>` stripped, `calcChain.xml` dropped (rel left dangling), no `refreshOnLoad`/`fullCalcOnLoad` → 5 of 14 shipped reports still display **October 2024** numbers | **CRITICAL** |
| BUG-15 | D | template, 5 places | Every period classification anchors on `TODAY()-30` → the numbers change every time the file is opened | **CRITICAL** |
| BUG-16 | D | `excelReporting.js:56,69-77` | Report period derived from the server wall clock; filename and content can disagree; no way to regenerate a past month | HIGH |
| BUG-17 | D | `pivotTable3/7.xml` | Altas page filter is the frozen literal `"9-2024"` | HIGH |
| BUG-18 | E | `excelConsolidation.js:169-183` | `case 1:`/`case 2:` are unreachable; `String(undefined)` produces the literal `"undefined"` as a gender | HIGH |
| BUG-19 | E | `excelConsolidation.js:186-231` | `TIPO DE CONTRATO LABORAL` switches on the **raw** string — no trim, no case-fold | MEDIUM |
| BUG-20 | E | `excelConsolidation.js` ×4 | `parseInt` fallbacks write `NaN` into the workbook | HIGH |
| BUG-21 | E | `excelConsolidation.js:88` | Dedup via `JSON.stringify` is key-order dependent **and runs before** canonicalization | HIGH |
| BUG-22 | E | `excelConsolidation.js:64-69` | `errorEnArchivo` — the only traceability field — is deleted before it reaches the output | HIGH |
| BUG-23 | E | `excelConsolidation.js` (absent) | RUC/DNI arrive as numbers; leading zeros destroyed (`09994533` → `9994533`) | HIGH |
| BUG-24 | F | `xl/tables/table1.xml` | `Validar Edad`, `Validar Genero`, `ValidarDNI` are three copies of the **same GENERO formula** | **CRITICAL** |
| BUG-25 | F | `Cuadro!AB` | Person identity keys on `APELLIDOS Y NOMBRES`, not the DNI | HIGH |
| BUG-26 | F | `pivotTable2.xml` | `Detalle Cesados` is filtered on `Bajas2="Borrar"` — the workers who ceased **outside** the period | HIGH |
| BUG-27 | F | `'Reporte Social - RRHH'!G53:G60` | `+F53/$F$60` hard-codes column F as Total; drifts when a third gender column appears | MEDIUM |
| BUG-28 | F | `template.xlsx!Cuadro` rows 2-3 | Junk test data (`"asfasf"`, `"asf"`, `"fafsasf"`, `"as"`) sits in the template; always overwritten, so it never reaches a report | LOW |
| BUG-29 | F | `Hoja1!A2:B61` | 14 lookup keys can never match; 2 real districts permanently resolve to `"No"` | MEDIUM |
| BUG-30 | F | `Cuadro!AE`,`AF` | Dead branch: both arms of the `IF` return the same value | LOW |
| BUG-31 | F | `Cuadro!AK/AM/AO/AP`, `AJ1` | Leftover manual date-repair helpers, stale `_FilterDatabase`, header `"a"` | LOW |
| BUG-32 | G | `app.js:66` | Missing path separator → zip written outside the upload folder | HIGH |
| BUG-33 | G | `app.js:88-90` | An **array** is passed as a path; a second top-level zip entry (`__MACOSX/`) breaks the run | HIGH |
| BUG-34 | G | `app.js:82` | `extractAllTo` with no entry, size, count or type validation | MEDIUM |
| BUG-35 | G | `app.js:90` | Synchronous multi-minute parse on the event loop — the cause of six "timeout" commits | HIGH |
| BUG-36 | G | `app.js:124` | `sort((a,b) => a.ctime + b.ctime)` is not a comparator → **always downloads `ABRIL_2026`** | **CRITICAL** |
| BUG-37 | G | `excelReporting.js:61-63` | Write failure is swallowed; `app.js` still answers `200 OK` and offers a download | **CRITICAL** |
| BUG-38 | G | `app.js:51` | No upload size or type limit; `express-fileupload` buffers the whole file in memory | MEDIUM |
| BUG-39 | G | `app.js:82` vs `:46,88` | `DATAFOLDER_URL` is half-honoured — extraction hard-codes `"subcontratistas"` | MEDIUM |
| BUG-40 | H | `public/js/index.js:103-111` | `getMonthAndYear()` duplicated client-side; the download is **renamed** to the expected month | **CRITICAL** (with BUG-36) |
| BUG-41 | H | `package.json:6` | No tests, no fixtures; `npm test` is the failing placeholder | HIGH |
| BUG-42 | H | `excelConsolidation.js:75,284` | `console.log("Error with: " + directory)` is the entire diagnostic — and `console.clear()` wipes it | HIGH |
| BUG-43 | H | `excelConsolidation.js:113,267-277` | `deleteFilesFromDirectory` can never catch an error and logs success unconditionally | MEDIUM |
| BUG-44 | H | `app.js:99` | A failed run leaves extracted files behind and **bricks the next run** | HIGH |
| BUG-45 | H | `app.js` / `progress.ejs` | `/progress` SSE endpoint is referenced by two clients and does not exist; `progress` is global mutable state | LOW |
| BUG-46 | H | git | 30 `.xlsx` binaries tracked; `.git` is **115 MB** | LOW |
| BUG-47 | I | `package.json:19` | `xlsx@0.18.5` — unmaintained on npm, CVE-2023-30533 + CVE-2024-22363, no fix available | MEDIUM |
| BUG-48 | I | `package.json` | `googleapis`, `@google-cloud/local-auth`, `exceljs`, `lodash`, `ejs` installed and unused | LOW |
| BUG-49 | I | `.github/workflows/subcontratistas.yml` | `sudo pm2 restart 0` restarts pm2 process **index 0** | MEDIUM |
| BUG-50 | I | `app.js:105-132` | `/downloadFile` serves any entry of `src/reportes/` with no extension filter — including the `~$` Excel lock file | MEDIUM |
| BUG-51 | J | `src/discrepancias.js:13-14` | The file does not parse — a corrupted edit committed to `main` | LOW |
| BUG-52 | J | `excelConsolidation.js:73` | `filteredData` computed and discarded; the filter is identity-true anyway | LOW |
| BUG-53 | J | `excelConsolidation.js:37-46` | `mkdirSync` guard runs **after** the `readdirSync` it was meant to protect | LOW |
| BUG-54 | J | `app.js:38`, `src/index.html`, `src/` | Dead `/ejs` route, duplicated instruction line, `<title>Document</title>`, `template_new.xlsx`, `test.xlsx` | LOW |

*(BUG-55 is listed under group A rather than at the end: the register is read by area, and IDs are stable once assigned, so a later addition sits with its neighbours rather than renumbering everything after it. `05-implementation-plan.md` §9 maps all 55 to phases. No id has ever been retired. One behaviour that looks like a defect is deliberately **not** numbered — the app deleting its own inputs, which the owner has accepted; see the note in group H, after BUG-44.)*

---

# A. Extraction & header anchoring

## BUG-01 — A missing `Cuadro` sheet deletes an entire subcontratista, silently — CRITICAL

**What.** If a subcontractor's workbook has no sheet named exactly `Cuadro` — `cuadro`, `CUADRO`, `Cuadro ` (trailing space), `Cuadro 2026`, or a renamed tab — that company's entire workforce is dropped from the report. The operator is never told.

**Where.** `src/excelConsolidation.js:131-133`:

```js
const personalSubcontrata = reader.utils.sheet_to_json(
    file.Sheets[file.SheetNames[file.SheetNames.indexOf("Cuadro")]]
);
```

and the handler that receives the throw, `src/excelConsolidation.js:74-77`:

```js
} catch (exception) {
    console.log("Error with: " + directory);
    console.error(exception);
}
```

**Why it is wrong.** `indexOf` returns `-1` on a miss → `SheetNames[-1]` is `undefined` → `Sheets[undefined]` is `undefined` → `sheet_to_json(undefined)` throws. The `catch` prints two lines and continues the loop. The failed directory contributes zero rows, and nothing downstream distinguishes "this subcontratista sent a malformed file" from "this subcontratista has no workers this month".

**Observable impact.** The output workbook looks complete: `Tabla2` is full, every pivot renders, every total is a number. It is simply missing a company. Since the whole point of the report is chasing non-compliant subcontratistas, the failure mode is exactly inverted — the least compliant supplier is the one most likely to disappear from the compliance report. Compounded by BUG-42 (`console.clear()`), the two diagnostic lines are usually gone before a human sees them.

**How to prove it.** Rename `Cuadro` to `Cuadro ` in one workbook of a test zip and run the pipeline. The run reports success, the report generates, and the row count silently drops by that company's headcount. There is no assertion anywhere that `Σ(rows per workbook) == rows written`.

## BUG-02 — The header row is assumed to be row 1 at cell A1 — CRITICAL

**What.** `sheet_to_json` is called with default options, which take row 1 as the header row and A1 as the origin. This is the owner's stated issue #1 and it is factual.

**Where.** `src/excelConsolidation.js:131-133` (quoted above) — no second argument.

**Why it is wrong.** Nothing in the format handed to subcontratistas guarantees the table starts at A1. A merged title row, a logo, a "REPORTE MENSUAL DE PERSONAL" banner, or a single leading blank column shifts everything. When that happens, `sheet_to_json` promotes the *banner text* to a column key and treats the real header row as data. The cleanup loop at `:64-69` then deletes every key (none match `dataColumns`), and the row survives as an empty object.

**Observable impact.** A workbook with a 3-row preamble yields rows whose 18 canonical keys are all `undefined`. `orderHeadersAndData` faithfully produces 18 `undefined` values, `json_to_sheet` omits them, and the rows land in the report as blanks — indistinguishable from BUG-10's ghost rows.

**How to prove it.** The capability to fix this is already installed and unused: `sheet_to_json` accepts a `range` option (an A1 range string or a 0-based row number), and `XLSX.utils.decode_range(ws['!ref'])` lets you scan for the first cell matching `/^\s*ruc\s*$/i`. Anchoring on that cell and passing `{ range: encode_range({s: anchor, e: R.e}), defval: null }` returns the correct headers and rows. No new dependency — see `04-proposed-packages.md`.

## BUG-03 — Header matching is exact-string, so a mis-cased or accented header blanks the column — CRITICAL

**What.** Column *order* is handled correctly. Column *recognition* is not. A header must match one of the 18 `dataColumns` byte for byte — including the canonical typo `CONTRATISTA PRNCIPAL` and the accented `Ú` in `DISTRITO SEGÚN DNI` — or the column is deleted and comes out blank.

**Where.** `src/excelConsolidation.js:64-69`:

```js
tempJson.forEach((jsonObject) =>
    Object.keys(jsonObject).forEach((key) => {
        if (dataColumns.indexOf(key) == -1) {
            delete jsonObject[key]; //Delete column not found inside dataColumns
        }
    })
);
```

then `src/excelConsolidation.js:300-312`:

```js
dataColumns.forEach(column => {
    orderedObject[column] = row[column]
})
```

**Why it is wrong.** `indexOf` on an array of strings is `===`. `"RUC "`, `"Ruc"`, `"DISTRITO SEGUN DNI"` (unaccented), `"Distrito segun DNI "`, `"FECHA DE NACIMIENTO"` all fail. There is exactly one alias in the entire codebase, hard-coded inline at `:141-143`:

```js
"CONTRATISTA PRNCIPAL": sheetToChange["CONTRATISTA PRNCIPAL"]
    ? sheetToChange["CONTRATISTA PRNCIPAL"]
    : sheetToChange["CONTRATISTA PRINCIPAL"],
```

There is no normalization (trim / collapse whitespace / case-fold / accent-fold) and no alias map. Note the asymmetry: the *correct* Spanish spelling `CONTRATISTA PRINCIPAL` is the alias, and the typo is canonical.

**Observable impact.** The column is not missing — it is **present and empty**, which is worse. `DISTRITO SEGÚN DNI` blank means `Zona de Influencia` resolves to `"No"` for that entire subcontratista, so its workers vanish from the zone report (`pivotTable1`) and from `Trabajdores Unicos Zona Influencia` while still appearing in headcount. `GENERO` blank means every one of those workers fails `Validar Genero` and lands in a `(blank)` column on four pivots.

**How to prove it.** Take any subcontractor workbook, retype the `DISTRITO SEGÚN DNI` header without the accent, re-run. The generated report has 5,065 rows as before, and the `Reporte Zona de Influencia` block loses that company's contribution with no error anywhere.

## BUG-04 — No header-shift detection: 643 rows collapse into a single "worker" — CRITICAL

**What.** When a subcontratista's sheet has its columns shifted by one, `RUC`, `EMPRESA`, `CONTRATISTA PRNCIPAL` and `Nro. DNI / CE` come out null and the *RUC number* lands in `APELLIDOS Y NOMBRES`. Because the template keys person identity on the name (BUG-25), all those rows share one "name".

**Where.** No detection exists. `src/excelConsolidation.js` performs no shape validation on a parsed sheet — it accepts whatever `sheet_to_json` returns.

**Why it is wrong.** `Trabajador` = `COUNTIF(Tabla2[APELLIDOS Y NOMBRES],[APELLIDOS Y NOMBRES])` counts every one of those rows as the same person, and `Trabajadores Unicos` = `1/Trabajador` gives each of them a weight of 1/643.

**Observable impact.** In `src/ReporteConsolidado.xlsx`, **643 rows** have `RUC`, `EMPRESA`, `CONTRATISTA PRNCIPAL` and `Nro. DNI / CE` all absent and the single numeric value `20101155588` in `APELLIDOS Y NOMBRES` — 12.7% of the 5,065-row run, all from one subcontratista's workbook. Those are real workers on a real construction site who together contribute a headcount of **1**. Every pivot filtered on `CONTRATISTA PRNCIPAL`, `EMPRESA` or `Tipo de Empresa` also mislabels them: `Tipo de Empresa` = `IF([EMPRESA]=[CONTRATISTA PRNCIPAL],"Principal","Secundaria")` evaluates blank = blank as TRUE, so all 643 are tagged `Principal`.

**How to prove it.**

```js
const X=require('xlsx');
const wb=X.readFile('src/reportes/Reporte_Subcontratistas_MAYO_2026.xlsx',{sheets:['Cuadro'],cellFormula:false});
const ws=wb.Sheets['Cuadro'], R=X.utils.decode_range(ws['!ref']);
let real=0, empty=0, missing=0;
for(let r=1;r<=R.e.r;r++){const c=ws[X.utils.encode_cell({c:2,r})];
  if(!c) missing++; else if(c.v==='') empty++; else real++;}
// → real 4412  emptyString 3757  missingCell 654
```

Read that output carefully, because the three buckets are three different things and only one of them is this defect. `missingCell 654` is the whole-sheet count: **653** of those rows sit inside the real data region (rows 2–5066) and one is row 8824, the template's own trailing row. Of the 653, **643** are this defect — the header-shift block, identifiable as rows where A/B/C/D are all absent *and* `APELLIDOS Y NOMBRES` is the number `20101155588` — and the remaining **10** are rows that carry no name at all. So the figure that drives `COUNTIF(Tabla2[APELLIDOS Y NOMBRES],20101155588)` is **643**, not 654. The 3,757 is BUG-10.

## BUG-05 — Empty cells lose their key, duplicate headers get suffixed `_1`/`_2` — HIGH

**What.** Two independent silent-data-loss paths inside the same default-options `sheet_to_json` call.

**Where.** `src/excelConsolidation.js:131-133`, missing `{ defval: null }`.

**Why it is wrong.** SheetJS omits the key entirely for an empty cell rather than emitting `null`. Downstream, `orderedObject[column] = row[column]` yields `undefined`, which is then indistinguishable from "this column was never recognised" (BUG-03) and from "this workbook does not have this column at all". Separately, SheetJS de-duplicates repeated header names by appending `_1`, `_2` — so a workbook with two `ESTADO` columns produces `ESTADO` and `ESTADO_1`, the latter fails `dataColumns.indexOf` and is deleted, and whichever of the two SheetJS happened to name `ESTADO` wins with no warning.

**Observable impact.** Three failure causes — unrecognised header, genuinely empty cell, duplicate header — all converge on the same `undefined`, which makes them impossible to tell apart in a run report. It is the reason the app cannot currently produce the "which subcontratista sent a bad file" list it was built to produce.

**How to prove it.** Add a second `ESTADO` column to a fixture workbook; the output silently keeps one of them and there is no record of which.

## BUG-55 — A workbook on the older input format silently contributes zero hours — MEDIUM

**What.** The input contract has drifted and the app has no version handling. `src/Formato Reporte subcontratas.xlsx` — the format historically handed to subcontratistas — has a `Cuadro` header that stops at `TIPO DE CONTRATO LABORAL`: **there is no `HPT` column** (verified: its header row is `RUC … TIPO DE CONTRATO LABORAL` followed directly by the computed columns `EPC/CJV`, `Tipo de Empresa`, …). A subcontratista still working from that file produces rows where `HPT` is simply absent.

**Where.** `HPT` is item 18 of `dataColumns` (`src/excelConsolidation.js:9-28`). A missing key becomes `undefined` in `orderHeadersAndData` (`:300-312`) and lands in the workbook as a blank — the same terminal state as BUG-03's unrecognised header and BUG-05's empty cell, with no way to tell them apart.

**Why it is wrong.** `HPT` is the `# Horas` measure on the `CJ Y EPC` sheet — the hours half of the CJV/EPC split, `985872.34` hours in `FEBRERO_2026`. A blank column does not error, does not warn, and does not zero out visibly: it just makes that subcontratista's hours vanish from the total while its headcount still counts.

**Observable impact.** Small today — 13 of 5,065 rows have no `HPT` cell, against 5,052 numeric summing to 963,807 hours — so no subcontratista is currently on the old format wholesale. That is exactly why it needs a version signal now rather than after someone re-sends the 2023 template: a whole-file miss would silently subtract that company's hours from a compliance figure.

**Fix direction.** Per `03-expected-output.md` §1.3, a missing `HPT` is a **WARNING**, not an error — record it as a *format-version signal* naming the subcontratista and the row count affected, and null the field explicitly rather than leaving `undefined`.

---

# B. Dates

## BUG-06 — There is no date normalization anywhere in the pipeline — CRITICAL

**What.** The owner's issue #2, confirmed. Whatever SheetJS returned for `FECHA NACIMIENTO`, `FECHA CESE/BAJA` and `FECHA INICIO DE LABORES EN OBRA` — an Excel serial number or a raw string — is written straight into the template's date-formatted columns F, M and O.

**Where.** `src/excelConsolidation.js` contains exactly one line touching a date column, `:257-259`:

```js
//Edge cases for fecha de cese
if (trabajador['FECHA CESE/BAJA'] == undefined) {
    trabajador['FECHA CESE/BAJA'] = "";
}
```

That is the whole of it. There is no parsing, no format detection, no validation, no serial conversion.

**Why it is wrong.** Columns F, M and O carry cell style 4 → `numFmtId 14` (built-in short date). A numeric serial renders as a date and participates in arithmetic; a string renders as left-aligned text and breaks every formula that touches it. The distinction is invisible to the operator scrolling the sheet unless they notice the alignment.

**Observable impact.** In the last consolidated run (`src/ReporteConsolidado.xlsx`, 5,065 rows): **103 text values in `FECHA NACIMIENTO`**, **100 in `FECHA INICIO DE LABORES EN OBRA`** — roughly 4% of rows. Observed shapes: `"04/07/1994"`, `"14/2/1989"`, `"3/5/1965"`, `"01/12/2002"`, `"30/1/26"`, plus `"09/10/205"` (a three-digit year). Day-first is the correct default: the template's own custom number formats are `dd/mm/yyyy;@`, `dd\.mm\.yyyy;@`, `d/mm/yyyy`. Consequences split across BUG-07 and BUG-08.

**How to prove it.** The template itself is the proof that this has been hand-patched for years — `Cuadro` columns AK/AM/AO/AP rows 2..8612 carry `LEFT([FECHA NACIMIENTO],2)`, `MID(…,4,2)`, `RIGHT(…,4)`, `DATE(AO2,AM2,AK2)`: a hand-rolled text-date parser the owner built inside Excel because the app never did it (BUG-31).

## BUG-07 — Text dates surface as `#VALUE!` in the deliverable — HIGH

**What.** `Edad` (V) and `Rango Edades` (W) do arithmetic directly on `FECHA NACIMIENTO` with **no `IFERROR` wrapper**, so a text date produces `#VALUE!`, and `#VALUE!` propagates into the pivot as its own row-label bucket on the front page of the report.

**Where.** `xl/tables/table1.xml`, `Cuadro!V` and `Cuadro!W`:

```
V: IF(((TODAY()-[FECHA NACIMIENTO])/365)<18,"Corregir",
     IF(((TODAY()-[FECHA NACIMIENTO])/365)>80,"Corregir",
        ROUNDDOWN(((TODAY()-[FECHA NACIMIENTO])/365),0)))
```

`W` recomputes the same expression twelve more times across six nested buckets. Neither is wrapped.

**Observable impact.** `Reporte_Subcontratistas_FEBRERO_2026.xlsx!'Reporte Social - RRHH'!C29 = "#VALUE!"` with **`F29 = 36`** — thirty-six workers sitting in an error bucket on the client-facing age-distribution table. The same cell in `MAYO_2026` is also `"#VALUE!"`. This is not an internal diagnostic; it is printed on the deliverable page.

**How to prove it.**

```js
const X=require('xlsx');
const ws=X.readFile('src/reportes/Reporte_Subcontratistas_FEBRERO_2026.xlsx',
  {sheets:['Reporte Social - RRHH'],cellFormula:false}).Sheets['Reporte Social - RRHH'];
console.log(ws.C29.v, ws.F29.v);   // → #VALUE! 36
```

## BUG-08 — Unparseable dates are silently classified as "not an Alta / not a Baja" — CRITICAL

**What.** Unlike `Edad`, the `Altas` and `Bajas2` columns *are* wrapped in `IFERROR` — with a fallback that means "nothing happened".

**Where.** `xl/tables/table1.xml`, `Cuadro!AH` and `Cuadro!AI`:

```
AH Bajas2: +IFERROR(IF([FECHA CESE/BAJA]="","No Aplica",
             IF(AND(MONTH(…)=MONTH(TODAY()-30),YEAR(…)=YEAR(TODAY()-30)),
                MONTH(TODAY()-30)&"-"&YEAR(TODAY()-30),"Borrar")),"No aplica")

AI Altas:  same shape on [FECHA INICIO DE LABORES EN OBRA], else "No Aplica"
```

**Why it is wrong.** The `IFERROR` cannot distinguish "the cell is text" from "the worker did not join this month". Both produce `"No Aplica"`, which `Altas Zona de Influencia` (AE) turns into `0` and `BajasAntiguas` (AG) reads as "did not join in this period".

**Observable impact.** This is the worst consequence of BUG-06, because it is completely invisible — no error cell, no blank, no colour. A worker whose start date was typed `"3/5/2026"` instead of a real date is simply **not counted as an Alta**. `Total Ingresos` (`F59`/`F60`) is the headline number of the report — 91 in FEBRERO_2026, 114 in OCTUBRE_2025 — and it is systematically low by however many of that month's joiners had text dates. Worse for `Bajas2`: a text cese date means the worker is neither a Baja of this period nor `"Borrar"`, so `BajasAntiguas` stays `"No"` and a long-departed worker keeps counting toward active headcount forever.

**How to prove it.** Take one row with a text `FECHA INICIO DE LABORES EN OBRA` inside the report period, retype it as a real date in Excel, and watch `Total Ingresos` increment by one. Do it for all ~100 and you have the size of the error.

## BUG-09 — `""` is force-written into a date column, and the real sentinels are never handled — HIGH

**What.** When `FECHA CESE/BAJA` is absent, the code writes the empty **string** into a column formatted as a date. Meanwhile the sentinels subcontratistas actually use are never touched.

**Where.** `src/excelConsolidation.js:257-259` (quoted in BUG-06).

**Why it is wrong.** Two problems. First, `""` is a text value in a `numFmtId 14` column — it is the reason the template's `Bajas2` needs `IF([FECHA CESE/BAJA]="","No Aplica",…)` as its first test, and that test is load-bearing. Second, `""` is only *one* of five sentinels in the real data. From the last run of 5,065 rows: `""` ×3,801, `"-"` ×754, `" - "` ×154, `"---"` ×125, `"ACTIVO"` ×58 — against only **171 real date serials**. The template catches `""` and nothing else; `"-"` falls through to `MONTH("-")` → `#VALUE!` → the `IFERROR(…,"No aplica")` wrapper.

**Observable impact.** 1,091 rows per run take the `IFERROR` path rather than the intended `""` path. Today they land in the same bucket, so the number happens to come out right — but it means the `IFERROR` is masking real failures (BUG-08) and cannot be removed until the sentinels are normalized upstream. A genuinely empty cell is the correct output.

**How to prove it.** Read column M of `src/ReporteConsolidado.xlsx` and tally distinct values. 171 numeric, 4,894 text.

---

# C. Output integrity — the template injection

## BUG-10 — 3,757 ghost rows of `""` stay inside `Tabla2` and poison every whole-column formula — CRITICAL

**What.** The report writer "clears" the previous run's rows by writing the empty string into each cell instead of deleting the rows, and never shrinks the Excel Table. The blanked rows remain members of `Tabla2`, so all 17 computed columns keep evaluating on them and every pivot keeps aggregating them.

**Where.** `src/excelReporting.js:34-40`:

```js
//DELETE ALL DATA
for (let row = startRow; row < lastRow; row++) {
    for (let column = 1; column <= lastColumn; column++) {
        worksheet.row(row).cell(column).value("")
    }
}
```

**Why it is wrong.** `.value("")` writes a shared-string reference, not a deletion. In `Reporte_Subcontratistas_MAYO_2026.xlsx` all A–R cells of rows 5067–8823 point at the same shared-string index (`""`). They are still inside `ref="A1:AI8824"`.

**Observable impact.** Verified counts on MAYO_2026 column C: **3,757 empty-string rows** alongside 4,412 real ones. The damage is not cosmetic:

| Formula | Effect of 3,757 `""` rows |
|---|---|
| `U Contratistas` = `IFERROR(1/COUNTIF(Tabla2[CONTRATISTA PRNCIPAL],[…]),0)` | `""` becomes a 3,757-member "contratista"; the distinct-contractor total on the `Contratistas` sheet is wrong |
| `AB Trabajador` = `COUNTIF(Tabla2[APELLIDOS Y NOMBRES],[…])` | `""` is a 3,757-row "person"; `AC Trabajadores Unicos` gives each 1/3757 |
| `AD` (array `SUMPRODUCT` over name × zone) | O(n²) over 8,823 rows instead of 5,065 — most of the workbook's recalc cost is spent on rows that do not exist |
| `AE Altas Zona de Influencia` / `AF Bajas Zona Influencia` | **No inflation** — on a ghost row `FECHA INICIO`/`FECHA CESE` is `""`, so `[Altas]`/`[Bajas2]` = `"No Aplica"` and both arms of the nested `IF` return 0. Verified against the cached `<v>` values in FEBRERO_2026: all 3,277 ghost rows have `AE` = 0 and `AF` = 0, summing to 0. The cost here is recalc time, not a wrong headcount |
| every pivot | gains a `(blank)`/`""` bucket |
| `Validacion` `Cuenta de RUC` | counts the ghosts: grand total **8,816** in FEBRERO_2026 against a real population of ~5,540 workers |

**How to prove it.** Run the counting snippet from BUG-04. Or open the report and look at `Validacion!D2521`.

**Note on the fix.** The clean fix is a post-write OOXML patch, not a library swap. `xl/tables/table1.xml` contains exactly four refs (`<table … ref>`, `<autoFilter ref>`, `<sortState ref>`, `<sortCondition ref>`) and the pivot cache binds to the **table name**, not a range (`<worksheetSource name="Tabla2"/>`), so resizing `Tabla2` makes every pivot follow automatically. See `04-proposed-packages.md`.

## BUG-11 — `Tabla2` is frozen at `A1:AI8824`: a hard 8,823-row ceiling with silent truncation — HIGH

**What.** The table reference in the output is byte-identical to the template's. The pipeline can never produce a report with more than 8,823 worker rows, and it will not tell anyone when it exceeds that.

**Where.** `src/excelReporting.js` never touches `xl/tables/table1.xml`. Confirmed in the output:

```
xl/tables/table1.xml: … name="Tabla2" displayName="Tabla2" ref="A1:AI8824" …
                      <autoFilter ref="A1:AI8824" …
```

**Why it is wrong.** `excelReporting.js:43-53` writes `dataPath.forEach((row, index) => … worksheet.row(index + 2) …)` with no bound check. Row 8,825 and beyond is written to the *sheet* but falls **outside** `Tabla2`: it gets no computed columns S–AI, it is invisible to the pivot cache, and it is excluded from every total — while still being visible if a human scrolls down.

**Observable impact.** Nothing yet, and that is the danger. Current volume is 5,065; `FEBRERO_2026` carried 5,538 named rows in a data region ending at row 5546. The historical range is ~4,800–8,800. The ceiling is roughly 3,300 workers away and the project is growing. When it is crossed, the report will simply under-count with no error.

**How to prove it.** Generate a report from a consolidated file with 9,000 rows and compare `Tabla` grand total against the input row count.

## BUG-12 — `row < lastRow` leaves the last previous-run row uncleared — MEDIUM

**What.** Off-by-one in the clearing loop.

**Where.** `src/excelReporting.js:35`: `for (let row = startRow; row < lastRow; row++)` where `lastRow = worksheet.usedRange().endCell().rowNumber()`.

**Why it is wrong.** `lastRow` is the last used row, inclusive. `<` excludes it. The final row of the previous cycle's data survives into the new report unless the new run happens to be at least as long.

**Observable impact.** Today it is masked: the used range is 8,824 (template junk extends past the data), so the surviving row is a ghost row and the visible damage is zero. It becomes a real leaked-worker bug the moment BUG-10 is fixed and the used range tracks actual data. Fix it in the same commit.

## BUG-13 — Column placement depends on JS object key-enumeration order — MEDIUM

**What.** Rows are written by iterating the object's keys and incrementing a column counter — there is no mapping from key name to column index.

**Where.** `src/excelReporting.js:43-53`:

```js
dataPath.forEach((row, index) => {
    let column = 0
    for (let data in row) {
        worksheet.row(index + 2).cell(column + 1).value(row[data])
        column++
    }
})
```

**Why it is wrong.** It works only because `orderHeadersAndData` produced objects whose keys were inserted in `dataColumns` order, and because `XlsxPopulate.usedRange().value()` returns arrays. Nothing enforces the invariant, no assertion checks it, and it silently breaks if the intermediate `ReporteConsolidado.xlsx` ever gains or loses a column. Note it is iterating an **array** from `usedRange().value()`, so `for…in` is enumerating array indices — which happens to be safe, but the code reads as if it were enumerating an object and would be wrong if the intermediate representation changed.

**Observable impact.** Latent. It is the reason the intermediate `ReporteConsolidado.xlsx` file cannot be removed from the pipeline without care, and the reason a single extra column anywhere shifts all 18 columns by one — a total data corruption with no error.

## BUG-14 — The delivered file carries no computed values, and five of fourteen shipped reports still display October 2024 — CRITICAL

**What.** `xlsx-populate` preserves all 94,600 `<f>` formula elements but strips their cached `<v>` values and drops `xl/calcChain.xml`. Nothing tells Excel to recalculate on open, and nothing tells the pivot cache to refresh. So the file that leaves the server contains formulas with no answers and pivots showing whatever was cached in the template.

**Where.** `src/excelReporting.js` — no post-write patching at all. Verified in `src/reportes/Reporte_Subcontratistas_MAYO_2026.xlsx`:

```
xl/calcChain.xml                      → absent
xl/_rels/workbook.xml.rels            → still declares rId15 → calcChain.xml   (dangling)
[Content_Types].xml                   → still declares the calcChain+xml override (dangling)
xl/workbook.xml                       → <calcPr calcId="191029"/>   (no fullCalcOnLoad)
xl/pivotCache/pivotCacheDefinition1.xml → refreshedBy="Alvaro"
                                          refreshedDate="45566.353735300923"  (2024-10-01 08:29)
                                          recordCount="5070"
                                          refreshOnLoad → absent (grep count 0)
```

**Why it is wrong.** Two dangling references to a part that no longer exists is the "Excel found unreadable content / needs repair" class of defect. And with neither `refreshOnLoad="1"` on the cache nor `fullCalcOnLoad="1"` on `<calcPr>`, the pivots render from a cache last refreshed on **1 October 2024**.

**Observable impact.** This is not theoretical. `Reporte_Subcontratistas_MAYO_2026.xlsx` — a file this app generated and the operator shipped — reads:

```
'Reporte Social - RRHH'!AG4 = "9-2024"      (the Altas page filter)
'Reporte Social - RRHH'!F15 = 1120          (Total Zona de Influencia)
'Reporte Social - RRHH'!F46 = 65            (Total Bajas)
```

Those are September 2024 numbers in a May 2026 report. Five of the fourteen archived reports (`DICIEMBRE_2024`, `FEBRERO_2025`, `NOVIEMBRE_2025`, `ABRIL_2026`, `MAYO_2026`) are in this state — they were generated and never opened in Excel. The nine that a human opened have a fresh `refreshedDate` and real numbers, which means **the report is only correct if someone manually opens it and hits Refresh**, and nothing in the process says so.

A second consequence: no downstream tool can read the report. Any programmatic check — including the acceptance tests in `03-expected-output.md` — needs an Excel round-trip first.

**How to prove it.**

```bash
unzip -l src/reportes/Reporte_Subcontratistas_MAYO_2026.xlsx | grep calcChain     # → nothing
grep -c refreshOnLoad xl/pivotCache/pivotCacheDefinition1.xml                     # → 0
```

and the SheetJS read of `AG4`/`F15` above.

---

# D. Determinism

## BUG-15 — Every period classification anchors on `TODAY()-30`, so the numbers change every time the file is opened — CRITICAL

**What.** There is no stored report period anywhere in the workbook. `Altas`, `Bajas2`, `Edad` and `Rango Edades` all derive from the wall clock at open time.

**Where.** `xl/tables/table1.xml` + the 8,823 per-cell copies:

| Column | Occurrences | Expression |
|---|---|---|
| `AH Bajas2` | 8,823 rows | `MONTH(TODAY()-30)`, `YEAR(TODAY()-30)` — 4 uses per row |
| `AI Altas` | 8,823 rows | same |
| `V Edad` | 8,823 rows | `TODAY()` ×3 per row, marked `ca="1"` (volatile) |
| `W Rango Edades` | 8,823 rows | `TODAY()` ×12 per row, `ca="1"` |

**Why it is wrong.** `TODAY()-30` is not a month — it is "whatever month the date 30 days ago happened to fall in". Combined with `ca="1"`, the report recomputes itself on every open.

**Observable impact.** Reopen `Reporte_Subcontratistas_FEBRERO_2026.xlsx` today (31 July 2026) and: every `Altas` becomes `"No Aplica"` because no February start date is in July, so `Total Ingresos` collapses to 0; `BajasAntiguas` flips to `"Si"` for everyone with a cese date, evicting them from every headcount pivot; and every worker's `Edad` gains five months, moving people between `Rango Edades` buckets with no data change. **A delivered compliance report cannot be re-verified.** If the client queries a number from February, the file no longer produces it.

**How to prove it.** Open any archived report, note `F15`/`F46`/`F60`, close without saving, change the machine clock by two months, reopen. Different numbers, same file.

**Fix direction.** `03-expected-output.md` §6.4 gives the four formula rewrites (AH, AI, V, W) against explicit `PeriodoInicio`/`PeriodoFin`/`PeriodoEtiqueta` defined names. Alternatively — and this is what `05-implementation-plan.md` §5 recommends as Option D — compute the five time-dependent columns in JS and write literals — which also removes the `#VALUE!` cascade of BUG-07 and the `IFERROR` swallow of BUG-08 in one move.

## BUG-16 — The report period comes from the server's wall clock; filename and content can disagree — HIGH

**What.** The output filename is derived from `new Date()` at write time. Nothing anywhere accepts a report period as input.

**Where.** `src/excelReporting.js:56` and `:69-77`:

```js
const reportPatAndName = path.join(__dirname, `reportes/Reporte_Subcontratistas${getMonthAndYear()}.xlsx`)

const getMonthAndYear = () => {
    const date = new Date();
    const month = date.getMonth() - 1
    const newDate = new Date(date.getFullYear(), month, 1)
    const monthString = newDate.toLocaleString('es-ES', { month: 'long' }).toUpperCase();
    const year = monthString == 'DICIEMBRE' ? date.getFullYear() - 1 : date.getFullYear()
    return `_${monthString}_${year}`;
}
```

**Why it is wrong.** Two independent period definitions that do not agree. `getMonthAndYear()` means "the calendar month before the current one"; `TODAY()-30` inside the workbook means "the month containing today minus 30 days". They coincide only for runs in roughly the first three weeks of the following month. Separately, the December correction is a band-aid (commit `48bb315 fix issue with month and year for december`) that uses a **localized month name** as a year predicate — correct on a full-ICU Node build, wrong on a small-ICU one where `toLocaleString('es-ES',{month:'long'})` returns `"December"` and the `== 'DICIEMBRE'` test never fires.

**Observable impact.** Verified divergence in the archive: `src/reportes/Reporte_Subcontratistas_DICIEMBRE_2025.xlsx` has

```
'Reporte Social - RRHH'!AG4 = "11-2025"     (Altas page filter)
'Reporte Social - RRHH'!D49 = "11-2025"
xl/pivotCache/…Definition1.xml refreshedDate="46021.751749074072"  → 2025-12-30 18:02
```

The file is named **DICIEMBRE** and reports **NOVIEMBRE**. Evaluating `getMonthAndYear()` for today's date (31 July 2026) returns `_JUNIO_2026`, while `TODAY()-30` = 1 July 2026 gives a period label of `"7-2026"` — filename JUNIO, content JULIO, from the same run.

And there is no way to regenerate a past month at all. Re-running February's zip in July produces a file named `_JUNIO_2026` whose Altas/Bajas are classified against July.

**Scope of the fix.** The `--period` argument (`05-implementation-plan.md` Phase 4 task 1) makes the period an *input* rather than an inference, so whatever folder of workbooks is handed to a run can be reported for any month the operator names. That is the whole of it. It does not make a past month recoverable — the app deletes its inputs and, per the owner's decision, will go on doing so (see the note under BUG-44), so February's zip cannot be resurrected by anything.

**How to prove it.**

```js
const f=(d)=>{const month=d.getMonth()-1;const nd=new Date(d.getFullYear(),month,1);
  const ms=nd.toLocaleString('es-ES',{month:'long'}).toUpperCase();
  return '_'+ms+'_'+(ms=='DICIEMBRE'?d.getFullYear()-1:d.getFullYear());};
f(new Date('2026-07-31T12:00:00'))   // → '_JUNIO_2026'
```

## BUG-17 — The Altas page filter is a frozen literal — HIGH

**What.** Two pivots select their Altas period by *item index into a stored item list*, and that stored selection is the string `"9-2024"`.

**Where.** `xl/pivotTables/pivotTable7.xml` and `xl/pivotTables/pivotTable3.xml`: `<pageField fld="34" item="14"/>`, which resolves against the `Altas` pivotField items to `"9-2024"`.

**Why it is wrong.** The formula produces a new label each period, but the pivot's selection is a saved index. When the item it points at no longer exists, Excel's choice of replacement is not deterministic — it currently lands correctly only because after recalc `Altas` has exactly two distinct values, and because the operator re-picks it by hand.

**Observable impact.** Directly visible: `MAYO_2026!'Reporte Social - RRHH'!AG4 = "9-2024"`. In a file the operator shipped, the `Detalle Ingresos Zona de Influencia` block and `Total Ingresos` are filtered to September 2024.

**How to prove it.** The SheetJS read of `AG4` in BUG-14.

---

# E. Normalization correctness

## BUG-18 — Unreachable `case` branches in the GENERO switch, and a literal `"undefined"` gender — HIGH

**What.** The GENERO normalizer has two dead branches and a `default` that writes `String(undefined)` into the workbook.

**Where.** `src/excelConsolidation.js:167-183`:

```js
let edgeCaseTrabajadorGenero = String(trabajador["GENERO"]).toLowerCase().trim();
switch (edgeCaseTrabajadorGenero) {
    case 1:
    case "1":
    case "01":
        trabajador["GENERO"] = "MASCULINO";
        break;
    case 2:
    case "2":
    case "02":
        trabajador["GENERO"] = "FEMENINO";
        break;
    default:
        trabajador["GENERO"] = edgeCaseTrabajadorGenero;
        break;
}
```

**Why it is wrong.** Three separate faults in seventeen lines.

1. `switch` uses strict equality. The scrutinee is always a string, so `case 1:` and `case 2:` can never match. Harmless (the string cases cover them) but it signals the code was never tested.
2. The block runs unconditionally — unlike the `TIPO TRABAJADOR`, `TIPO DE CONTRATO LABORAL` and `ESTADO` blocks, which are all guarded by `typeof … == "string"`. So a **missing** GENERO cell becomes `String(undefined).toLowerCase().trim()` = the literal string `"undefined"`.
3. The mapped output is uppercase `"MASCULINO"`/`"FEMENINO"`, but the `default` passes through *lowercase*. The template validates the lowercase word (`LOWER([GENERO])="masculino"`), so that inconsistency is survivable — but it means the canonical stored value is whatever path a given row took. In the last run: 4,716 `masculino`, 312 `femenino`, 25 `MASCULINO`, 2 `FEMENINO`, and **10 rows of `"undefined"`**.

**Observable impact.** `"undefined"` is a distinct value, so it becomes a **third column** on every gender-pivoted table. Verified in `src/reportes/Reporte_Subcontratistas_OCTUBRE_2025.xlsx`, `'Reporte Social - RRHH'` row 7:

```
C7 "Zona de Influencia" | D7 "femenino" | E7 "masculino" | F7 "undefined" | G7 "Total"
```

Against FEBRERO_2026 and MAYO_2026, where row 7 is `… | F7 "Total"`. That single shift is what breaks BUG-27.

**How to prove it.** The SheetJS read of `C7:G7` across the three files, above.

## BUG-19 — `TIPO DE CONTRATO LABORAL` switches on the raw, untrimmed, un-lowercased string — MEDIUM

**What.** The one normalization switch that does not trim or case-fold, and it is the one with the largest set of free-text variants.

**Where.** `src/excelConsolidation.js:186-231`:

```js
if (typeof trabajador["TIPO DE CONTRATO LABORAL"] == "string") {
    switch (trabajador["TIPO DE CONTRATO LABORAL"]) {
        case "Planilla":
        case "Plazo fijo":
        case "PLAZO FIJO":
        case "PLAZA FIJO":
            trabajador["TIPO DE CONTRATO LABORAL"] = 1;
```

**Why it is wrong.** Compare with `ESTADO` at `:235`, which does `String(...).toLowerCase().trim()` first. Here, `"plazo fijo"`, `"PLAZO FIJO "` and `"Plazo Fijo"` all miss every case and fall to `parseInt("plazo fijo")` → `NaN` (BUG-20). The four hard-coded casings — including the typo `"PLAZA FIJO"` — are an accreted list of exactly what past workbooks happened to contain.

**Observable impact.** The column is carried but consumed by no formula and no pivot, so the impact today is limited to junk values in the delivered data table: the last run contains `0` ×6, `5` ×4, `0.03` ×2, and single instances of `10`, `11`, `14`, against a legal domain of {1,2,3,4}.

## BUG-20 — `parseInt` fallbacks write `NaN` into the workbook — HIGH

**What.** All four normalization switches end in a `default` that calls `parseInt` on an unrecognised value, and the result is written unconditionally.

**Where.** `src/excelConsolidation.js:162`, `:226-228`, `:251` — e.g.

```js
default:
    trabajador.ESTADO = parseInt(trabajador.ESTADO);
    break;
```

**Why it is wrong.** `parseInt` on a non-numeric string yields `NaN`, and `parseInt` on a partially-numeric string yields a *plausible-looking wrong number*. There is no validation of the result against the legal domain, and no error path.

**Observable impact.** Two distinct damages. `NaN` values are dropped by `json_to_sheet`, so the cell arrives empty and joins the `(blank)` bucket on `Tabla`'s ESTADO column axis. Worse, the partial parses survive: `ESTADO` in the last run contains **`184` and `160`** against a legal domain of {1, 2, 3} — column-shift junk that `parseInt` happily converted. `ESTADO` is the column axis of the `Tabla` pivot and the page filter of `CJ Y EPC`, so those values create phantom columns in the headcount breakdown.

**How to prove it.** Tally distinct values of column P in `src/ReporteConsolidado.xlsx`: 4,761×1, 245×2, 36×3, 21 empty, plus 184 and 160.

## BUG-21 — De-duplication is key-order dependent and runs before canonicalization — HIGH

**What.** Duplicate workers are removed by stringifying each row object and putting the strings in a `Set`. `JSON.stringify` serializes keys in insertion order, and insertion order follows each source workbook's column order.

**Where.** `src/excelConsolidation.js:87-92`:

```js
let setWithNoDuplicates = new Set(combinedArray.map(JSON.stringify));
```

then, twenty lines later at `:96`:

```js
const orderedDataWithoutDuplicates = orderHeadersAndData(combinedArrayWithoutDuplicates)
```

**Why it is wrong.** The canonicalization step that would make `JSON.stringify` a valid identity function runs **after** the dedup that needs it. Two byte-identical workers reported by two subcontratistas whose workbooks list columns in different orders produce different JSON strings and are not deduped. Swap the two lines and the dedup becomes order-independent for free.

Two further problems: `JSON.stringify` of a whole row makes the identity key *every field*, so a worker whose two rows differ by one trailing space in `DOMICILIO DE TRABAJADOR` is two people; and dedup runs *before* the `errorEnArchivo` stamp would have been useful, so you cannot report which two files collided.

**Observable impact.** The template compensates for the resulting duplicates with the `Trabajador` / `Trabajadores Unicos` weighting (which is why every published total is fractional: `5096.833333333334`). That weighting is *supposed* to catch genuine double-reporting, which the business wants to see on the `Dos Subcontratas por Mes` sheet. Failed dedup means literal duplicates from a single company pollute that sheet alongside the real cross-company duplicates.

**How to prove it.** Build a two-workbook fixture with the same worker, columns in different order. The output has two rows; `Dos Subcontratas por Mes` lists the worker under one company twice.

## BUG-22 — `errorEnArchivo`, the only traceability field, is deleted before it reaches the output — HIGH

**What.** Every parsed row is stamped with its source file specifically so non-compliant subcontratistas can be traced. The caller's cleanup loop then deletes it, because it is not one of the 18 `dataColumns`.

**Where.** Stamped at `src/excelConsolidation.js:137-145`:

```js
//? To review which Subcontratista is not in compliance with the file structure
personalSubcontrata.forEach((sheetToChange, index, arr) => {
    arr[index] = { ...sheetToChange, errorEnArchivo: `${fileName}`, … };
});
```

Deleted at `src/excelConsolidation.js:64-69` (the `dataColumns.indexOf(key) == -1 → delete` loop).

**Why it is wrong.** The comment says exactly what the field is for. The very next thing that happens to it is deletion. `fileName` is also the `fs.readdirSync` **array**, not a string, so it template-stringifies as `"file.xlsx"` only because each folder happens to hold exactly one workbook.

**Observable impact.** There is no provenance in the output at all. When a value is wrong in the consolidated table, nothing identifies which subcontractor's workbook it came from — which is the single piece of information the operator needs in order to act. This field is the seed of the `Errores` sheet described in `03-expected-output.md` §8.

## BUG-23 — Numeric coercion destroys leading zeros in RUC and DNI — HIGH

**What.** `RUC` and `Nro. DNI / CE` are identifiers, not numbers, but they arrive from SheetJS as whatever the source cell type was and are written straight through.

**Where.** No handling in `src/excelConsolidation.js` at all — the two columns pass through the cleanup loop and `orderHeadersAndData` untouched.

**Why it is wrong.** A Peruvian DNI is 8 digits with significant leading zeros; a CE is 9 digits, likewise. Once a subcontratista's workbook stores it as a number, `09994533` is `9994533` before the app ever sees it — and the app does nothing to restore it.

**Observable impact.** In the last run: `Nro. DNI / CE` is numeric in 1,356 rows, text in 2,986, absent in 723; `RUC` is numeric in 3,276, text in 1,130, absent in **659 (13%)**. The same RUC appears as the number `20604191883` in one row and the text `"20547422407"` in another, so any exact match across the column fails. Nothing validates either identifier — the 4,406 populated RUC cells hold 148 distinct raw values, 147 after trimming, **146 distinct non-blank trimmed values**, and a SUNAT mod-11 check-digit test over those 146 gives **122 pass, 23 fail the check digit, 1 fails the format check**: **~16% of distinct RUCs carry a real data error today, completely invisible to the pipeline**. And the template cannot catch it, because the column that was supposed to (`ValidarDNI`) is BUG-24.

**How to prove it.** Read column D of `src/ReporteConsolidado.xlsx` as raw cells and count `t === 'n'`; compare digit lengths. Of 4,342 non-empty values: **4 at 7 characters** (the leading-zero casualties), **4,202 at exactly 8**, **134 at 9** — the plausible-CE population — and **2 at 10**. Only the 134 nine-digit values are legitimate CE candidates, which is why DNI validation has to be conditional on document type rather than a blanket 8-digit rule.

---

# F. Template-side defects

These live in `src/template.xlsx`, not in the JavaScript, but they are shipped in every report and are the app's responsibility.

## BUG-24 — `Validar Edad`, `Validar Genero` and `ValidarDNI` are three copies of the same GENERO formula — CRITICAL

**What.** Three of the template's validation columns are byte-identical. Only one of them is correct. Age is never validated and the DNI is never validated.

**Where.** `xl/tables/table1.xml`, columns X, Z and AA all carry:

```
IF(OR(LOWER(Tabla2[[#This Row],[GENERO]])="masculino",
      LOWER(Tabla2[[#This Row],[GENERO]])="femenino"),"OK","Corregir")
```

**Why it is wrong.** It is a copy-paste defect, and the originals are recoverable — they are preserved verbatim in the previous generation of the same workbook, `src/Formato Reporte subcontratas.xlsx` → `xl/tables/table1.xml`:

```
Validar Edad  →  +IF(Tabla2[[#This Row],[Edad]]="Corregir","Corregir","Ok")
ValidarDNI    →  +IF(Tabla2[[#This Row],[Nro. DNI / CE]]="","Corregir",
                    IF(LEN(Tabla2[[#This Row],[Nro. DNI / CE]])>=8,"OK","Corregir"))
```

Corroboration that those ran in production: in `Formato Reporte subcontratas.xlsx!Cuadro`, column W holds `"Ok"` (mixed case) while column Y holds `"OK"` — two different literals from two different formulas, exactly as the originals prescribe. The current template has `"OK"` everywhere.

**Observable impact.** The entire hidden `Validacion` sheet is wired to `ValidarDNI`. Its right-hand block (`pivotTable12.xml`, page filter `ValidarDNI = "Corregir"`, titled *Validacion Documento de Identidad*) is supposed to list every worker with a missing or under-8-character document number. Because AA actually tests GENERO, in `FEBRERO_2026` that block resolves to a single `(blank)` group. **The DNI validation report has been empty for as long as the defect has existed** — while `Nro. DNI / CE` was absent on **723 of 5,065 rows** in the last run. The report that exists to catch bad identity data catches nothing.

**How to prove it.** Open `Validacion` in any archived report; the right-hand block is empty. Then compare `<calculatedColumnFormula>` for columns X/Z/AA in `template.xlsx` against the same columns in `Formato Reporte subcontratas.xlsx`.

## BUG-25 — Person identity keys on the name, not the DNI — HIGH

**What.** The de-duplication weighting that produces every headcount in the report treats `APELLIDOS Y NOMBRES` as the person key.

**Where.** `xl/tables/table1.xml`, `Cuadro!AB`:

```
Trabajador = COUNTIF(Tabla2[APELLIDOS Y NOMBRES],Tabla2[[#This Row],[APELLIDOS Y NOMBRES]])
```

feeding `AC Trabajadores Unicos = IF([Trabajador]>1,1/[Trabajador],[Trabajador])`.

**Why it is wrong.** A name is neither unique nor stable. `"HUARCAYA COCCHE JESUS "` and `"HUARCAYA COCCHE JESUS"` are two people; two genuinely different homonyms are one person split 0.5/0.5. `"JAVIER CARHUAVILCA, LUIS ALBERTO"` and `"CARRERA VALENTIN LUIS HERMINIO"` show the comma convention is not consistent either, and the column has 4,373 distinct values across 5,065 rows with observed leading spaces and doubled internal spaces.

**Observable impact.** This is the multiplier on BUG-04: the 643 header-shifted rows all carry the same RUC number as their "name", so `Trabajador` = 643 for each of them and the block contributes a headcount of 1. It is also what `Dos Subcontratas por Mes` is built on — that sheet exists to find workers reported by two subcontratistas in the same month, and it finds them by string-matching names.

**Note.** The fix is not simply "switch to DNI": 723 rows have no DNI at all (BUG-23), so a DNI-keyed formula would need a documented fallback. The right move is to normalize the name in JS (trim, collapse internal whitespace, case-fold for comparison) *and* emit a clean DNI, then decide the key deliberately. Whatever is chosen must be recorded — this is the single most consequential business definition in the report.

## BUG-26 — `Detalle Cesados Zona de Influencia` is filtered on the wrong item — HIGH

**What.** The Bajas detail listing on the deliverable page is filtered to `Bajas2 = "Borrar"` — which by definition means "ceased in some *other* period".

**Where.** `xl/pivotTables/pivotTable2.xml`: `<pageField fld="33" item="1"/>` → `"Borrar"`. Visible on the sheet as `'Reporte Social - RRHH'!U4 = "Bajas2"`, `V4 = "Borrar"`, in all 14 archived reports.

**Why it is wrong.** The summary block above it (`pivotTable4`, `Total Bajas`) sums `Bajas Zona Influencia`, which is 1 exactly for rows whose cese fell **inside** the period. The detail block selects the complement. The two disagree by construction, and because `Bajas Zona Influencia` is 0 for every row the detail block selects, its Total column is all zeros.

**Observable impact.** In `FEBRERO_2026` the summary says **79 bajas** while the detail lists **55 rows, every Total = 0** — including cese dates of 2026‑01‑03, 2025‑11‑30 and even 2026‑08‑01 (a future date). In `OCTUBRE_2025`: summary **91**, detail **5 rows**. This has been shipping wrong for at least 14 months. Anyone who cross-checks the two blocks finds they do not reconcile.

**How to prove it.** Read `U4`/`V4` and count rows in `U6:AD10`'s expanded range against `F46`.

## BUG-27 — The zone-percentage column hard-codes `F` as the Total column — MEDIUM

**What.** `'Reporte Social - RRHH'!G53:G60` computes `+F53/$F$60` — a fixed reference to whichever column the pivot's grand total *happened* to land in when the sheet was built.

**Why it is wrong.** The pivot's column axis is `GENERO`. With two genders, Total is column F. Add a third value and Total moves to G, while `G53:G60` keeps dividing by F — which is now a data column, not a total.

**Observable impact.** Verified in `src/reportes/Reporte_Subcontratistas_OCTUBRE_2025.xlsx`, where BUG-18's `"undefined"` gender became a real column. Be precise about which block does what, because two different pivot blocks are involved.

`G53:G60` belongs to the **`Sum of Altas Zona de Influencia`** block that starts at row 51. In `FEBRERO_2026` its header row 52 reads `D "femenino" | E "masculino" | F "Total Ingresos"`, and `G53:G60` carries the shared formula `+F53/$F$60` — `$F$60` being that block's own `Total Ingresos` row. In `OCTUBRE_2025` the third gender item pushed the Total into column G:

```
OCTUBRE_2025 row 52: C "Zona de Influencia" | D "femenino" | E "masculino" | F "undefined" | G "Total Ingresos"
OCTUBRE_2025 G53 = 25   G60 = 114     ← plain numbers, no formula left in any cell of G53:G60
```

So the pivot body simply **expanded over `G53:G60` and wiped the percentage formulas**. The published October report has no zone-percentage column at all — the column was destroyed, not miscomputed.

Separate evidence that the column axis really does shift: in the `Sum of Trabajdores Unicos Zona Influencia` block (rows 6–15, which carries no percentage formula), `OCTUBRE_2025` has `F15 = 1` (the whole `"undefined"` column) and `G15 = 1867.5` (the real grand total), where `FEBRERO_2026` has `F15 = 1609.5` as the Total.

FEBRERO_2026 and MAYO_2026 have only two genders, the Total stays in `F`, and the formula survives — which is why nobody noticed. Either failure mode is silent: a destroyed formula column looks like a formatting choice.

**How to prove it.** SheetJS read of `C52:G52`, `G53`, `G60` (checking for `.f`) and of `F15`/`G15` across the three files.

## BUG-28 — Junk test data lives in the template's first two data rows — LOW

**What.** `template.xlsx!Cuadro` rows 2 and 3 carry leftover test values and two real workers' records, inside `Tabla2`.

**Where.** `src/template.xlsx`, `Cuadro`:

```
row 2:  A2 "asfasf"        B2 "asf"      C2 "fafsasf"   E2 "GUARDIA RIOS ELLIOT JOULE"
row 3:  A3 2055163079      B3 "asfasf"   C3 "as"        E3 "LOPEZ PICON JEAN CARLOS"
```

**Why it is wrong.** They are inside `Tabla2`, so if they ever survived a run they would be counted: `"asfasf"` would become a contratista in the `Contratistas` roll-call and the two named workers would be phantoms. They also make the template unusable as a clean, empty baseline.

**Observable impact — smaller than it looks, and worth stating precisely.** `writeDataToWorksheet` overwrites `Cuadro` rows 2..n+1 with the consolidated data on every run, so the junk is destroyed before the file is saved. Verified: scanning columns A and C of the full `Cuadro` sheet of `MAYO_2026`, `FEBRERO_2026` and `OCTUBRE_2025` returns **zero** occurrences of `"asfasf"`, `"fafsasf"`, `"asf"` or `"as"`. `MAYO_2026!A2` is `20604191883`, `B2` is `"2A TECH SCRL"`, `E2` is `"ZEGARRA ZEGARRA MANUEL ENRIQUE"` — real data. **The junk has never shipped in a report.**

It still matters for two reasons, which is why it is LOW rather than dropped: it is template hygiene inside a compliance artefact, and it blocks using `template.xlsx` itself as the clean reference the structural assertions and fixture expectations are written against (`03-expected-output.md` §9 preamble and items 20 and 31) — a zero-row run of the current pipeline would leave `GUARDIA RIOS ELLIOT JOULE` and `LOPEZ PICON JEAN CARLOS` in the output. Clean it in the same commit as BUG-31; it is a two-row delete.

## BUG-29 — 14 lookup keys in `Hoja1!A2:B61` can never match; 2 real districts always resolve to `"No"` — MEDIUM

**What.** `Zona de Influencia` is `+IFERROR(VLOOKUP(TRIM([DISTRITO SEGÚN DNI]),Hoja1!$A$2:$B$61,2,FALSE),"No")`. The formula trims the *lookup value*; nobody trimmed the *keys*.

**Where.** `src/template.xlsx!Hoja1!A2:B61` — 56 populated rows in 60 slots (rows 28–31 empty). **Fourteen** keys carry leading or trailing whitespace, dumped verbatim from the sheet XML with their row numbers:

```
r8  "BREÑA "        r12 "ATE "          r13 "BELLAVISTA "   r14 "CARMEN DE LA LEGUA -REYNOSO "
r16 "EL AGUSTINO "  r23 "BRENA - LIMA " r32 "LA VICTORIA "  r35 "SANTA ANITA "
r42 "BRENA - LIMA " r45 "Ventanilla "   r50 " LA PERLA CALLAO"
r52 " CALLAO"       r53 "CALLAO "       r61 "SAN LUIS "
```

One further key has a doubled internal space, `"CERCADO DE  LIMA"` (r47), which `TRIM` collapses — so it can never match either.

**Why it is wrong.** `VLOOKUP(…, FALSE)` is exact match. A padded key is a different string.

**Observable impact.** Twelve of the fourteen are covered by an unpadded twin elsewhere in the table (`VLOOKUP` is case-insensitive, so `"BELLAVISTA "` is covered by `"Bellavista"` at r59 and `"Ventanilla "` by `"VENTANILLA"` at r44), so the damage from those is noise. **Two are not**: `"CARMEN DE LA LEGUA -REYNOSO "` (row 14 — r57 `"CARMEN DE LA LEGUA-REYNOSO"` has no space before the hyphen, so it is not a twin) and `" LA PERLA CALLAO"` (row 50 — r49 holds `"LA PERLA"`, a different string). Both are real Callao districts, and both will permanently resolve to `"No"` — meaning workers who genuinely live in the zone of influence are counted as outside it. Because the fallback is the string `"No"` and not an error, **an unrecognised district is indistinguishable from a genuine out-of-zone district**. There is no way to tell "lives in Ate" from "wrote `AT E`" except by reading the 56-entry table.

Two further hygiene issues in the same table: the value side is dirty (`SAN LUIS ` carries a trailing space, so that zone label is permanently non-canonical and appears with a trailing space in every pivot), and there are 5 duplicate keys. Also on `Hoja1`: `F2:F7` holds an age-bucket list (`18-23`, `59 - A mas`, …) that matches nothing column W emits and is referenced by nothing — dead.

**How to prove it.** Dump `Hoja1!A2:B61` and compare each key against `TRIM(key)`.

## BUG-30 — `Altas Zona de Influencia` and `Bajas Zona Influencia` have a dead branch — LOW

**Where.** `xl/tables/table1.xml`, `Cuadro!AE`:

```
IF(AND([Trabajador]>1,[Zona de Influencia]<>"No",[Altas]<>"No Aplica",[Altas]<>"borrar"),1,
   IF(AND([Altas]<>"No Aplica",[Altas]<>"borrar"),1,0))
```

**Why it is wrong.** Both arms return `1` under overlapping conditions, so the whole expression reduces to `IF([Altas] not in {"No Aplica","borrar"},1,0)`. The `Trabajador>1` and zone tests are dead code, and `"borrar"` is never a value of `[Altas]` (only of `[Bajas2]`). `AF` is the same shape on `[Bajas2]`. Despite the names, neither is zone-restricted — the zone split comes from the pivot's row axis.

**Impact.** None on the numbers. It is misleading enough to have cost someone an afternoon, and it will cost the rework an afternoon too if not flagged.

## BUG-31 — Leftover manual date-repair helpers and other cruft in `Cuadro` — LOW

**Where.** `src/template.xlsx!Cuadro`, outside `Tabla2`:

```
AK2  LEFT(Tabla2[[#This Row],[FECHA NACIMIENTO]],2)
AM2  MID (Tabla2[[#This Row],[FECHA NACIMIENTO]],4,2)
AO2  RIGHT(Tabla2[[#This Row],[FECHA NACIMIENTO]],4)
AP2  DATE(AO2,AM2,AK2)
```

across rows 2..8612, plus a stale defined name `_xlnm._FilterDatabase` on `Cuadro!$AK$14:$AP$8612` and a header `"a"` in `AJ1`. On a numeric serial these produce nonsense (`34456` → `"34"`, `"32"`, `"4432"`, `DATE(4432,32,34)` = 925772).

**Why it matters.** Not a bug in itself — it is documentation. It is direct evidence that the owner has been hand-patching text dates inside Excel, which is exactly the job BUG-06 says belongs upstream in code. Delete it once date normalization lands, and not before.

---

# G. Server & delivery

## BUG-32 — The uploaded zip is written outside the upload folder — HIGH

**What.** A missing path separator concatenates the destination folder name onto the filename.

**Where.** `src/app.js:65-66`:

```js
const uniqueFilename = `${Date.now()}_${zipFile.name}`;
const uploadedFilePath = `${uploadDestination}${uniqueFilename}`;
```

with `uploadDestination = process.env.DATAFOLDER_URL || "subcontratistas"`.

**Why it is wrong.** No `path.join`, no separator. The result is `subcontratistas1741059493565_Febrero-2025` — a *file* in the process CWD, not a file in a *folder*. And because the path is relative, it lands wherever pm2's working directory happens to be.

**Observable impact.** **The proof is committed to this repo**: `git ls-files` lists a 0-byte file named `subcontratistas1741059493565_Febrero-2025` in the repository root. A failed upload also leaves the zip behind permanently, because the `fs.unlinkSync(uploadedFilePath)` at `:85` only runs if extraction succeeded.

**How to prove it.** `ls -la subcontratistas1741059493565_Febrero-2025` — it is there, 0 bytes, tracked by git.

## BUG-33 — An array is passed where a path is expected — HIGH

**What.** `app.js` reads the directory listing and passes the **array** to `consolidateExcelFile`, which string-concatenates it into a path.

**Where.** `src/app.js:88-90`:

```js
const pathExtractedFolder = fs.readdirSync(path.join(__dirname, uploadDestination));
consolidateExcelFile(pathExtractedFolder);
```

consumed at `src/excelConsolidation.js:37`:

```js
let targetDir = path.join(__dirname, '/subcontratistas/' + uploadedFileName);
```

**Why it is wrong.** `'/subcontratistas/' + ['Febrero-2025']` is `'/subcontratistas/Febrero-2025'` — it works **only** because the array has exactly one element. With two entries the array stringifies with a comma: `['__MACOSX','Febrero-2025']` → `"__MACOSX,Febrero-2025"`.

**Observable impact.** macOS zips **always** add a `__MACOSX/` folder. The moment an operator zips on a Mac, the extracted folder has two top-level entries and the path becomes nonsense. `fs.readdirSync(targetDir)` at `:38` is outside any try/catch in `consolidateExcelFile`, so it throws `ENOENT`, propagates to `app.js:95`, and the operator gets `{"message":"Error in server"}` with the actual cause visible only in the pm2 log. The whole run fails with a message that says nothing about what to do.

The same array is also what stamps `errorEnArchivo` (BUG-22) and what builds the per-file read path at `:126`.

**How to prove it.** Zip a folder on macOS with Finder, upload it, watch the 500.

## BUG-34 — `extractAllTo` with no entry, size, count or type validation — MEDIUM

**What.** The app hands an untrusted archive to `adm-zip` and asks for no guarantees at all.

**Where.** `src/app.js:82`:

```js
zip.extractAllTo(path.join(__dirname, "subcontratistas"), /* overwrite */ true);
```

**Why it is wrong, precisely.** Worth being accurate about the residual risk, because it changes what the fix should be. The installed `adm-zip@0.5.10` **does** route extraction through a sanitizer — `node_modules/adm-zip/adm-zip.js:606`:

```js
var entryName = sanitize(targetPath, canonical(entry.entryName.toString()));
```

so the classic zip-slip write-outside-target (CVE-2018-1002204, fixed in 0.4.11) is mitigated by the library despite the app asking for nothing. What is **not** mitigated is everything else: no cap on entry count, no cap on total uncompressed size (a zip bomb is an unbounded write and an unbounded `entry.getData()` buffer), no `.xlsx` type filter, and no exclusion of `__MACOSX/` — which is BUG-33's trigger. What `npm audit` reports in this repo is a HIGH advisory against `<0.6.0` — **GHSA-xcpc-8h2w-3j85**, "Crafted ZIP file triggers 4GB memory allocation", CWE-400/789, CVSS 7.5, `fixAvailable: adm-zip@0.6.0` (`isSemVerMajor`). npm emits no CVE alias for it, so cite the GHSA. Given the pipeline already peaks near 1 GB RSS during the template round-trip, a 4 GB allocation is an immediate OOM on the pm2 host rather than a theoretical DoS.

**Observable impact.** Today: none observed — the archive comes from one trusted operator. The practical exposure is the `__MACOSX` failure and unbounded memory, not arbitrary-path write.

## BUG-35 — The whole pipeline runs synchronously on the event loop — HIGH

**What.** ~50–100 multi-megabyte workbooks are parsed with the **synchronous** `xlsx.readFile` inside a single blocking call, on the request thread.

**Where.** `src/app.js:90` calls `consolidateExcelFile(...)` (not `await`ed, because it is not async), which loops `reader.readFile(...)` at `src/excelConsolidation.js:126`. Then `app.js:93` awaits `writeDataToWorksheet`, whose `XlsxPopulate.fromFileAsync` / `toFileAsync` are async but individually expensive.

**Why it is wrong.** For the entire run the server serves nothing — not a health check, not a progress ping. This is why BUG-45's progress plumbing was written and abandoned: there was no way to serve it. And `req.setTimeout(6000000)` at `app.js:56` is set *inside* the handler, after the socket exists, so it patches the symptom at the wrong layer.

**Observable impact.** The commit history is the symptom, verbatim: `2209f72 increase request timeout`, `cfc72d0 increase timeout`, `1af497f fix server timeout issue`, `729b435 update timeout`, `7b21653 update timeout`, `30f4361 increase timeout`. Six commits, none of which addressed the cause. From the browser's side the page simply hangs with a disabled button for minutes.

**Note on the fix.** The answer is not a worker pool. Measured on this class of machine, parsing the real `Formato Reporte subcontratas.xlsx` (2.4 MB, 4,808-row `Cuadro`) costs 432 ms with default options and 278 ms with `{ sheets: ['Cuadro'], cellFormula: false, cellStyles: false }` — so 100 workbooks is ~28 s, and the template round-trip is another ~2.5 s. The whole job is ~30 seconds of CPU. The problem is that those 30 seconds are *blocking*, not that they are 30 seconds. Move to `fs.promises.readFile` + `XLSX.read(buf)`, yield between files, return a job id, and serve progress on the SSE endpoint the client already expects (BUG-45).

## BUG-36 — `/downloadFile` always serves the same, wrong, report — CRITICAL

**What.** The download route tries to sort reports newest-first and instead performs no sort at all, then serves the first entry the filesystem returned.

**Where.** `src/app.js:123-131`:

```js
// Sort files by creation time
filesWithStats.sort((a, b) => a.ctime + b.ctime);

let sortedFiles = filesWithStats.map((file) => file.name);

res.sendFile(path.join(__dirname, "reportes", sortedFiles[0]))
```

**Why it is wrong.** `a.ctime + b.ctime` adds two `Date` objects. `Date`'s default primitive is a **string**, so the expression is string concatenation; `Array.prototype.sort` coerces the comparator's return to a number, gets `NaN`, and treats it as 0. The array is returned untouched. The intent — newest first — needed `b.ctime - a.ctime`.

**Observable impact.** `sortedFiles[0]` is whatever `readdirSync` returned first, which on this machine is alphabetical:

```js
fs.readdirSync('src/reportes')[0]   // → 'Reporte_Subcontratistas_ABRIL_2026.xlsx'
```

So the operator generates JULIO 2026 and downloads **ABRIL 2026**. And because BUG-40 renames the download client-side to the month the operator expected, the April file arrives on their desktop named `Reporte_Subcontratistas_JUNIO_2026.xlsx`. That combination is what makes this CRITICAL rather than HIGH: there is no signal at any point that the wrong file was delivered. The only way to find out is to open it and notice the numbers are three months old — which is hard, because BUG-14 means the numbers are stale anyway.

Aggravating factor (BUG-50): the listing is not filtered by extension, so `~$Reporte_Subcontratistas_FEBRERO_2025.xlsx` — a 165-byte Excel lock file currently sitting in `src/reportes/` — is a valid delivery candidate.

**How to prove it.**

```js
const arr=[{n:'Z',ctime:new Date(2026,0,1)},{n:'A',ctime:new Date(2020,0,1)}];
arr.sort((x,y)=>x.ctime+y.ctime);
arr.map(x=>x.n).join(',')          // → 'Z,A'   (unchanged)
Number(new Date() + new Date())    // → NaN
```

## BUG-37 — A failed report write returns HTTP 200 with a download button — CRITICAL

**What.** The only error handler in the report writer logs and returns normally. The caller cannot tell success from failure.

**Where.** `src/excelReporting.js:61-63`:

```js
} catch (error) {
    console.error("An error occurred:", error);
}
```

There is no `throw`, no rejected promise, no return value. `src/app.js:93-94`:

```js
await writeDataToWorksheet("template.xlsx")
res.status(200).end()
```

**Why it is wrong.** `writeDataToWorksheet` resolves to `undefined` whether it wrote a 4 MB workbook or blew up on the first line. The same function also returns early at `:21-24` if the `Cuadro` sheet is missing, with `console.log("Worksheet 'data' not found.")` — again resolving normally.

**Observable impact.** `public/js/index.js:60` checks `if (response.status == 200)` and renders the "Descargar Archivo" button. So on a failed run the operator sees a success state, clicks download, and — thanks to BUG-36 — receives ABRIL 2026 named as the current month. **A total pipeline failure is indistinguishable from a successful run, all the way to the delivered file.** Every failure mode in this register that surfaces as an exception is neutralised by this one line.

**How to prove it.** Make `src/reportes/` read-only and run the pipeline. HTTP 200, download button, no file written.

## BUG-38 — No upload size or type limit — MEDIUM

**Where.** `src/app.js:51`: `app.use(fileUpload());` — no options.

**Why it is wrong.** `express-fileupload` with no `limits` and no `useTempFiles` buffers the entire upload in memory. There is no `.zip` check either; a non-zip reaches `new AdmZip(...)` and throws.

**Observable impact.** Acceptable-ish for one trusted operator on an internal box, but it stacks with BUG-34's unbounded extraction and the ~1 GB peak RSS of the template round-trip. Set a size cap, an entry-count cap and an `.xlsx`-only filter in the same commit as BUG-34.

## BUG-39 — `DATAFOLDER_URL` is honoured in two places out of three — MEDIUM

**What.** The upload destination is configurable by environment variable, but the extraction target and the consolidation reader both hard-code the literal.

**Where.**

| Line | Uses |
|---|---|
| `src/app.js:20` | `const uploadDestination = process.env.DATAFOLDER_URL \|\| "subcontratistas"` |
| `src/app.js:46,88` | `path.join(__dirname, uploadDestination)` — configurable |
| `src/app.js:82` | `path.join(__dirname, "subcontratistas")` — **hard-coded** |
| `src/excelConsolidation.js:37,126` | `'/subcontratistas/'` — **hard-coded** |

**Observable impact.** Setting `DATAFOLDER_URL` to anything else breaks the app: files extract to `src/subcontratistas` while `readdirSync` looks in `src/<other>`. Either wire it through or delete the variable — a half-honoured configuration knob is worse than none, because it invites someone to use it.

---

# H. Observability & operations

## BUG-40 — The download filename is recomputed on the client — CRITICAL in combination with BUG-36

**What.** `getMonthAndYear()` exists twice: once server-side to name the file, once client-side to name the *download*. The client's copy wins on the operator's desktop.

**Where.** `src/excelReporting.js:69-77` and `public/js/index.js:103-111` — character-for-character identical implementations. Used at `public/js/index.js:89`:

```js
downloadElement.download = `Reporte_Subcontratistas${getMonthAndYear()}.xlsx`
```

**Why it is wrong.** The client renames whatever bytes arrive. The filename is therefore a *claim about what the operator asked for*, not a fact about what the server sent. It also runs on the operator's clock, not the server's, so a run near midnight or across a timezone can name it differently again.

**Observable impact.** This is what converts BUG-36 from noticeable to invisible. It is also a maintenance trap in its own right: the December year band-aid (`monthString == 'DICIEMBRE' ? getFullYear()-1 : getFullYear()`) has to stay identical in both copies forever, and there is no test for either.

**Fix.** Compute the filename **once**, server-side, from the operator-supplied period (BUG-16), and send it in `Content-Disposition`. Delete the client copy.

## BUG-41 — No tests, no fixtures, no way to know anything in this register regressed — HIGH

**What.** The repo has zero tests. `package.json:6` is the npm placeholder:

```json
"scripts": {
    "test": "echo \"Error: no test specified\" && exit 1",
    "dev": "node --watch src/app.js "
}
```

and `.github/workflows/subcontratistas.yml` runs `npm ci` then `npm run build --if-present` then `sudo pm2 restart 0` — it never runs `npm test`.

**Why it is wrong.** Every defect in groups A, B and E is a pure function over a string or a workbook fixture — the ideal shape for a test. Their absence is precisely why the `case 1:` / `case 2:` dead branches, the `a.ctime + b.ctime` non-comparator and the three-identical-validation-formulas survived to production. Node 22 (the version CI pins) ships `node:test` and `node:assert`, so this costs one line in `package.json` and one line in CI.

**Observable impact.** No regression gate exists for the rework. The parallel-run diff (`03-expected-output.md` §9 items 28–29) and every fixture assertion depend on it.

**Fixture note.** The fixtures are **hand-written**, not carved out of a real month: kilobyte-scale, five to twenty rows each, synthetic names and document numbers, authored from knowledge of each pathology with `src/ReporteConsolidado.xlsx` and `src/template.xlsx` used as reference for realistic *shape* only. One workbook per pathology — header not in row 1, a leading blank column, columns reordered, `EMPRESA` to the left of `RUC`, `DISTRITO SEGUN DNI` unaccented and `RUC ` with a trailing space, `CONTRATISTA PRINCIPAL` spelled correctly, a duplicate header, a sheet not named exactly `Cuadro`, no `Cuadro` sheet at all, the column-shifted workbook (A–D absent, the RUC number in `APELLIDOS Y NOMBRES`), text dates in every observed shape plus the malformed years, fractional serials, the `FECHA CESE/BAJA` sentinels, a DNI with a leading zero alongside RUCs that pass and fail the mod-11 check, out-of-domain `ESTADO`/`TIPO DE CONTRATO LABORAL`/`GENERO` values, the older input format with no `HPT` column (BUG-55), and dirty text columns — plus four container fixtures: a folder with two `.xlsx`, a folder with zero, a folder holding a `~$` Excel lock file, and a zip carrying a `__MACOSX/` entry. Each ships with its expected output as JSON beside it; that file is the assertion. `05-implementation-plan.md` Phase 0 task 2 lists all 21 by filename and `03-expected-output.md` §9 item 31 is the acceptance criterion. This corpus is not a supplement to a golden master — there is none, and there will be none, so its coverage is the ceiling on what the offline suite can catch. Do not add more multi-megabyte workbooks — see BUG-46.

## BUG-42 — The diagnostic for a lost subcontratista is one console line, and the console is cleared — HIGH

**What.** The only failure signal in the extraction loop is a `console.log`, and the loop calls `console.clear()` on every iteration.

**Where.** `src/excelConsolidation.js:74-77` (the catch, quoted in BUG-01) and `src/excelConsolidation.js:281-291`:

```js
function logCurrentProgress() {
    console.clear();
    console.log(`Progress : ${…}`);
}
```

called at `:50`, at the top of every directory iteration.

**Why it is wrong.** `console.clear()` inside a long-running server process wipes the operator's terminal — including the `"Error with: " + directory` lines and the stack traces printed by `console.error` for every *earlier* failure. By the end of a 100-directory run, the terminal shows one progress percentage and nothing else. There is no log file, no run summary, no per-file record.

**Observable impact.** This is the amplifier on BUG-01. The pipeline's single most dangerous failure mode has exactly one diagnostic, and the pipeline deletes it. The operator has no way to answer "did every subcontratista's file parse?" — which is the whole question the report exists to answer.

**Fix priority.** Highest value per line of code in the register: (1) stop swallowing errors, (2) emit an `Errores` sheet in the output workbook with `(archivo, subcontratista, fila, celda, columna, valor crudo, motivo)`, (3) *then* consider a logger. Steps 1 and 2 need no dependency.

## BUG-43 — The cleanup function cannot catch its own errors and reports success unconditionally — MEDIUM

**Where.** `src/excelConsolidation.js:267-277`:

```js
function deleteFilesFromDirectory() {
    try {
        fs.rm(targetDir, { recursive: true }, () => console.log("All files deleted"))
    }
    catch (exception) {
        console.error("Error removing files from folder")
    }
}
```

**Why it is wrong.** Three faults stacked. `fs.rm` is the **callback** form — it reports errors through the callback's first argument, so the surrounding `try/catch` can never fire. The callback ignores that argument entirely and prints `"All files deleted"` whether or not anything was deleted. And the call is not awaited (it cannot be — it is callback-style inside a synchronous function), so `consolidateExcelFile` returns and `app.js:93` starts the template round-trip while the recursive delete is still running.

**Observable impact.** The race itself is currently benign: `ReporteConsolidado.xlsx` lives outside `targetDir` and is already written by line 110. The real damage is the false success message — combined with BUG-44, the operator is told files were deleted when they were not.

**Fix direction.** The same one BUG-44 needs: a fresh per-run temp directory removed in an **awaited** `finally`, with a real error path, on every exit path. All three faults here are in the *manner* of the deletion; deleting the inputs is intended (see the note under BUG-44) and nothing should be copied anywhere first.

## BUG-44 — A failed run leaves extracted files behind and bricks the next run — HIGH

**What.** The cleanup on the error path is commented out, so any failure leaves the extracted subcontractor folders in `src/subcontratistas/`. The next upload then extracts *alongside* them, `readdirSync` returns two top-level entries, and BUG-33's array coercion produces a broken path.

**Where.** `src/app.js:95-101`:

```js
} catch (err) {
    console.error(err);
    //Remove all files from the folder
    // fs.rm(path.join(__dirname, uploadDestination), { recursive: true }, () => res.status(500).send("File processing failed"))
    res.status(500).json({ message: "Error in server" }).end()
}
```

**Why it is wrong.** Failure is **sticky**. One bad run leaves the app in a state where every subsequent run fails, with the same useless `"Error in server"` message, until someone SSHes in and clears `src/subcontratistas/` by hand.

**Observable impact.** For a tool used once a month by one non-developer operator, a failure mode that requires shell access to recover is the difference between "retry the upload" and "call Alvaro". Extract to a fresh per-run temp directory and delete it in a `finally`.

## Note — the app destroying its own inputs is **accepted behaviour**, not a defect

Stated once here so that nobody files it as a BUG later. `src/app.js:85` does `fs.unlinkSync(uploadedFilePath)` on the uploaded zip immediately after extraction, and `deleteFilesFromDirectory()` (`src/excelConsolidation.js:270`) removes the extracted folder at the end of every run. `src/subcontratistas/` is consequently empty and **no past month's input workbooks exist anywhere** — not on the pm2 box, not in this repo.

**The owner has decided that retaining inputs, logs or any other historical material is not required.** The app may go on deleting what it is given; no past month needs to be reproducible after the fact. That is intended behaviour, so it carries **no BUG id**: nothing was retired, nothing was renumbered, and the register still holds **55** defects at their existing severities. BUG-43 (MEDIUM) and BUG-44 (HIGH) stay live and unchanged because they are faults in the *manner* of the deletion — a callback-form `fs.rm` inside a `try/catch` that can never fire, an unconditional "All files deleted", an unawaited call racing report generation, and a cleanup commented out on the error path — not in the fact of it.

What this costs is the ability to prove a reworked pipeline reproduces a specific past month's published numbers. `05-implementation-plan.md` §4 states that as an accepted risk and sets out what replaces it: hand-written pathology fixtures plus structural assertions offline (BUG-41), and a two-month parallel run in which one upload is processed by both the old and the new pipeline inside the same job and the two outputs are diffed — which needs nothing retained, because both runs consume the same in-flight extraction and the `finally` above simply moves to the end of the job.

None of this touches the 14 delivered reports in `src/reportes/`. They are **evidence about current behaviour** and the source of most of the measured numbers in this register — the 3,757 ghost rows in `MAYO_2026`, the 36 workers in the `#VALUE!` bucket on `FEBRERO_2026`'s front page, the five of fourteen still displaying September-2024 numbers, `Detalle Cesados` claiming 79 bajas and listing 55 rows. Every "how to prove it" snippet that reads one of them stands. What they are not is a baseline to diff a new run against.

## BUG-45 — The progress endpoint is referenced by two clients and does not exist — LOW

**What.** Both the EJS view and the browser bundle open an `EventSource('/progress')`. There is no such route.

**Where.**
- `src/views/progress.ejs`: `const eventSource = new EventSource("/progress");`
- `public/js/index.js:1-24`: the same code, commented out.
- `src/excelConsolidation.js:314-316`: `getCurrentProgress()` is written and exported.
- `src/app.js:15`: `getCurrentProgress` is **imported and never routed**.

**Why it is wrong.** The plumbing is 90% built and 0% connected — because it could not work anyway while the event loop is blocked (BUG-35). Also `let progress = 1` at `excelConsolidation.js:8` is module-level mutable state, so it is global rather than per-run and would report nonsense under concurrent uploads.

**Observable impact.** None today; the operator just watches a disabled button for several minutes with no feedback. It becomes trivially fixable once BUG-35 is addressed, and is the single biggest UX win available.

## BUG-46 — 30 multi-megabyte workbooks are tracked in git — LOW

**What.** `git ls-files` counts **30 tracked `.xlsx` files** at 2–5 MB each. `.git` is **115 MB**.

**Why it matters.** `npm ci` on the self-hosted runner clones this every build. More importantly, it makes the repo hostile to the small fixture files BUG-41 needs — "don't commit workbooks" is currently indistinguishable from "the repo is full of workbooks". Move the historical reports and templates out (they are inputs and archives, not source), keep `template.xlsx` and kilobyte-sized fixtures.

---

# I. Security & dependencies

## BUG-47 — `xlsx@0.18.5` is unmaintained on npm with two unpatchable advisories — MEDIUM

**What.** `package.json:19` pins `"xlsx": "^0.18.5"`, resolved in `package-lock.json` to the registry tarball. SheetJS stopped publishing to npm after 0.18.5 (2022-03-24) and moved to their own CDN, so `npm audit` reports `fixAvailable: false`.

**The advisories.** GHSA-4r6h-8v6p-xvw6 / CVE-2023-30533 (prototype pollution, needs ≥0.19.3) and GHSA-5pgg-2g8v-p4x9 / CVE-2024-22363 (ReDoS, needs ≥0.20.2). GitHub's advisory DB lists `firstPatchedVersion: NONE` for both in the npm ecosystem for exactly that reason.

**Why it is only MEDIUM.** The attacker-controlled input is a zip uploaded by one known operator containing workbooks from known subcontractors. Prototype pollution and ReDoS in that threat model are a nuisance, not a breach. The reason to move is not the CVE — it is that `sheet_to_json`'s `range` option (BUG-02) and cleaner date handling are worth having, and staying on a frozen 2022 artifact means never getting a fix for anything.

**Note.** `04-proposed-packages.md` covers the options and their supply-chain trade-offs. Do not confuse this with the *writer*: `xlsx-populate@1.21.0` is also unmaintained but must be kept — it is the only thing in the ecosystem that preserves this template's 13 pivot tables byte-identically, and it does so by never parsing them.

## BUG-48 — Five dependencies are installed and unused — LOW

**Where.** `package.json` declares `@google-cloud/local-auth@^2.1.0`, `googleapis@^105.0.0`, `exceljs@^4.4.0`, `lodash@^4.17.21`, `ejs@^3.1.9`.

- `googleapis` + `@google-cloud/local-auth`: never `require`d anywhere. Leftovers from the `firebaseproject` origin (`package.json:2` still carries that name). Together they are the largest attack surface in the tree, for zero functionality.
- `exceljs`: never `require`d. 21.8 MB unpacked.
- `lodash`: `require`d as `_` at `excelConsolidation.js:5` and **never called**.
- `ejs`: serves only the dead `/ejs` route (BUG-54).

**Impact.** Install time, audit noise, and a misleading picture of what the app actually does.

## BUG-49 — CI restarts pm2 process index 0 — MEDIUM

**Where.** `.github/workflows/subcontratistas.yml`:

```yaml
- run: sudo pm2 restart 0
- run: sudo pm2 save
```

with the correct form sitting commented out directly above it:

```yaml
# - run: pm2 describe subcontratistas || pm2 start ~/Desktop/subcontratistas/app.js --name subcontratistas
```

**Why it is wrong.** Index 0 is whichever process pm2 happens to have listed first. If another app is ever added to that runner, a deploy of this repo restarts an unrelated service — and never restarts this one, so the operator runs last month's code without knowing. Restart by name.

## BUG-50 — `/downloadFile` serves any entry of `src/reportes/` — MEDIUM

**What.** No authentication (accepted by the owner), but also no extension filter, no path validation, and a directory that accumulates every report ever generated.

**Where.** `src/app.js:105-132`.

**Observable impact.** `src/reportes/` currently holds 14 reports and `~$Reporte_Subcontratistas_FEBRERO_2025.xlsx`, a 165-byte Excel lock file left behind by someone editing a report while the app ran. That lock file is in the `readdirSync` listing and is therefore a valid `sortedFiles[0]` candidate — under a different filesystem ordering the operator downloads 165 bytes of garbage. Filter to `/^Reporte_Subcontratistas_.*\.xlsx$/` and serve the file the run just produced, by name, not by position.

---

# J. Broken and dead code

## BUG-51 — `src/discrepancias.js` does not parse — LOW

**Where.** `src/discrepancias.js:13-14`:

```js
        const files = fs.readdi
        "ga/rSync(folderPath);
```

A corrupted edit committed to `main`. It is never `require`d, so the server is unaffected — but `node src/discrepancias.js` is a syntax error, and any tooling that parses the whole `src/` tree (a linter, a bundler, a test runner glob) will choke on it.

**Worth noting:** its intent is genuinely useful and unfinished — compare the `SUBCONTRATISTA` name *inside* each workbook against its folder name, which is exactly the provenance check BUG-22 needs. It also hard-codes `workbook.SheetNames[1]` and cell `C3`, which are the same assumptions BUG-01 and BUG-02 are about. Either finish it as part of the extraction rework or delete it; do not leave it.

## BUG-52 — `filteredData` is computed and discarded, and the filter is a no-op — LOW

**Where.** `src/excelConsolidation.js:73`:

```js
let filteredData = data.filter((trabajador, index) => data.indexOf(trabajador) === index);
```

Never read. And `data.indexOf(trabajador)` on object references compares identity, so for an array of distinct objects the predicate is always true — it filters nothing. It also operates on `data`, the array-of-arrays, not on worker rows. Three separate mistakes in one line, which is a good marker for where the dedup thinking went wrong (see BUG-21).

## BUG-53 — The directory-creation guard runs after the read it was meant to protect — LOW

**Where.** `src/excelConsolidation.js:37-46`:

```js
let targetDir = path.join(__dirname, '/subcontratistas/' + uploadedFileName);
let directories = fs.readdirSync(targetDir);
console.log(directories)

//Create the folder
if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir);
}
```

`readdirSync` throws `ENOENT` if the directory is missing, so the guard four lines later is unreachable in exactly the case it was written for. Delete it or hoist it.

## BUG-54 — Dead routes, dead files, and frontend cruft — LOW

| Item | Where |
|---|---|
| `/ejs` route rendering `progress` with `{ message: 'Hello, EJS!' }` | `src/app.js:38-41` — the only reason `ejs` is a dependency |
| `<title>Document</title>` | `src/index.html:6` |
| Duplicated instruction: "El archivo debe estar en formato zip" twice | `src/index.html:32-33` |
| Instruction 1 tells the operator to "Ingresar a alvarobeltran.dev" — inside the page they are already on | `src/index.html:38` |
| Bootstrap, Popper and axios loaded from **three different CDNs** — no offline operation on an internal tool | `src/index.html:9,85,90,95` |
| Unused `<script type="module"></script>` | `src/index.html:83` |
| `src/template_new.xlsx`, `src/test.xlsx`, root `Reporte_Subcontratistas__OCTUBRE_2024.xlsx` (note the double underscore — a fossil of an earlier filename template) | repo tree |
| `package.json:2` still names the project `firebaseproject` | `package.json` |
| Four `//TODO:` comments at the top of `app.js`, including "Move project to Next.js" | `src/app.js:22-26` |

---

# Where the owner's assumptions were right and wrong

**"Column order is already handled" — right, and it does not help.**

`orderHeadersAndData()` (`src/excelConsolidation.js:300-312`) genuinely rebuilds every row in canonical `dataColumns` order, so a workbook that lists its columns in a different order *is* correctly reordered. That assumption is factual.

But reordering is the second step, and the first step is recognition — and recognition is an exact, case-sensitive, accent-sensitive, whitespace-sensitive string equality (`dataColumns.indexOf(key)` at `:66`). A header of `"RUC "`, `"Ruc"`, `"DISTRITO SEGUN DNI"` or `"CONTRATISTA PRINCIPAL"` never becomes a recognised key, so it is deleted before `orderHeadersAndData` ever sees it. The reorder is correct; it just never gets a chance. The column comes out **present and empty**, which is worse than missing, because nothing distinguishes it from a subcontratista who genuinely left the field blank.

The two fixes are the same mechanism: normalize the header (trim → collapse internal whitespace → NFD accent-fold → upper-case) and look it up in a Map seeded with the 18 canonical names plus an explicit, greppable alias table. Verified on the real variants, that normalizer collapses `"DISTRITO SEGUN DNI"`, `"Distrito segun DNI "`, `"DISTRITO SEGÚN DNI"` and `"  distrito  según   dni"` to one key, and `"RUC "` / `"Ruc"` to `RUC`. The one case it cannot solve — `CONTRATISTA PRINCIPAL` vs the canonical typo `CONTRATISTA PRNCIPAL` — is a genuine spelling difference and belongs in the alias table, where it can be logged as "accepted alias X as Y" rather than resolved silently by a fuzzy matcher.

**"Anchor extraction on the first column whose header is RUC" — right, and the capability is already installed.**

`sheet_to_json` is called with no options (`:131-133`), which is exactly the A1 assumption the owner described. The fix needs no new dependency: scan `XLSX.utils.decode_range(ws['!ref'])` for the first cell matching `/^\s*ruc\s*$/i`, then pass `{ range: encode_range({s: anchor, e: R.e}), defval: null, raw: true }`. One caveat worth knowing before you write it — anchoring alone is not enough. Even anchored, `sheet_to_json` returns header keys **verbatim and untrimmed** (`' ruc '` stays `' ruc '`), so the normalization layer above is still required. Anchoring and header-variant tolerance are one job, not two.

**"Dates are inconsistent" — right, and worse than the owner probably thinks.**

Confirmed and quantified: ~200 of 5,065 rows carry text dates, plus at least one malformed year (`"09/10/205"`). What the owner may not have connected is that the damage splits into two very different failure modes. The visible one is `#VALUE!` in `Edad`/`Rango Edades` (BUG-07) — 36 workers in an error bucket on the front page of `FEBRERO_2026`. The invisible one is `Altas`/`Bajas2` (BUG-08), where the `IFERROR` fallback quietly reclassifies an unparseable date as "did not join / did not leave". The first is ugly. The second silently understates `Total Ingresos` and keeps departed workers on the active headcount indefinitely, and nothing on the deliverable hints at it.

**"Mostly self-implemented; I want a package list" — right, but the packages are not where the value is.**

Of the twelve package questions researched in `04-proposed-packages.md`, exactly two are unambiguous adopts and one is "you already have it". The highest-value fixes in this register need no dependency at all: anchoring on the normalized `RUC` header, not swallowing the missing-`Cuadro` error, shrinking `Tabla2` instead of writing 3,757 empty strings into it, fixing the `a.ctime + b.ctime` comparator, and taking the report period from the operator instead of the wall clock. The dependencies make the result *trustworthy*; those five changes make it *correct*.

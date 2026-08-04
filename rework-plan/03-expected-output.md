# Expected Results / Output Specification

This is the acceptance contract for the reworked pipeline: what a subcontractor workbook is allowed to look like, what a canonical worker record is, what the delivered `.xlsx` must contain, and what has to be true before a month's report is considered correct. Where `01-current-state.md` and `02-shortcomings.md` describe what the app does today, this document describes what it must do — every requirement here is checkable, and §9 turns them into a numbered test list. Numbers quoted below were measured directly against `src/ReporteConsolidado.xlsx` (the last real run, 5,065 rows), `src/template.xlsx`, and the 14 archived reports in `src/reportes/`.

The governing principle, and the one that resolves every ambiguity in what follows: **a failure must be louder than a success.** The app's most dangerous property today is that a subcontractor whose workbook cannot be read produces no error the operator ever sees (`src/excelConsolidation.js:74-77`, plus `console.clear()` at `:284` wiping the terminal), and the output still looks complete.

---

## 1. Input contract

### 1.1 The package

One `.zip`, uploaded by one operator, containing one folder per subcontratista, each holding exactly one `.xlsx`. The folder name is the subcontratista's identity for reporting purposes and must be carried through to the run report (§8).

Tolerances the extractor must have that it does not have today:

| Situation | Required behaviour | Today |
|---|---|---|
| `__MACOSX/` entry at any level (macOS always adds it) | skipped silently | corrupts the path — `consolidateExcelFile` receives an array from `fs.readdirSync` (`src/app.js:88-90`) that only works because it has exactly one element |
| More than one top-level folder | each processed, or a clear error naming both | undefined behaviour, same cause |
| `~$…xlsx` Excel lock files | skipped silently (one is sitting in `src/reportes/` right now) | attempts to parse, throws, swallowed |
| Non-`.xlsx` entries (`.xls`, `.pdf`, `.csv`, images) | skipped and **listed** in the run report | attempts to parse, swallowed |
| Folder containing two or more `.xlsx` | hard error naming the folder and both files | reads whichever `readdirSync` returned first |
| Folder containing zero `.xlsx` | hard error naming the folder | throws inside the `try`, swallowed |

Also required, and independent of correctness: cap the upload size, cap the entry count and total uncompressed size, and reject entries whose normalized path escapes the extraction root. See `04-proposed-packages.md` for the `adm-zip` advisory that makes the size cap non-optional.

### 1.2 Locating the table — the anchoring rule

This is owner goal #1 and it replaces `reader.utils.sheet_to_json(sheet)` with default options at `src/excelConsolidation.js:131-133`, which hard-assumes the header is row 1 and the table starts at A1.

**Sheet selection.** Scan every sheet name; select the first whose value, after trimming, collapsing internal whitespace, folding accents (NFD + strip combining marks) and upper-casing, equals `CUADRO`. This accepts `Cuadro `, `cuadro`, `CUADRO`. If no sheet matches, the workbook **fails loudly** with the folder name, the file name, and the list of sheet names actually present. It must never resolve to `undefined` and disappear into a `catch`.

**Header anchoring.** Within the selected sheet:

1. Read `!ref` and walk cells in row-major order from the top-left of the used range.
2. Find the **first** cell whose value, normalized by the same function, equals exactly `RUC`.
3. That cell defines the **header row only**. It does *not* define the left edge.
4. Resolve the left edge by scanning **leftward** from the anchor along the same row, stopping at two consecutive empty cells. The leftmost non-empty cell of that run is the table's left edge. Resolve the right edge by scanning **rightward** from the anchor under the same two-consecutive-empties rule. Read headers across the full resolved span, not rightward from `RUC`.
5. Read data rows downward from the row after the anchor. Stop after **5 consecutive rows that are entirely empty** across the full header span. Trailing blank rows below the stop point are discarded, not counted.
6. Cap the anchor search at the first 50 rows and first 30 columns of the used range. If no `RUC` cell is found inside that window, the workbook fails loudly with the first 10 non-empty cell values found, so the operator can see what the file actually contains.

**Why steps 3 and 4 are split, and it is not pedantry.** The owner's own premise is that column *order* may vary. If the anchor also defined the left edge, a workbook that puts `EMPRESA` — or any other canonical column — to the left of `RUC` would have those columns silently discarded, because they fall outside the read range. That is a new instance of exactly the failure class BUG-03 describes: a column that is *present and empty* rather than reported. The ≥8-of-18 threshold in §1.4 would not catch it either, since losing one or two columns still leaves 16 or 17 resolving. Anchoring identifies the *row*; the span is a separate measurement.

Whenever the resolved left edge is to the left of the `RUC` column, emit an **INFO** line in the run report — `"left edge resolved at B7, two columns left of the RUC anchor at D7: EMPRESA, CONTRATISTA PRNCIPAL"` — so an unexpected span is visible rather than merely tolerated.

SheetJS supports this with the API already installed — `XLSX.utils.decode_range` to scan for the anchor and to walk the header row in both directions, then `sheet_to_json(ws, { range: encode_range({s: {r: anchorRow, c: leftEdge}, e: {r: R.e.r, c: rightEdge}}), defval: null, raw: true })`. No new dependency is required for the anchoring itself.

**`defval: null` is mandatory.** The default omits keys entirely for empty cells, which is a second silent data-loss path independent of header matching: a row with a missing `DISTRITO SEGÚN DNI` currently arrives as an object with no such key, and `orderHeadersAndData` (`:300-312`) writes `undefined` into that slot.

### 1.3 Header matching

Normalize every header with the same function used for the anchor:

```
trim → collapse internal whitespace runs to one space → NFD, strip combining marks → uppercase
```

That single function resolves every *formatting* variant the owner has hit: `"RUC "`, `"Ruc"`, `"DISTRITO SEGUN DNI"`, `"Distrito segun DNI "`, `"  distrito  según   dni"` all collapse onto their canonical form. What it cannot resolve is a genuine *spelling* difference, and those belong in an explicit, greppable alias table — never in a fuzzy matcher, which would resolve them by accident and give no audit trail.

| Incoming header | Canonical column | Resolved by |
|---|---|---|
| `CONTRATISTA PRINCIPAL` | `CONTRATISTA PRNCIPAL` | **alias table** — the canonical name carries a typo (`PRNCIPAL`) that is load-bearing in `xl/tables/table1.xml`, every pivot field, and every structured reference |
| `DISTRITO SEGUN DNI`, `Distrito segun DNI ` | `DISTRITO SEGÚN DNI` | normalizer (accent fold + trim) |
| `RUC `, `Ruc` | `RUC` | normalizer |
| `Nro DNI/CE`, `N° DNI / CE`, `NRO. DNI/CE` | `Nro. DNI / CE` | alias table (punctuation is not whitespace) |
| `FECHA DE NACIMIENTO` | `FECHA NACIMIENTO` | alias table |
| `FECHA DE CESE`, `FECHA CESE`, `FECHA DE CESE/BAJA` | `FECHA CESE/BAJA` | alias table |
| `FECHA DE INICIO DE LABORES EN OBRA`, `FECHA INICIO LABORES` | `FECHA INICIO DE LABORES EN OBRA` | alias table |
| `SEXO` | `GENERO` | alias table |
| `CARGO`, `PUESTO`, `TITULO DE PUESTO` | `TITULO DE PUESTO/CARGO` | alias table |
| `H.P.T.`, `HORAS` | `HPT` | alias table |

Only the first row is evidence-backed today — it is the single alias that exists anywhere in the codebase (`src/excelConsolidation.js:141-144`). The rest are a seed list. **The alias table is grown from the run report, not from guesswork:** every unrecognised header is logged verbatim per subcontratista (§8), and the operator promotes recurring ones into the table. That is the only mechanism that keeps the table honest.

Rules on top of matching:

- A header that matches nothing is **reported**, never silently dropped. Today the cleanup loop at `:64-70` deletes any key not in `dataColumns`, and the column comes out blank with no message.
- Two headers that normalize to the same canonical column is a **hard error** for that workbook, not a `_1`/`_2` suffix. SheetJS de-duplicates repeated header names by suffixing, producing a key that will never match anything.
- A canonical column absent from the workbook produces a **warning** naming the column and the subcontratista, and the field is null for every row of that file. It never produces `undefined`.
- `HPT` is the one column that is legitimately absent from older files: `src/Formato Reporte subcontratas.xlsx` — the format historically handed to subcontratistas — has a `Cuadro` header that stops at `TIPO DE CONTRATO LABORAL`. Treat a missing `HPT` as a warning, not an error, and record it as a version signal.

### 1.4 What is not tolerated

These reject the workbook with a message naming the subcontratista folder, and the run continues with the remaining files:

1. No sheet resolving to `Cuadro`.
2. No `RUC` header cell inside the search window.
3. Duplicate canonical columns after normalization.
4. Zero data rows below the anchor.
5. A header row that resolves fewer than 8 of the 18 canonical columns. This is the guard against the **643-row header-shift block** described in §2.3 — the single most damaging silent failure in the last run.

A rejected workbook is a **failed run for that subcontratista**, surfaced at the top of the run report. It is never an empty contribution that looks like "this company has no workers."

---

## 2. Canonical record schema

18 fields, in this order, which is simultaneously `dataColumns` (`src/excelConsolidation.js:9-28`), `xl/tables/table1.xml` tableColumn ids 1–17 + 35, and `Cuadro!A1:R1`. Header strings are byte-exact including the `PRNCIPAL` typo and the accented `Ú` — verified against the header row of `src/ReporteConsolidado.xlsx`.

| # | Col | Canonical header | Output type | Required | Coercion | Validation |
|---|---|---|---|---|---|---|
| 1 | A | `RUC` | **text** | yes | trim; if numeric, format as integer with no separators and left-pad to 11 | 11 digits; SUNAT mod-11 check digit (weights `5,4,3,2,7,6,5,4,3,2`, `r = 11 - sum%11`, map 10→0 and 11→1) |
| 2 | B | `EMPRESA` | text | yes | trim; collapse internal whitespace; strip embedded CR/LF | non-empty |
| 3 | C | `CONTRATISTA PRNCIPAL` | text | yes | same as B | non-empty; drives S, T, U and 3 pivots |
| 4 | D | `Nro. DNI / CE` | **text** | yes | trim; if numeric, format as integer and left-pad to 8 | DNI: exactly 8 digits. CE: 9 digits, leading zeros significant. Anything else → flag, keep raw |
| 5 | E | `APELLIDOS Y NOMBRES` | text | yes | trim; collapse internal whitespace; uppercase | non-empty; must not be purely numeric (see §2.3) |
| 6 | F | `FECHA NACIMIENTO` | **date serial** | yes | §3 | parses; plausible range 1930-01-01 … today−16y |
| 7 | G | `TIPO TRABAJADOR` | integer | no | §4 | ∈ {1,2,3} or null |
| 8 | H | `TITULO DE PUESTO/CARGO` | text | yes | trim; collapse whitespace | non-empty; row axis of the `Tabla` pivot |
| 9 | I | `NOMBRE DE OBRA…` | text | no | trim | none — carried, never consumed |
| 10 | J | `DOMICILIO DE TRABAJADOR` | text | no | trim | none — carried, never consumed |
| 11 | K | `DISTRITO SEGÚN DNI` | text | yes | trim; collapse whitespace | sole input to `Zona de Influencia`; see §2.2 |
| 12 | L | `GENERO` | text, lowercase | yes | §4 | ∈ {`masculino`, `femenino`} or null |
| 13 | M | `FECHA CESE/BAJA` | **date serial or genuinely empty** | conditional | §3 + §4 sentinel table | parses, or empty. Presence *is* the Baja signal |
| 14 | N | `NACIONALIDAD` | text, uppercase | yes | trim; collapse whitespace; uppercase; accent-preserving | free text, but see §2.1 |
| 15 | O | `FECHA INICIO DE LABORES EN OBRA` | **date serial** | yes | §3 | parses; ≥ project start, ≤ period end + 1 month |
| 16 | P | `ESTADO` | integer | yes | §4 | ∈ {1,2,3} or null |
| 17 | Q | `TIPO DE CONTRATO LABORAL` | integer | no | §4 | ∈ {1,2,3,4} or null |
| 18 | R | `HPT` | number (hours) | yes | numeric coercion; reject non-numeric | ≥ 0; the `# Horas` measure in `CJ Y EPC` |

Plus **provenance on every record**, which must survive to the output — today `readFileToJson` stamps `errorEnArchivo` at `:140` and the caller deletes it at `:66`:

`{ archivo, carpetaSubcontratista, hoja, filaOrigen, celdaOrigen }`

`filaOrigen`/`celdaOrigen` are what turn "unparseable date" into "cell `F1743` of `SUBCONTRATA X/reporte.xlsx`", which is the difference between a report that is accurate and one that is actionable.

### 2.1 Text normalization is required but must not be over-applied

`NACIONALIDAD` carries **7 spellings of one value** — `PERUANA` 2,398 / `Peruano` 1,262 / `PERUANO` 600 / `Peruana` 403 / `PERUANA ` 131 / `peruana` 76 / `PERUANO ` 75 — and it is a filter field on 4 pivots, so every spelling is a separate filter item. Uppercase + trim collapses these to `PERUANA` / `PERUANO`, which is enough; do **not** attempt gender-folding (`PERUANO` → `PERUANA`) in code. That is a business decision about how the client wants nationality reported, and it belongs in a lookup table on `Hoja1` alongside the district table, where the business already owns its own vocabulary.

`CONTRATISTA PRNCIPAL` is worse and matters more: the pivot cache has accumulated **352 distinct spellings for roughly 84 real companies**, including `" CLJ CONTRUCTORA SAC"` (leading space), `"_x000d__x000a_MCORP SAC"` (embedded CRLF), and `"ACIS PROCESS S.A.C"` vs `"ACIS PROCESS S.A.C."`. Trim + whitespace-collapse + CR/LF strip removes most of it. The residue (punctuation variants) is again a lookup-table problem, not a code problem — and `Sheet1` (Razón Social → Nombre Comercial, 82 rows, referenced by nothing in the entire workbook) is the natural home for it.

### 2.2 `DISTRITO SEGÚN DNI` is not normalized in code

The district → zone mapping lives in `Hoja1!A2:B61` and is consumed by the Excel formula in column Y. Measured against `src/template.xlsx`: **56 populated rows in 60 slots**, mapping onto exactly **7 zones plus the `"No"` sentinel** — `ATE`, `BREÑA`, `CALLAO`, `EL AGUSTINO`, `LA VICTORIA`, `SAN LUIS ` (trailing space, propagates verbatim into every pivot as a distinct label), `SANTA ANITA`.

The key space is deliberately not just district names — it includes RENIEC ubigeo-prefixed forms (`015001011-EL AGUSTINO`) and district-with-province forms (`VENTANILLA -CALLAO`). **Do not move this table into JS.** It is curated by the business, and moving it moves ownership away from the people who maintain it. The code's job is only to hand Y a trimmed, whitespace-collapsed string.

Two repairs belong in the *workbook*, not the code: trim the keys (the formula trims the lookup value but nobody trimmed the keys, so **14 padded keys** can never match — of which `"CARMEN DE LA LEGUA -REYNOSO "` (r14) and `" LA PERLA CALLAO"` (r50) have no unpadded twin and represent real districts that always resolve to `"No"`), and strip the trailing space from the `SAN LUIS ` value.

### 2.3 The header-shift block — a first-class rejection case

Measured in `src/ReporteConsolidado.xlsx`: **643 rows** have `RUC`, `EMPRESA`, `CONTRATISTA PRNCIPAL` and `Nro. DNI / CE` all null, and the number `20101155588` — a RUC — sitting in `APELLIDOS Y NOMBRES`. That is 12.7% of the last run, and all 643 rows come from one subcontratista's workbook.

The damage is not the nulls. `Trabajador` (AB) is `COUNTIF(Tabla2[APELLIDOS Y NOMBRES], [APELLIDOS Y NOMBRES])`, so all 643 rows share one "name" → `COUNTIF` = 643 → `Trabajadores Unicos` = 1/643 each → **643 real workers contribute a combined headcount of exactly 1.**

Two independent signals catch this, and both must be implemented:

- The ≥8-of-18 header-resolution threshold in §1.4 rejects the workbook before it is read.
- `APELLIDOS Y NOMBRES` that is numeric, or that matches `/^\d{8,11}$/` after trimming, is a per-row rejection with the raw value in the run report.

Same block, incidentally, is the entire source of fractional date serials: **1,280 cells in `src/ReporteConsolidado.xlsx` carry a fractional serial — 643 in `FECHA NACIMIENTO` (F), 637 in `FECHA INICIO DE LABORES EN OBRA` (O), 0 in `FECHA CESE/BAJA` (M) — across 850 distinct values, and every single one of them sits inside the 643-row block. There are zero fractional serials anywhere else in the file.** They come at two time offsets, not one: **586 at `.79166667` (19:00)** and **694 at `.83333333` (20:00)**. Time components are not a general phenomenon in this data; they are one broken export. Truncate them anyway (§3.4), but know the diagnosis.

---

## 3. Date handling

This is owner goal #2 and the highest-value change in the rework. Today `src/excelConsolidation.js` has **no date handling at all** beyond `FECHA CESE/BAJA === undefined → ""` (`:257-259`); whatever SheetJS produced is written straight through.

Scope: `FECHA NACIMIENTO` (F), `FECHA CESE/BAJA` (M), `FECHA INICIO DE LABORES EN OBRA` (O).

### 3.1 Accepted input forms

| Form | Example from the data | Handling |
|---|---|---|
| Excel serial, integer | `34519` | accept as-is |
| Excel serial, fractional | `43139.791666666664` | **truncate** to the integer day |
| JS `Date` (if the reader was configured with `cellDates`) | — | extract `{y,m,d}` in the same timezone it was built in |
| `dd/mm/yyyy` | `04/07/1994` | parse day-first |
| `d/m/yyyy` | `3/5/1965`, `14/2/1989` | parse day-first |
| `d/mm/yyyy` | `3/10/1976` | parse day-first |
| `dd/mm/yy` | `27/05/25`, `30/1/26` | parse day-first + pivot rule §3.3 |
| `dd-mm-yyyy` | `15-03-2020` | parse day-first |
| `dd.mm.yyyy` | `15.03.2020` | parse day-first |
| ISO `yyyy-mm-dd` | — | accept (unambiguous), no day-first question |
| anything else | `09/10/205`, `10-11-202-6`, `05/09/20258`, `PUMACAYO VILCHEZ TEOFILO DINO` | **reject → null + run-report entry** |

The last three malformed values are real: all appear in `FECHA INICIO DE LABORES EN OBRA` or `FECHA CESE/BAJA` in `src/ReporteConsolidado.xlsx`. `10-11-202-6` and `05/09/20258` are new relative to `09/10/205`, which is measured in `src/ReporteConsolidado.xlsx`'s `FECHA INICIO DE LABORES` column and already documented in `01-current-state.md` §8 and `02-shortcomings.md` BUG-06 — the malformed-year problem is not a single typo, it is a recurring class.

Volume: 103 text values in `FECHA NACIMIENTO`, 100 in `FECHA INICIO DE LABORES EN OBRA`, out of 5,065 rows. Roughly 4% of the workforce.

### 3.2 Day-first is the rule

`04/07/1994` means **4 July 1994**, not 7 April. Justification is in the template itself, not in a locale assumption — `xl/styles.xml` of `src/template.xlsx` declares exactly three custom date formats and all three are day-first:

```
<numFmt numFmtId="164" formatCode="dd\.mm\.yyyy;@"/>
<numFmt numFmtId="165" formatCode="dd/mm/yyyy;@"/>
<numFmt numFmtId="168" formatCode="d/mm/yyyy"/>
```

Month-first must never be attempted, not even as a fallback for values where day-first fails. A value that does not parse day-first is an error, not an invitation to reinterpret. Silently switching interpretation is how `03/05/1965` becomes 5 March instead of 3 May with nobody noticing.

### 3.3 Two-digit years

Only one 2-digit-year shape was observed in the corpus (`30/1/26`, `27/05/25`), both recent dates.

**Rule, per column:**

- `FECHA CESE/BAJA` and `FECHA INICIO DE LABORES EN OBRA`: pivot at **60** — `00–60` → 20xx, `61–99` → 19xx. A cese or start date is never in the distant past for this project, and the pivot is only a safety net; the range check below is what actually validates.
- `FECHA NACIMIENTO`: **reject 2-digit years outright.** There is no way to distinguish `3/5/65` meaning 1965 from a typo, and a birth date feeds `Edad`, `Rango Edades` and the `Validacion` pivot — the three things this report exists to produce. Route it to the run report and let the operator ask the subcontratista.

Do not rely on a library's default pivot. The three mainstream libraries disagree and at least two are wrong for one of these columns: date-fns slides its window against the reference date (with ref 2026, `68` → **2068**), dayjs uses the JS `Date` rule (`68` → **2068**, `69` → 1969), Luxon's configurable `Settings.twoDigitCutoffYear` defaults to 60 (`68` → 1968). Set the pivot explicitly whichever library you pick. See `04-proposed-packages.md`.

### 3.4 Strict rejection

A parser that "succeeds" on garbage is worse than one that fails, because the failure becomes invisible. Required rejections:

| Input | Must be rejected because |
|---|---|
| `31/02/2026`, `30/02/2024` | calendar-impossible; day out of range for the month |
| `32/01/2026`, `13/13/2020` | component out of range |
| `09/10/205` | year is 3 digits — must **not** silently become year 0205 |
| `05/09/20258` | year is 5 digits |
| `10-11-202-6` | not a date shape |
| `" 04/07/1994 "` | trim **before** parsing; strict parsers reject untrimmed input |
| any value outside the column's plausible range (§3.5) | domain violation, even if it parses |

Every rejection carries `{ subcontratista, archivo, fila, celda, columna, valorCrudo, motivo }` into the run report. "~200 unparseable rows" is not a deliverable; a list of 200 cells with their raw text is.

### 3.5 Domain plausibility checks

Parsing correctly is not the same as being right. Layer these on top:

- `FECHA NACIMIENTO` ∈ [1930-01-01, today − 16 years]. The template's own `Edad` formula already flags `<18` or `>80` as `"Corregir"`, so these bounds mirror a rule the business already agreed to.
- `FECHA INICIO DE LABORES EN OBRA` ∈ [project start, `PeriodoFin` + 1 month].
- `FECHA CESE/BAJA` ∈ [`FECHA INICIO DE LABORES EN OBRA`, `PeriodoFin` + 1 month]. A cese before the start date is a data error; so is the future date `46235` (2026-08-01) currently sitting in the `FEBRERO_2026` detail block.

Out-of-range values go to the run report with the parsed value shown, so the operator can see *what* it parsed to and judge whether the source is a typo or a genuine outlier.

### 3.6 Writing the date

Every accepted date lands in the output as a **true Excel date serial** on a cell with `numFmtId="14"` — never as text, never as `""`.

Verified in `src/template.xlsx`: `cellXfs` index 4 is `<xf numFmtId="14" … applyNumberFormat="1" …/>`, and `Cuadro!F2`, `M2` and `O2` all carry `s="4"`. The columns are already correctly formatted; the app only has to write numbers into them. `xlsx-populate`'s `Cell.value(date)` converts a JS `Date` to a serial automatically via `lib/dateConverter.js`, which already encodes the 1900 leap-year adjustment.

**The 1900 bug matters only at the boundary, and that is exactly why it must be handled.** Excel treats the non-existent 1900-02-29 as serial 60, so for serials ≤ 60 the naive `new Date(Date.UTC(1899,11,30) + n*86400000)` is off by one day. No worker birth date lands there — but a blank coerced to `0`, or a mistyped small value, silently becomes a 1899/1900 date instead of being flagged. Use `XLSX.SSF.parse_date_code(serial)` on the read side (already available in the installed `xlsx`, returns `{y,m,d}` components with no `Date` and therefore no timezone) and let `xlsx-populate` handle the write side.

**Pick one timezone convention and hold it end to end.** SheetJS's `cellDates: true` builds *local-midnight* `Date` objects; `xlsx-populate`'s converter is also local-based. They agree only if you stay in local time throughout. Safest pattern: read with `cellDates: false`, get `{y,m,d}` from `SSF.parse_date_code`, construct `new Date(y, m-1, d)` — never `Date.UTC` — and never serialize a date to ISO/UTC anywhere in the pipeline. Alternatively pin `TZ=America/Lima` in the pm2 environment and stop thinking about it.

Also read the workbook's date system rather than assuming: SheetJS exposes it as `wb.Workbook.WBProps.date1904`. A workbook authored on legacy Mac Excel is off by exactly 1,462 days — a four-year error that looks like plausible data.

### 3.7 Worked examples

Serials computed against the 1900 system.

| Raw cell value | Cell type | Interpreted as | Written | Displayed (numFmtId 14) |
|---|---|---|---|---|
| `34519` | number | 1994-07-04 | `34519` | `04/07/1994` |
| `43139.791666666664` | number | 2018-02-08 19:00 → truncate | `43139` | `08/02/2018` |
| `"04/07/1994"` | text | 4 Jul 1994 (day-first) | `34519` | `04/07/1994` |
| `"14/2/1989"` | text | 14 Feb 1989 | `32553` | `14/02/1989` |
| `"3/5/1965"` | text | 3 May 1965 | `23865` | `03/05/1965` |
| `"30/1/26"` (col O) | text | 30 Jan 2026 (pivot 60) | `46052` | `30/01/2026` |
| `"27/05/25"` (col O) | text | 27 May 2025 | `45804` | `27/05/2025` |
| `"3/5/65"` (col F) | text | **rejected** — 2-digit year on a birth date | *(empty)* | *(blank)* + run-report entry |
| `"09/10/205"` | text | **rejected** — 3-digit year | *(empty)* | *(blank)* + run-report entry |
| `"05/09/20258"` | text | **rejected** — 5-digit year | *(empty)* | *(blank)* + run-report entry |
| `"10-11-202-6"` | text | **rejected** — not a date shape | *(empty)* | *(blank)* + run-report entry |
| `"31/02/2026"` | text | **rejected** — calendar-impossible | *(empty)* | *(blank)* + run-report entry |
| `""`, `"-"`, `" -"`, `"---"`, `"ACTIVO"` (col M) | text | no cese → empty | *(cell left genuinely empty)* | *(blank)* |
| `"PUMACAYO VILCHEZ TEOFILO DINO"` (col M) | text | **rejected** — column-shift | *(empty)* | *(blank)* + run-report entry |

Target: **zero text values in columns F, M and O**, against 103 / 4,894 / 100 today.

The `FECHA CESE/BAJA` line deserves its own note. The current code force-writes `""` — a *text* value into a date-formatted column — for 3,801 rows. That is precisely why the template's `Bajas2` needs its `IFERROR(…,"No aplica")` wrapper, and that wrapper is now load-bearing: it hides every genuine failure. Write a genuinely empty cell and the wrapper stops mattering.

---

## 4. Normalization of coded domains

Four columns carry integer codes. The authoritative allowed-value lists are the cell comments still attached to the header row of `src/template.xlsx` (`xl/comments1.xml`, anchored at G1/I1/L1/P1/Q1) — these are what the subcontratistas were told to use.

**The universal rule for all four: normalize by `String(v).trim().toLowerCase()` first, then match. Never `parseInt` as a fallback. An unrecognised value yields `null` in the cell, plus a run-report entry carrying the raw value verbatim. `NaN` must never reach the workbook.**

Today three of the four switches disagree on that preprocessing: `TIPO TRABAJADOR` (`:150-165`) and `ESTADO` (`:234-254`) trim and lowercase; `TIPO DE CONTRATO LABORAL` (`:186-231`) switches on the **raw** string, so `"plazo fijo"` and `"PLAZO FIJO "` miss every case; `GENERO` (`:168-183`) lowercases the input and then compares it against numeric `case 1:` / `case 2:` branches, which are unreachable under `switch`'s strict comparison.

### 4.1 `TIPO TRABAJADOR` (G)

| Code | Canonical | Accepted synonyms (after trim + lowercase) |
|---|---|---|
| 1 | EMPLEADO | `1`, `01`, `empleado`, `empleada` |
| 2 | OBRERO DE CONSTRUCCION CIVIL | `2`, `02`, `obrero de construccion civil`, `obrero de construcción civil`, `occ` |
| 3 | OBRERO | `3`, `03`, `obrero`, `obrera` |

Observed today: 2,542×`2`, 2,111×`1`, 255×`3`, 157 empty. Not referenced by any formula or pivot — but a `NaN` here still lands in a cell inside `Tabla2`, so it still has to be clean.

### 4.2 `ESTADO` (P)

| Code | Canonical | Accepted synonyms |
|---|---|---|
| 1 | ACTIVO | `1`, `01`, `activo`, `activa`, `activo en obra`, `en obra` |
| 2 | CESADO | `2`, `02`, `cesado`, `cesada`, `cese` |
| 3 | RETEN | `3`, `03`, `reten`, `retén` |

Observed today: 4,761×`1`, 245×`2`, 36×`3`, 21 empty — **plus `184` and `160`**, which are column-shift junk that survived `parseInt` and are now columns in the `Tabla` pivot. `03 = RETEN` is in the code but *not* in the header comment; add it to the comment so the input contract matches the implementation.

### 4.3 `TIPO DE CONTRATO LABORAL` (Q)

| Code | Canonical | Accepted synonyms |
|---|---|---|
| 1 | PLAZO FIJO | `1`, `01`, `plazo fijo`, `plaza fijo`, `planilla` |
| 2 | PLAZO INDETERMINADO | `2`, `02`, `plazo indeterminado`, `indeterminado` |
| 3 | CONTRATO DE EXTRANJERO | `3`, `03`, `contrato de extranjero`, `extranjero` |
| 4 | SIN CONTRATO REGIMEN CIVIL | `4`, `04`, `sin contrato regimen civil`, `sin contrato régimen civil`, `si`, `rxh`, `recibo por honorarios` |

Observed today: 2,481×`1`, 2,282×`4`, 195×`2`, 71 empty, 21×`3` — **plus `0`×6, `5`×4, `0.03`×2, and one each of `10`, `11`, `14`**. `0.03` is a locale-decimal artifact of `parseInt` on a mangled cell; all of these become null + exception under the rule above.

`si` mapping to 4 is inherited from the current code and is almost certainly a subcontratista answering "does he have a contract?" — keep it, but flag it in the run report as a low-confidence mapping so the operator can see how often it fires.

### 4.4 `GENERO` (L)

**The canonical stored value is the lowercase Spanish word, not the code.** The header comment says `01 = MASCULINO / 02 = FEMENINO`, but the template validates the *word*: `Validar Genero` (Z) is `IF(OR(LOWER([GENERO])="masculino",LOWER([GENERO])="femenino"),"OK","Corregir")`. Storing `MASCULINO` uppercase, as the current code does at `:173`, happens to pass because of `LOWER()`, but it produces a second pivot item and splits the gender columns.

| Canonical | Accepted synonyms |
|---|---|
| `masculino` | `1`, `01`, `m`, `masculino`, `masculina`, `hombre`, `varon`, `varón` |
| `femenino` | `2`, `02`, `f`, `femenino`, `femenina`, `mujer` |
| `null` | empty cell only |

Observed today: 4,716 `masculino`, 312 `femenino`, 25 `MASCULINO`, 2 `FEMENINO`, and **10 rows containing the literal string `"undefined"`** — the output of `String(undefined).toLowerCase()` at `:168` leaking through the `default` branch at `:181`.

Those 10 rows are not cosmetic. `GENERO` is the column axis of four pivots. In `src/reportes/Reporte_Subcontratistas_OCTUBRE_2025.xlsx` they materialised a **third gender column** labelled `"undefined"` (`F7="undefined"`, `F15=1`), which pushed the Total column from `F` to `G` — and the percentage formulas in `G53:G60` (`+F53/$F$60`) hard-code `F` as Total, so the published percentage column silently computed against a gender instead of the total. **The literal string `"undefined"` must be impossible by construction.**

---

## 5. The 17 computed columns

All 17 are Excel Table calculated columns in `Tabla2`, S..AI, carried in `xl/tables/table1.xml` as `<calculatedColumnFormula>`. The rework must decide, per column, whether the value is produced by Excel or written as a literal by the app.

**The rule: a column whose value depends on the wall clock becomes a JS-computed literal, evaluated against the stored report period (§6). A column whose value depends only on the sheet's own contents stays an Excel formula.** That single rule kills the entire "the numbers changed when I reopened it" class of bug while leaving the business-owned lookup tables where the business can edit them.

**A column moved to "JS literal" must also lose its calculated-column formula.** All 17 of these columns are Excel Table *calculated columns*: `xl/tables/table1.xml` carries a `<calculatedColumnFormula>` child inside each of the 17 `<tableColumn>` elements (verified — including `Edad` id=25, `Rango Edades` id=23, `BajasAntiguas` id=34, `Bajas2` id=28 and `Altas` id=29). Writing a literal value into a calculated column without removing that element is not stable: Excel flags the cell as an inconsistent formula and re-fills the column's formula on the next table edit, sort or refresh — silently restoring the `TODAY()-30` behaviour this whole section exists to remove. So for every column routed to JS, delete the `<calculatedColumnFormula>` child while keeping the `<tableColumn>` element's `id` and `name` intact, so the pivot cache's field mapping is unchanged. See `05-implementation-plan.md` Phase 4.

| Col | Name | Rule in plain English | Where computed |
|---|---|---|---|
| S | `EPC/CJV` | Is the contratista principal one of the 4 EPC suppliers listed in `Hoja1!L5:M9`, or part of the Consorcio? Default `CJV`. | **Excel** — the lookup table is business-owned |
| T | `Tipo de Empresa` | `Principal` if the employing `EMPRESA` *is* the `CONTRATISTA PRNCIPAL`, else `Secundaria`. | **Excel** |
| U | `Contratistas` | `1/COUNTIF` over the contratista column — summing it over any slice gives the count of distinct contratistas principales. | **Excel** |
| V | `Edad` | Whole years from `FECHA NACIMIENTO` to the **end of the report period**; `"Corregir"` if <18 or >80; `"Sin Fecha"` if the birth date is missing. | **JS literal** — clock-dependent today (`ca="1"`, `TODAY()`) |
| W | `Rango Edades` | Bucket `Edad` into `18 - 23`, `24 - 31`, `32 - 40`, `41 - 49`, `50 - 58`, `59 +`; `"Sin Fecha"` where the age is unknown. | **JS literal** |
| X | `Validar Edad` | **Corrected**: `Ok` unless `Edad` is `"Corregir"`. | **Excel**, corrected formula |
| Y | `Zona de Influencia` | Map the trimmed `DISTRITO SEGÚN DNI` through `Hoja1!A2:B61`; anything unmapped → `"No"`. | **Excel** — business-owned table |
| Z | `Validar Genero` | `OK` iff `GENERO` is exactly `masculino`/`femenino` (case-insensitive). Already correct. | **Excel**, unchanged |
| AA | `ValidarDNI` | **Corrected**: `Corregir` if `Nro. DNI / CE` is empty or shorter than 8 characters, else `OK`. | **Excel**, corrected formula |
| AB | `Trabajador` | How many rows in the whole table share this person's **name**. `>1` = reported by two subcontratistas in the same month. | **Excel** |
| AC | `Trabajadores Unicos` | Headcount weight: `1/Trabajador` when duplicated, else the count. Summing it = unique headcount. | **Excel** |
| AD | `Trabajdores Unicos Zona Influencia` *(sic)* | Same weighting restricted to in-zone rows. Out-of-zone-only workers score 0. | **Excel** (see note) |
| AE | `Altas Zona de Influencia` | 1 if this row is an Alta of the period, else 0. | **JS literal** |
| AF | `Bajas Zona Influencia` | 1 if this row is a Baja of the period, else 0. | **JS literal** |
| AG | `BajasAntiguas` | `Si` if the worker ceased in an *earlier* period and did not join in this one — stale carry-over that must not be counted. Every headcount pivot filters `= "No"`. | **JS literal** |
| AH | `Bajas2` | Three-state: `"No Aplica"` (still employed), `"<M>-<YYYY>"` (ceased in the period), `"Borrar"` (ceased in another period). | **JS literal** |
| AI | `Altas` | Two-state: `"<M>-<YYYY>"` (joined in the period), `"No Aplica"` (everything else). | **JS literal** |

Note on **AD**: it is a genuine array formula (`<calculatedColumnFormula array="1">`) computing a SUMPRODUCT over the whole name column × the whole zone column, per row — O(n²) at 5,000+ rows. It is deterministic, so it may stay a formula for phase-1 parity, but it is the obvious next candidate for a JS literal if recalculation time becomes painful. If it stays, the `t="array"` / `ref` attributes must be preserved when rows are regenerated (see `05-implementation-plan.md`).

### 5.1 The three copy-pasted validation columns

`Validar Edad` (X), `Validar Genero` (Z) and `ValidarDNI` (AA) are byte-identical in `src/template.xlsx` — all three are the GENERO formula. Only Z is correct.

The correct bodies are not guesswork. They are preserved verbatim in the previous generation of the same workbook, `src/Formato Reporte subcontratas.xlsx` → `xl/tables/table1.xml`:

```
Validar Edad   →  +IF(Tabla2[[#This Row],[Edad]]="Corregir","Corregir","Ok")

ValidarDNI     →  +IF(Tabla2[[#This Row],[Nro. DNI / CE]]="","Corregir",
                      IF(LEN(Tabla2[[#This Row],[Nro. DNI / CE]])>=8,"OK","Corregir"))

Validar Genero →  IF(OR(LOWER(...[GENERO])="masculino",
                        LOWER(...[GENERO])="femenino"),"OK","Corregir")   ← already correct
```

Corroboration that these ran in production: in that older file, column W holds `"Ok"` (mixed case) while column Y holds `"OK"` — two different literals from two different formulas, exactly as the originals prescribe. The current template has `"OK"` everywhere.

**Blast radius of the `ValidarDNI` regression.** The entire hidden `Validacion` sheet is wired to it. The right-hand block (`pivotTable12.xml`, page filter `ValidarDNI = "Corregir"`) is supposed to list every worker with a missing or under-8-character document number. Because AA actually tests GENERO, that block resolves to a single `(blank)` group in `FEBRERO_2026` — **the DNI validation report has been empty for as long as the defect has existed**, while `Nro. DNI / CE` was absent on 723 of 5,065 rows in the last run.

Note also that even after the fix, `ValidarDNI` only checks length. Real Peruvian identifier validation (11-digit RUC mod-11 check digit; 8-digit DNI vs 9-digit CE) belongs in JS, in the run report — see §2 and `04-proposed-packages.md`. Measured against the 146 distinct non-empty RUC values in `src/ReporteConsolidado.xlsx`: **122 pass the mod-11 check, 23 fail it, and 1 is not 11 digits.** That is ~16% of distinct RUCs carrying a real error today, entirely invisible to the current pipeline. Four of the failures are the near-consecutive run `20504039123 / …125 / …127 / …130`, which for that prefix can only be valid with check digit `0` — they look incremented or fabricated.

### 5.2 Dead logic to remove while you are in there

- **AE and AF have a dead branch.** `IF(AND([Trabajador]>1,[Zona de Influencia]<>"No",[Altas]<>"No Aplica",[Altas]<>"borrar"),1,IF(AND([Altas]<>"No Aplica",[Altas]<>"borrar"),1,0))` — both branches produce `1` under the same effective condition, so the whole thing reduces to `IF([Altas] not in {"No Aplica","borrar"},1,0)`. Despite the name, it is not zone-restricted; the zone split comes from the pivot's row axis. `"borrar"` is never a value of `[Altas]`.
- **The manual date-repair helpers.** `Cuadro` columns AK/AM/AO/AP, rows 2..8612, carry `LEFT([FECHA NACIMIENTO],2)`, `MID(…,4,2)`, `RIGHT(…,4)`, `DATE(AO2,AM2,AK2)` — a hand-rolled text-date parser the owner used to patch bad values by hand. On a numeric serial they produce nonsense (`925772`). They are the direct evidence that date normalization belongs upstream, in code, and they go once §3 exists. Remove the stale defined name `_xlnm._FilterDatabase` on `Cuadro!$AK$14:$AP$8612` and the stray header `"a"` in `AJ1` at the same time.
- **`Hoja1!F2:F7`** holds an age-bucket label list (`18-23`, `59 - A mas`, `24-31`, …) that matches nothing column W emits and is referenced by nothing. Dead.
- **The pivot cache's calculated field** `Trabajadores = ROUND('Trabajadores Unicos',0)` is used by no pivot.
- **`Sheet1`** (Razón Social → Nombre Comercial, 82 rows) is referenced by nothing — a grep for `Sheet1!` across every worksheet, table and pivot part returns zero hits. Either wire it up or label it as documentation.

---

## 6. The report period

### 6.1 The requirement

**The report period is an explicit input, stored in the workbook, and every period-dependent value is computed against it.**

- `PERIODO_INICIO` = first day of the reported month; `PERIODO_FIN` = last day of that month. Both real date serials.
- Chosen by the **operator at upload time** — a month/year selector on the upload form, defaulting to the previous calendar month, requiring confirmation.
- Never derived from the server clock at write time, and never from the client clock at download time.
- Stored in the workbook as defined names on the already-hidden `Hoja1` (`PeriodoInicio`, `PeriodoFin`, `PeriodoEtiqueta` where the label is `"<M>-<YYYY>"`), stamped into `docProps/custom.xml`, echoed as a visible caption on `Reporte Social - RRHH`, and used to build the output filename — so the filename and the content cannot disagree.

### 6.2 Why this is the highest-priority correctness fix

There is **no stored report period anywhere in the workbook today**. Every period-dependent value derives from `TODAY()-30`, evaluated at open time, in `Cuadro!V` (`TODAY()` ×3 per row, ×8,823 rows), `W` (×12 per row), `AH` and `AI` (`MONTH(TODAY()-30)` / `YEAR(TODAY()-30)`, 4 uses per row each). The filename derives from a *different* definition — `getMonthAndYear()` in `src/excelReporting.js:69-77`, "the calendar month before the current one" — and there is a **second, duplicated copy** of that function in `public/js/index.js:103-111` used for the download filename.

The two definitions coincide only if the file is generated and opened during roughly the first three weeks of the following month. They demonstrably diverge in production: `src/reportes/Reporte_Subcontratistas_DICIEMBRE_2025.xlsx` carries `refreshedDate="46021.751749074072"` = 30 December 2025 18:02, and its own Altas page filter reads `11-2025`. **The file is named DICIEMBRE and reports NOVIEMBRE.**

Consequences, all verified in the archive:

1. **The numbers mutate on every open.** Reopening `FEBRERO_2026` today reclassifies its Altas/Bajas against the current month: every `Altas` becomes `"No Aplica"`, `Total Ingresos` collapses to 0, and `BajasAntiguas` flips to `"Si"` for anyone with a cese date, evicting them from every headcount pivot. **A delivered report cannot be re-verified.**
2. **Ages drift.** A worker who was 31 in the February report is 32 when the same file is opened in August; the `Rango Edades` distribution shifts with no data change.
3. **Five of fourteen archived reports still show September-2024 numbers** — `DICIEMBRE_2024`, `FEBRERO_2025`, `NOVIEMBRE_2025`, `ABRIL_2026`, `MAYO_2026` all display Total Zona de Influencia **1120**, Total Bajas **65**, Total Ingresos **91**, Total Trabajadores Activos **3283.5**, with the Altas filter pinned to `"9-2024"`. Those files were shipped by the app and never opened in Excel. The pivot cache in every generated file still says `refreshedBy="Alvaro" refreshedDate="45566.353735300923"` — 1 October 2024, 08:29. **The app's actual output today is a template with new bytes in A:R and stale everything else.**

### 6.3 The acceptance rule

> Generate the same period twice, a week apart, on two machines whose clocks differ. Every headline number must be identical. Then reopen a delivered report six months later: still identical.

This is the single test the current pipeline cannot pass, and it is the reason §5 routes the five clock-dependent columns to JS literals.

### 6.4 Formula changes this implies

If any of V/W/AG/AH/AI is left as a formula rather than a literal, its body must be re-pointed at the defined names:

| Column | Replace `TODAY()`-based body with |
|---|---|
| AH `Bajas2` | `+IF([FECHA CESE/BAJA]="","No Aplica",IF(NOT(ISNUMBER([FECHA CESE/BAJA])),"Revisar",IF(AND([FECHA CESE/BAJA]>=PeriodoInicio,[FECHA CESE/BAJA]<=PeriodoFin),PeriodoEtiqueta,"Borrar")))` |
| AI `Altas` | same shape on `[FECHA INICIO DE LABORES EN OBRA]`, falling through to `"No Aplica"` |
| V `Edad` | `DATEDIF([FECHA NACIMIENTO],PeriodoFin,"Y")` inside the same <18 / >80 guards, wrapped in `IFERROR(…,"Sin Fecha")`; drop `ca="1"` |
| W `Rango Edades` | bucket off `[Edad]` instead of recomputing the age 6 times; wrap in `IFERROR(…,"Sin Fecha")` |

And two pivot page filters must be re-pointed at generation time rather than left to Excel's post-refresh guesswork: `pivotTable7.xml` and `pivotTable3.xml` currently carry `<pageField fld="34" item="14"/>`, which resolves to the literal `"9-2024"`.

---

## 7. Output workbook contract

### 7.1 Sheet inventory

Nine sheets. Six are the report; three are plumbing. This inventory must not change.

| Sheet | Role | Visibility |
|---|---|---|
| `Reporte Social - RRHH` | the deliverable page — 4 summary blocks + 3 detail listings, 7 pivots | visible |
| `CJ Y EPC` | active headcount and HPT hours split CJV vs EPC | visible |
| `Contratistas` | distinct-contractor roll-call | visible |
| `Tabla` | headcount by contratista × empresa × cargo × ESTADO | visible |
| `Dos Subcontratas por Mes` | workers reported by two subcontratistas in the same month | visible |
| `Validacion` | data-quality exception lists | hidden |
| `Cuadro` | the data table `Tabla2` — 18 raw + 17 computed columns | visible |
| `Hoja1` | lookup tables + (new) the stored report period | hidden |
| `Sheet1` | Razón Social → Nombre Comercial reference list | hidden |

The dependency chain is: **18 raw columns → 17 computed columns in `Tabla2` → one shared pivot cache (`cacheSource → worksheetSource name="Tabla2"`) → 13 pivot tables across the 6 report sheets.** There is exactly one cache and every pivot reads it. Because the cache binds to the **table name**, not to a fixed range, resizing `Tabla2` propagates to all 13 pivots automatically.

### 7.2 The data range

**`Cuadro` must contain exactly as many data rows as there are accepted workers. Zero ghost rows.**

Today `src/excelReporting.js:35-40` "clears" old rows with `.value("")` instead of removing them, and never shrinks the table. In `Reporte_Subcontratistas_MAYO_2026.xlsx`, rows 5067–8823 — **3,757 rows** — carry the empty string in A:R while the formula columns S:AI still compute on every one of them. In `FEBRERO_2026` the 8,823-row table breaks down as **5,538 rows with a non-empty `APELLIDOS Y NOMBRES` + 3,277 ghost rows + 8 rows with no cell at all**.

The consequences are not cosmetic. `COUNTIF(Tabla2[CONTRATISTA PRNCIPAL],"")` = 3,757 corrupts column U — on a `FEBRERO_2026` ghost row, `Contratistas` reads `0.000304414`, i.e. 1/3285. `COUNTIF(Tabla2[APELLIDOS Y NOMBRES],"")` corrupts AB/AC/AD the same way — `Trabajador` = 3,285 on every ghost row, so `Trabajadores Unicos` = 1/3285. The `Validacion` counts include them (`D2521` = 8,816 against a real population of ~5,540), and every pivot gains a `""`/`(blank)` bucket.

**What the ghost rows do *not* do is inflate the Altas/Bajas counters.** `AE` is `IF(AND([Trabajador]>1,[Zona de Influencia]<>"No",[Altas]<>"No Aplica",[Altas]<>"borrar"),1,IF(AND([Altas]<>"No Aplica",[Altas]<>"borrar"),1,0))`; on a ghost row `FECHA INICIO DE LABORES EN OBRA` is `""`, so `[Altas]` = `"No Aplica"` and both arms evaluate to 0. Verified against the cached values still present in `FEBRERO_2026` (which retains its `calcChain` and real `<v>` entries): every one of the 3,277 ghost rows has `AE` = 0 and `AF` = 0, and both columns sum to 0 over the whole ghost block. The case against ghost rows does not need that claim and should not make it.

Required:

- `Tabla2`'s `ref` is resized to `A1:AI<1+n>`. All four refs in `xl/tables/table1.xml` must move together: `<table … ref>`, `<autoFilter ref>`, `<sortState ref>`, `<sortCondition ref>`.
- Surplus rows are **deleted**, not blanked.
- `n` may exceed 8,823. The current hard ceiling — anything past row 8,824 is written to the sheet but falls *outside* the table, gets no formula columns, and is invisible to every pivot and every total — must be impossible by construction.
- The clearing loop's off-by-one (`row < lastRow`, `:35`, so the final row is never cleared) is moot once rows are deleted, but do not carry it forward.
- The template's own junk must go. Precisely: **row 2** holds `A2 "asfasf"` / `B2 "asf"` / `C2 "fafsasf"` and the real worker `E2 "GUARDIA RIOS ELLIOT JOULE"`; **row 3** holds `A3 2055163079` / `B3 "asfasf"` / `C3 "as"` and a second real worker, `E3 "LOPEZ PICON JEAN CARLOS"`. Note this is template hygiene, not a shipped defect: the writer overwrites `Cuadro` rows 2..n+1 on every run, and a scan of columns A and C across the full `Cuadro` sheet of `MAYO_2026`, `FEBRERO_2026` and `OCTUBRE_2025` finds zero occurrences of any of those strings. It matters because a zero-row or short run would leak the two named workers, and because the template cannot serve as a clean baseline while they are in it.

### 7.3 Pivots

- Every pivot must be free of `""` and `(blank)` buckets — which follows automatically from §7.2 plus §4 (no `NaN`, no `"undefined"`).
- The pivot cache must reflect the current run: `recordCount = n`, fresh `refreshedDate`. At minimum, inject `refreshOnLoad="1"` on `<pivotCacheDefinition>` — it is absent today, which is why five archived reports still display October-2024 cached numbers.
- Set `fullCalcOnLoad="1"` on `<calcPr>` in `xl/workbook.xml`, since `xl/calcChain.xml` is dropped by the writer.
- Fix the two page filters that are wired to the wrong item:
  - `pivotTable2.xml` (`Detalle Cesados Zona de Influencia`) filters on `Bajas2 = "Borrar"` — i.e. workers whose cese fell **outside** the period. Since `Bajas Zona Influencia` is 0 for exactly those rows, the detail block's Total column is all zeros and its population contradicts its own summary: `FEBRERO_2026` says **79 bajas** and lists **55 rows, all Total = 0**; `OCTUBRE_2025` says **91** and lists **5**. This has been shipping wrong for at least 14 months. It must filter on `PeriodoEtiqueta`.
  - `pivotTable7.xml` / `pivotTable3.xml` carry the hard-coded literal `"9-2024"` (§6.4).
- `G53:G60` on `Reporte Social - RRHH` is `+F53/$F$60`, hard-coding `F` as the Total column. Replace with a reference that cannot drift when a third gender column appears (§4.4).

### 7.4 Readability without Excel

**Acceptance target:** the delivered workbook can be read by SheetJS, without opening Excel, and yields the same headline numbers a human sees.

That is currently impossible: `xlsx-populate` strips cached `<v>` values from formula cells and drops `xl/calcChain.xml`, so the file only produces numbers once Excel recalculates it. No JS formula engine can close the gap — every computed column uses `Tabla2[[#This Row],[…]]`, and structured references are unsupported by HyperFormula (issues #126 and #241, both open since 2020) and by every other candidate (see `04-proposed-packages.md`).

The practical contract, in two tiers:

1. **Minimum (required):** the workbook carries `refreshOnLoad="1"` + `fullCalcOnLoad="1"`, so a human opening it always sees current numbers rather than a stale cache.
2. **Target (required for automated verification):** the run emits a machine-readable side-car — `reportes/Reporte_Subcontratistas_<MES>_<AÑO>.json` — containing the headline metrics computed **in JS from the consolidated records**, before the workbook is ever written: unique headcount, headcount by zone × gender, Altas, Bajas, CJV/EPC split and hours, distinct contratistas, and the full exception list. That side-car is what CI asserts on, what the run report renders from, and what makes month-over-month comparison a `diff` instead of an Excel session.

Two OOXML integrity defects to fix while the archive is open, both verified in the current output: the output's `xl/_rels/workbook.xml.rels` still carries `rId15 → calcChain.xml` and `[Content_Types].xml` still declares the `calcChain+xml` override even though the part is absent (a dangling relationship Excel silently repairs); and `xlsx-populate` omits `<dimension>` entirely from the output sheet where the template has `<dimension ref="A1:AU8824"/>`.

### 7.5 Filename and the download route

`Reporte_Subcontratistas_<MES>_<AÑO>.xlsx`, where `<MES>` is the uppercase Spanish month name of the **selected period** and `<AÑO>` its year — matching the 14 files already in `src/reportes/`. Derived from `PeriodoInicio`, not from `new Date()`.

- The filename is computed **once, server-side**, and returned to the client. `public/js/index.js:103-111` must stop recomputing it; the duplicated `getMonthAndYear()` and its `monthString == 'DICIEMBRE' ? getFullYear()-1 : getFullYear()` band-aid both disappear.
- `GET /downloadFile` must return the file just generated. Today `src/app.js:124` sorts with `(a, b) => a.ctime + b.ctime` — adding two `Date`s is not a comparator; it coerces to a string, yields `NaN`, and `sort` is a no-op. `sortedFiles[0]` is then whatever `readdirSync` returned first, alphabetically `Reporte_Subcontratistas_ABRIL_2026.xlsx`. **The operator downloads the wrong month.** Serve by explicit path, not by directory scan.
- Re-running a past period must be possible and must overwrite deterministically — same period in, same filename out.
- Any failure inside report writing must propagate. `src/excelReporting.js:61-63` catches, logs and returns normally, so `src/app.js:94` answers `200 OK` and offers a download button for a report that was never written.

---

## 8. The run report — a new deliverable

This is the direct answer to the app's most dangerous behaviour, and it is not optional. Today the entire diagnostic for a whole subcontratista's workforce vanishing is `console.log("Error with: " + directory)` at `src/excelConsolidation.js:75` — printed to a terminal that `console.clear()` at `:284` has already wiped.

**A subcontratista whose file could not be read MUST appear as a loud failure at the top of the run report. It must never be a silent omission that looks like "no workers this month."**

### 8.1 Shape

Two artifacts, because they serve different readers:

- **An `Errores` sheet inside the delivered workbook**, plus a standalone CSV. This is what the operator actually opens, and it is the **required** artifact. Columns: `subcontratista`, `archivo`, `hoja`, `fila`, `celda`, `columna`, `valor crudo`, `motivo`, `severidad`.
- **Optionally, a newline-delimited JSON log**, one line per workbook, for a developer watching a run in progress. The owner has decided that keeping historical logs is not required, so nothing in this specification depends on that file outliving the run and no retention period is set for it. It is the cheap, lower-value item at the end of `05-implementation-plan.md` Phase 5, not a deliverable.

The Excel sheet is the deliverable, and it travels with the report. A log file on the pm2 host solves nothing for someone working in Excel — which is the whole reason the exception list lives inside the workbook.

### 8.2 Contents

**Per-run summary, first:**

| Metric | |
|---|---|
| Report period | `PeriodoEtiqueta`, `PeriodoInicio`, `PeriodoFin` |
| Subcontratistas expected / read / **failed** | failed count in bold, and never zero-suppressed |
| Rows found / accepted / rejected | must reconcile: `found − rejected = accepted` |
| Rows written to `Cuadro` | must equal `accepted − deduplicated` |
| Duplicates removed | itemised, with the canonical key that matched |

**Per subcontratista:**

- File read (name, size, sheet used, header row and anchor cell resolved).
- Rows found, rows accepted, rows rejected.
- **Header anomalies and how each was resolved** — `"accepted 'CONTRATISTA PRINCIPAL' as 'CONTRATISTA PRNCIPAL' via alias table"`, `"accepted 'DISTRITO SEGUN DNI' via accent folding"`, `"header 'OBSERVACIONES' not recognised — ignored"`, `"column 'HPT' absent — treated as null for 47 rows"`.
- **Unparseable dates**, one line each, with column, cell address, and the raw value verbatim.
- **Unrecognised coded values**, one line each, with the raw value — e.g. `ESTADO = "184"`, `TIPO DE CONTRATO LABORAL = "0.03"`.
- **Identifier failures**: RUC failing the mod-11 check digit, DNI not 8 digits (distinguishing legitimate 9-digit CE from a leading-zero casualty), missing RUC or DNI.
- **Row-level rejections** with the reason: name field numeric, fewer than 8 canonical columns resolved, all-empty row.

**Cross-cutting sections:**

- Workers reported by two or more subcontratistas — the `Dos Subcontratas por Mes` population, but including `Trabajador = 3` cases, which that pivot hides because only item `2` is visible.
- Districts that resolved to `"No"`, grouped and counted. An unrecognised district is currently indistinguishable from a genuine out-of-zone district, and this list is the only way the operator can tell `"AT E"` from someone who really does live outside the zone — and the only feed for growing `Hoja1!A2:B61`.
- Contratista/empresa spellings that differ from a known value only by whitespace or punctuation.

### 8.3 Severity

| Severity | Meaning | Example |
|---|---|---|
| **FAILED** | a whole workbook was not processed | no `Cuadro` sheet; no `RUC` anchor; <8 columns resolved |
| **ERROR** | a row was rejected | numeric name; unparseable required date; no `APELLIDOS Y NOMBRES` |
| **WARNING** | a row was accepted with a field nulled | unrecognised `ESTADO`; RUC check-digit failure; out-of-range date |
| **INFO** | a normalization fired | alias accepted; sentinel `"-"` treated as empty; 2-digit year expanded |

The run must not throw on the first failure. Collect everything, process every workbook that can be processed, and present the whole picture at the end.

---

## 9. Acceptance criteria

Numbered, checkable — **31 of them**. Each maps to a defect with a measured cost. They are proved two ways, and between them the two need **nothing stored**: no archived zips, no retained inputs, no diff against a past month's report. `05-implementation-plan.md` §4 is the same strategy from the build side.

- **Fixtures plus structural assertions — the primary automated gate.** Criteria 1–25 are asserted offline, on every `npm test` and every push, against the hand-written fixture corpus (criteria 30–31) and a structural assertion helper that reads the generated workbook against `src/template.xlsx`: `Tabla2`'s `ref` matches the actual row count; zero empty-string rows inside the table; `COUNTIF(Tabla2[…],"") = 0`; zero `#VALUE!`; zero `NaN`; the literal `"undefined"` appears zero times; every populated date cell is numeric; all 13 pivot parts are present and SHA-1-identical **to the template's** — never to a past report; and no dangling relationship or content-type override survives. Not one of these needs a historical file, which is precisely why they are the gate rather than a supplement to one. `05-implementation-plan.md` Phase 0 tasks 2–4 build them; criteria 30–31 specify the corpus they run on.
- **The determinism pair.** Criteria 26–27 need two runs a week apart and one reopen months later — a calendar, not an archive. Nothing has to be kept between the two runs but the metrics side-car of §7.4, which is a few kilobytes of JSON the developer holds for a week.
- **The parallel run — the end-to-end check.** Criteria 28–29 compare the new pipeline against the old one on the *same live upload*, inside the same job, for two monthly cycles before cutover. Nothing is retained here either: both runs consume the same in-flight extraction and the diff happens before the job deletes it.

**What is deliberately absent:** any criterion that reproduces a specific past month's published numbers. The app deletes its inputs on every run and the owner has decided that retaining them — or any other historical material — is not required, so the 14 delivered reports in `src/reportes/` keep the role they have throughout this document set: **evidence about current behaviour**, and the source of most of the measured numbers quoted below, rather than a baseline the new pipeline is expected to hit. That trade is an accepted risk, stated in full in `05-implementation-plan.md` §4.6.

### Extraction

1. The `Cuadro` sheet is located case-, accent- and whitespace-insensitively. A workbook with no such sheet fails loudly with the folder name and the actual sheet list. *(Regression target: `src/excelConsolidation.js:131-133`.)*
2. The header row is located by anchoring on the first cell normalizing to `RUC`; that cell defines the header **row** only, and the left and right edges are resolved by scanning that row outward from the anchor (§1.2 steps 3–4). A canonical column placed to the left of `RUC` must survive; the run report carries an INFO line whenever the left edge is left of the anchor. A workbook with no `RUC` cell in the first 50×30 window fails loudly.
3. Header matching is normalized (trim, collapse whitespace, accent-fold, case-fold) plus an explicit alias table. At minimum these resolve: `CONTRATISTA PRINCIPAL` → `CONTRATISTA PRNCIPAL`, `DISTRITO SEGUN DNI` → `DISTRITO SEGÚN DNI`, `RUC ` → `RUC`, `Nro DNI/CE` → `Nro. DNI / CE`. An unmatched header is reported, never silently dropped.
4. A canonical column absent from a workbook produces a warning; it never produces a column of `undefined`.
5. Provenance (`archivo`, `carpetaSubcontratista`, `hoja`, `filaOrigen`) survives to the output. *(Today the cleanup loop at `:64-70` deletes `errorEnArchivo`.)*
6. Empty source cells yield explicit nulls (`defval: null`); duplicate header names are rejected, not suffixed `_1`/`_2`.
7. **Zero rows lost or invented.** Assert `Σ(rows read per workbook) − (rows rejected, itemised) − (duplicates removed, itemised) = rows written`.
8. De-duplication uses a canonical key computed **after** normalization. *(Today `new Set(combinedArray.map(JSON.stringify))` at `:88` serializes in each source file's column order, so two byte-identical workers from two differently-ordered workbooks do not dedupe — and it runs before `orderHeadersAndData` canonicalizes anything.)*

### Data

9. **Zero text values in columns F, M and O.** Every date is a real serial with `numFmtId="14"`, or a genuinely empty cell. Against 103 / 4,894 / 100 today.
10. Every `FECHA CESE/BAJA` sentinel — `""` (3,801), `"-"` (754), `" -"` (154), `"---"` (125), `"ACTIVO"` (58), `" "` (1) — becomes an empty cell.
11. **Zero `NaN`** anywhere in `Cuadro`. `ESTADO` ∈ {1,2,3}∪null (today it contains `184` and `160`); `TIPO TRABAJADOR` ∈ {1,2,3}∪null; `TIPO DE CONTRATO LABORAL` ∈ {1,2,3,4}∪null (today: `0`, `0.03`, `5`, `10`, `11`, `14`).
12. `GENERO` ∈ {`masculino`, `femenino`}∪null. **The literal string `"undefined"` appears zero times** (10 today).
13. `RUC` and `Nro. DNI / CE` are text with leading zeros preserved. `09994533` does not become `9994533`. *(Measured DNI length distribution today: 4 values at 7 chars — the leading-zero casualties — 4,202 at 8, 134 at 9 (legitimate CE), 2 at 10.)*
14. **Zero rows** where `APELLIDOS Y NOMBRES` is numeric (643 today).

### Output workbook

15. `Tabla2` `ref` equals `A1:AI<1+n>` where `n` is the actual row count. Assert `COUNTIF(Tabla2[CONTRATISTA PRNCIPAL],"") = 0` and `COUNTIF(Tabla2[APELLIDOS Y NOMBRES],"") = 0`. Today: 3,757 (MAYO_2026), 3,277 (FEBRERO_2026).
16. `n > 8823` is handled correctly; the 8,823-row ceiling is gone by construction.
17. **Zero `#VALUE!`** in `Edad` and `Rango Edades`. The `#VALUE!` bucket visible in the deliverable — `Reporte_Subcontratistas_FEBRERO_2026.xlsx!'Reporte Social - RRHH'!C29` with **36 workers** in it — becomes 0 or a named `"Sin Fecha"` bucket.
18. `Validar Edad` and `ValidarDNI` carry the formulas recovered from `src/Formato Reporte subcontratas.xlsx`. Verification: the right-hand `Validacion` block lists rows with a missing or <8-character DNI — a **non-empty** list, against 723 missing DNIs in the last run.
19. `Detalle Cesados Zona de Influencia` is filtered on the period, not `"Borrar"`. Acceptance: **detail row count == `Total Bajas` in `F46`.** Today 55 vs 79 (FEBRERO_2026), 5 vs 91 (OCTUBRE_2025).
20. Template junk is gone: `Cuadro` row 2 (`A2 "asfasf"`, `B2 "asf"`, `C2 "fafsasf"`, `E2 "GUARDIA RIOS ELLIOT JOULE"`) and row 3 (`B3 "asfasf"`, `C3 "as"`, `E3 "LOPEZ PICON JEAN CARLOS"`), the AK/AM/AO/AP date-repair helpers, `AJ1 = "a"`, the stale `_xlnm._FilterDatabase` on `$AK$14:$AP$8612`. *(Hygiene, not a shipped defect — the writer overwrites both rows on every real run; verified absent from `MAYO_2026`, `FEBRERO_2026` and `OCTUBRE_2025`.)*
21. `refreshOnLoad="1"` on the pivot cache and `fullCalcOnLoad="1"` on `<calcPr>`; no dangling `calcChain` relationship or content-type override.
22. The report period is stored as defined names + `docProps/custom.xml` and matches the filename.
23. The download route serves the file just generated. *(`src/app.js:124` `a.ctime + b.ctime` is not a comparator.)*
24. Any failure in report writing propagates as a non-200 response. *(`src/excelReporting.js:61-63` currently swallows it.)*
25. The workbook opens in Excel with **no repair prompt**. Cheapest automated check: `libreoffice --headless --convert-to xlsx` against a *copy*, asserting exit 0 and no repair diagnostics — as a CI smoke test only, never as a pipeline step (LibreOffice's pivot-cache handling makes a round-trip a real corruption risk).

### Determinism

26. **Same inputs + same period ⇒ byte-comparable headline numbers, regardless of when the run happens.** Generate the same period twice, a week apart, on machines with different clocks; every number in the side-car JSON must match.
27. **Reopening a delivered report six months later shows identical numbers.** No `TODAY()` remains in any formula that feeds a pivot.

### Regression against the old pipeline

28. **Parallel-run cutover.** For **two monthly cycles** before cutover, the operator's single upload is processed by **both** pipelines inside the same job — **sequentially, never concurrently** (the template round-trip peaks near 944 MB RSS; two at once OOMs the pm2 box) — and the two output workbooks are diffed by `tools/diff-reports.js`. **The old pipeline's output is the one delivered to the client**; a failure in the new pipeline's run is reported and never fails the job. **Nothing is retained:** both runs consume the same in-flight extraction, and the comparison happens before the job's `finally` removes it. The mechanics are `05-implementation-plan.md` §4.3–§4.4 and Phase 5 task 8.

    **The diff covers, in this order:**

    - The 18 raw columns of `Cuadro!A:R` as a multiset, keyed on (`RUC`, `Nro. DNI / CE`, `APELLIDOS Y NOMBRES`, `FECHA INICIO DE LABORES EN OBRA`): rows only in the old output, rows only in the new one, rows in both. **Rows present only in the new output are the recovered ones** — subcontratistas the old pipeline silently dropped, which is the single most valuable thing this diff can surface.
    - The same 18 columns cell-by-cell for matched rows, comparing **value *and* type**, so a text date that became a serial reports as a type change rather than as an inequality and the two are never confused.
    - The computed columns S..AI for matched rows, cell by cell.
    - The pivot totals — the full cell list below.
    - The per-side counts of rows read / rows rejected / rows deduplicated / rows written.

    **Parallel-run reference cells.** The table below is **a set of measurements of `src/reportes/Reporte_Subcontratistas_FEBRERO_2026.xlsx` as it stands today**, and it is the list of cells the diff must cover. It is **not** a set of targets the new pipeline is expected to reproduce — several of these values are *supposed* to move, and criterion 29 says which. `FEBRERO_2026` is quoted because it is the cleanest of the fourteen delivered reports: `calcChain.xml` present, `refreshedDate` 2026-03-04 12:21, no `"undefined"` gender column, and an Altas period (`2-2026`) that agrees with its own filename.

    | Sheet | Cell | Value in `FEBRERO_2026` today |
    |---|---|---|
    | `Reporte Social - RRHH` | `D15` / `E15` / `F15` | 97 / 1512.5 / **1609.5** |
    | | `D46` / `E46` / `F46` (Total Bajas) | 4 / 75 / **79** |
    | | `D60` / `E60` / `F60` (Total Ingresos) | 7 / 84 / **91** |
    | | `C29` (`#VALUE!` bucket) | **36** |
    | | `D49` / `AG4` (Altas filter) | `2-2026` |
    | `CJ Y EPC` | `C7` / `D7` (CJV) | 4337.833333333334 / 791532.3363977855 |
    | | `C8` / `D8` (EPC) | 759 / 194340 |
    | | `C9` / `D9` (Total Trabajadores Activos) | **5096.833333333334** / 985872.3363977855 |
    | `Tabla` | `D64` / `E64` / `F64` / `G64` | 3644.5 / 160.16666666666666 / 26 / **3830.666666666667** |
    | `Contratistas` | `C91` grand total | **84** distinct contratistas |
    | `Dos Subcontratas por Mes` | rows `A7:E61` | 55 |
    | `Validacion` | `D2521` (`Cuenta de RUC`) | 8816 |

    The zone- and rango-level breakdowns (`C8:F14`, `C23:F28`, `C39:F45`, `C53:F59`) are compared cell-for-cell on the same basis.

    **One caveat, and it decides how much of this is automatable.** The old pipeline's output ships with stale cached pivot values — that is BUG-14, and it is why five of the fourteen delivered reports still display September-2024 numbers — so *its* side of the pivot-total comparison is only meaningful after a human opens the file in Excel and refreshes it. Budget **one manual refresh of the old output per parallel month**, and record in the diff report that it was done. The new pipeline's side comes from the metrics side-car (§7.4) with no Excel session at all. The other four items of the diff run unattended.

29. **Expected divergences, enumerated and frozen *before* the first parallel diff is run**, so that an **unexpected** divergence is the signal rather than a judgement call made after seeing the number. Each entry is a fix landing. **Anything not on this list blocks cutover** — not "is investigated", blocks.

    1. **Ghost rows disappear.** `Validacion!D2521` (`Cuenta de RUC`) falls from the table-height count of 8,816 toward the real population of ≈5,540, and every whole-column `COUNTIF`/`SUMPRODUCT` moves with it.
    2. **Text dates become serials.** ~200 of 5,065 rows change type in F, M and O, and the rows they belong to enter the Altas/Bajas counts they were silently excluded from.
    3. **The `#VALUE!` bucket empties.** The 36 workers at `'Reporte Social - RRHH'!C29` redistribute into real `Rango Edades` buckets.
    4. **The shifted workbook's 643 rows gain real identities.** They stop being one worker named `20101155588` and become 643 workers with a RUC, an EMPRESA and a CONTRATISTA PRNCIPAL, so headcount rises there — and `Tipo de Empresa` stops reading blank = blank as TRUE and tagging every one of them `Principal`.
    5. **`Detalle Cesados` grows** from 55 rows to 79, with a non-zero Total column, once the page filter stops selecting `Bajas2 = "Borrar"` (§7.3).
    6. **`Validacion`'s right-hand block becomes non-empty** — 723 rows with a missing DNI in the last run, against an empty list today (§5.1).
    7. **`Validar Edad` and `ValidarDNI` change by design**: they stop being byte-identical copies of `Validar Genero`.
    8. **Sentinels, `"undefined"` and `NaN` become empty cells.** `"-"` ×754, `" -"` ×154, `"---"` ×125, `"ACTIVO"` ×58 in `FECHA CESE/BAJA`; the 10 `"undefined"` genders; every `parseInt` default.
    9. **Contratista spellings collapse**, 352 distinct toward ~84, which moves `Contratistas!C91`, column U's distinct-contratista weight and every pivot filter list.
    10. **Dedupe changes if the identity key changes** (`05-implementation-plan.md` §8 Q3) — and changes slightly even if it does not, because the key is now computed *after* normalization instead of by `JSON.stringify` over raw rows.
    11. **Fractional totals persist.** `5096.833…` and `3830.666…` are *correct*: `Trabajadores Unicos` is a de-duplication weight, so a worker reported by two subcontratistas contributes 0.5 + 0.5 and one reported by three contributes 0.333 × 3. Do not "fix" the decimals, and do not flag them as a divergence.

30. **The `OCTUBRE_2025` gender regression, as a fixture.** The pathology that file records — a `GENERO` value outside {`masculino`, `femenino`} producing a third gender column, which pushed the Total from `F` to `G`, let the pivot body expand over `G53:G60`, and overwrote the `+F53/$F$60` percentage formulas outright (`G53` = 25, `G60` = 114, no `<f>` left) — is encoded in `src/fixtures/codes-out-of-domain.xlsx` and asserted **offline**, with no reference to the delivered file: the literal string `"undefined"` appears zero times in the output; `GENERO` is closed to {`masculino`, `femenino`}∪null; and the `G53:G60` percentage block is present and formula-bearing. The `OCTUBRE_2025` measurements stay in this document as the evidence for *why* that fixture exists — §4.4 and §7.3 above.

31. **Hand-written pathology fixtures — the primary offline verification, not a supplement.** Commit **~21 fixtures**, kilobyte-scale, five to twenty rows each, with **synthetic identities**, authored from knowledge of each pathology and using `src/ReporteConsolidado.xlsx` and `src/template.xlsx` as reference for realistic *shape* only — never carved out of a real month. One fixture per pathology, at minimum:

    | | Workbook fixtures (17) |
    |---|---|
    | 1 | header block that does not start at A1 |
    | 2 | a leading blank column |
    | 3 | columns in a different order |
    | 4 | **`EMPRESA` to the left of `RUC`** — the left-edge case in §1.2 step 4; it must not lose a column |
    | 5 | accent-stripped / case-varied / space-padded headers (`DISTRITO SEGUN DNI`, `RUC ` with a trailing space, mixed case) |
    | 6 | `CONTRATISTA PRINCIPAL` spelled correctly (the alias-table case) |
    | 7 | a duplicate header name — must be a hard error, not a `_1` suffix |
    | 8 | a sheet not named exactly `Cuadro` |
    | 9 | no `Cuadro` sheet at all |
    | 10 | the column-shifted workbook: A–D absent, a RUC number in `APELLIDOS Y NOMBRES` |
    | 11 | text dates in every observed shape (`04/07/1994`, `14/2/1989`, `3/5/1965`, `30/1/26`) plus the malformed years (`09/10/205`, `05/09/20258`, `10-11-202-6`) |
    | 12 | fractional serials at `.791666…` and `.833333…`, plus serial `60` (the 1900 boundary) |
    | 13 | the `FECHA CESE/BAJA` sentinels — `""`, `"-"`, `" -"`, `"---"`, `"ACTIVO"` |
    | 14 | a DNI with a leading zero, plus RUCs that pass and RUCs that fail the mod-11 check |
    | 15 | out-of-domain coded values: `ESTADO` 184 and 160, `TIPO DE CONTRATO LABORAL` 0 / 0.03 / 5 / 10 / 11 / 14, and a `GENERO` outside the two-item domain — the input class behind criterion 30 |
    | 16 | the older input format with **no `HPT` column** (`src/Formato Reporte subcontratas.xlsx`'s shape) |
    | 17 | dirty text columns: leading space, embedded CRLF, doubled internal space |

    | | Container fixtures (4) |
    |---|---|
    | 18 | a folder holding two `.xlsx` |
    | 19 | a folder holding zero `.xlsx` |
    | 20 | a folder containing a `~$…xlsx` lock file |
    | 21 | a zip carrying a `__MACOSX/` entry and a `._` resource fork |

    **Each fixture ships with its expected output as JSON beside it — that file is the assertion.** Where a fixture needs a proportion, take it from a real measurement rather than inventing one (the ghost-row ratio from `FEBRERO_2026`'s 5,538 + 3,277 + 8 breakdown; the shift block from the 643-row / 12.7% case; the dirty-text case from the 352 spellings for ~84 companies). Do **not** commit more multi-megabyte workbooks — `src/` and `src/reportes/` already carry well over 100 MB of them — and review the corpus once for real identities before the first commit.

---

## Cross-references

- `00-summary.md` — the overview: the four verdicts, the highest-value fixes, the schedule.
- `01-current-state.md` — how the pipeline works today, end to end.
- `02-shortcomings.md` — the defect inventory this specification is written against.
- `04-proposed-packages.md` — which of these requirements justify a dependency (date parsing, row validation) and which do not (header normalization, table resizing, identifier checksums, worker pools).
- `05-implementation-plan.md` — the order to build it in; the two-part verification strategy behind §9 (the fixture corpus and structural assertions in §4.2, the parallel run and its diff script in §4.3–§4.5) and the accepted risk in §4.6; and the OOXML mechanics of resizing `Tabla2` and refreshing the pivot cache without destroying the 13 pivot parts.

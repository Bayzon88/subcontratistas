# Current State

This document describes what the `subcontratistas` app is, how it runs, what it produces, and what the data actually looks like — as of 31 July 2026, verified against the repo and the raw OOXML of the workbooks it reads and writes. It is deliberately descriptive: where something is broken it is named and quantified but not argued about, because judgement belongs in `02-shortcomings.md`. The one thing worth reading it for is section 8, the measured type distribution across the 5,065 rows of the last real run — that table is the empirical case for the whole rework. Sections 3 and 10 exist to make sure the rework does not throw away the parts that are already right.

---

## 1. What this is for, and the human process around it

A construction consortium (CJV) runs a Lima-metro project with a long tail of subcontractors. Every month each subcontratista must report its workforce on the project: who they are, where they live, when they joined, when they left, hours worked. That reporting is a social/compliance obligation — the client wants to see how many of the workers on the project come from the districts the works pass through (the **Zona de Influencia**), the gender and age distribution, and the monthly **Altas** and **Bajas**.

The cycle, as it actually happens:

1. Each subcontratista fills in a copy of a distributed `.xlsx` format and returns it. The last run had **148 distinct non-empty `RUC` values, 125 distinct `EMPRESA` values and 82 distinct `CONTRATISTA PRNCIPAL` values** (raw string counts over `src/ReporteConsolidado.xlsx`; 147/122/80 after trimming whitespace). So the practical scale is roughly 80–150 companies per month depending on how you count sub-tiers.
2. One operator collects those workbooks into a folder tree — **one folder per subcontratista, one `.xlsx` inside each** — and zips it.
3. The operator opens the app in a browser, drags the zip onto the page, clicks **Procesar**, and waits. There is no progress feedback; the page just sits there for the duration of the run.
4. When the request returns 200, a **Descargar Archivo** button appears. The operator clicks it and gets one `.xlsx`.
5. The operator opens that file in Excel. **This step is not optional** — the delivered workbook contains formulas with no cached values and a pivot cache that has not been refreshed since 1 October 2024, so opening it in Excel is what actually produces the numbers.
6. The operator manually fixes whatever looks wrong (the leftover date-repair helper columns in `Cuadro!AK:AP` are physical evidence of this), re-picks the Altas page filter, and sends the file on.

Once a month, one person, no other users. No authentication, no accounts, no scheduling. That framing is correct for the tool and is not something the rework should change.

---

## 2. Runtime architecture

Plain CommonJS Node on Express 4. Four source files, one HTML page, one client script.

| File | Role | Size |
|---|---|---|
| `src/app.js` | Express server: routes, upload handling, zip extraction, orchestration | 141 lines |
| `src/excelConsolidation.js` | Reads every subcontratista workbook, normalizes, dedupes, reorders, writes `ReporteConsolidado.xlsx` | 319 lines |
| `src/excelReporting.js` | Opens `template.xlsx`, injects the consolidated rows, saves to `src/reportes/` | 79 lines |
| `src/discrepancias.js` | Standalone folder-name vs `SUBCONTRATISTA` cross-check. **Does not parse** (a corrupted edit at line 12 committed to `main`); never `require`d | 34 lines |
| `src/index.html` + `public/js/index.js` | Single-page drag-and-drop UI | — |
| `src/views/progress.ejs` | Progress-bar page for an SSE endpoint that was never built | — |

### Routes

| Route | Handler | What it does |
|---|---|---|
| `GET /` | `app.js:53` | `sendFile(src/index.html)` |
| `POST /uploadfiles` | `app.js:55` | The entire pipeline, synchronously, inside the request |
| `GET /downloadFile` | `app.js:105` | Sends one file from `src/reportes/` |
| `GET /ejs` | `app.js:38` | Renders `progress.ejs`. Dead — nothing links to it |

`getCurrentProgress` is exported from `excelConsolidation.js:314` but never routed. Both `progress.ejs` and the commented-out block at the top of `public/js/index.js` are written against a `/progress` SSE endpoint that does not exist server-side. The listen port defaults to `50001` (`app.js:19`), while the nginx config in `src/README.md` proxies to `3000`.

### Data flow, zip to workbook

```mermaid
flowchart TD
    A["Operator drags .zip<br/>POST /uploadfiles"] --> B["zipFile.mv → uploadDestination + filename<br/>app.js:65-70"]
    B --> C["AdmZip.extractAllTo(src/subcontratistas, true)<br/>app.js:82<br/>then unlinkSync(zip) app.js:85"]
    C --> D["readdirSync → array of top-level entries<br/>app.js:88"]
    D --> E["consolidateExcelFile(dirs)<br/>excelConsolidation.js:29"]

    subgraph PER["per subcontratista folder — excelConsolidation.js:49-80"]
      F["xlsx.readFile(workbook)<br/>:126"] --> G["sheet_to_json(Sheets['Cuadro'])<br/>:131-133 — defaults: header = row 1 at A1"]
      G --> H["stamp errorEnArchivo,<br/>alias CONTRATISTA PRINCIPAL → PRNCIPAL<br/>:137-145"]
      H --> I["switch-normalize TIPO TRABAJADOR, GENERO,<br/>TIPO DE CONTRATO LABORAL, ESTADO;<br/>FECHA CESE/BAJA undefined → \"\"<br/>:148-260"]
      I --> J["delete every key not in dataColumns<br/>(incl. errorEnArchivo) :64-70"]
    end

    E --> PER
    PER --> K["concat all rows<br/>:85"]
    K --> L["dedupe: new Set(rows.map(JSON.stringify))<br/>:88"]
    L --> M["orderHeadersAndData → 18 canonical columns<br/>:300-312"]
    M --> N[("src/ReporteConsolidado.xlsx<br/>one sheet 'Cuadro', ref A1:R5066")]
    E --> O["deleteFilesFromDirectory (async fs.rm, not awaited)<br/>:267-277"]

    N --> P["writeDataToWorksheet('template.xlsx')<br/>excelReporting.js:3"]
    P --> Q["xlsx-populate opens src/template.xlsx<br/>:17"]
    Q --> R["blank rows 2..lastRow, cols 1..18<br/>with .value(\"\") :35-40"]
    R --> S["write consolidated rows into Cuadro A..R<br/>by object key order :43-53"]
    S --> T[("src/reportes/Reporte_Subcontratistas_&lt;MES&gt;_&lt;AÑO&gt;.xlsx<br/>filename from wall clock :56,69-77")]

    T --> U["GET /downloadFile → sortedFiles[0]<br/>app.js:105-132"]
    U --> V["Operator opens in Excel:<br/>formulas evaluate, pivots refresh manually"]
```

Four properties of this flow matter for the rework:

- **It is one synchronous blocking call inside the HTTP handler.** `consolidateExcelFile` at `app.js:90` is not awaited because it is not async; `xlsx.readFile` is synchronous. The event loop is blocked for the whole run, which is why the process cannot serve a progress ping and why `req.setTimeout(6000000)` was added at `app.js:56`. The commit log carries `increase timeout`, `update timeout` ×2, `increase request timeout`, `fix server timeout issue` — five commits fighting the symptom.
- **`ReporteConsolidado.xlsx` is a real checkpoint on disk**, not an in-memory value. Stage 1 writes it (`excelConsolidation.js:110`), stage 2 reads it back (`excelReporting.js:7`). It is inspectable after a failure and it is why the data-quality measurements in section 8 are possible at all.
- **The 18 columns are aligned by object key-enumeration order**, not by name. `excelReporting.js:45` iterates `for (let data in row)` with a manual `column++`. This works only because `orderHeadersAndData` produced objects whose keys are in `dataColumns` order — the contract is real but implicit.
- **A run consumes its inputs.** The uploaded zip is deleted with `fs.unlinkSync` immediately after extraction (`app.js:85`), and `deleteFilesFromDirectory()` clears `src/subcontratistas/` at the end of consolidation (`excelConsolidation.js:113`, `:267-277`). After a successful run the only things left on disk are `ReporteConsolidado.xlsx` and the month's file in `src/reportes/`; the ~100 workbooks that produced them are gone. The owner has decided that retaining inputs, logs or any other historical material is not required, so this is intended behaviour rather than something the rework will change. What `02-shortcomings.md` faults is the *manner* of the deletion — the `fs.rm` is callback-style inside a `try/catch` that can never fire, it logs success unconditionally, it is not awaited so it races report generation, and the error-path cleanup is commented out at `app.js:99` so a failed run leaves the extracted folders behind — not the fact of it.

---

## 3. Tech stack and dependency inventory

Node 24.15.0 locally, Node 22.x on the CI runner. CommonJS, no build step, no bundler, no TypeScript, no lint config. `package.json` is still named `firebaseproject` with `main: app.js` (the file is at `src/app.js`), and `"test"` is the npm-init placeholder `echo "Error: no test specified" && exit 1`. There are **no tests and no fixtures** anywhere in the repo.

| Dependency | Installed | Used? | Where / notes |
|---|---|---|---|
| `express` | 4.18.2 | **yes** | the server |
| `express-fileupload` | 1.4.0 | **yes** | `app.js:51`; buffers the whole upload in memory, no size or type limit |
| `adm-zip` | 0.5.10 | **yes** | `app.js:78-82`, the only call site |
| `xlsx` (SheetJS) | 0.18.5 | **yes** | the reader in `excelConsolidation.js` and the writer for `ReporteConsolidado.xlsx`. This is the frozen npm artifact — SheetJS stopped publishing to npm after 0.18.5 (2022-03-24) and moved to their own CDN |
| `xlsx-populate` | 1.21.0 | **yes** | the template round-trip in `excelReporting.js`. Pulls in `jszip@3.10.1` transitively |
| `dotenv` | 16.3.1 | **yes** | `app.js:2`, guarded on `NODE_ENV !== "production"` |
| `path`, `fs` | built-in | **yes** | — |
| `axios` | 1.5.1 | **no** | `require`d at `app.js:5`, never called server-side. The browser gets axios from a CDN, not from this package |
| `ejs` | 3.1.9 | **effectively no** | serves only the dead `/ejs` route |
| `lodash` | 4.17.21 | **no** | `require`d as `_` at `excelConsolidation.js:5`, zero call sites |
| `exceljs` | 4.4.0 | **no** | 21.8 MB installed, never `require`d |
| `googleapis` | 105.0.0 | **no** | never `require`d |
| `@google-cloud/local-auth` | 2.1.0 | **no** | never `require`d |

Five of twelve declared dependencies are dead weight; `node_modules` carries 197 packages. The client side loads Bootstrap 5.3.2, Popper 2.11.8 and axios 1.5.1 from **three different CDNs** with SRI hashes (`src/index.html:84-99`), plus an `@n8n/chat` stylesheet at line 12 — so the page does not work offline.

---

## 4. The data contract — 18 canonical columns

`dataColumns` at `src/excelConsolidation.js:9-28` is the contract. It is simultaneously the input filter, the output column order, and the header row of `ReporteConsolidado.xlsx` — and it matches `Cuadro!A1:R1` in the template byte for byte, including the `PRNCIPAL` typo and the accented `Ú`.

| # | Col | Canonical header (verbatim) | Type as written today |
|---|---|---|---|
| 1 | A | `RUC` | mixed number/text |
| 2 | B | `EMPRESA` | text |
| 3 | C | `CONTRATISTA PRNCIPAL` | text — note the missing `I` |
| 4 | D | `Nro. DNI / CE` | mixed number/text |
| 5 | E | `APELLIDOS Y NOMBRES` | text — this is the de-facto person key |
| 6 | F | **`FECHA NACIMIENTO`** | **date** (style 4 → `numFmtId 14`) |
| 7 | G | `TIPO TRABAJADOR` | integer code 1/2/3 |
| 8 | H | `TITULO DE PUESTO/CARGO` | text |
| 9 | I | `NOMBRE DE OBRA DONDE ESTA ASIGNADO DURANTE EL MES REPORTADO` | text |
| 10 | J | `DOMICILIO DE TRABAJADOR` | text |
| 11 | K | `DISTRITO SEGÚN DNI` | text — accented `Ú` |
| 12 | L | `GENERO` | lowercase word |
| 13 | M | **`FECHA CESE/BAJA`** | **date** (style 4 → `numFmtId 14`) |
| 14 | N | `NACIONALIDAD` | text |
| 15 | O | **`FECHA INICIO DE LABORES EN OBRA`** | **date** (style 4 → `numFmtId 14`) |
| 16 | P | `ESTADO` | integer code 1/2/3 |
| 17 | Q | `TIPO DE CONTRATO LABORAL` | integer code 1–4 |
| 18 | R | `HPT` | number (hours) |

**The three date columns are F, M and O.** All three carry cell style 4 → built-in `numFmtId 14` (short date), so a numeric serial renders as a date and a text date renders as left-aligned text sitting in a date-formatted column. Nothing in the JavaScript touches dates at all — whatever SheetJS produced goes straight into the output.

Header recognition is exact string equality against this list (`excelConsolidation.js:66`, `:305-307`). There is **exactly one alias in the entire codebase**: `CONTRATISTA PRINCIPAL` → `CONTRATISTA PRNCIPAL` at `excelConsolidation.js:141-143`.

### The input format has drifted

`src/Formato Reporte subcontratas.xlsx` is the format historically handed to the subcontratistas. Its `Cuadro` header row, read directly:

```
RUC, EMPRESA, CONTRATISTA PRNCIPAL, Nro. DNI / CE, APELLIDOS Y NOMBRES,
FECHA NACIMIENTO, TIPO TRABAJADOR, TITULO DE PUESTO/CARGO,
NOMBRE DE OBRA DONDE ESTA ASIGNADO DURANTE EL MES REPORTADO,
DOMICILIO DE TRABAJADOR, DISTRITO SEGÚN DNI, GENERO, FECHA CESE/BAJA,
NACIONALIDAD, FECHA INICIO DE LABORES EN OBRA, ESTADO, TIPO DE CONTRATO LABORAL,
| EPC/CJV, Tipo de Empresa, Contratistas, Edad, Rango Edades, Validar Edad,
  Zona de Influencia, Validar Genero, ValidarDNI, Trabajador, Trabajadores Unicos,
  Bajas, Altas
```

**17 raw columns, not 18 — there is no `HPT`.** That file also has 8 sheets rather than 9 (`Reporte` instead of `Reporte Social - RRHH`, and **no `CJ Y EPC`**) and 13 computed columns rather than 17. Those two facts are the same event: `HPT` was added as the raw input that feeds the `# Horas` measure on the new `CJ Y EPC` sheet, and the same revision added `Trabajdores Unicos Zona Influencia`, `Altas Zona de Influencia`, `Bajas Zona Influencia` and `BajasAntiguas` (renaming `Bajas` to `Bajas2`). The app has no notion of format versions — a workbook returned on the old format simply produces a blank `HPT` column, silently.

That older file also happens to be the archaeological record for three formulas the current template lost; see `03-expected-output.md`.

---

## 5. Template workbook anatomy — `src/template.xlsx`

3.5 MB on disk, 67 OOXML parts, 9 sheets. The `Cuadro` worksheet part (`xl/worksheets/sheet4.xml`) alone is **43.9 MB uncompressed**.

| Sheet | Part | Role | Visible |
|---|---|---|---|
| `Reporte Social - RRHH` | sheet1 (548 KB) | the deliverable page — 7 pivots | yes |
| `CJ Y EPC` | sheet2 | active headcount + hours, CJV vs EPC | yes |
| `Hoja1` | sheet3 | lookup tables | hidden |
| `Cuadro` | sheet4 (43.9 MB) | the data table `Tabla2` | yes |
| `Contratistas` | sheet5 | distinct-contractor roll-call | yes |
| `Tabla` | sheet6 | headcount by contractor × cargo × ESTADO | yes |
| `Sheet1` | sheet7 | Razón Social → Nombre Comercial, 83 rows | hidden |
| `Dos Subcontratas por Mes` | sheet8 | workers reported by two subcontratistas | yes |
| `Validacion` | sheet9 (227 KB) | data-quality exception lists | hidden |

### `Tabla2`

`xl/tables/table1.xml` defines an Excel Table named **`Tabla2`** at `ref="A1:AI8824"` — 35 columns × 8,823 data rows, with an autoFilter and a `sortState` on column C. Columns **A–R are the 18 raw columns**; columns **S–AI are 17 calculated columns**, every one of them written with structured references of the form `Tabla2[[#This Row],[...]]`:

| Col | Name | What it computes |
|---|---|---|
| S | `EPC/CJV` | `IFERROR(VLOOKUP([CONTRATISTA PRNCIPAL],Hoja1!$L$5:$M$9,2,FALSE),"CJV")` |
| T | `Tipo de Empresa` | `Principal` if `EMPRESA = CONTRATISTA PRNCIPAL`, else `Secundaria` |
| U | `Contratistas` | `IFERROR(1/COUNTIF(Tabla2[CONTRATISTA PRNCIPAL],[...]),0)` — distinct-count weight |
| V | `Edad` | age from `(TODAY()-[FECHA NACIMIENTO])/365`, `"Corregir"` outside 18–80. **`ca="1"` volatile, no IFERROR** |
| W | `Rango Edades` | six buckets `18 - 23 … 59 +`, recomputed from `TODAY()` twelve times per row. **volatile, no IFERROR** |
| X | `Validar Edad` | *is literally the `GENERO` formula* |
| Y | `Zona de Influencia` | `+IFERROR(VLOOKUP(TRIM([DISTRITO SEGÚN DNI]),Hoja1!$A$2:$B$61,2,FALSE),"No")` |
| Z | `Validar Genero` | `IF(OR(LOWER([GENERO])="masculino",LOWER([GENERO])="femenino"),"OK","Corregir")` |
| AA | `ValidarDNI` | *is literally the `GENERO` formula* |
| AB | `Trabajador` | `COUNTIF(Tabla2[APELLIDOS Y NOMBRES],[...])` — **the identity key is the name, not the DNI** |
| AC | `Trabajadores Unicos` | `IF([Trabajador]>1,1/[Trabajador],[Trabajador])` — why every total ends in `.5` or `.333…` |
| AD | `Trabajdores Unicos Zona Influencia` *(sic)* | array formula, `SUMPRODUCT` over name × zone, O(n²) across 8,823 rows |
| AE | `Altas Zona de Influencia` | 0/1 counter derived from AI |
| AF | `Bajas Zona Influencia` | 0/1 counter derived from AH |
| AG | `BajasAntiguas` | `IF(AND([Bajas2]="borrar",[Altas]="No Aplica"),"Si","No")` — the stale-carry-over filter every headcount pivot uses |
| AH | `Bajas2` | three-state period classification off `[FECHA CESE/BAJA]` vs `TODAY()-30` |
| AI | `Altas` | two-state period classification off `[FECHA INICIO DE LABORES EN OBRA]` vs `TODAY()-30` |

X, Z and AA are byte-identical; only Z is correct for its name. **There is no stored report period anywhere in the workbook** — every period-dependent value derives from `TODAY()-30` evaluated at open time, in `AH`, `AI`, `V` and `W`, across 8,823 rows each.

**Outside** the table, `Cuadro!AK/AM/AO/AP` rows 2..8612 carry a hand-rolled text-date parser (`LEFT(...,2)`, `MID(...,4,2)`, `RIGHT(...,4)`, `DATE(AO2,AM2,AK2)`) — the owner's manual workaround for text dates, preserved in the template. There is also a stale defined name `_xlnm._FilterDatabase` on `Cuadro!$AK$14:$AP$8612` and a header `"a"` in `AJ1`. The template still contains junk test data in row 2: RUC `"asfasf"`, EMPRESA `"asf"`, CONTRATISTA `"fafsasf"`.

### Pivots

**13 pivot tables over one shared cache.** `xl/pivotCache/pivotCacheDefinition1.xml` (787 KB) declares `<cacheSource type="worksheet"><worksheetSource name="Tabla2"/></cacheSource>` — it binds to the **table name**, not to a fixed range — and `pivotCacheRecords1.xml` is 2.2 MB. The 13 pivots are distributed 7 / 1 / 1 / 1 / 1 / 2 across `Reporte Social - RRHH`, `CJ Y EPC`, `Contratistas`, `Tabla`, `Dos Subcontratas por Mes` and `Validacion`. Three of them (`pivotTable2`, `pivotTable3`, `pivotTable6`) are 0.8–0.95 MB each because they are per-worker detail listings.

### Lookup tables

`Hoja1` carries the two lookups that the business, not the code, owns:

- **`A2:B61`** — `DISTRITO SEGÚN DNI` → `Zona de Influencia`. 56 populated rows in 60 slots, mapping every observed spelling of a district (`AGUSTINO`, `ATE VITARTE`, `AT E`, `CALLO`, RENIEC ubigeo-prefixed forms like `015001011-EL AGUSTINO`) onto one of 7 zones: `ATE`, `BREÑA`, `CALLAO`, `EL AGUSTINO`, `LA VICTORIA`, `SAN LUIS `, `SANTA ANITA`. Anything not in the table falls to `"No"`.
- **`L5:M9`** — `CONTRATISTA PRNCIPAL` → `EPC`. Four companies (`2A TECH SCRL`, `J & V RESGUARDO SAC`, `PROSEGURIDAD S.A`, `SOCIAL CAPITAL GROUP SAC`); everything else defaults to `CJV`.

`Sheet1` is a manually-maintained Razón Social → Nombre Comercial list of 83 rows, referenced by nothing in the workbook.

---

## 6. What the operator actually receives

The deliverable is `src/reportes/Reporte_Subcontratistas_<MES>_<AÑO>.xlsx`, ~2.7–4.5 MB. Structurally it is `template.xlsx` with new bytes written into `Cuadro!A2:R<n+1>`:

- **The pivot parts survive intact.** xlsx-populate keeps the input as a live JSZip archive and only rewrites the parts it models; `xl/pivotTables/*`, `xl/pivotCache/*`, `xl/tables/table1.xml` and the theme pass through untouched. This is the hardest problem in the domain and it is already solved.
- **All 94,600 formulas in `Cuadro` survive**, with the same element count as the template.
- **`xl/calcChain.xml` is dropped and cached `<v>` values are stripped from formula cells.** The workbook produces numbers only once Excel opens and recalculates it. Nothing downstream can read the report programmatically without an Excel round-trip.
- **`Tabla2` stays at `ref="A1:AI8824"`.** Verified: the ref strings in `src/template.xlsx` and in `src/reportes/Reporte_Subcontratistas_MAYO_2026.xlsx` are byte-identical (`A1:AI8824`, `A1:AI8824`, `A2:AI8824`, `C1:C8824`). The clearing loop at `excelReporting.js:35-40` writes `.value("")` rather than removing rows, so in the May 2026 report rows **5067–8823 (3,757 rows)** carry the empty string in A–R while the formula columns S–AI still evaluate on every one of them.
- **The pivot cache is never refreshed and `refreshOnLoad` is not set.** Five of the fourteen archived reports still display the template's cached October-2024 numbers verbatim — they were shipped and never opened.
- **The filename comes from the wall clock**, via `getMonthAndYear()` at `excelReporting.js:69-77`, and is recomputed independently client-side at `public/js/index.js:103-111`. Two copies of the same logic that must stay in sync.

Every generated report accumulates in `src/reportes/`, which now holds 14 months plus a stray Excel lock file `~$Reporte_Subcontratistas_FEBRERO_2025.xlsx`. `GET /downloadFile` sorts that directory with `filesWithStats.sort((a, b) => a.ctime + b.ctime)` (`app.js:124`) — adding two Dates is not a comparator, so the sort is a no-op and `sortedFiles[0]` is whatever `readdirSync` returned first.

---

## 7. Deployment

- **Self-hosted GitHub Actions runner.** `.github/workflows/subcontratistas.yml` triggers on push and PR to `main`, runs `actions/checkout@v4`, `setup-node@v4` (Node 22.x, npm cache), `npm ci`, `npm run build --if-present` (there is no build script, so this is a no-op), then `sudo pm2 restart 0` and `sudo pm2 save`. The restart is **by process index, not by name** — the commented-out line above it shows the name-based version (`pm2 describe subcontratistas || pm2 start ...`) was tried and abandoned.
- **nginx in front.** Two configs are committed as plain files rather than as deployment artifacts: `src/README.md` holds a `server` block proxying to `localhost:3000` with a `root` of `~/bayzon88/Desktop/actions-runner/_subcontratistas/subcontratistas/subcontratistas/src`; the file `n8n` at the repo root holds the Certbot-managed `alvarobeltran.dev` config with a `/automation` location proxying to n8n on `5678`.
- **The repo carries its own output.** 30 `.xlsx` files are tracked in git: 15 under `src/` (including `template.xlsx` 3.5 MB, `template_new.xlsx` 1.9 MB, `Formato Reporte subcontratas.xlsx` 2.3 MB, `ReporteConsolidado.xlsx` 3.6 MB and a near-duplicate `Reporte Consolidado.xlsx` 3.6 MB) and 14 under `src/reportes/` at 2.7–4.5 MB each. `src/` is 100 MB on disk, `src/reportes/` alone is 53 MB, and `.git` is **115 MB**. `.gitignore` covers only `/node_modules/`, `/subcontratistas/` and `.env`.
- A 0-byte file named `subcontratistas1741059493565_Febrero-2025` sits committed in the repo root — the artefact of the missing path separator at `app.js:66`.

---

## 8. Measured data-quality reality

This is the empirical case for the rework. Measured directly on `src/ReporteConsolidado.xlsx` — the intermediate output of the last real run, **5,065 data rows, ref `A1:R5066`**. `n` = numeric cell, `s` = text cell, empty = the key was absent.

| Column | numeric | text | empty | notes |
|---|---|---|---|---|
| `RUC` (A) | 3,276 | 1,130 | **659** | the same RUC appears both as the number `20604191883` and as the text `"20547422407"`; **13.0% missing** |
| `Nro. DNI / CE` (D) | 1,356 | 2,986 | **723** | numeric coercion destroys leading zeros: `09994533` → `9994533` |
| `FECHA NACIMIENTO` (F) | 4,789 | **103** | 173 | text samples: `"04/07/1994"`, `"14/11/1995"`, `"01/12/2002"`, `"20/04/2000"`, `"14/2/1989"`, `"3/5/1965"` |
| `FECHA CESE/BAJA` (M) | 171 | 4,894 (mostly `""`) | 0 | the code force-writes `""` when the key is absent (`excelConsolidation.js:257-259`) |
| `FECHA INICIO DE LABORES` (O) | 4,813 | **100** | 152 | includes **`"09/10/205"`** — a typo'd 3-digit year no strict parser will accept |
| `TIPO TRABAJADOR` (G) | 4,908 | 0 | 157 | |
| `GENERO` (L) | 0 | 5,065 | 0 | normalized to lowercase strings |
| `ESTADO` (P) | 5,044 | 0 | 21 | |
| `TIPO DE CONTRATO LABORAL` (Q) | 4,994 | 0 | 71 | |

**Roughly 200 of 5,065 rows (~4%) carry text dates** in the date-formatted columns F and O. Those rows produce `#VALUE!` in `Edad` and `Rango Edades` — neither is wrapped in `IFERROR`, so the error bucket reaches the deliverable — and they fall into the `IFERROR(...,"No aplica")` branch of `Bajas2` and `Altas`, which means they are silently counted as *not* an alta and *not* a baja.

The text-date shapes actually present: `dd/mm/yyyy`, `d/m/yyyy`, `d/mm/yyyy`, `dd/mm/yy`, `dd-mm-yyyy`, `dd.mm.yyyy`, plus malformed years. **Day-first (es-PE) is the correct disambiguation**, confirmed by the template's own custom number formats: `dd/mm/yyyy;@`, `dd\.mm\.yyyy;@`, `d/mm/yyyy`. `04/07/1994` means 4 July 1994.

Two structural pathologies are visible in the same file and are worth naming here because they shape the rework's acceptance criteria:

- **643 rows** carry the *number* `20101155588` (a RUC) in `APELLIDOS Y NOMBRES` with A–D all null — one subcontratista's workbook had shifted headers and was consolidated anyway. Because the person key is the name, `COUNTIF` sees 643 rows sharing one "name" and `Trabajadores Unicos` gives each `1/643`: those 643 real workers contribute a combined headcount of **1**.
- **10 rows** hold the literal string `"undefined"` in `GENERO` — `String(undefined).toLowerCase()` leaking out of `excelConsolidation.js:181`. In `Reporte_Subcontratistas_OCTUBRE_2025.xlsx` that produced a third gender column on four pivots.

---

## 9. What runs, and how long

No instrumentation exists, but the costs are measurable. Parsing `src/Formato Reporte subcontratas.xlsx` (2.4 MB, 4,808-row `Cuadro`) takes ~430 ms with SheetJS defaults, so ~100 workbooks is roughly 45 seconds of blocked event loop. The xlsx-populate template round-trip costs about 0.9 s to open and 1.3 s to write, and peaks near 1 GB RSS because `xl/worksheets/sheet4.xml` is 42 MB uncompressed. Total: on the order of 30–60 seconds of CPU for a monthly run, all of it inside one HTTP request, with no output to the operator until it finishes. Sizing details and the argument about what to do with them are in `04-proposed-packages.md`.

---

## 10. What works and should be kept

This app has been in production for nearly three years (first commit 2023-09-06, 58 commits) and produces a real compliance deliverable every month. Several of its design decisions are correct and the rework should preserve them deliberately rather than lose them by accident.

**The canonical column reordering is the right design.** `orderHeadersAndData()` (`excelConsolidation.js:300-312`) rebuilds every row in `dataColumns` order regardless of the order the source workbook used. The owner's belief that column order is already handled is **factually true** — subcontratistas genuinely can rearrange their columns and the app copes. What is brittle is header *recognition* (exact, case-, accent- and whitespace-sensitive string equality), not reordering. The rework should fix recognition and keep the reorder exactly as it is.

**The domain normalization maps encode institutional knowledge that is expensive to re-derive.** The `switch` bodies at `excelConsolidation.js:148-254` are a catalogue of how ~100 real companies actually mis-type things: `"activo en obra"`, `"PLAZA FIJO"`, `"obrero de construccion civil"`, `"Sin contrato regimen civil"`. The same is true of `Hoja1!A2:B61` — 56 hand-curated district spellings including `AT E`, `CALLO` and RENIEC ubigeo prefixes. The mechanism (a hardcoded `switch`, a VLOOKUP range) is worth changing; the **vocabulary** is an asset and must be carried across verbatim.

**The template-plus-pivot architecture is the right answer, and it already works.** The client reads six pivot sheets, not a flat table. Those pivots are curated Excel artefacts that no JS library can generate, and the `Hoja1` lookups are owned by the business inside the workbook where the business can edit them. xlsx-populate preserves all of it because it never parses the parts it does not model. Keeping the template — and keeping xlsx-populate as the writer — avoids re-solving the single hardest problem in this domain.

**The two-stage pipeline with a materialised checkpoint is good structure.** `ReporteConsolidado.xlsx` sitting on disk between consolidation and reporting is what makes the app debuggable at all: every measurement in section 8 was taken from it. Keep the split, keep the artefact. It is a single per-run file that each month overwrites — a diffable intermediate, not a history, and keeping it implies nothing about keeping inputs.

**The `errorEnArchivo` idea was right.** `readFileToJson` stamps every row with its source file (`excelConsolidation.js:140`) precisely so a non-compliant subcontratista can be traced. The field is destroyed downstream by the cleanup loop, but the intent is exactly what the rework needs and the design is already there.

**The UX has zero friction and should stay that way.** One page, drag a zip, click Procesar, click Descargar. No login, no configuration, no install. For a tool one person uses twelve times a year, that is the correct amount of interface — the additions worth making (a period selector, a progress indicator, an exceptions report) are small and should not turn it into an application.

**The stack is appropriately small.** Express plus two Excel libraries, no framework, no database, no container. It boots instantly, runs as one pm2 process behind nginx, and deploys on push. The problems in `02-shortcomings.md` are correctness and observability problems, not architecture problems, and none of them argues for a bigger stack.

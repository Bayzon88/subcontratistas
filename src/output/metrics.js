"use strict";
/**
 * The metrics side-car - `reportes/Reporte_Subcontratistas_<MES>_<ANIO>.json`
 * (03-expected-output.md §7.4 tier 2, 05-implementation-plan.md Phase 3 task 6).
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT OPTIONAL
 * -----------------------------------------------
 * `xlsx-populate` strips the cached `<v>` from every formula cell and drops
 * `xl/calcChain.xml`, so the delivered workbook produces numbers only once Excel
 * recalculates it, and no JS formula engine can close the gap (every computed column uses
 * `Tabla2[[#This Row],[...]]`, and structured references are unsupported by HyperFormula
 * and by every other candidate - 04-proposed-packages.md). The consequence is that the
 * headline figures of a compliance report cannot be read, asserted or compared without a
 * human opening Excel.
 *
 * So the run publishes them itself. Every number below is computed IN JS, from the
 * consolidated records, BEFORE the workbook is written. That makes three things possible
 * that are impossible today:
 *
 *   1. AC 26 - the determinism gate. "Generate the same period twice, a week apart, on
 *      machines with different clocks; every number in the side-car JSON must match."
 *      Without this file that gate needs two manual Excel sessions and cannot run in CI,
 *      which is the exact manual-verification loop the rework exists to end.
 *   2. The parallel-run headline comparison (05 §4.3-§4.4, AC 28). This is the NEW
 *      pipeline's side of it, and the only way the comparison happens without an Excel
 *      session at all - the OLD pipeline's pivots are stale until a human refreshes them
 *      (BUG-14: five of fourteen delivered reports still display September-2024 numbers).
 *   3. Month-over-month comparison as a `diff` rather than an Excel session.
 *
 * NOTHING HERE READS A CLOCK. No `new Date()`, no `Date.now()`, no `TODAY()`. The period
 * is a required argument; a caller that forgot it is a wiring bug and gets a TypeError,
 * exactly as `output/computed.js` and `pipeline/period.js` do. A DATA problem never
 * throws - it lands in the IssueList or in one of the exception lists below.
 *
 * THE SEMANTICS ARE THE TEMPLATE'S, NOT MINE
 * ------------------------------------------
 * The side-car is only useful if it predicts what the workbook will show. So every
 * aggregate below reproduces the corresponding `Tabla2` calculated column and pivot,
 * read verbatim out of `src/template.xlsx` -> `xl/tables/table1.xml` and
 * `xl/pivotTables/pivotTable*.xml`, quirks included. The four that matter most:
 *
 *   Trabajadores Unicos (AC)   `IF([Trabajador]>1, 1/[Trabajador], [Trabajador])`
 *       A DE-DUPLICATION WEIGHT, not a count. A worker reported by two subcontratistas
 *       contributes 0.5 + 0.5; one reported by three contributes 0.333... x 3. Summing it
 *       over any slice gives the unique headcount OF THAT SLICE. Fractional totals like
 *       `5096.833333333334` (CJ Y EPC!C9 in FEBRERO_2026) are CORRECT and are never
 *       rounded here - 03 §9 criterion 29.11 says so in as many words.
 *
 *   Contratistas (U)           `IFERROR(1/COUNTIF([CONTRATISTA PRNCIPAL], <this row>), 0)`
 *       Same trick on the contratista column, so summing it gives the DISTINCT count.
 *       `Contratistas!C91` = 84 in FEBRERO_2026.
 *
 *   Zona de Influencia (Y)     `+IFERROR(VLOOKUP(TRIM([DISTRITO SEGUN DNI]),Hoja1!$A$2:$B$61,2,FALSE),"No")`
 *       The business-owned district table, with `"No"` as the default. An unrecognised
 *       district is therefore indistinguishable from a genuinely out-of-zone one in the
 *       workbook - which is why `excepciones.listas.distritosSinZona` below exists
 *       (03 §8.2: "the only feed for growing Hoja1!A2:B61").
 *
 *   EPC/CJV (S)                `IFERROR(VLOOKUP([CONTRATISTA PRNCIPAL],Hoja1!$L$5:$M$9,2,FALSE),"CJV")`
 *       Four EPC suppliers; everything else is Consorcio, i.e. `"CJV"`.
 *
 * `pipeline/lookups.js` normalizes both sides of those two VLOOKUPs harder than Excel
 * does (trim + collapse + accent-fold + upper), which is the BUG-29 fix. That is a
 * deliberate divergence from the live template and it is why `template-v2.xlsx` cleans
 * the 15 unreachable keys: after Phase 4 task 7 the two agree again.
 *
 * BOTH HEADCOUNTS ARE PUBLISHED, SIDE BY SIDE (05 §8 Q3)
 * -----------------------------------------------------
 * The delivered number is keyed on the normalized name, because that is the template's
 * own notion of a person (`COUNTIF(Tabla2[APELLIDOS Y NOMBRES], ...)`) and switching the
 * key is the one change in the plan that moves numbers the client has already seen. The
 * DNI-keyed count sits next to it so the owner can watch the size of the gap for a few
 * months before deciding. Neither is recomputed here: `pipeline/dedupe.js keyCensus()`
 * owns the keying, and this module calls it twice.
 */

const config = require("../config");
const { CANONICAL } = require("../pipeline/columns");
const { SEVERITY, SEVERITY_ORDER } = require("../pipeline/issues");
const { parsePeriod } = require("../pipeline/period");
const { keyCensus, conservationCheck, sourceOf } = require("../pipeline/dedupe");
const { ZONA_DEFAULT, EPC_DEFAULT } = require("../pipeline/lookups");
const { IDENTITY_MODES, DNI_DIGITS, personKey, normalizeRuc } = require("../pipeline/identity");
const {
    computeRow,
    excelTextEquals,
    LITERALS,
    RANGO_LABELS,
} = require("./computed");

/* ------------------------------------------------------------------ *
 * Identity of the artifact
 * ------------------------------------------------------------------ */

/** Bump when a field is renamed or removed. Consumers (CI, the diff script, the run
 *  report renderer) pin on this, so an added field is NOT a version bump. */
const VERSION = 1;

/** The eight headline metrics of 03 §7.4, in the order that section lists them. The
 *  array is the contract: a test asserts `Object.keys(result.metricas)` equals it, so a
 *  metric cannot be dropped or renamed without a failing test. "the CJV/EPC split and
 *  its hours" is two keys (`cjvEpc`, `horas`) because they are two dataFields on the same
 *  pivot (`pivotTable8`: `# Trabajadores` = fld 28, `# Horas` = fld 17) and CI asserts
 *  them independently. */
const METRIC_NAMES = Object.freeze([
    "headcount",        // 1  unique headcount
    "porZonaGenero",    // 2  headcount by zone x gender
    "altas",            // 3  Altas
    "bajas",            // 4  Bajas
    "cjvEpc",           // 5  the CJV/EPC split
    "horas",            // 6  ...and its hours
    "contratistas",     // 7  distinct contratistas
    "excepciones",      // 8  the full exception list
]);

/* ------------------------------------------------------------------ *
 * Canonical columns this module reads
 * ------------------------------------------------------------------ */

const COL_RUC = "RUC";
const COL_EMPRESA = "EMPRESA";
const COL_CONTRATISTA = "CONTRATISTA PRNCIPAL";   // the typo is the real header
const COL_DNI = "Nro. DNI / CE";
const COL_NOMBRE = "APELLIDOS Y NOMBRES";
const COL_DISTRITO = "DISTRITO SEGÚN DNI";
const COL_GENERO = "GENERO";
const COL_ESTADO = "ESTADO";
const COL_HPT = "HPT";

for (const name of [COL_RUC, COL_EMPRESA, COL_CONTRATISTA, COL_DNI, COL_NOMBRE,
    COL_DISTRITO, COL_GENERO, COL_ESTADO, COL_HPT]) {
    if (!CANONICAL.includes(name)) {
        throw new Error(`output/metrics.js: "${name}" is not a canonical column - columns.js drifted`);
    }
}

/**
 * `GENERO` is closed to {masculino, femenino} u null (03 §4.4, AC 12), so the gender axis
 * is three fixed keys rather than whatever happened to arrive. That is deliberate: the
 * OCTUBRE_2025 regression was a THIRD gender item appearing in the pivot, pushing the
 * Total column from F to G and destroying the `+F53/$F$60` percentage block. A
 * fixed-arity object here makes the same accident a visible `sinGenero` count instead of
 * a new column.
 */
const GENERO_FEMENINO = "femenino";
const GENERO_MASCULINO = "masculino";

/** `pivotTable8`'s page filter on `CJ Y EPC` is `ESTADO` = shared item 0 = the number 1,
 *  i.e. ACTIVO (codes.js ESTADO entry 1). Hence "Total Trabajadores Activos". */
const ESTADO_ACTIVO = 1;

/** The two rows of that pivot, in its own row order (rowItems: x=0 then x=1, and the
 *  cache's shared items for `EPC/CJV` are `["CJV","EPC"]`). */
const EPC_VALUES = Object.freeze([EPC_DEFAULT, "EPC"]);

/** Default cap on the verbatim issue stream. 03 §7.4 wants the side-car small enough to
 *  hold for a week; 03 §8.2 wants the full exception list. Both are honoured by keeping
 *  every COUNT uncapped and only ever truncating the row-by-row dump - and since issues
 *  are sorted FAILED first, a truncation can only ever drop INFO lines. */
const MAX_INCIDENCIAS = 20000;

/* ------------------------------------------------------------------ *
 * Small helpers - none of them may ever produce NaN, undefined or "undefined"
 * ------------------------------------------------------------------ */

/** A finite number, or null. Never NaN (BUG-20, AC 11). */
function num(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Deterministic text order. `localeCompare` is never used - a sort whose result depends
 *  on the host's ICU data is exactly the non-determinism this rework removes. Nulls last. */
function compareText(a, b) {
    const an = a === null || a === undefined;
    const bn = b === null || b === undefined;
    if (an && bn) return 0;
    if (an) return 1;
    if (bn) return -1;
    return a < b ? -1 : a > b ? 1 : 0;
}

function compareNumber(a, b) {
    const an = typeof a !== "number" || !Number.isFinite(a);
    const bn = typeof b !== "number" || !Number.isFinite(b);
    if (an && bn) return 0;
    if (an) return 1;
    if (bn) return -1;
    return a - b;
}

/** Trimmed non-empty string, or null. Used for grouping keys only - never for output of
 *  a stored value, which is published verbatim. */
function text(value) {
    if (value === null || value === undefined) return null;
    const s = String(value);
    return s.trim() === "" ? null : s;
}

/** Map<label|null, number> -> sorted [{...labelKey, filas|peso}], nulls last. */
function tally(map, labelKey, valueKey) {
    const out = [];
    for (const [label, value] of map) out.push({ [labelKey]: label, [valueKey]: value });
    out.sort((a, b) => compareText(a[labelKey], b[labelKey]));
    return out;
}

function increment(map, key, by = 1) {
    map.set(key, (map.get(key) || 0) + by);
}

/* ------------------------------------------------------------------ *
 * Argument validation - wiring bugs throw, data problems never do
 * ------------------------------------------------------------------ */

/**
 * The period, as a `parsePeriod` descriptor. A `"YYYY-MM"` string is parsed; anything
 * else must already carry the four fields every aggregate here depends on.
 *
 * Required, with no default. A default would reintroduce the hidden clock read that
 * BUG-15/BUG-16 are made of - the app currently derives the period from `TODAY()-30` in
 * the formulas and from `getMonthAndYear()` in the filename, and the two disagree
 * (`DICIEMBRE_2025` is named December and reports November).
 */
function resolvePeriod(period) {
    if (typeof period === "string") return parsePeriod(period);
    if (period && typeof period === "object"
        && Number.isFinite(period.inicioSerial)
        && Number.isFinite(period.finSerial)
        && typeof period.etiqueta === "string" && period.etiqueta !== "") {
        return period;
    }
    throw new TypeError(
        'output/metrics.js: se requiere un periodo explicito - "YYYY-MM" o el descriptor de '
        + "period.parsePeriod() con inicioSerial, finSerial y etiqueta"
    );
}

/**
 * The two business-owned lookup tables, from `lookups.readLookups(config.TEMPLATE)`.
 *
 * Required, and deliberately not defaulted: without them every district resolves to `"No"`
 * and every contratista to `"CJV"`, which does not fail - it silently reports a zone
 * headcount of ~0 and a 100% CJV split. A side-car that quietly reports the wrong thing is
 * worse than no side-car, so a missing table is a TypeError.
 */
function resolveLookups(lookups) {
    const ok = lookups && typeof lookups === "object"
        && lookups.zonaByDistrito && typeof lookups.zonaByDistrito.get === "function"
        && lookups.epcByContratista && typeof lookups.epcByContratista.get === "function";
    if (!ok) {
        throw new TypeError(
            "output/metrics.js: se requieren las tablas de lookups.readLookups(plantilla) "
            + "(zonaByDistrito, epcByContratista); sin ellas toda zona resolveria a "
            + `${JSON.stringify(ZONA_DEFAULT)} y todo contratista a ${JSON.stringify(EPC_DEFAULT)}`
        );
    }
    return lookups;
}

/** An IssueList, a plain array of issues, or nothing. Never mutated here. */
function issueItems(issues) {
    if (!issues) return [];
    if (Array.isArray(issues)) return issues;
    if (Array.isArray(issues.items)) return issues.items;
    return [];
}

/* ------------------------------------------------------------------ *
 * Pass 1 - per-record derivations that need no cross-row information
 * ------------------------------------------------------------------ */

/**
 * Reproduces `Zona de Influencia` (Y) and `EPC/CJV` (S) for one record, plus the plain
 * fields the pivots slice on.
 *
 * The two defaults are the template's own `IFERROR` sentinels, exported by lookups.js so
 * that neither string is spelled twice in the codebase - six of the thirteen pivots
 * page-filter on literals like these and a one-character difference silently empties a
 * row on the client-facing page.
 */
function deriveBase(record, lookups) {
    const r = record || {};
    const distrito = r[COL_DISTRITO];
    const contratista = r[COL_CONTRATISTA];
    const genero = r[COL_GENERO];

    return {
        distrito: distrito === undefined ? null : distrito,
        // VLOOKUP(TRIM(distrito), Hoja1!A2:B61, 2, FALSE) -> "No" when unmatched.
        zona: lookups.zonaByDistrito.get(distrito, ZONA_DEFAULT),
        // Whitespace-only collapses to null, which is what the WORKBOOK will show: text.js
        // already nulls those upstream, and `output/consolidated.js` refuses to write a
        // whitespace-only string at all - so `COUNTIF(col,"")` groups it with the genuine
        // blanks rather than giving `"   "` a phantom group of its own.
        contratista: text(contratista),
        // VLOOKUP(contratista, Hoja1!L5:M9, 2, FALSE) -> "CJV" when unmatched. LookupTable
        // treats a blank key as a miss, so a blank contratista lands on the CJV side.
        epc: lookups.epcByContratista.get(contratista, EPC_DEFAULT),
        genero: genero === GENERO_FEMENINO || genero === GENERO_MASCULINO ? genero : null,
        estado: num(r[COL_ESTADO]),
        hpt: num(r[COL_HPT]),
    };
}

/** `[Zona de Influencia]<>"No"`, with Excel's case-insensitive `<>`. */
function inZone(zona) {
    return !excelTextEquals(String(zona), ZONA_DEFAULT);
}

/* ------------------------------------------------------------------ *
 * The five column weights, verbatim from xl/tables/table1.xml
 * ------------------------------------------------------------------ */

/**
 * `Trabajadores Unicos` (AC): `IF([Trabajador]>1, 1/[Trabajador], [Trabajador])`.
 *
 * When `[Trabajador]` is 1 the else branch returns 1, so the whole thing is `1/n` - but it
 * is written the template's way because the template is the thing being predicted.
 */
function trabajadoresUnicos(trabajador) {
    return trabajador > 1 ? 1 / trabajador : trabajador;
}

/**
 * `Trabajdores Unicos Zona Influencia` (AD) *(sic - the typo is the real column name)*:
 *
 *   IF(AND([Trabajador]>1, [Zona de Influencia]<>"No"),
 *      1/SUMPRODUCT((name=this name)*(zona<>"No")),
 *        SUMPRODUCT((name=this name)*(zona<>"No")))
 *
 * where the SUMPRODUCT is "how many rows of this person are in-zone" (`enZona` below).
 *
 * REPRODUCED VERBATIM, INCLUDING ITS QUIRK. For a single-row worker the else branch gives
 * 1 in-zone / 0 out-of-zone, which is the documented behaviour ("out-of-zone-only workers
 * score 0"). But for a worker with two rows, one in-zone and one out, the in-zone row
 * scores `1/1 = 1` AND the out-of-zone row falls to the else branch and scores `enZona = 1`
 * as well - the same person counted twice, once under his zone and once under `"No"`. That
 * is what the delivered workbook does today and what it will keep doing while AD stays an
 * Excel formula (03 §5 note on AD), so the side-car must agree with it rather than quietly
 * be more correct. `metricas.porZonaGenero.dobleConteo` counts the affected rows so the
 * effect is a number rather than a surprise.
 */
function trabajadoresUnicosZona(trabajador, zona, enZona) {
    return trabajador > 1 && inZone(zona) ? 1 / enZona : enZona;
}

/**
 * `Altas Zona de Influencia` (AE) and `Bajas Zona Influencia` (AF), collapsed.
 *
 * The template writes each as a two-armed IF whose arms are both `1` under the same
 * effective condition - BUG-30, 03 §5.2 - so both reduce to:
 *
 *   IF(OR([X]="No Aplica", [X]="borrar"), 0, 1)
 *
 * Despite the names, neither is zone-restricted; the zone split comes from the pivot's row
 * axis. `"borrar"` is lowercase in the formula and `Bajas2` emits `"Borrar"`, so the
 * comparison must be case-insensitive (see `computed.js excelTextEquals` for why that
 * matters more than it looks).
 *
 * NOTE, and it is a real consequence of Option D: `"Revisar"` - the new state
 * `output/computed.js` emits when a date cell held something unreadable (BUG-08,
 * 03 §6.4) - is in neither excluded set, so a `Revisar` row scores 1 here. For Altas that
 * is invisible in the delivered numbers because `pivotTable7` page-filters on
 * `PeriodoEtiqueta`; for Bajas it is NOT, because `pivotTable4` filters on
 * `BajasAntiguas = "No"` and a `Revisar` row passes. `metricas.altas`/`metricas.bajas`
 * publish the filtered total, the in-period count and the `revisar` count separately so
 * the gap is visible rather than baked in.
 */
function periodFlag(value) {
    if (excelTextEquals(value, LITERALS.NO_APLICA)) return 0;
    if (excelTextEquals(value, LITERALS.BORRAR)) return 0;
    return 1;
}

/* ------------------------------------------------------------------ *
 * Zone x gender accumulator
 * ------------------------------------------------------------------ */

function newGenderBucket() {
    return { femenino: 0, masculino: 0, sinGenero: 0, total: 0, filas: 0 };
}

function addToGenderBucket(bucket, genero, value) {
    if (genero === GENERO_FEMENINO) bucket.femenino += value;
    else if (genero === GENERO_MASCULINO) bucket.masculino += value;
    else bucket.sinGenero += value;
    bucket.total += value;
    bucket.filas += 1;
}

/**
 * One zone x gender matrix, shaped like the pivots on `Reporte Social - RRHH`
 * (rows = `Zona de Influencia`, columns = `GENERO`, the Total column last).
 *
 * Zones are sorted by code unit, nulls last. `"No"` therefore lands after the uppercase
 * district labels, which is also where the pivot puts it - but the ordering rule here is
 * plain text order, not a special case, because a special case is a thing that can drift.
 */
function newMatrix(medida, filtro) {
    return { medida, filtro, zonas: new Map(), totales: newGenderBucket() };
}

function addToMatrix(matrix, zona, genero, value) {
    if (!matrix.zonas.has(zona)) matrix.zonas.set(zona, newGenderBucket());
    addToGenderBucket(matrix.zonas.get(zona), genero, value);
    addToGenderBucket(matrix.totales, genero, value);
}

function finishMatrix(matrix) {
    const zonas = [];
    for (const [zona, bucket] of matrix.zonas) zonas.push({ zona, ...bucket });
    zonas.sort((a, b) => compareText(a.zona, b.zona));

    // The in-zone subtotal: the grand total minus the "No" row. Published because the
    // page's caption is "Total Zona de Influencia" while the pivot's grand total includes
    // the out-of-zone row, and the two are not the same number.
    let enZona = 0;
    let fueraDeZona = 0;
    for (const z of zonas) {
        if (inZone(z.zona)) enZona += z.total;
        else fueraDeZona += z.total;
    }

    return {
        medida: matrix.medida,
        filtro: matrix.filtro,
        zonas,
        totales: {
            femenino: matrix.totales.femenino,
            masculino: matrix.totales.masculino,
            sinGenero: matrix.totales.sinGenero,
        },
        filas: matrix.totales.filas,
        enZona,
        fueraDeZona,
        total: matrix.totales.total,
    };
}

/* ------------------------------------------------------------------ *
 * computeMetrics
 * ------------------------------------------------------------------ */

/**
 * The eight headline metrics of 03 §7.4, from the consolidated records.
 *
 * @param {Array<object>} records  canonical records - the array that is about to be
 *                                 written into `Cuadro!A2:R<n+1>`. Date columns are
 *                                 integer Excel serials or null.
 * @param {object} options
 * @param {string|object} options.period    `"YYYY-MM"` or a `parsePeriod()` descriptor.
 *                                          REQUIRED - no clock is read.
 * @param {object} options.lookups          `lookups.readLookups(config.TEMPLATE)`. REQUIRED.
 * @param {IssueList|Array} [options.issues] the run's collected issues. Read, never
 *                                          appended to: this module reports, it does not
 *                                          diagnose.
 * @param {object} [options.stats]          the run's counters, same shape `runReport.js`
 *                                          accepts: `{workbooks|archivos, expected|esperados,
 *                                          walk, dedupe, collapsed, written, crossSubcontratista}`.
 *                                          Entirely optional enrichment.
 * @param {Array<object>} [options.computed] `computed.computeRow()` results, parallel to
 *                                          `records`. Pass the ones `output/template.js`
 *                                          already built so the two artifacts cannot
 *                                          disagree; omit and they are recomputed here.
 * @param {Array<Set|Array|object>} [options.unparseableDates] per-record "this date cell
 *                                          held something unreadable" sets, parallel to
 *                                          `records`, built with
 *                                          `computed.unparseableDatesFromIssues()`. Only
 *                                          consulted when `options.computed` is absent.
 *                                          Without it the BUG-08 `"Revisar"` state can
 *                                          never appear - see `computed.js`.
 * @param {"name"|"dni"} [options.identityKey] which headcount is the DELIVERED one.
 *                                          Defaults to `config.IDENTITY_KEY`. Both are
 *                                          always published (05 §8 Q3).
 * @param {number} [options.maxIncidencias] cap on the verbatim issue dump. Counts are
 *                                          never capped.
 * @returns {object} the side-car structure. The caller writes it as
 *                   `reportes/<period.filenameBase>.json`.
 */
function computeMetrics(records, options = {}) {
    const opts = options || {};
    if (!Array.isArray(records)) {
        throw new TypeError("output/metrics.js: computeMetrics(records, ...) requiere un arreglo de registros");
    }
    const period = resolvePeriod(opts.period);
    const lookups = resolveLookups(opts.lookups);
    const items = issueItems(opts.issues);
    const stats = opts.stats && typeof opts.stats === "object" ? opts.stats : {};
    const identityKey = opts.identityKey === undefined || opts.identityKey === null
        ? config.IDENTITY_KEY
        : opts.identityKey;
    if (!IDENTITY_MODES.includes(identityKey)) {
        throw new TypeError(
            `output/metrics.js: identityKey "${identityKey}" desconocida, se espera ${IDENTITY_MODES.join(" o ")}`
        );
    }
    const maxIncidencias = Number.isInteger(opts.maxIncidencias) && opts.maxIncidencias >= 0
        ? opts.maxIncidencias
        : MAX_INCIDENCIAS;

    /* ---------------------------------------------------------- *
     * Both censuses. dedupe.js owns the keying; nothing is re-implemented here.
     * ---------------------------------------------------------- */
    const censusName = keyCensus(records, "name");
    const censusDni = keyCensus(records, "dni");

    /* ---------------------------------------------------------- *
     * Pass 1 - per-record base values, and the cross-row counters the weights need.
     * ---------------------------------------------------------- */
    const n = records.length;
    const base = new Array(n);
    const nameKeys = new Array(n);
    const computedRows = new Array(n);

    // `Trabajador` (AB) = COUNTIF over the whole name column. `censusName.counts` is the
    // same tally under the same normalization, so the JS headcount and the workbook's
    // COUNTIF cannot diverge by construction (identity.js normalizeNameKey does not fold
    // accents, precisely so that this equality holds).
    const trabajadorCount = censusName.counts;
    // The SUMPRODUCT inside AD: rows per person that are in-zone.
    const enZonaPorPersona = new Map();
    // COUNTIF over CONTRATISTA PRNCIPAL, behind column U.
    const contratistaCount = new Map();

    for (let i = 0; i < n; i++) {
        const record = records[i] || {};
        const b = deriveBase(record, lookups);
        base[i] = b;

        // `personKey(record, "name")` is the SAME normalizer keyCensus keyed its counts
        // with, so `trabajadorCount.get(key)` is exactly the template's
        // `COUNTIF(Tabla2[APELLIDOS Y NOMBRES], <this row>)` and the two can never drift.
        // Empty-key records are never grouped (identity.js §7): each is its own person, so
        // its `Trabajador` is 1. This mirrors dedupe.js, which refuses to collapse them.
        const key = personKey(record, "name");
        nameKeys[i] = key;
        if (key !== "" && inZone(b.zona)) increment(enZonaPorPersona, key, 1);

        // The blank contratista forms its own COUNTIF group, exactly as
        // `COUNTIF(col,"")` does in Excel - it is one distinct "contratista", which is
        // wrong and which is the template's arithmetic. `contratistas.sinContratista`
        // below makes it a visible number instead of a silent +1.
        increment(contratistaCount, b.contratista === null ? "" : String(b.contratista), 1);

        computedRows[i] = resolveComputedRow(record, i, period, lookups, opts);
    }

    /* ---------------------------------------------------------- *
     * Pass 2 - the weights, the matrices and the tallies.
     * ---------------------------------------------------------- */

    // Metric 2: pivotTable1, 'Reporte Social - RRHH'!C6:F15.
    //   rows = Zona de Influencia, cols = GENERO,
    //   data = Sum of Trabajdores Unicos Zona Influencia, page filter BajasAntiguas = "No".
    const matrizHeadcount = newMatrix("Trabajdores Unicos Zona Influencia", { BajasAntiguas: LITERALS.NO });
    // Metric 3: pivotTable7, C51:F59 - data = Sum of Altas Zona de Influencia,
    //   page filter Altas = PeriodoEtiqueta.
    const matrizAltas = newMatrix("Altas Zona de Influencia", { Altas: period.etiqueta });
    // Metric 4: pivotTable4, C37:F46 - data = Sum of Bajas Zona Influencia,
    //   page filter BajasAntiguas = "No".
    const matrizBajas = newMatrix("Bajas Zona Influencia", { BajasAntiguas: LITERALS.NO });

    // Metrics 5 and 6: pivotTable8 on 'CJ Y EPC'!B6:D9 - rows = EPC/CJV,
    //   data = Sum of Trabajadores Unicos + Sum of HPT,
    //   page filters ESTADO = 1 (ACTIVO) and BajasAntiguas = "No".
    const cjvEpc = new Map();
    for (const v of EPC_VALUES) cjvEpc.set(v, { trabajadores: 0, horas: 0, filas: 0, horasNulas: 0 });

    const rangoTally = new Map();
    const distritoSinZona = new Map();
    const generoPorValor = { femenino: 0, masculino: 0, sinGenero: 0 };
    const estadoTally = new Map();

    let sumaTrabajadoresUnicos = 0;
    let sumaTrabajadoresUnicosZona = 0;
    let sumaAltasZona = 0;
    let sumaBajasZona = 0;
    let sumaContratistas = 0;
    let sumaHoras = 0;

    let altasEnPeriodo = 0;
    let altasRevisar = 0;
    let bajasEnPeriodo = 0;
    let bajasBorrar = 0;
    let bajasRevisar = 0;
    let bajasAntiguasSi = 0;
    let dobleConteoZona = 0;

    let filasActivas = 0;
    let filasSinDistrito = 0;
    let filasSinContratista = 0;
    let filasSinEmpresa = 0;
    let filasSinHpt = 0;
    let edadSinFecha = 0;
    let edadCorregir = 0;

    let sinRuc = 0;
    let rucInvalido = 0;
    let sinDni = 0;
    let dniCorregir = 0;   // the ValidarDNI (AA) population: empty or shorter than 8

    for (let i = 0; i < n; i++) {
        const record = records[i] || {};
        const b = base[i];
        const c = computedRows[i];
        const key = nameKeys[i];

        const trabajador = key === "" ? 1 : (trabajadorCount.get(key) || 1);
        const enZona = key === "" ? (inZone(b.zona) ? 1 : 0) : (enZonaPorPersona.get(key) || 0);

        const tu = trabajadoresUnicos(trabajador);
        const tuz = trabajadoresUnicosZona(trabajador, b.zona, enZona);
        const ae = periodFlag(c.Altas);
        const af = periodFlag(c.Bajas2);
        const contratistaKey = b.contratista === null ? "" : String(b.contratista);
        const u = 1 / (contratistaCount.get(contratistaKey) || 1);

        sumaTrabajadoresUnicos += tu;
        sumaTrabajadoresUnicosZona += tuz;
        sumaAltasZona += ae;
        sumaBajasZona += af;
        sumaContratistas += u;

        // AD's double-count quirk: a duplicated worker whose OTHER row is in-zone gets a
        // non-zero score on this out-of-zone row too. See trabajadoresUnicosZona().
        if (trabajador > 1 && !inZone(b.zona) && enZona > 0) dobleConteoZona += 1;

        const bajasAntiguas = c.BajasAntiguas;
        const activo = excelTextEquals(bajasAntiguas, LITERALS.NO);
        if (!activo) bajasAntiguasSi += 1;

        // Metric 2 - filtered on BajasAntiguas = "No", like every headcount pivot.
        if (activo) addToMatrix(matrizHeadcount, b.zona, b.genero, tuz);

        // Metric 3 - filtered on Altas = PeriodoEtiqueta (the page filter ooxml.js repoints).
        if (c.Altas === period.etiqueta) {
            altasEnPeriodo += 1;
            addToMatrix(matrizAltas, b.zona, b.genero, ae);
        }
        if (excelTextEquals(c.Altas, LITERALS.REVISAR)) altasRevisar += 1;

        // Metric 4 - filtered on BajasAntiguas = "No"; a row only contributes when AF = 1,
        // i.e. Bajas2 is neither "No Aplica" nor "Borrar".
        if (activo && af === 1) addToMatrix(matrizBajas, b.zona, b.genero, af);
        if (c.Bajas2 === period.etiqueta) bajasEnPeriodo += 1;
        if (excelTextEquals(c.Bajas2, LITERALS.BORRAR)) bajasBorrar += 1;
        if (excelTextEquals(c.Bajas2, LITERALS.REVISAR)) bajasRevisar += 1;

        // Metrics 5 and 6 - ESTADO = 1 (ACTIVO) and BajasAntiguas = "No".
        if (b.estado === ESTADO_ACTIVO && activo) {
            filasActivas += 1;
            const bucket = cjvEpc.get(b.epc) || { trabajadores: 0, horas: 0, filas: 0, horasNulas: 0 };
            if (!cjvEpc.has(b.epc)) cjvEpc.set(b.epc, bucket);
            bucket.trabajadores += tu;
            bucket.filas += 1;
            if (b.hpt === null) bucket.horasNulas += 1;
            else { bucket.horas += b.hpt; sumaHoras += b.hpt; }
        }

        // Exception tallies.
        increment(rangoTally, c["Rango Edades"], 1);
        if (c.Edad === LITERALS.SIN_FECHA) edadSinFecha += 1;
        else if (c.Edad === LITERALS.CORREGIR) edadCorregir += 1;

        if (!inZone(b.zona)) {
            const d = text(b.distrito);
            if (d === null) filasSinDistrito += 1;
            else increment(distritoSinZona, d, 1);
        }

        if (b.genero === GENERO_FEMENINO) generoPorValor.femenino += 1;
        else if (b.genero === GENERO_MASCULINO) generoPorValor.masculino += 1;
        else generoPorValor.sinGenero += 1;

        increment(estadoTally, b.estado === null ? null : b.estado, 1);

        if (b.contratista === null) filasSinContratista += 1;
        if (text(record[COL_EMPRESA]) === null) filasSinEmpresa += 1;
        if (b.hpt === null) filasSinHpt += 1;

        const ruc = normalizeRuc(record[COL_RUC]);
        if (ruc.text === "") sinRuc += 1;
        else if (!ruc.valid) rucInvalido += 1;

        // ValidarDNI (AA), the corrected formula recovered in 03 §5.1:
        //   IF([Nro. DNI / CE]="","Corregir",IF(LEN([Nro. DNI / CE])>=8,"OK","Corregir"))
        // Evaluated against the STORED value, because that is what Excel will see, and
        // length-only, because that is all the formula checks - the mod-11 and DNI/CE
        // shape work lives in identity.js and lands in the IssueList, not in column AA.
        const dniStored = text(record[COL_DNI]);
        if (dniStored === null) {
            sinDni += 1;
            dniCorregir += 1;
        } else if (dniStored.length < DNI_DIGITS) {
            dniCorregir += 1;
        }
    }

    /* ---------------------------------------------------------- *
     * Assemble.
     * ---------------------------------------------------------- */

    const contratistas = buildContratistas(contratistaCount, sumaContratistas, filasSinContratista);
    const cross = buildCrossSubcontratista(stats, records, censusName, nameKeys);

    const metricas = {
        // 1 - unique headcount, both keys side by side (05 §8 Q3).
        headcount: {
            clave: identityKey,
            entregado: identityKey === "dni" ? censusDni.distinct : censusName.distinct,
            porNombre: buildCensus(censusName),
            porDni: buildCensus(censusDni),
            // Σ Trabajadores Unicos over the whole table. Equals `porNombre.distintos` by
            // construction; published because it is what the workbook actually sums, and a
            // divergence between the two means the keying drifted.
            sumaTrabajadoresUnicos,
            filas: n,
            brecha: censusName.distinct - censusDni.distinct,
        },

        // 2 - headcount by zone x gender.
        porZonaGenero: {
            ...finishMatrix(matrizHeadcount),
            sumaSinFiltro: sumaTrabajadoresUnicosZona,
            excluidasBajasAntiguas: bajasAntiguasSi,
            dobleConteo: dobleConteoZona,
        },

        // 3 - Altas ("Total Ingresos" on the deliverable page).
        altas: {
            ...finishMatrix(matrizAltas),
            etiqueta: period.etiqueta,
            enPeriodo: altasEnPeriodo,
            revisar: altasRevisar,
            sumaSinFiltro: sumaAltasZona,
        },

        // 4 - Bajas ("Total Bajas").
        bajas: {
            ...finishMatrix(matrizBajas),
            etiqueta: period.etiqueta,
            enPeriodo: bajasEnPeriodo,
            borrar: bajasBorrar,
            revisar: bajasRevisar,
            bajasAntiguas: bajasAntiguasSi,
            sumaSinFiltro: sumaBajasZona,
        },

        // 5 - the CJV/EPC split ("# Trabajadores", "Total Trabajadores Activos").
        cjvEpc: buildSplit(cjvEpc, "trabajadores", filasActivas),

        // 6 - ...and its hours ("# Horas"). `sinHpt` is whole-table, not filtered: the
        // older input format has no HPT column at all (BUG-55 / fixture 16), and a run
        // where the hours are simply absent must not read as a run where they are zero.
        horas: { ...buildSplit(cjvEpc, "horas", filasActivas), sinHpt: filasSinHpt },

        // 7 - distinct contratistas.
        contratistas,

        // 8 - the full exception list.
        excepciones: {
            totales: {
                incidencias: items.length,
                fallos: items.filter(i => i && i.severity === SEVERITY.FAILED).length,
            },
            porSeveridad: severityCounts(items),
            porCodigo: codeCounts(items),
            fallos: buildFallos(items),
            listas: {
                distritosSinZona: {
                    filas: sumOfMap(distritoSinZona) + filasSinDistrito,
                    sinDistrito: filasSinDistrito,
                    distritos: tally(distritoSinZona, "distrito", "filas"),
                },
                edad: {
                    sinFecha: edadSinFecha,
                    corregir: edadCorregir,
                    // Every bucket, not just the exceptions: AC 17 asks for the `#VALUE!`
                    // bucket (36 workers in FEBRERO_2026) to become 0 or a named
                    // "Sin Fecha", and that is only assertable against the whole
                    // distribution.
                    rangos: buildRangos(rangoTally),
                },
                fechasRevisar: {
                    altas: altasRevisar,
                    bajas2: bajasRevisar,
                    total: altasRevisar + bajasRevisar,
                    // Nothing can be `Revisar` unless the caller threaded the signal
                    // through; false means the BUG-08 swallow is still in effect.
                    senalDisponible: Boolean(opts.computed || opts.unparseableDates),
                },
                identificadores: {
                    sinRuc,
                    rucInvalido,
                    sinDni,
                    // The ValidarDNI = "Corregir" population - the hidden `Validacion`
                    // block that has been empty for as long as BUG-26 has existed
                    // (723 missing DNIs in the last run). AC 18.
                    validarDniCorregir: dniCorregir,
                },
                genero: { ...generoPorValor },
                estado: tally(estadoTally, "estado", "filas"),
                empresa: { sinEmpresa: filasSinEmpresa },
                dosSubcontratistas: cross,
            },
        },
    };

    return {
        version: VERSION,
        tipo: "metricas",
        // No timestamp, anywhere. AC 26 compares two runs a week apart and a `generatedAt`
        // would break that for no operational gain. If a run ever needs one, `run.js`
        // stamps it outside this structure.
        periodo: {
            key: period.key ?? null,
            etiqueta: period.etiqueta,
            inicio: period.inicio ?? null,
            fin: period.fin ?? null,
            inicioSerial: period.inicioSerial,
            finSerial: period.finSerial,
            anio: period.year ?? null,
            mes: period.month ?? null,
            mesNombre: period.mesNombre ?? null,
            archivo: period.filename ?? null,
        },
        metricas,
        proceso: buildProceso(stats, items, n),
        // Every number above is a prediction of a cell in the workbook. This says which
        // cell, so a mismatch is traceable without re-deriving the mapping.
        origen: ORIGEN,
        incidencias: buildIncidencias(items, maxIncidencias),
        incidenciasOmitidas: Math.max(0, items.length - maxIncidencias),
    };
}

/* ------------------------------------------------------------------ *
 * Builders
 * ------------------------------------------------------------------ */

function buildCensus(census) {
    return {
        clave: census.mode,
        distintos: census.distinct,
        filas: census.total,
        conIdentidad: census.withIdentity,
        sinIdentidad: census.withoutIdentity,
        // How often the DNI key fell back to the name because the row had no DNI at all -
        // 723 of 5,065 rows in the last run. Without this the DNI-keyed headcount looks
        // like a DNI-keyed headcount when it is partly a name-keyed one (identity.js).
        clavesPorRespaldo: census.fallbackKeys,
        clavesDuplicadas: census.duplicateKeys,
        filasDuplicadas: census.duplicateRows,
    };
}

/** `cjvEpc` Map -> the pivot's two rows plus its grand total, for one dataField. */
function buildSplit(map, field, filas) {
    const filasList = [];
    let total = 0;
    for (const [epc, bucket] of map) {
        filasList.push({ epc, valor: bucket[field], filas: bucket.filas });
        total += bucket[field];
    }
    filasList.sort((a, b) => compareText(a.epc, b.epc));
    return {
        medida: field === "horas" ? "HPT" : "Trabajadores Unicos",
        filtro: { ESTADO: ESTADO_ACTIVO, BajasAntiguas: LITERALS.NO },
        grupos: filasList,
        filas,
        total,
    };
}

/**
 * Column U summed: `Σ IFERROR(1/COUNTIF(col, this), 0)` = the number of distinct
 * contratistas. Both forms are published and neither is rounded:
 *
 *   `distintos` - the integer group count. The answer to the question.
 *   `suma`      - the reciprocal sum, i.e. what `Contratistas!C91` actually computes.
 *
 * They agree exactly for small tables and drift in the last ULP once the sum runs over
 * dozens of reciprocals - measured at 5,000 rows / 84 contratistas: `83.999999999996`.
 * A gap larger than float noise means the grouping drifted, which is the thing worth
 * catching; rounding `suma` would hide exactly that.
 */
function buildContratistas(counts, suma, sinContratista) {
    const grupos = [];
    for (const [name, filas] of counts) {
        grupos.push({ contratista: name === "" ? null : name, filas });
    }
    grupos.sort((a, b) => compareText(a.contratista, b.contratista));
    return {
        medida: "Contratistas",
        distintos: grupos.length,
        suma,
        // A blank CONTRATISTA PRNCIPAL is its own COUNTIF group and therefore counts as one
        // distinct contratista - the template's arithmetic, made visible.
        sinContratista,
        distintosNoVacios: grupos.filter(g => g.contratista !== null).length,
        lista: grupos,
    };
}

function buildRangos(map) {
    const out = [];
    // The six real buckets first, in the template's own row order, so a missing bucket
    // reads as a zero rather than as an absent key.
    for (const label of RANGO_LABELS) out.push({ rango: label, filas: map.get(label) || 0 });
    const extra = [];
    for (const [label, filas] of map) {
        if (!RANGO_LABELS.includes(label)) extra.push({ rango: label, filas });
    }
    extra.sort((a, b) => compareText(a.rango, b.rango));
    return out.concat(extra);
}

/**
 * The `Dos Subcontratas por Mes` population (03 §8.2), which must include the
 * `Trabajador = 3` cases the pivot hides - it only makes item `2` visible.
 *
 * Prefers `stats.crossSubcontratista` (dedupe.js already computed it, and it survives a
 * `scope: "all"` collapse that removed the extra rows from `records`); falls back to
 * deriving it from the records when the caller did not pass it.
 */
function buildCrossSubcontratista(stats, records, census, nameKeys) {
    const fromStats = Array.isArray(stats.crossSubcontratista) ? stats.crossSubcontratista : null;
    if (fromStats) {
        const porCopias = new Map();
        let filas = 0;
        for (const g of fromStats) {
            const copies = num(g && g.copies) || 0;
            filas += copies;
            increment(porCopias, copies, 1);
        }
        return {
            fuente: "dedupe",
            grupos: fromStats.length,
            filas,
            porCopias: tally(porCopias, "copias", "grupos").sort((a, b) => compareNumber(a.copias, b.copias)),
        };
    }

    // Derived: group the records by name key and count the distinct subcontratistas.
    const bySubs = new Map();
    for (let i = 0; i < records.length; i++) {
        const key = nameKeys[i];
        if (key === "") continue;
        if ((census.counts.get(key) || 1) < 2) continue;
        if (!bySubs.has(key)) bySubs.set(key, { copies: 0, subs: new Set() });
        const g = bySubs.get(key);
        g.copies += 1;
        const s = sourceOf(records[i]).subcontratista;
        if (s !== null) g.subs.add(s);
    }
    const porCopias = new Map();
    let grupos = 0;
    let filas = 0;
    for (const g of bySubs.values()) {
        if (g.subs.size < 2) continue;
        grupos += 1;
        filas += g.copies;
        increment(porCopias, g.copies, 1);
    }
    return {
        fuente: "registros",
        grupos,
        filas,
        porCopias: tally(porCopias, "copias", "grupos").sort((a, b) => compareNumber(a.copias, b.copias)),
    };
}

function severityCounts(items) {
    const out = {};
    for (const s of SEVERITY_ORDER) out[s] = 0;
    for (const i of items) {
        if (i && Object.prototype.hasOwnProperty.call(out, i.severity)) out[i.severity] += 1;
    }
    return out;
}

/** Sorted by code, not by count: a count-ordered object reorders itself between runs and
 *  makes the `diff` of AC 26 unreadable. */
function codeCounts(items) {
    const m = new Map();
    for (const i of items) {
        if (!i || typeof i.code !== "string") continue;
        increment(m, i.code, 1);
    }
    const keys = [...m.keys()].sort(compareText);
    const out = {};
    for (const k of keys) out[k] = m.get(k);
    return out;
}

/** Every FAILED issue, named. Never zero-suppressed: a subcontratista whose workbook could
 *  not be read must never be a silent omission that looks like "no workers this month"
 *  (03 §8, 05 §1 principle 4). */
function buildFallos(items) {
    return items
        .filter(i => i && i.severity === SEVERITY.FAILED)
        .map(i => ({
            subcontratista: i.subcontratista ?? null,
            archivo: i.archivo ?? null,
            hoja: i.hoja ?? null,
            codigo: i.code ?? null,
            motivo: i.message ?? null,
        }))
        .sort((a, b) => compareText(a.subcontratista, b.subcontratista)
            || compareText(a.archivo, b.archivo)
            || compareText(a.codigo, b.codigo)
            || compareText(a.motivo, b.motivo));
}

/** Reading order, most alarming first, so a truncation can only ever drop INFO lines. */
const DISPLAY_SEVERITY_ORDER = Object.freeze([
    SEVERITY.FAILED, SEVERITY.ERROR, SEVERITY.WARNING, SEVERITY.INFO,
]);
const SEVERITY_RANK = new Map(DISPLAY_SEVERITY_ORDER.map((s, i) => [s, i]));

function buildIncidencias(items, max) {
    const decorated = items.map((i, index) => ({ i, index }));
    decorated.sort((a, b) => {
        const ra = SEVERITY_RANK.has(a.i.severity) ? SEVERITY_RANK.get(a.i.severity) : DISPLAY_SEVERITY_ORDER.length;
        const rb = SEVERITY_RANK.has(b.i.severity) ? SEVERITY_RANK.get(b.i.severity) : DISPLAY_SEVERITY_ORDER.length;
        return ra - rb
            || compareText(a.i.subcontratista, b.i.subcontratista)
            || compareText(a.i.archivo, b.i.archivo)
            || compareNumber(a.i.fila, b.i.fila)
            || compareText(a.i.celda, b.i.celda)
            || compareText(a.i.code, b.i.code)
            // Arrival index is the final, always-total tiebreak: two otherwise identical
            // issues must not swap places between runs.
            || (a.index - b.index);
    });
    return decorated.slice(0, max).map(({ i }) => ({
        severidad: i.severity ?? null,
        codigo: i.code ?? null,
        subcontratista: i.subcontratista ?? null,
        archivo: i.archivo ?? null,
        hoja: i.hoja ?? null,
        fila: i.fila ?? null,
        celda: i.celda ?? null,
        columna: i.columna ?? null,
        valor: i.valor === undefined ? null : i.valor,
        motivo: i.message ?? null,
    }));
}

/**
 * The row arithmetic, so the side-car reconciles on its own
 * (05 Phase 3 verification: "the side-car JSON present and internally reconciling").
 *
 * `escritas` is NOT derived from the other three - deriving it would make the conservation
 * check tautological, which is `runReport.js`'s rule and the same one applies here. It
 * comes from the records this module was handed, which is the array that is about to be
 * written.
 */
function buildProceso(stats, items, filasEscritas) {
    // `stats.dedupe` may be dedupe()'s whole return or just its `.stats` - both shapes are
    // accepted, exactly as runReport.js accepts them, so run.js passes one object to both.
    const dedupeStats = stats.dedupe && typeof stats.dedupe === "object"
        ? (stats.dedupe.stats && typeof stats.dedupe.stats === "object" ? stats.dedupe.stats : stats.dedupe)
        : null;

    // `read` goes to conservationCheck verbatim: it already accepts a total, an array of
    // numbers, or an array of per-workbook descriptors, which is what "Σ(rows read per
    // workbook)" means in 05 Phase 3 task 8.
    const read = stats.read !== undefined && stats.read !== null
        ? stats.read
        : (stats.leidas !== undefined && stats.leidas !== null
            ? stats.leidas
            : (dedupeStats && Number.isInteger(dedupeStats.rowsIn) ? dedupeStats.rowsIn : undefined));
    const rejected = firstNum(stats.rechazadas, stats.rejected);
    const collapsed = stats.collapsed !== undefined && stats.collapsed !== null
        ? stats.collapsed
        : (stats.colapsadas !== undefined && stats.colapsadas !== null
            ? stats.colapsadas
            : (dedupeStats && Number.isInteger(dedupeStats.rowsCollapsed) ? dedupeStats.rowsCollapsed : undefined));

    const conservacion = conservationCheck({
        read,
        rejected: rejected === null ? undefined : rejected,
        collapsed,
        written: filasEscritas,
    });

    return {
        filas: {
            leidas: conservacion.detail.read,
            // Reported as supplied, NOT as conservationCheck defaults it: that function
            // treats a missing `rejected` as 0 so the two-term form still works, and a
            // side-car that printed 0 for "nobody told us" would look like a clean run.
            rechazadas: rejected,
            colapsadas: conservacion.detail.collapsed,
            escritas: filasEscritas,
        },
        conservacion: {
            ok: conservacion.ok,
            esperadas: conservacion.expected,
            escritas: conservacion.actual,
            motivo: conservacion.detail.motivo,
            // "NO VERIFICABLE" rather than a silent pass: a term the caller never supplied
            // is not the same thing as arithmetic that closed.
            verificable: conservacion.expected !== null,
        },
        incidencias: items.length,
    };
}

function firstNum(...values) {
    for (const v of values) {
        const x = num(v);
        if (x !== null) return x;
    }
    return null;
}

function sumOfMap(map) {
    let n = 0;
    for (const v of map.values()) n += v;
    return n;
}

/**
 * Where each metric lands in the workbook, measured on `src/template.xlsx`. This is what
 * turns "the side-car and the workbook disagree" from an argument into a cell reference,
 * and it is what the parallel-run diff (05 §4.4) reads to know which cells to compare.
 * The cell addresses are FEBRERO_2026's - the template's own pivots sit a few rows higher
 * because they have fewer items - so `hoja` + `pivote` are the stable part.
 */
const ORIGEN = Object.freeze({
    headcount: Object.freeze({ hoja: "Cuadro", columna: "AC", medida: "Trabajadores Unicos" }),
    porZonaGenero: Object.freeze({ hoja: "Reporte Social - RRHH", pivote: "pivotTable1", celdaTotal: "F15" }),
    altas: Object.freeze({ hoja: "Reporte Social - RRHH", pivote: "pivotTable7", celdaTotal: "F60" }),
    bajas: Object.freeze({ hoja: "Reporte Social - RRHH", pivote: "pivotTable4", celdaTotal: "F46" }),
    cjvEpc: Object.freeze({ hoja: "CJ Y EPC", pivote: "pivotTable8", celdaTotal: "C9" }),
    horas: Object.freeze({ hoja: "CJ Y EPC", pivote: "pivotTable8", celdaTotal: "D9" }),
    contratistas: Object.freeze({ hoja: "Contratistas", pivote: "pivotTable9", celdaTotal: "C91" }),
    excepciones: Object.freeze({ hoja: "Errores", pivote: null, celdaTotal: null }),
});

/**
 * One record's five Option-D literals: taken from `options.computed[i]` when the caller
 * already built them (so `output/template.js` and this module cannot disagree about what
 * is in column AI), otherwise computed here.
 */
function resolveComputedRow(record, i, period, lookups, opts) {
    if (Array.isArray(opts.computed) && opts.computed[i]) return opts.computed[i];
    const unparseable = Array.isArray(opts.unparseableDates) ? opts.unparseableDates[i] : undefined;
    return computeRow(record, period, lookups, { unparseableDates: unparseable });
}

/* ------------------------------------------------------------------ *
 * Serialization
 * ------------------------------------------------------------------ */

/**
 * The bytes the caller writes to `reportes/<period.filenameBase>.json`.
 *
 * Two spaces and a trailing newline, so the artifact is `diff`-able by eye and by CI -
 * which is the whole point of AC 26. `JSON.stringify` is deterministic for a plain object
 * (insertion order), and every map above is emitted through a sorted array, so two runs
 * over the same records produce byte-identical output.
 */
function serialize(metrics) {
    return JSON.stringify(metrics, null, 2) + "\n";
}

/** `Reporte_Subcontratistas_<MES>_<ANIO>.json`, from the period and nothing else - the
 *  same stem as the workbook, so name and content cannot disagree (03 §7.5). */
function metricsFilename(period) {
    return `${resolvePeriod(period).filenameBase}.json`;
}

module.exports = {
    computeMetrics,
    serialize,
    metricsFilename,

    // Shared definitions and the pure helpers, exported for the tests and for anything
    // that needs one aggregate without the whole structure.
    VERSION,
    METRIC_NAMES,
    ORIGEN,
    MAX_INCIDENCIAS,
    ESTADO_ACTIVO,
    EPC_VALUES,
    trabajadoresUnicos,
    trabajadoresUnicosZona,
    periodFlag,
    inZone,
};

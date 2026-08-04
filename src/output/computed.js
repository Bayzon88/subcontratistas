"use strict";
/**
 * The five JS-computed columns of `Tabla2` - Option D
 * (05-implementation-plan.md §5 and Phase 4 task 3; 03-expected-output.md §5, §6).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Twelve of the seventeen computed columns are VLOOKUP/COUNTIF/SUMPRODUCT over data that
 * cannot change after the file is written, so they stay Excel formulas and the business
 * keeps owning `Hoja1`'s lookup tables. The other five are anchored on the wall clock -
 * `TODAY()` in V and W, `TODAY()-30` in AH and AI, and AG derives from those two - so
 * every number they feed mutates every time the workbook is opened (BUG-15, BUG-16;
 * 02-shortcomings.md §BUG-15 "Reopen FEBRERO_2026 today and Total Ingresos collapses to
 * 0"). Those five are computed here, in JS, against an EXPLICIT period, and written into
 * the sheet as literal values.
 *
 * Nothing in this file reads a clock. There is no `new Date()`, no `Date.now()`, no
 * `TODAY()`. `period` is a required argument and a missing one throws, because that is a
 * wiring bug in the caller, not a defect in a subcontratista's workbook.
 *
 * THE LITERAL STRINGS ARE THE CONTRACT
 * ------------------------------------
 * Every string this module emits was read out of `src/template.xlsx` ->
 * `xl/tables/table1.xml` `<calculatedColumnFormula>` and cross-checked against the shared
 * items actually present in `xl/pivotCache/pivotCacheDefinition1.xml`:
 *
 *   Edad          <s v="Corregir"/> plus numeric items
 *   Rango Edades  "18 - 23" "24 - 31" "32 - 40" "41 - 49" "50 - 58" "59 +"
 *   BajasAntiguas "No" "Si"
 *   Bajas2        "No Aplica" "Borrar" "<M>-<YYYY>"
 *   Altas         "No Aplica" "<M>-<YYYY>"
 *
 * Six of the thirteen pivots page-filter on `BajasAntiguas`, two on `Altas` and one on
 * `Bajas2`, matching those literals exactly. A one-character difference does not fail; it
 * silently empties a pivot row on the client-facing page. Hence: one definition, exported,
 * shared by metrics.js, template.js and the tests.
 *
 * WHAT DELIBERATELY CHANGES vs THE TEMPLATE
 * -----------------------------------------
 * 1. `Sin Fecha` (V, W) where the birth date is absent. The template does the arithmetic
 *    unwrapped, so a text date became `#VALUE!` and `#VALUE!` became its own row label on
 *    the front page - 36 workers at `FEBRERO_2026!'Reporte Social - RRHH'!C29`
 *    (BUG-07; acceptance criterion 17 asks for exactly this named bucket).
 * 2. `Revisar` (AH, AI) where the source cell held something that could not be read as a
 *    date. The template wraps both in `IFERROR(..., "No Aplica")`, which reclassified
 *    ~200 text-date rows as "did not join / did not leave" with nothing on the deliverable
 *    hinting at it (BUG-08, CRITICAL). `Revisar` is the state named in
 *    03-expected-output.md §6.4. It only appears when the caller passes the signal - see
 *    `unparseableDatesFromIssues`.
 * 3. Whole-year date arithmetic instead of `(TODAY()-fnac)/365`. The /365 form drifts by a
 *    day per leap year and can move a worker across a `Rango Edades` boundary.
 * 4. `Corregir` propagates from V into W. The template's W has no <18/>80 guard at all, so
 *    a 16-year-old falls through all six nested ANDs into the final `else` and is reported
 *    as `"59 +"` on the age-distribution table. See RANGO_EDADES below.
 */

const { CANONICAL } = require("../pipeline/columns");
const { serialToYMD } = require("../pipeline/dates");
const { containsSerial } = require("../pipeline/period");
const { CODE } = require("../pipeline/issues");

/* ------------------------------------------------------------------ *
 * Column identity
 * ------------------------------------------------------------------ */

/** Source columns, by canonical name. Asserted against columns.js below so a rename
 *  there is a load-time error rather than five columns of `Sin Fecha` in production. */
const COL_NACIMIENTO = "FECHA NACIMIENTO";
const COL_CESE = "FECHA CESE/BAJA";
const COL_INICIO = "FECHA INICIO DE LABORES EN OBRA";

for (const name of [COL_NACIMIENTO, COL_CESE, COL_INICIO]) {
    if (!CANONICAL.includes(name)) {
        throw new Error(`output/computed.js: "${name}" is not a canonical column - columns.js drifted`);
    }
}

/**
 * The five columns this module owns, in sheet order, with the position each occupies in
 * `Tabla2`. `index0` is the 0-based sheet column; `tableColumnId` is the `id` attribute of
 * the matching `<tableColumn>` in `xl/tables/table1.xml`, which is what the pivot cache's
 * field mapping keys on and which must survive the `<calculatedColumnFormula>` deletion
 * (05 Phase 4 task 3). Exported so template.js writes by NAME rather than by key order
 * (BUG-13) and ooxml.js strips exactly these five formulas.
 */
const COMPUTED_COLUMNS = Object.freeze([
    Object.freeze({ name: "Edad", letter: "V", index0: 21, tableColumnId: 25 }),
    Object.freeze({ name: "Rango Edades", letter: "W", index0: 22, tableColumnId: 23 }),
    Object.freeze({ name: "BajasAntiguas", letter: "AG", index0: 32, tableColumnId: 34 }),
    Object.freeze({ name: "Bajas2", letter: "AH", index0: 33, tableColumnId: 28 }),
    Object.freeze({ name: "Altas", letter: "AI", index0: 34, tableColumnId: 29 }),
]);

/** Just the names, in the same order. */
const COMPUTED_COLUMN_NAMES = Object.freeze(COMPUTED_COLUMNS.map(c => c.name));

/* ------------------------------------------------------------------ *
 * The literals
 * ------------------------------------------------------------------ */

/**
 * Every string these five columns can emit. Verbatim from the template, casing included.
 *
 * `NO_APLICA` is "No Aplica" with a capital A. The template's `Bajas2` carries a SECOND
 * casing in its outer wrapper - `IFERROR(..., "No aplica")` - which is unreachable here
 * because a literal value cannot raise an Excel error, and which never fired in the
 * shipped data either: the pivot cache holds `"No Aplica"` and no lowercase variant. It is
 * NOT reproduced, deliberately - two casings are two pivot items.
 */
const LITERALS = Object.freeze({
    /** V, X: the <18 / >80 guard. `Validar Edad` in template-v2 is
     *  `+IF([Edad]="Corregir","Corregir","Ok")`, so column X depends on this exact string. */
    CORREGIR: "Corregir",
    /** V, W: birth date absent or unusable. Replaces the `#VALUE!` bucket of BUG-07. */
    SIN_FECHA: "Sin Fecha",
    /** AH, AI: nothing happened in this period. */
    NO_APLICA: "No Aplica",
    /** AH only: ceased, but in some other period. `Detalle Cesados` filters on it today. */
    BORRAR: "Borrar",
    /** AH, AI: the cell held something, and it was not a date (BUG-08). New state,
     *  03-expected-output.md §6.4. */
    REVISAR: "Revisar",
    /** AG. */
    SI: "Si",
    NO: "No",
});

/**
 * `Rango Edades`, verbatim from the template's own nested formula. The boundaries are
 * `>=18 <24`, `>=24 <32`, `>=32 <41`, `>=41 <50`, `>=50 <59`, else - so the labels and the
 * ranges agree, and the last bucket is an unconditional else.
 *
 * `max: Infinity` on "59 +" mirrors that else. It is only ever reached by ages 59..80,
 * because anything above 80 is `Corregir` and anything above the plausibility window never
 * arrives with a serial at all (dates.js `plausibleRange`, config.MAX_AGE_YEARS = 80).
 */
const RANGO_EDADES = Object.freeze([
    Object.freeze({ label: "18 - 23", min: 18, max: 23 }),
    Object.freeze({ label: "24 - 31", min: 24, max: 31 }),
    Object.freeze({ label: "32 - 40", min: 32, max: 40 }),
    Object.freeze({ label: "41 - 49", min: 41, max: 49 }),
    Object.freeze({ label: "50 - 58", min: 50, max: 58 }),
    Object.freeze({ label: "59 +", min: 59, max: Infinity }),
]);

/** The six bucket labels, in pivot row order. */
const RANGO_LABELS = Object.freeze(RANGO_EDADES.map(b => b.label));

/**
 * The `Edad` guard, inclusive: `<18` and `>80` both yield `Corregir` in the template.
 * Whole years, so 80 passes and 81 does not - the float form `(days/365)>80` fires a few
 * days earlier, which is one of the reasons the /365 arithmetic is gone.
 */
const EDAD_MIN = 18;
const EDAD_MAX = 80;

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Excel's `=` on text is CASE-INSENSITIVE; JavaScript's `===` is not.
 *
 * This is not a detail. `BajasAntiguas` is `IF(AND([Bajas2]="borrar",...))` - lowercase -
 * while `Bajas2` emits `"Borrar"`. Excel matches them; a naive `===` port does not, and
 * every `BajasAntiguas` silently becomes `"No"`, which puts every stale carry-over worker
 * back into every headcount pivot (all six of them filter `BajasAntiguas = "No"`).
 */
function excelTextEquals(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return a === b;
    return a.toLowerCase() === b.toLowerCase();
}

/** A usable Excel date serial: a finite integer. `null` (empty cell) is not one. */
function isSerial(v) {
    return Number.isInteger(v) && Number.isFinite(v);
}

/**
 * The period must be an explicit, complete descriptor. A caller that forgot it is a wiring
 * bug and must not silently produce a workbook classified against nothing - so this
 * throws, exactly as period.js throws on a malformed `--period` (05 §8 Q5).
 */
function requirePeriod(period) {
    if (!period || typeof period !== "object"
        || !Number.isFinite(period.inicioSerial)
        || !Number.isFinite(period.finSerial)
        || typeof period.etiqueta !== "string" || period.etiqueta === "") {
        throw new TypeError(
            "output/computed.js: se requiere un periodo explicito de period.parsePeriod(\"YYYY-MM\") " +
            "con inicioSerial, finSerial y etiqueta"
        );
    }
    return period;
}

/**
 * Normalize the "this cell held something unusable" signal into a lookup.
 * Accepts a Set, an array, or a plain object keyed by canonical column name.
 */
function asUnparseableSet(input) {
    if (!input) return null;
    if (input instanceof Set) return input;
    if (Array.isArray(input)) return new Set(input);
    if (typeof input === "object") {
        return new Set(Object.keys(input).filter(k => input[k]));
    }
    return null;
}

/**
 * Build that signal from the per-row issues `schema.parseRow` returns.
 *
 * The record cannot carry it: dates.js nulls an unreadable cell, so an empty cese and a
 * cese reading `"ACTIVO"` are both `null` by the time they reach here. Only the issue
 * stream still knows the difference, and keeping that difference is the whole point of
 * BUG-08 - "did not leave" and "we could not read the leaving date" are opposite facts.
 *
 * `DATE_IMPLAUSIBLE` counts as unusable: dates.js parses it, reports it, and returns
 * `ok:false` with a null serial, so the cell is just as unwritable as an unparseable one.
 *
 * @param {Array|{items:Array}} issues  parseRow().issues, or an IssueList
 * @returns {Set<string>} canonical column names
 */
function unparseableDatesFromIssues(issues) {
    const items = Array.isArray(issues) ? issues : (issues && Array.isArray(issues.items) ? issues.items : []);
    const out = new Set();
    for (const i of items) {
        if (!i || (i.code !== CODE.DATE_UNPARSEABLE && i.code !== CODE.DATE_IMPLAUSIBLE)) continue;
        if (typeof i.columna === "string" && i.columna) out.add(i.columna);
    }
    return out;
}

/* ------------------------------------------------------------------ *
 * V - Edad
 * ------------------------------------------------------------------ */

/**
 * Completed years between two dates - `DATEDIF(start, end, "Y")`.
 *
 * Whole-year arithmetic on the calendar components, NOT `(end-start)/365`. The division
 * form gains a day every leap year, so a worker born 1994-03-01 reads 31.7 or 32.0
 * depending on how many 29 Februaries fall in the interval, and `ROUNDDOWN` turns that
 * into a bucket change with no data change.
 *
 * @returns {number|null} null when either side is not representable
 */
function completedYears(startSerial, endSerial) {
    const a = serialToYMD(startSerial);
    const b = serialToYMD(endSerial);
    if (!a || !b) return null;
    let years = b.y - a.y;
    // The birthday has not come round yet in the end year.
    if (b.m < a.m || (b.m === a.m && b.d < a.d)) years -= 1;
    return years;
}

/**
 * Age at the LAST DAY OF THE PERIOD - never at "today".
 *
 * @param {number|null} nacimientoSerial
 * @param {object} period  from period.parsePeriod
 * @returns {number|null} completed years, or null when there is no usable birth date
 */
function edadAlCierre(nacimientoSerial, period) {
    requirePeriod(period);
    if (!isSerial(nacimientoSerial)) return null;
    return completedYears(nacimientoSerial, period.finSerial);
}

/**
 * Column V. Template:
 *   IF(((TODAY()-[FECHA NACIMIENTO])/365)<18,"Corregir",
 *     IF(((TODAY()-[FECHA NACIMIENTO])/365)>80,"Corregir",
 *        ROUNDDOWN(((TODAY()-[FECHA NACIMIENTO])/365),0)))
 *
 * Same two guards, same `"Corregir"` literal - `Validar Edad` (X) reads
 * `+IF([Edad]="Corregir","Corregir","Ok")` and depends on it - with `TODAY()` replaced by
 * the period end and `/365` replaced by completed years.
 *
 * A missing or unusable birth date yields `"Sin Fecha"` rather than `#VALUE!` (BUG-07,
 * criterion 17) and never a number, so nothing downstream can average it by accident.
 *
 * @returns {number|"Corregir"|"Sin Fecha"}
 */
function computeEdad(nacimientoSerial, period) {
    const edad = edadAlCierre(nacimientoSerial, period);
    if (edad === null) return LITERALS.SIN_FECHA;
    if (edad < EDAD_MIN || edad > EDAD_MAX) return LITERALS.CORREGIR;
    return edad;
}

/* ------------------------------------------------------------------ *
 * W - Rango Edades
 * ------------------------------------------------------------------ */

/**
 * Column W, derived from V rather than recomputing the age six more times (the template
 * evaluates `TODAY()` twelve times per row here, 8,823 rows).
 *
 * Three-way, because V is three-way:
 *   number    -> its bucket
 *   "Sin Fecha" -> "Sin Fecha"   (03 §5: "'Sin Fecha' where the age is unknown")
 *   "Corregir"  -> "Corregir"
 *
 * The last line is a deliberate divergence. The template's W carries NO <18/>80 guard, so
 * an under-18 fails all six `AND`s and lands in the unconditional else - a 16-year-old is
 * printed as `"59 +"` on the client-facing age distribution. Ages 16 and 17 do reach here
 * (config.MIN_AGE_YEARS = 16 lets them through plausibility, and flagging them is the
 * point of the guard), so they get their own row instead of being hidden inside the oldest
 * bucket. Cost: the `Rango Edades` pivot at `'Reporte Social - RRHH'!C21:F30` can show up
 * to 8 item rows instead of 7. It has six blank rows of slack before the next pivot at
 * C37, so it cannot collide - but anything that changes that layout must re-check it.
 *
 * @param {number|string} edad  the value computeEdad returned
 * @returns {string} one of RANGO_LABELS, "Sin Fecha" or "Corregir"
 */
function computeRangoEdades(edad) {
    if (typeof edad === "string") {
        // Pass the two non-numeric states straight through; never guess a bucket for them.
        return edad === LITERALS.CORREGIR ? LITERALS.CORREGIR : LITERALS.SIN_FECHA;
    }
    if (!Number.isFinite(edad)) return LITERALS.SIN_FECHA;   // no NaN reaches a cell, ever
    for (const bucket of RANGO_EDADES) {
        if (edad >= bucket.min && edad <= bucket.max) return bucket.label;
    }
    // Unreachable while computeEdad guards [18, 80]: below 18 it returns "Corregir", and
    // the final bucket is open-ended upward. Kept so a future guard change cannot emit
    // `undefined` into a pivot row label.
    return LITERALS.SIN_FECHA;
}

/* ------------------------------------------------------------------ *
 * AI - Altas   and   AH - Bajas2
 * ------------------------------------------------------------------ */

/**
 * The shared shape of both period classifiers.
 *
 * Template (AI shown; AH is identical but for its `outside` branch):
 *   +IFERROR(IF([FECHA INICIO DE LABORES EN OBRA]="","No Aplica",
 *      IF(AND(MONTH(d)=MONTH(TODAY()-30),YEAR(d)=YEAR(TODAY()-30)),
 *         MONTH(TODAY()-30)&"-"&YEAR(TODAY()-30),"No Aplica")),"No Aplica")
 *
 * `TODAY()-30` becomes `[period.inicioSerial, period.finSerial]` and the emitted label
 * becomes `period.etiqueta`, which is built as `<M>-<YYYY>` - same shape as the template's
 * `MONTH()&"-"&YEAR()`, unpadded ("2-2026", not "02-2026"). Two pivot page filters carry
 * that literal.
 *
 * Month+year equality and an inclusive `[inicio, fin]` range test agree exactly, since the
 * period is always a whole calendar month; the range form is used because it reads as one
 * comparison and cannot disagree with `period.etiqueta`.
 */
function classifyAgainstPeriod(serial, period, outsideLiteral, unusable) {
    requirePeriod(period);
    // Genuinely empty: the worker did not join / has not left. This is the common case -
    // 3,802 of 5,065 rows have no cese.
    if (serial === null || serial === undefined || serial === "") {
        // ...unless the cell DID hold something we could not read. The template's IFERROR
        // folded that into "nothing happened" (BUG-08, CRITICAL): it understates
        // Total Ingresos and keeps departed workers on the active headcount forever, with
        // nothing on the deliverable hinting at it. Make it visible instead.
        return unusable ? LITERALS.REVISAR : LITERALS.NO_APLICA;
    }
    if (!isSerial(serial)) return LITERALS.REVISAR;   // a non-empty non-date reached us
    return containsSerial(period, serial) ? period.etiqueta : outsideLiteral;
}

/**
 * Column AI. Two-state plus the new `Revisar`:
 *   no start date            -> "No Aplica"
 *   start inside the period  -> period.etiqueta
 *   start outside the period -> "No Aplica"   (the template's else branch)
 *   start unreadable         -> "Revisar"
 */
function computeAltas(inicioSerial, period, options = {}) {
    return classifyAgainstPeriod(inicioSerial, period, LITERALS.NO_APLICA, Boolean(options.unusable));
}

/**
 * Column AH. Three-state plus `Revisar`. Note the else branch is `"Borrar"`, NOT
 * `"No Aplica"` - that is the only structural difference from AI, and `Detalle Cesados`
 * (pivotTable2) filters on these literal strings:
 *   no cese                 -> "No Aplica"   (still employed)
 *   cese inside the period  -> period.etiqueta
 *   cese outside the period -> "Borrar"
 *   cese unreadable         -> "Revisar"
 */
function computeBajas2(ceseSerial, period, options = {}) {
    return classifyAgainstPeriod(ceseSerial, period, LITERALS.BORRAR, Boolean(options.unusable));
}

/* ------------------------------------------------------------------ *
 * AG - BajasAntiguas
 * ------------------------------------------------------------------ */

/**
 * Column AG, verbatim: `IF(AND([Bajas2]="borrar",[Altas]="No Aplica"),"Si","No")`.
 *
 * Derives purely from AH and AI - no dates, no period. The template writes `"borrar"` in
 * lowercase while AH emits `"Borrar"`; see `excelTextEquals` for why that matters more
 * than it looks.
 *
 * `Bajas2 = "Revisar"` therefore yields `"No"`, i.e. the worker stays in the headcount.
 * That is the literal contract and it is the right call: an unreadable cese date is not
 * evidence of departure. It is no longer invisible either - AH says `Revisar` and the
 * Errores sheet names the cell.
 */
function computeBajasAntiguas(bajas2, altas) {
    const stale = excelTextEquals(bajas2, LITERALS.BORRAR) && excelTextEquals(altas, LITERALS.NO_APLICA);
    return stale ? LITERALS.SI : LITERALS.NO;
}

/* ------------------------------------------------------------------ *
 * The row
 * ------------------------------------------------------------------ */

/**
 * All five values for one consolidated record.
 *
 * @param {object} record   a `schema.parseRow` record: date columns are integer Excel
 *                          serials or null, keyed by canonical name.
 * @param {object} period   `period.parsePeriod("YYYY-MM")`. Required. No clock is read.
 * @param {object} [lookups] `lookups.readLookups(template)`. Accepted for call-site
 *                          uniformity with the other output modules and deliberately
 *                          unused: none of these five columns consults `Hoja1`. The
 *                          district and EPC tables belong to the twelve Excel formulas,
 *                          which is where the business can keep editing them (05 §5).
 * @param {object} [options]
 * @param {Set|Array|object} [options.unparseableDates] canonical column names whose source
 *                          cell was NOT empty but could not be read as a date. Build it
 *                          with `unparseableDatesFromIssues(parseRow().issues)`. Omit it
 *                          and an unreadable date is indistinguishable from an empty one,
 *                          which is precisely the BUG-08 behaviour - so callers on the
 *                          real pipeline should always pass it.
 * @returns {Readonly<{ "Edad": number|string, "Rango Edades": string,
 *                      "BajasAntiguas": string, "Bajas2": string, "Altas": string }>}
 *          keyed by the `<tableColumn name=...>` values in table1.xml, so template.js can
 *          place them by name.
 */
function computeRow(record, period, lookups, options = {}) {
    requirePeriod(period);
    const row = record || {};
    const unusable = asUnparseableSet(options.unparseableDates);

    const edad = computeEdad(row[COL_NACIMIENTO], period);
    const rango = computeRangoEdades(edad);
    const altas = computeAltas(row[COL_INICIO], period, {
        unusable: unusable ? unusable.has(COL_INICIO) : false,
    });
    const bajas2 = computeBajas2(row[COL_CESE], period, {
        unusable: unusable ? unusable.has(COL_CESE) : false,
    });
    const bajasAntiguas = computeBajasAntiguas(bajas2, altas);

    return Object.freeze({
        "Edad": edad,
        "Rango Edades": rango,
        "BajasAntiguas": bajasAntiguas,
        "Bajas2": bajas2,
        "Altas": altas,
    });
}

module.exports = {
    // the API
    computeRow,
    computeEdad,
    computeRangoEdades,
    computeAltas,
    computeBajas2,
    computeBajasAntiguas,
    edadAlCierre,
    completedYears,
    unparseableDatesFromIssues,
    excelTextEquals,

    // the shared definitions - metrics.js, template.js, ooxml.js and the tests all read
    // these rather than repeating a string literal that a pivot filter depends on
    COMPUTED_COLUMNS,
    COMPUTED_COLUMN_NAMES,
    LITERALS,
    RANGO_EDADES,
    RANGO_LABELS,
    EDAD_MIN,
    EDAD_MAX,
    COL_NACIMIENTO,
    COL_CESE,
    COL_INICIO,
};

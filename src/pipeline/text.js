"use strict";
/**
 * Text normalization for the free-text columns (03-expected-output.md §2.1,
 * 05-implementation-plan.md Phase 2 task 7). The whole module is one rule:
 *
 *     strip literal OOXML whitespace escapes -> collapse every whitespace run to a
 *     single space -> trim -> optionally uppercase
 *
 * Pure: no I/O, no clock, no locale. `toUpperCase()` is used deliberately instead of
 * `toLocaleUpperCase()` so the result never depends on the process locale (the Turkish
 * dotless-i rule would otherwise turn "MINICARGADOR" input into a locale-dependent
 * output on a tr-TR box).
 *
 * Measured payoff, all of it in `src/ReporteConsolidado.xlsx` and `src/template.xlsx`:
 *
 *  - CONTRATISTA PRNCIPAL carries 352 distinct spellings for ~84 real companies. The
 *    whitespace-only variants are " CLJ CONTRUCTORA SAC" (leading space),
 *    "_x000d__x000a_MCORP SAC" (escaped CRLF), "BK MODULAR  S.A.C" (doubled internal
 *    space) and "EPOS S.A. -  SUCURSAL DEL PERU". That distinct count drives
 *    Contratistas!C91 = 84, column U's distinct-contratista weight and every pivot
 *    filter list.
 *  - NACIONALIDAD carries 7 spellings of PERUANA/PERUANO across 4 pivot filters;
 *    trim + collapse + uppercase folds them to exactly 2.
 *  - DISTRITO SEGÚN DNI must be whitespace-collapsed because Zona de Influencia (Y) is
 *    VLOOKUP(TRIM(distrito), Hoja1!$A$2:$B$61, 2, FALSE) and Excel's TRIM only strips
 *    LEADING/TRAILING space. "CERCADO DE  LIMA" and "SAN JUAN DE  MIRAFLORES" survive
 *    Excel's TRIM, miss the exact-match lookup, resolve to "No", and the worker drops
 *    out of the zone report while still counting toward headcount (BUG-29).
 *  - APELLIDOS Y NOMBRES is the identity key for dedupe (config.IDENTITY_KEY = "name"),
 *    so "HUARCAYA COCCHE JESUS " and "HUARCAYA COCCHE JESUS" are two people until this
 *    runs (BUG-24).
 *
 * What this module deliberately does NOT do:
 *
 *  - No punctuation stripping. "ACIS PROCESS S.A.C" vs "ACIS PROCESS S.A.C." stays two
 *    values. That residue is a business vocabulary problem and belongs in the Sheet1
 *    lookup table the business already owns (§2.1), not in code.
 *  - No accent folding on data. Only HEADERS are accent-folded, by columns.normalizeHeader().
 *    BREÑA is a real district and MIRELLES LOBATÓN is a real surname; folding them here
 *    would corrupt the compliance artefact.
 *  - No uppercasing of DISTRITO / EMPRESA / CONTRATISTA PRNCIPAL. Looks like an omission,
 *    is not: UPPERCASE_COLUMNS in columns.js is the contract, Excel's VLOOKUP and pivot
 *    grouping are both case-insensitive, and "El agustino" is what the subcontratista
 *    actually wrote.
 *  - No gender-folding of NACIONALIDAD (PERUANO -> PERUANA). Business decision, §2.1.
 */

const { TEXT_COLUMNS, UPPERCASE_COLUMNS } = require("./columns");

/**
 * Literal OOXML control-character escapes that leaked into the cell text.
 *
 * Excel encodes a C0 control inside a shared string as `_x000D_`; when a producer
 * double-escapes, or when a value is read out of a pivot cache definition, the escape
 * arrives as the literal 7 characters and SheetJS hands it back verbatim. Measured in
 * `src/template.xlsx!xl/pivotCache/pivotCacheDefinition*.xml`:
 *   "_x000d__x000a_MCORP SAC"
 *   "GM Y M GENERAL SOLUTIONS_x000d__x000a_AND CONSULTING S.A.C"
 *   "BARTOLO_x000d__x000a_DE LA_x000d__x000a_CRUZ _x000d__x000a_BRIAN"
 *   "_x0009_CAPATAZ"
 *
 * Only the five C0 WHITESPACE controls (09 TAB, 0A LF, 0B VT, 0C FF, 0D CR) are
 * recognised. A blanket /_x[0-9a-f]{4}_/ would eat "_x0041_" out of a legitimate
 * company name, and every escape it could remove that this one cannot is a control
 * character that has no business being in the value anyway.
 */
const OOXML_WHITESPACE_ESCAPE = /_x000[9abcd]_/gi;

/**
 * Any run of whitespace, replaced by exactly one space.
 *
 * JavaScript's \s already covers U+00A0 NBSP and U+FEFF BOM, which matters: NBSP is
 * measured 48x in APELLIDOS Y NOMBRES, 21x in DOMICILIO DE TRABAJADOR, 7x in
 * TITULO DE PUESTO/CARGO and 3x in DISTRITO SEGÚN DNI of the last real run. NBSP is
 * not the space character, so "OPERARIO ELECTRICISTA" and "OPERARIO ELECTRICISTA"
 * are two separate pivot labels for one job title until this collapse runs.
 */
const WHITESPACE_RUN = /\s+/g;

/** Text columns that are additionally uppercased. */
const UPPERCASE_SET = new Set(UPPERCASE_COLUMNS);

/**
 * Every column this module owns: the free-text columns plus NACIONALIDAD, which is an
 * uppercase column without being a TEXT_COLUMN in columns.js. Order follows columns.js.
 */
const NORMALIZED_COLUMNS = Object.freeze(
    [...new Set([...TEXT_COLUMNS, ...UPPERCASE_COLUMNS])]
);
const NORMALIZED_SET = new Set(NORMALIZED_COLUMNS);

/**
 * Coerce a raw cell value to the text we are going to normalize, or null when there is
 * nothing to normalize. Deterministic on every branch - a Date goes through
 * toISOString(), never through the timezone- and locale-dependent Date#toString().
 *
 * A Date or a number reaching a text column is a misfiling, not a value to repair here;
 * `coerced` on the result tells schema.js it happened.
 */
function toText(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === "string") return raw;
    // NaN and +/-Infinity have no honest text form; they become null, and `coerced`
    // keeps them visible to the caller rather than producing the string "NaN".
    if (typeof raw === "number") return Number.isFinite(raw) ? String(raw) : null;
    if (typeof raw === "bigint" || typeof raw === "boolean") return String(raw);
    if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.toISOString();
    return null;
}

/**
 * Normalize one free-text value.
 *
 * @param {*} raw                       the raw cell value, any type
 * @param {{uppercase?: boolean}} [options]
 * @returns {{value: string|null, changed: boolean, coerced: boolean}}
 *
 *   value    the normalized text, or null when nothing survived (empty, whitespace-only,
 *            or an input with no honest text form). Never undefined, never "".
 *   changed  true when the NORMALIZATION steps altered the text. This is the flag
 *            schema.js raises CODE.TEXT_NORMALIZED on, and the one the run report
 *            groups by to show which collapses happened.
 *   coerced  true when the input was not a string (and not null/undefined). Kept
 *            separate from `changed` on purpose: a numeric EMPRESA cell is a different
 *            defect from a doubled space, and lumping them together would bury the
 *            whitespace evidence that §2.1 exists to surface. `coerced` with a null
 *            `value` means the input had no text form and was dropped - the caller
 *            still holds the raw value and must report it.
 */
function normalizeText(raw, options) {
    const uppercase = options ? options.uppercase === true : false;
    const coerced = raw !== null && raw !== undefined && typeof raw !== "string";
    const text = toText(raw);
    if (text === null) return { value: null, changed: false, coerced };

    // Escapes become a SPACE, not "": "GM Y M GENERAL SOLUTIONS_x000d__x000a_AND
    // CONSULTING S.A.C" must not collapse into "...SOLUTIONSAND CONSULTING...".
    let value = text.replace(OOXML_WHITESPACE_ESCAPE, " ").replace(WHITESPACE_RUN, " ").trim();
    if (uppercase) value = value.toUpperCase();

    if (value === "") return { value: null, changed: text !== "", coerced };
    return { value, changed: value !== text, coerced };
}

/** True when this canonical column is normalized by this module. */
function isNormalizedColumn(canonical) {
    return NORMALIZED_SET.has(canonical);
}

/** True when this canonical column is additionally uppercased. */
function isUppercaseColumn(canonical) {
    return UPPERCASE_SET.has(canonical);
}

/**
 * Column-aware entry point. Applies the rule iff `canonical` is one of the columns this
 * module owns; every other column (RUC, the dates, the coded domains, HPT) belongs to
 * its own module and passes through untouched - except that `undefined` becomes `null`,
 * because the pipeline never emits undefined (05 §1 principle 5).
 *
 * @param {string} canonical  a canonical column name from columns.CANONICAL
 * @param {*} raw
 * @returns {{value: *, changed: boolean, coerced: boolean, applied: boolean}}
 */
function normalizeForColumn(canonical, raw) {
    if (!NORMALIZED_SET.has(canonical)) {
        return {
            value: raw === undefined ? null : raw,
            changed: false,
            coerced: false,
            applied: false,
        };
    }
    const r = normalizeText(raw, { uppercase: UPPERCASE_SET.has(canonical) });
    return { value: r.value, changed: r.changed, coerced: r.coerced, applied: true };
}

module.exports = {
    // The two regexes stay private: both carry /g, so an external .test() would be
    // stateful through lastIndex and would return alternating answers.
    NORMALIZED_COLUMNS,
    normalizeText,
    normalizeForColumn,
    isNormalizedColumn,
    isUppercaseColumn,
};

"use strict";
/**
 * The four closed coded domains: TIPO TRABAJADOR (G), GENERO (L), ESTADO (P) and
 * TIPO DE CONTRATO LABORAL (Q).
 *
 * Replaces the four inconsistent `switch` blocks in excelConsolidation.js:147-253,
 * which between them carry three confirmed defects (02-shortcomings.md):
 *
 *   BUG-18  the GENERO switch lower-cases its scrutinee into a string and then offers
 *           numeric `case 1:` / `case 2:` branches, which `switch`'s strict comparison
 *           can never reach; and the block is unguarded, so a missing cell became
 *           `String(undefined).toLowerCase()` = the literal "undefined" - 10 rows in the
 *           last run, and in OCTUBRE_2025 a third gender column that shifted Total from
 *           F to G and broke the hard-coded `+F53/$F$60` percentage block.
 *   BUG-19  TIPO DE CONTRATO LABORAL switched on the RAW string, so "plazo fijo" and
 *           "PLAZO FIJO " missed every case.
 *   BUG-20  every `default:` was `parseInt(...)`, which writes NaN - or, worse, a
 *           plausible-looking partial parse (ESTADO 184 and 160 are in the last run).
 *
 * The universal rule (03-expected-output.md §4): normalize FIRST, match against a closed
 * table, and never parseInt as a fallback. An unrecognised value yields `null` plus a
 * CODE_OUT_OF_DOMAIN issue carrying the raw value verbatim. NaN must never reach the
 * workbook, and the literal string "undefined" must be impossible by construction.
 *
 * Pure: no I/O, no clock. The per-domain normalizers do not touch the IssueList at all -
 * only the generic `normalizeCode()` entry point records, and only when handed one.
 */

const { CODED_COLUMNS, normalizeHeader } = require("./columns");
const { CODE } = require("./issues");

/**
 * Match key for a coded value: NFD-fold accents, collapse whitespace, trim, casefold.
 *
 * Reuses normalizeHeader's folding so there is exactly one accent/whitespace rule in the
 * codebase, then lower-cases instead of upper-casing: header keys are shouted because
 * headers are, whereas the coded vocabulary is prose ("obrero de construccion civil") and
 * 03 §4 specifies the domain tables in lowercase. Case is irrelevant to the lookup either
 * way; what matters is that "Plazo Fijo ", "PLAZO FIJO" and "plazo fijo" are one key, and
 * that "obrero de construcción civil" folds onto "obrero de construccion civil".
 */
function normalizeCodeKey(value) {
    return normalizeHeader(value).toLowerCase();
}

/**
 * Second-chance key for numeric-looking values: strips leading zeros and a zero-only
 * decimal tail, so "001" and "1.00" reach the same entry as "1" and "01".
 *
 * It can only ever re-query the SAME closed table, so it cannot widen a domain: "0",
 * "184" and "160" still miss, and "0.03" - the locale-decimal artifact parseInt used to
 * turn into 0 - does not match the pattern at all.
 */
const NUMERIC_KEY = /^0*(\d+)(?:[.,]0+)?$/;

/**
 * The domains, verbatim from 03-expected-output.md §4.1-§4.4, merged with every case the
 * original switches knew (excelConsolidation.js:150-252) - losing a synonym silently
 * loses rows, so nothing from the old vocabulary is dropped, including the "PLAZA FIJO"
 * typo and the bare "SI".
 *
 * Exported so the run report and the tests can enumerate the legal vocabulary rather than
 * restate it.
 */
const DOMAINS = Object.freeze({
    "TIPO TRABAJADOR": Object.freeze({
        column: "TIPO TRABAJADOR",
        letter: "G",
        type: "integer",
        entries: Object.freeze([
            { value: 1, label: "EMPLEADO", synonyms: ["1", "01", "empleado", "empleada"] },
            {
                value: 2,
                label: "OBRERO DE CONSTRUCCION CIVIL",
                synonyms: [
                    "2",
                    "02",
                    "obrero de construccion civil",
                    "obrero de construcción civil",
                    "occ",
                ],
            },
            { value: 3, label: "OBRERO", synonyms: ["3", "03", "obrero", "obrera"] },
        ]),
    }),

    ESTADO: Object.freeze({
        column: "ESTADO",
        letter: "P",
        type: "integer",
        entries: Object.freeze([
            {
                value: 1,
                label: "ACTIVO",
                synonyms: ["1", "01", "activo", "activa", "activo en obra", "en obra"],
            },
            { value: 2, label: "CESADO", synonyms: ["2", "02", "cesado", "cesada", "cese"] },
            // 03 = RETEN is in the original code but not in the template's header comment;
            // 03 §4.2 keeps the code and asks for the comment to be corrected instead.
            { value: 3, label: "RETEN", synonyms: ["3", "03", "reten", "retén"] },
        ]),
    }),

    "TIPO DE CONTRATO LABORAL": Object.freeze({
        column: "TIPO DE CONTRATO LABORAL",
        letter: "Q",
        type: "integer",
        entries: Object.freeze([
            {
                value: 1,
                label: "PLAZO FIJO",
                // "plaza fijo" is a typo the old switch carried explicitly; keep it.
                synonyms: ["1", "01", "plazo fijo", "plaza fijo", "planilla"],
            },
            {
                value: 2,
                label: "PLAZO INDETERMINADO",
                synonyms: ["2", "02", "plazo indeterminado", "indeterminado"],
            },
            {
                value: 3,
                label: "CONTRATO DE EXTRANJERO",
                synonyms: ["3", "03", "contrato de extranjero", "extranjero"],
            },
            {
                value: 4,
                label: "SIN CONTRATO REGIMEN CIVIL",
                synonyms: [
                    "4",
                    "04",
                    "sin contrato regimen civil",
                    "sin contrato régimen civil",
                    "rxh",
                    "recibo por honorarios",
                ],
                // 03 §4.3: "si" is inherited from the old switch and is almost certainly a
                // subcontratista answering "does he have a contract?". Kept, but reported as
                // a low-confidence mapping so the operator can see how often it fires.
                lowConfidence: ["si"],
            },
        ]),
    }),

    GENERO: Object.freeze({
        column: "GENERO",
        letter: "L",
        // 03 §4.4: the stored value is the LOWERCASE Spanish word, not the code. The
        // template validates the word (`LOWER([GENERO])="masculino"`), and storing the
        // uppercase form as the old code did at :173 produced a second pivot item that
        // split the gender columns.
        type: "string",
        entries: Object.freeze([
            {
                value: "masculino",
                label: "MASCULINO",
                synonyms: ["1", "01", "m", "masculino", "masculina", "hombre", "varon", "varón"],
            },
            {
                value: "femenino",
                label: "FEMENINO",
                synonyms: ["2", "02", "f", "femenino", "femenina", "mujer"],
            },
        ]),
    }),
});

/** The domains must be exactly the coded columns columns.js declares. */
for (const column of CODED_COLUMNS) {
    if (!DOMAINS[column]) throw new Error(`codes.js: no domain for coded column ${column}`);
}
for (const column of Object.keys(DOMAINS)) {
    if (!CODED_COLUMNS.includes(column)) throw new Error(`codes.js: ${column} is not a coded column`);
}

/** column -> Map(normalized synonym -> {value, label, lowConfidence}). Built once. */
const LOOKUPS = new Map();
for (const domain of Object.values(DOMAINS)) {
    const map = new Map();
    const put = (synonym, entry, lowConfidence) => {
        const key = normalizeCodeKey(synonym);
        const existing = map.get(key);
        // A collision between two different codes is a programming error in the table
        // above, not a data problem, so it throws at load rather than at row 3,000.
        if (existing && existing.value !== entry.value) {
            throw new Error(
                `codes.js: synonym "${synonym}" maps to both ${existing.value} and ${entry.value} in ${domain.column}`
            );
        }
        map.set(key, Object.freeze({ value: entry.value, label: entry.label, lowConfidence }));
    };
    for (const entry of domain.entries) {
        for (const synonym of entry.synonyms) put(synonym, entry, false);
        for (const synonym of entry.lowConfidence || []) put(synonym, entry, true);
    }
    LOOKUPS.set(domain.column, map);
}

/** Ordered legal values for a column, for the run report and the header comments. */
function allowedValues(column) {
    const domain = DOMAINS[column];
    return domain ? domain.entries.map(e => e.value) : [];
}

function isCodedColumn(column) {
    return Object.prototype.hasOwnProperty.call(DOMAINS, column);
}

/**
 * The one matcher. Pure.
 *
 * @returns {{value: (number|string|null), ok: boolean, empty: boolean,
 *            lowConfidence: boolean, label: (string|null), matched: (string|null),
 *            column: string}}
 *
 *  - empty cell            -> {value: null, ok: true,  empty: true}   no issue: 157 blank
 *                             TIPO TRABAJADOR and 21 blank ESTADO in the last run are
 *                             absence, not error, and flagging them would bury the Errores
 *                             sheet under thousands of non-events.
 *  - recognised value      -> {value: <code>, ok: true, empty: false}
 *  - anything else         -> {value: null, ok: false, empty: false}  caller reports it.
 *
 * `value` is never NaN and never the raw input: it is either null or one of the frozen
 * table values (BUG-20).
 */
function normalizeInDomain(column, raw) {
    const base = { value: null, ok: true, empty: false, lowConfidence: false, label: null, matched: null, column };
    const lookup = LOOKUPS.get(column);
    if (!lookup) throw new Error(`codes.js: unknown coded column ${column}`);

    // null/undefined/blank never become a string here - that is exactly how the literal
    // "undefined" reached the workbook (BUG-18).
    if (raw === null || raw === undefined) return { ...base, empty: true };

    // A cell is a string, a number or a boolean. Anything else (a Date from cellDates, an
    // array from a mis-shaped read) is junk: stringifying it could accidentally produce a
    // legal key - String([1]) === "1" - so it is rejected explicitly instead. NaN and
    // Infinity are rejected here too, so they can never be mistaken for an empty cell.
    const type = typeof raw;
    if (type !== "string" && type !== "number" && type !== "boolean") return { ...base, ok: false };
    if (type === "number" && !Number.isFinite(raw)) return { ...base, ok: false };

    const key = normalizeCodeKey(raw);
    if (key === "") return { ...base, empty: true };

    let hit = lookup.get(key);
    if (!hit) {
        const numeric = NUMERIC_KEY.exec(key);
        if (numeric) hit = lookup.get(numeric[1]);
    }
    if (!hit) return { ...base, ok: false };

    return {
        ...base,
        value: hit.value,
        label: hit.label,
        matched: key,
        lowConfidence: hit.lowConfidence,
    };
}

const normalizeTipoTrabajador = raw => normalizeInDomain("TIPO TRABAJADOR", raw);
const normalizeEstado = raw => normalizeInDomain("ESTADO", raw);
const normalizeTipoContratoLaboral = raw => normalizeInDomain("TIPO DE CONTRATO LABORAL", raw);
const normalizeGenero = raw => normalizeInDomain("GENERO", raw);

/**
 * Generic entry point: coerce one coded cell and record what happened.
 *
 * @param {string} column   canonical column name (must be one of CODED_COLUMNS)
 * @param {*}      raw      the raw cell value, untouched
 * @param {object} [context]
 * @param {import("./issues").IssueList} [context.issues]  collector; omit to stay pure
 * @param {string} [context.subcontratista]
 * @param {string} [context.archivo]
 * @param {string} [context.hoja]
 * @param {number} [context.fila]
 * @param {string} [context.celda]
 * @returns {object} the normalizeInDomain result
 *
 * Severity follows 03 §8.3: an unrecognised code is a WARNING - the row is accepted with
 * the field nulled, not rejected.
 */
function normalizeCode(column, raw, context = {}) {
    const result = normalizeInDomain(column, raw);
    const issues = context.issues;
    if (!issues) return result;

    const where = {
        subcontratista: context.subcontratista,
        archivo: context.archivo,
        hoja: context.hoja,
        fila: context.fila,
        celda: context.celda,
        columna: column,
        valor: raw,
    };

    if (!result.ok) {
        issues.warning({
            ...where,
            code: CODE.CODE_OUT_OF_DOMAIN,
            message: `${column} out of domain - value nulled (allowed: ${allowedValues(column).join(", ")})`,
            detalle: { allowed: allowedValues(column) },
        });
    } else if (result.lowConfidence) {
        // No dedicated CODE exists for "a low-confidence synonym fired" and issues.js is a
        // frozen contract, so this rides on TEXT_NORMALIZED at INFO ("a normalization
        // fired") rather than polluting the CODE_OUT_OF_DOMAIN counts the acceptance
        // criteria read. 03 §4.3 only requires that the operator can count the hits.
        issues.info({
            ...where,
            code: CODE.TEXT_NORMALIZED,
            message: `${column} accepted via low-confidence synonym "${result.matched}" as ${result.value} (${result.label})`,
            detalle: { matched: result.matched, lowConfidence: true },
        });
    }

    return result;
}

module.exports = {
    DOMAINS,
    LOOKUPS,
    allowedValues,
    isCodedColumn,
    normalizeCodeKey,
    normalizeInDomain,
    normalizeTipoTrabajador,
    normalizeEstado,
    normalizeTipoContratoLaboral,
    normalizeGenero,
    normalizeCode,
};

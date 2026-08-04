"use strict";
/**
 * The issue model. Every rejected value, skipped file, recovered column and collapsed
 * duplicate becomes one of these - never a silent NaN, never a blank cell, never a
 * #VALUE! (05-implementation-plan.md §1 principle 5).
 *
 * The list is the source for both the "Errores" sheet and the run.json log.
 */

/** Severity, in ascending order of alarm. */
const SEVERITY = Object.freeze({
    INFO: "INFO",        // handled, worth knowing: a skipped __MACOSX/ entry, a recovered column
    WARNING: "WARNING",  // accepted with a caveat: a missing HPT column, a bad RUC check digit
    ERROR: "ERROR",      // a row or value was rejected; the run continues
    FAILED: "FAILED",    // a whole workbook or folder could not be processed; the run continues
                         // but the report is knowingly incomplete and says so, loudly
});

const SEVERITY_ORDER = [SEVERITY.INFO, SEVERITY.WARNING, SEVERITY.ERROR, SEVERITY.FAILED];

/**
 * Stable issue codes. Grouped by origin. Used by tests and by the run report's
 * summary counts, so they must not be renamed casually.
 */
const CODE = Object.freeze({
    // zip / container
    SKIPPED_MACOSX: "SKIPPED_MACOSX",
    SKIPPED_LOCKFILE: "SKIPPED_LOCKFILE",
    SKIPPED_NON_XLSX: "SKIPPED_NON_XLSX",
    FOLDER_MULTIPLE_XLSX: "FOLDER_MULTIPLE_XLSX",
    FOLDER_NO_XLSX: "FOLDER_NO_XLSX",
    ZIP_ENTRY_CAP: "ZIP_ENTRY_CAP",
    ZIP_SIZE_CAP: "ZIP_SIZE_CAP",
    ZIP_TRAVERSAL: "ZIP_TRAVERSAL",

    // workbook / sheet / anchor
    SHEET_NOT_FOUND: "SHEET_NOT_FOUND",
    SHEET_MATCHED_LOOSELY: "SHEET_MATCHED_LOOSELY",
    ANCHOR_NOT_FOUND: "ANCHOR_NOT_FOUND",
    ANCHOR_FOUND: "ANCHOR_FOUND",
    LEFT_EDGE_EXTENDED: "LEFT_EDGE_EXTENDED",
    WORKBOOK_UNREADABLE: "WORKBOOK_UNREADABLE",
    DATE_SYSTEM_1904: "DATE_SYSTEM_1904",

    // headers
    HEADER_ALIAS_ACCEPTED: "HEADER_ALIAS_ACCEPTED",
    HEADER_UNRECOGNIZED: "HEADER_UNRECOGNIZED",
    HEADER_DUPLICATE: "HEADER_DUPLICATE",
    COLUMN_MISSING: "COLUMN_MISSING",

    // rows / values
    ROW_NUMERIC_NAME: "ROW_NUMERIC_NAME",
    ROW_EMPTY: "ROW_EMPTY",
    DATE_UNPARSEABLE: "DATE_UNPARSEABLE",
    DATE_IMPLAUSIBLE: "DATE_IMPLAUSIBLE",
    DATE_TWO_DIGIT_YEAR: "DATE_TWO_DIGIT_YEAR",
    DATE_FRACTIONAL_TRUNCATED: "DATE_FRACTIONAL_TRUNCATED",
    CODE_OUT_OF_DOMAIN: "CODE_OUT_OF_DOMAIN",
    RUC_CHECK_DIGIT: "RUC_CHECK_DIGIT",
    RUC_FORMAT: "RUC_FORMAT",
    DNI_LENGTH: "DNI_LENGTH",
    REQUIRED_MISSING: "REQUIRED_MISSING",
    TEXT_NORMALIZED: "TEXT_NORMALIZED",

    // dedupe / reconciliation
    DUPLICATE_COLLAPSED: "DUPLICATE_COLLAPSED",
    FOLDER_NAME_MISMATCH: "FOLDER_NAME_MISMATCH",
    // run.js only: leidas - rechazadas - colapsadas != escritas (03 §9 AC 7). Raised at
    // FAILED so a run that lost or invented rows says so at the top of the Errores sheet
    // instead of leaving the arithmetic for a developer to notice.
    CONSERVATION_BROKEN: "CONSERVATION_BROKEN",
});

/**
 * Build one issue. Every field is optional except severity, code and message, so a
 * container-level issue and a cell-level issue are the same shape.
 *
 * @param {object} o
 * @param {string} o.severity      one of SEVERITY
 * @param {string} o.code          one of CODE
 * @param {string} o.message       human-readable, Spanish domain terms preserved
 * @param {string} [o.subcontratista] source folder name
 * @param {string} [o.archivo]     source file name
 * @param {string} [o.hoja]        source sheet name
 * @param {number} [o.fila]        1-based source row number in the sheet
 * @param {string} [o.celda]       A1 address, e.g. "F1743"
 * @param {string} [o.columna]     canonical column name
 * @param {*}      [o.valor]       the RAW value, before any coercion
 * @param {*}      [o.detalle]     anything else worth carrying (matched format, alias, ...)
 */
function issue(o) {
    if (!SEVERITY[o.severity]) throw new Error(`unknown severity: ${o.severity}`);
    if (!CODE[o.code]) throw new Error(`unknown issue code: ${o.code}`);
    return {
        severity: o.severity,
        code: o.code,
        message: o.message,
        subcontratista: o.subcontratista ?? null,
        archivo: o.archivo ?? null,
        hoja: o.hoja ?? null,
        fila: o.fila ?? null,
        celda: o.celda ?? null,
        columna: o.columna ?? null,
        valor: o.valor === undefined ? null : o.valor,
        detalle: o.detalle ?? null,
    };
}

/** Collector. Passed down the pipeline; every module appends rather than throwing. */
class IssueList {
    constructor() {
        this.items = [];
    }
    add(o) {
        const i = issue(o);
        this.items.push(i);
        return i;
    }
    /** Convenience wrappers. */
    info(o) { return this.add({ ...o, severity: SEVERITY.INFO }); }
    warning(o) { return this.add({ ...o, severity: SEVERITY.WARNING }); }
    error(o) { return this.add({ ...o, severity: SEVERITY.ERROR }); }
    failed(o) { return this.add({ ...o, severity: SEVERITY.FAILED }); }

    get length() { return this.items.length; }
    bySeverity(s) { return this.items.filter(i => i.severity === s); }
    byCode(c) { return this.items.filter(i => i.code === c); }

    /** { INFO: n, WARNING: n, ERROR: n, FAILED: n } */
    counts() {
        const out = {};
        for (const s of SEVERITY_ORDER) out[s] = 0;
        for (const i of this.items) out[i.severity]++;
        return out;
    }

    /** { CODE: n, ... }, descending. */
    countsByCode() {
        const m = new Map();
        for (const i of this.items) m.set(i.code, (m.get(i.code) || 0) + 1);
        return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
    }

    /** True when anything happened that the operator must see before trusting the report. */
    hasBlockingIssues() {
        return this.items.some(i => i.severity === SEVERITY.FAILED);
    }
}

module.exports = { SEVERITY, SEVERITY_ORDER, CODE, issue, IssueList };

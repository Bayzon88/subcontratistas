"use strict";
/**
 * ReporteConsolidado.xlsx - the DIFFABLE INTERMEDIATE.
 *
 * WHAT THIS FILE IS FOR, because its purpose is now much narrower than the file it
 * replaces. Today `src/excelConsolidation.js:109` writes `ReporteConsolidado.xlsx` and
 * `src/excelReporting.js:7` READS IT BACK - it is a real checkpoint on the pipeline's
 * path, which is why one added column shifts all 18 (BUG-13). After the rework NOTHING
 * READS IT BACK: `output/template.js` injects the in-memory records straight into the
 * template. This artefact survives for exactly two reasons
 * (01-current-state.md §9, 05-implementation-plan.md §2.1):
 *
 *   1. debugging - it is the only place a human can see the 5,000 consolidated rows
 *      without opening the 3.7 MB template, and every data measurement quoted in the
 *      plan documents was taken from its predecessor;
 *   2. the parallel-run comparison (03 §9 AC 28) - `tools/diff-reports.js` diffs the 18
 *      raw columns "value AND type" between the two pipelines, and a text date that
 *      became a serial has to report as a TYPE change, not as an inequality.
 *
 * Both reasons demand faithfulness, not helpfulness: this writer places values, it does
 * not repair them. The one thing it will not do is emit a value that cannot be read back
 * as what the record says it is - a text date (BUG-09), a numeric identifier whose
 * leading zero is gone (BUG-23), a `NaN` (BUG-20) or the literal `"undefined"` (BUG-18).
 * Those become an empty cell plus a line in the IssueList, never a throw.
 *
 * WHY SheetJS AND NOT xlsx-populate: there is no template to preserve here - one flat
 * sheet, no pivots, no table, no styles beyond the three date columns. xlsx-populate's
 * round-trip costs 912 ms and 944 MB peak RSS (05 §3 Phase 3) and buys nothing on a file
 * built from scratch. `output/template.js` is where xlsx-populate belongs.
 *
 * DETERMINISM: verified byte-stable. SheetJS's zip writer uses a fixed entry timestamp
 * and emits no `<dcterms:created>`, so the same records and the same period produce a
 * SHA-1-identical file on any machine at any time (03 §9 AC 26). Nothing below reads a
 * clock, and `period` is an argument that is never inferred when absent.
 */

const fs = require("node:fs");
const path = require("node:path");
const XLSX = require("xlsx");

const config = require("../config");
const {
    CANONICAL,
    DATE_COLUMNS,
    TEXT_ID_COLUMNS,
    INDEX_BY_CANONICAL,
} = require("../pipeline/columns");
const { CODE, IssueList } = require("../pipeline/issues");
const dates = require("../pipeline/dates");
const { parsePeriod } = require("../pipeline/period");

/** The one sheet. Same name the input workbooks use and the template's data sheet uses. */
const SHEET_NAME = config.SHEET_NAME;

/**
 * Excel's BUILT-IN short date. 03 §3.6 and AC 9 require `numFmtId="14"` on every
 * populated cell of F, M and O - the same style the template's `Cuadro!F2/M2/O2` carry
 * (cellXfs index 4 -> numFmtId 14).
 *
 * SheetJS has no "numFmtId" input: the writer maps `cell.z` back to an id, and it emits
 * the built-in id (rather than a new `<numFmt>` entry) only when the format code matches
 * its own table entry byte for byte. So the code is taken FROM that table, and asserted
 * against the literal, so a SheetJS version bump that changed the spelling would be a
 * loud module-load failure here instead of a silent numFmtId 164+ in the output.
 */
const DATE_NUMFMT_ID = 14;
const DATE_FORMAT_CODE = (XLSX.SSF && XLSX.SSF._table && XLSX.SSF._table[DATE_NUMFMT_ID]) || "m/d/yy";
if (DATE_FORMAT_CODE !== "m/d/yy") {
    throw new Error(
        `output/consolidated.js: xlsx's built-in format ${DATE_NUMFMT_ID} is ` +
        `${JSON.stringify(DATE_FORMAT_CODE)}, expected "m/d/yy" - the numFmtId 14 ` +
        "guarantee of 03 §3.6 / AC 9 cannot be made"
    );
}

const IS_DATE_COLUMN = new Set(DATE_COLUMNS);
const IS_TEXT_ID_COLUMN = new Set(TEXT_ID_COLUMNS);

/**
 * The three strings JS coercion produces when a value was never there. AC 11 ("zero NaN")
 * and AC 12 ("the literal string \"undefined\" appears zero times", 10 today - BUG-18)
 * are absolute, so the writer refuses them as the last gate, exactly the way schema.js's
 * validators are the second gate behind the normalizers. Matched case-sensitively and
 * only in their exact spelling: these are `String(undefined)`, `String(NaN)` and
 * `String(null)`, never something a person typed.
 */
const JS_COERCION_ARTEFACTS = new Set(["undefined", "NaN", "null"]);

/* ------------------------------------------------------------------ *
 * Issue plumbing
 * ------------------------------------------------------------------ */

/**
 * Report a value this writer would not put in a cell.
 *
 * `celda` in issues.js means the SOURCE cell ("F1743 of SUBCONTRATA X/reporte.xlsx"), and
 * this module has no source - it is downstream of every reader. So the source coordinates
 * come from the record's provenance (BUG-22: today they are deleted before they get this
 * far) and the address inside the artefact rides in `detalle.celdaConsolidado` rather
 * than impersonating one.
 */
function note(ctx, at, code, message, detalle) {
    const prov = at.record && typeof at.record === "object" ? at.record.provenance : null;
    ctx.issues.warning({
        code,
        message: `${at.canonical}: ${message}`,
        subcontratista: prov && prov.subcontratista !== undefined ? prov.subcontratista : null,
        archivo: prov && prov.archivo !== undefined ? prov.archivo : null,
        hoja: prov && prov.hoja !== undefined ? prov.hoja : null,
        fila: prov && Number.isInteger(prov.filaOrigen) ? prov.filaOrigen : null,
        columna: at.canonical,
        valor: at.value,
        detalle: { celdaConsolidado: at.celda, ...(detalle || {}) },
    });
}

/** A value that cannot be written at all: empty cell + one WARNING. Never a throw. */
function reject(ctx, at, message, detalle) {
    ctx.rechazadas++;
    // issues.js is a frozen contract with no "the writer refused this" code.
    // CODE_OUT_OF_DOMAIN carries the same meaning schema.js gives it: the value is
    // outside what the column allows, the field is nulled, and the row survives.
    note(ctx, at, CODE.CODE_OUT_OF_DOMAIN, message, detalle);
    return null;
}

function describeType(v) {
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    if (v instanceof Date) return "Date";
    return typeof v;
}

/* ------------------------------------------------------------------ *
 * Cell builders - one per column kind
 * ------------------------------------------------------------------ */

/**
 * F, M and O. A real Excel serial with numFmtId 14, or no cell at all.
 *
 * BUG-09 and AC 9: today's file carries 103 text values in FECHA NACIMIENTO, 4,894 in
 * FECHA CESE/BAJA (mostly `""`, force-written at excelConsolidation.js:257-259) and 100
 * in FECHA INICIO DE LABORES EN OBRA. Not one text cell may leave this function - the
 * empty string included, which is why `""` takes the same rejection path as `"ACTIVO"`
 * instead of being quietly treated as "absent".
 */
function dateCell(ctx, at) {
    const value = at.value;
    let serial = null;

    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            return reject(ctx, at, `serial no finito (${String(value)}): se deja la celda vacia`);
        }
        serial = Math.trunc(value);
        if (serial !== value) {
            // schema.js/dates.js already truncate; reaching here means an unnormalized
            // record. Keep the day, say so - the 1,280 fractional serials of 03 §3.3 are
            // one broken export at 19:00/20:00, not a different date.
            ctx.truncadas++;
            note(ctx, at, CODE.DATE_FRACTIONAL_TRUNCATED,
                `serial fraccionario ${value}: se escribe ${serial}`, { serial });
        }
    } else if (value instanceof Date) {
        // Local components, never Date.UTC and never an ISO string (03 §3.6: pick one
        // timezone convention and hold it end to end).
        serial = Number.isNaN(value.getTime())
            ? null
            : dates.dateToSerial({ y: value.getFullYear(), m: value.getMonth() + 1, d: value.getDate() });
        if (serial === null) {
            return reject(ctx, at, "Date invalida: se deja la celda vacia");
        }
    } else {
        return reject(ctx, at,
            `una columna de fecha nunca recibe ${describeType(value)} ` +
            `(${JSON.stringify(value)}): se deja la celda vacia (BUG-09, AC 9)`,
            { esperado: "serial de Excel entero o null" });
    }

    if (serial < dates.MIN_SERIAL || serial > dates.MAX_SERIAL) {
        return reject(ctx, at,
            `serial ${serial} fuera del rango de Excel (${dates.MIN_SERIAL}..${dates.MAX_SERIAL}): ` +
            "se deja la celda vacia",
            { serial });
    }

    ctx.escritas++;
    return { t: "n", v: serial, z: DATE_FORMAT_CODE };
}

/**
 * A and D. Always a TEXT cell, with an explicit `t: "s"` - never left for SheetJS to
 * infer, because inference is exactly how `09994533` became `9994533` (BUG-23, AC 13:
 * 4 of today's DNIs are 7 characters long for this reason).
 */
function idCell(ctx, at) {
    const value = at.value;

    if (typeof value === "string") {
        if (value.trim() === "") return null;  // a blank RUC/DNI is a data reality (660/723 today)
        if (JS_COERCION_ARTEFACTS.has(value.trim())) {
            return reject(ctx, at, `valor "${value.trim()}" es un artefacto de coercion: se deja la celda vacia`);
        }
        ctx.escritas++;
        return { t: "s", v: value };
    }

    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            return reject(ctx, at, `identificador no finito (${String(value)}): se deja la celda vacia`);
        }
        const text = String(value);
        note(ctx, at, CODE.TEXT_NORMALIZED,
            `llego como numero ${text} y se escribe como texto; si tenia ceros a la ` +
            "izquierda ya se perdieron aguas arriba (BUG-23)",
            { normalizado: text });
        ctx.escritas++;
        return { t: "s", v: text };
    }

    return reject(ctx, at,
        `un identificador nunca es ${describeType(value)}: se deja la celda vacia`,
        { esperado: "texto" });
}

/** The other 13 columns: text as text, numbers as numbers, everything else refused. */
function valueCell(ctx, at) {
    const value = at.value;

    if (typeof value === "string") {
        const trimmed = value.trim();
        // AC 15 / 03 §7.2: `""` is never emitted. An empty cell is an empty cell - the
        // ghost-row disease starts with a writer that thinks "" is a value.
        if (trimmed === "") return null;
        if (JS_COERCION_ARTEFACTS.has(trimmed)) {
            return reject(ctx, at,
                `valor "${trimmed}" es un artefacto de coercion: se deja la celda vacia (BUG-18, AC 12)`);
        }
        ctx.escritas++;
        // Verbatim, NOT trimmed: this artefact must show what the pipeline produced.
        // Whitespace differences are the dedupe's business (`"...JESUS "` vs `"...JESUS"`),
        // and a writer that silently trims would hide the very defect it is used to find.
        return { t: "s", v: value };
    }

    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            return reject(ctx, at,
                `${String(value)} no es un numero finito: se deja la celda vacia (BUG-20, AC 11)`);
        }
        ctx.escritas++;
        return { t: "n", v: value };
    }

    if (typeof value === "boolean") {
        return reject(ctx, at, "un booleano no es un valor de esta columna: se deja la celda vacia");
    }

    if (value instanceof Date) {
        return reject(ctx, at,
            "una fecha fuera de F/M/O es un valor mal ubicado: se deja la celda vacia",
            { esperado: "texto o numero" });
    }

    return reject(ctx, at,
        `no se puede escribir un valor de tipo ${describeType(value)}: se deja la celda vacia`);
}

/** Route one cell to its builder. */
function cellFor(ctx, at) {
    if (at.value === null || at.value === undefined) return null;
    if (IS_DATE_COLUMN.has(at.canonical)) return dateCell(ctx, at);
    if (IS_TEXT_ID_COLUMN.has(at.canonical)) return idCell(ctx, at);
    return valueCell(ctx, at);
}

/* ------------------------------------------------------------------ *
 * Sheet construction
 * ------------------------------------------------------------------ */

/** The mutable bag buildSheet counts into. Exported through buildSheet's default so a
 *  test can call buildSheet(records) with no ceremony. */
function newContext(issues) {
    return {
        issues: issues instanceof IssueList ? issues : (issues || new IssueList()),
        escritas: 0,
        vacias: 0,
        rechazadas: 0,
        truncadas: 0,
        filasOmitidas: 0,
    };
}

/** Read one canonical field BY NAME. Anything else on the record (`provenance`) is ignored. */
function fieldOf(record, canonical) {
    if (!record || typeof record !== "object") return undefined;
    return Object.prototype.hasOwnProperty.call(record, canonical) ? record[canonical] : undefined;
}

/**
 * Build the `Cuadro` worksheet: header row + one row per record.
 *
 * BUG-13, and the whole reason this loop is written the way it is: every cell is placed
 * by looking its canonical NAME up in `INDEX_BY_CANONICAL`. Object key-enumeration order
 * is never consulted, so a record whose keys arrive reversed, partial, or carrying extra
 * keys still lands in A..R correctly. `excelReporting.js:45-48` does the opposite
 * (`for (let data in row)` with a manual `column++`) and one added column shifts all 18.
 *
 * @param {object[]} records  deduplicated canonical records
 * @param {object} [ctx]      counter bag from newContext(); one is created when omitted
 * @returns {object} a SheetJS worksheet
 */
function buildSheet(records, ctx = newContext()) {
    // A plain object, not Object.create(null): SheetJS's writer walks worksheets with the
    // usual prototype methods available.
    const ws = {};
    const lastCol = CANONICAL.length - 1;

    for (const [canonical, col] of INDEX_BY_CANONICAL) {
        ws[XLSX.utils.encode_cell({ r: 0, c: col })] = { t: "s", v: canonical };
    }

    let r = 0;
    for (const record of records) {
        if (!record || typeof record !== "object" || Array.isArray(record)) {
            // A non-record in the array is a caller bug, but this module does not throw for
            // one bad element and silently dropping it would break AC 7's row arithmetic.
            ctx.filasOmitidas++;
            ctx.issues.warning({
                code: CODE.CODE_OUT_OF_DOMAIN,
                message: `registro ${r + 1} no es un objeto (${describeType(record)}): se omite la fila`,
                valor: record === undefined ? null : record,
            });
            continue;
        }

        r++;
        for (const [canonical, col] of INDEX_BY_CANONICAL) {
            const value = fieldOf(record, canonical);
            if (value === null || value === undefined) { ctx.vacias++; continue; }
            const address = XLSX.utils.encode_cell({ r, c: col });
            const cell = cellFor(ctx, { record, canonical, value, celda: address });
            // No cell at all - not "", not null, not 0. An absent value has no `<c>`
            // element in the sheet XML (AC 15, 03 §7.2).
            if (cell === null) { ctx.vacias++; continue; }
            ws[address] = cell;
        }
    }

    ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r, c: lastCol } });
    return ws;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Normalize the period argument. Absent is allowed and means "not stamped" - it is NEVER
 * inferred from the wall clock, which is the defect this rework exists to remove (BUG-16).
 */
function resolvePeriod(period) {
    if (period === null || period === undefined) return null;
    if (typeof period === "string") return parsePeriod(period);
    if (typeof period === "object" && typeof period.key === "string") {
        // A descriptor from period.js. Re-parsing costs microseconds and guarantees every
        // field this module reads is present, whatever the caller assembled by hand.
        return parsePeriod(period.key);
    }
    throw new TypeError(
        'output/consolidated.js: period must be "YYYY-MM" or a descriptor from parsePeriod'
    );
}

/**
 * Write the consolidated intermediate.
 *
 * @param {object[]} records   deduplicated canonical records (18 canonical keys, plus an
 *                             optional `provenance`; key order is irrelevant)
 * @param {string} outPath     destination .xlsx; parent directories are created
 * @param {object} [options]
 * @param {string|object} [options.period]  "YYYY-MM" or a parsePeriod descriptor. Stamped
 *                             into docProps so the artefact says which month it is; the
 *                             sheet itself is unaffected. Omitted = not stamped.
 * @param {IssueList} [options.issues]  collector; a fresh one is created when omitted
 * @returns {Readonly<object>} `{path, hoja, ref, filas, columnas, bytes, periodo, celdas,
 *   filasOmitidas, issues}`. `celdas.escritas + celdas.vacias` is always
 *   `filas x 18`; `celdas.rechazadas` is the subset of `vacias` that was left empty
 *   because the value could not be written, and each one has its own line in `issues`.
 * @throws {TypeError} only for a wiring bug (bad arguments). Never for a data problem.
 */
function writeConsolidated(records, outPath, options = {}) {
    if (!Array.isArray(records)) {
        throw new TypeError("output/consolidated.js: records must be an array");
    }
    if (typeof outPath !== "string" || outPath.trim() === "") {
        throw new TypeError("output/consolidated.js: outPath must be a non-empty string");
    }
    const opts = options || {};
    const issues = opts.issues instanceof IssueList ? opts.issues : (opts.issues || new IssueList());
    const periodo = resolvePeriod(opts.period);

    const ctx = newContext(issues);
    const ws = buildSheet(records, ctx);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, SHEET_NAME);
    if (periodo) {
        // docProps/core.xml only - SheetJS writes no <dcterms:created>, so this stays
        // byte-deterministic (verified). The sheet contract is header + A..R, untouched.
        wb.Props = { Title: `Reporte consolidado - ${periodo.mesNombre} ${periodo.year}` };
    }

    // bookSST: ~5,000 rows x 10 text columns over ~150 companies is mostly repeated
    // strings; the shared-string table is a large size win and the type SheetJS emits for
    // a shared string (t="s") is the unambiguous "this is text" Excel honours.
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx", bookSST: true, compression: true });

    const resolved = path.resolve(outPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, buffer);

    const filas = XLSX.utils.decode_range(ws["!ref"]).e.r;  // header row excluded
    return Object.freeze({
        path: resolved,
        hoja: SHEET_NAME,
        ref: ws["!ref"],
        filas,
        columnas: CANONICAL.length,
        bytes: buffer.length,
        periodo: periodo ? periodo.key : null,
        celdas: Object.freeze({
            escritas: ctx.escritas,
            vacias: ctx.vacias,
            rechazadas: ctx.rechazadas,
            truncadas: ctx.truncadas,
        }),
        filasOmitidas: ctx.filasOmitidas,
        issues,
    });
}

module.exports = {
    writeConsolidated,
    buildSheet,
    newContext,
    SHEET_NAME,
    DATE_NUMFMT_ID,
    DATE_FORMAT_CODE,
    JS_COERCION_ARTEFACTS,
};

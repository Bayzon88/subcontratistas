"use strict";
/**
 * The monthly report writer - it turns N consolidated records into the workbook the
 * client actually reads (05-implementation-plan.md Phase 3 tasks 1, 2 and 5; Phase 4
 * tasks 1 and 3; 03-expected-output.md §7).
 *
 * Option D in one paragraph (05 §5). `src/template-v2.xlsx` keeps its 13 pivot tables,
 * its one shared pivot cache and its `Hoja1` lookup tables. We inject the 18 raw columns
 * A..R, we write FIVE columns (V/W/AG/AH/AI) as JS-computed literal values because their
 * template formulas were anchored on `TODAY()`, and we regenerate the TWELVE remaining
 * computed columns (S/T/U/X/Y/Z/AA/AB/AC/AD/AE/AF) as per-cell Excel formulas taken
 * verbatim from `xl/tables/table1.xml`. Then `output/ooxml.js` resizes `Tabla2` and sets
 * `refreshOnLoad`/`fullCalcOnLoad`. xlsx-populate never parses the pivot parts, the table
 * part or the theme, so they survive byte-identical - that is the whole reason Option D
 * works and the reason this module must not be ported to ExcelJS or SheetJS CE.
 *
 * WHY THE TWELVE FORMULAS ARE WRITTEN PER CELL, and not left to the calculated column
 * ------------------------------------------------------------------------------------
 * A table calculated column carries its formula once, in
 * `<tableColumn><calculatedColumnFormula>`. It is tempting to assume Excel fills that
 * formula down into every row of the resized table on open. It does not, and the template
 * itself is the proof: `src/template.xlsx` was authored by Excel and carries 8,823
 * per-cell `<f>` elements in EVERY ONE of the 17 computed columns - 150,000 of them. Excel
 * materialises the formula into each cell and treats `<calculatedColumnFormula>` as the
 * pattern applied when a row is ADDED through the UI, not as a substitute for cell
 * content. Every report the current app has ever shipped inherited those per-cell `<f>`
 * from the template, so the pipeline has never once relied on an auto-fill.
 *
 * The failure mode if that assumption were wrong in the other direction is total and
 * silent: `refreshOnLoad="1"` rebuilds the pivot cache from cell VALUES, so twelve empty
 * columns would produce six empty report sheets, and nobody would find out until the
 * client opened the file. 05 Phase 3 task 5 and the §6 risk register row 5 both say to
 * regenerate the per-cell `<f>` from `table1.xml`; that is what this module does.
 * `writeFormulas: false` exists only so the alternative can be measured in a real Excel
 * session, and it is not a supported production setting.
 *
 * NO GHOST ROWS (BUG-10, BUG-12)
 * ------------------------------
 * The old writer "cleared" surplus rows with `.value("")` and never shrank the table, so
 * MAYO_2026 shipped 3,757 rows of empty strings INSIDE `Tabla2` while the formula columns
 * still computed on every one of them - `COUNTIF(Tabla2[APELLIDOS Y NOMBRES],"")` = 3,757
 * poisoned `Trabajador`, `Trabajadores Unicos` and `Contratistas` for every real row, and
 * every pivot grew a `(blank)` bucket. Its clearing loop also stopped at `row < lastRow`,
 * so the final row was never even cleared (BUG-12). Neither defect can recur here:
 * template-v2 ships a table of exactly two rows, this module writes exactly `rowCount`
 * data rows, `ooxml.js` sizes `Tabla2` to match, and `verify()` re-reads the saved file
 * and fails the run if a single empty string made it inside the table range.
 *
 * PLACEMENT IS BY NAME, NEVER BY KEY ORDER (BUG-13)
 * -------------------------------------------------
 * `excelReporting.js:43-53` iterated `for (let data in row)` with a manual `column++`, so
 * the 18 columns lined up only because JS enumeration order happened to agree with the
 * sheet. One added or removed key shifted the whole table by one, with no error. Here
 * every value is placed through a `Map<canonicalHeader, columnNumber>` built from
 * `columns.js` for A..R and from the `<tableColumn name>` entries of `table1.xml` for the
 * five literal columns, which sit at NON-CONTIGUOUS positions (V, W, AG, AH, AI). The two
 * sources are cross-checked at load: if `columns.js` and the template ever disagree about
 * the name at a position, this module throws instead of writing a shifted table.
 *
 * DETERMINISM
 * -----------
 * No clock. `period` is a required argument; `xlsx-populate` stamps every zip entry it
 * rewrites with `new Date(0)` and never writes `dcterms:modified`; the five literal
 * columns come from `output/computed.js`, which reads no clock either. Same records +
 * same period => same bytes (AC 26).
 *
 * COST (05 Phase 3, "Budget ~1 GB RSS and ~2.5 s")
 * -----------------------------------------------
 * Measured on template-v2: ~110 ms to open (the old 43.9 MB `sheet4.xml` took 912 ms),
 * then roughly 0.25 ms per data row to build and serialize 35 cells. A 5,000-row run
 * lands near 2 s and several hundred MB of RSS. THE PIPELINE CANNOT RUN CONCURRENTLY -
 * `config.ALLOW_CONCURRENT_RUNS` is false and the Phase 5 job runner must enforce it.
 */

const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");
const XlsxPopulate = require("xlsx-populate");

const config = require("../config");
const { CANONICAL, DATE_COLUMNS, TEXT_ID_COLUMNS } = require("../pipeline/columns");
const { SEVERITY, CODE, IssueList } = require("../pipeline/issues");
const { parsePeriod } = require("../pipeline/period");
const { dateToSerial, MIN_SERIAL, MAX_SERIAL } = require("../pipeline/dates");
const { computeRow, COMPUTED_COLUMNS, COMPUTED_COLUMN_NAMES } = require("./computed");
const { patchWorkbook, EXCEL_MAX_ROWS } = require("./ooxml");

/* ------------------------------------------------------------------ *
 * Names and addresses. Every one of these is verified against the
 * template at load time by readLayout()/readSpecimen(); none is a guess.
 * ------------------------------------------------------------------ */

/** The sheet the worker table lives on. Its `<tableParts>` carries `Tabla2`. */
const SHEET_CUADRO = "Cuadro";
/** Hidden. Holds the business-owned lookup tables and, since template-v2, the period. */
const SHEET_HOJA1 = "Hoja1";
/** The client-facing page. Gets the visible period caption (03 §6.1). */
const SHEET_PORTADA = "Reporte Social - RRHH";
/** The new diagnostics sheet (03 §8). Appended last so no existing sheet index moves. */
const SHEET_ERRORES = "Errores";

/** `Tabla2`'s header row, and the first row of data under it. */
const HEADER_ROW = 1;
const FIRST_DATA_ROW = 2;

/** The zip part that owns the table definition. Read, never written, by this module. */
const TABLE_PART = "xl/tables/table1.xml";
const SHEET_CONTENT_TYPE =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";

/**
 * Where the period lands on the hidden Hoja1. `tools/build-template-v2.js` put the labels
 * in O2:O4 and left P2:P4 empty; the three defined names point at exactly these cells.
 * P2/P3 already carry style 4 (numFmtId 14) so the serials render as dates.
 */
const PERIOD_CELLS = Object.freeze({ inicio: "P2", fin: "P3", etiqueta: "P4" });

/**
 * The visible caption. Row 1 of `Reporte Social - RRHH` is empty in the template and the
 * topmost pivot on that sheet starts at row 6 (`pivotTable1` at C6:F15), so C1 cannot
 * collide with a pivot body no matter how the pivots grow upward - they do not.
 */
const CAPTION_CELL = "C1";
const CAPTION_PREFIX = "Periodo reportado: ";

/** Excel's own ceiling, minus the header row. There is no 8,823-row cliff here (AC 16). */
const MAX_DATA_ROWS = EXCEL_MAX_ROWS - 1;

/** Values that must never reach a cell (AC 11, AC 12; BUG-18, BUG-20). */
const FORBIDDEN_LITERALS = Object.freeze(["undefined", "NaN", "null", "Infinity", "-Infinity"]);

/* ------------------------------------------------------------------ *
 * Errors
 *
 * Same posture as ooxml.js: a STRUCTURAL problem throws, because a
 * half-written table produces a workbook whose wrongness is invisible
 * downstream. A DATA problem never throws - it becomes an issue and an
 * empty cell (05 §1 principle 5).
 * ------------------------------------------------------------------ */

const TEMPLATE_ERROR = Object.freeze({
    BAD_ARGUMENT: "BAD_ARGUMENT",
    NO_RECORDS: "NO_RECORDS",
    TOO_MANY_ROWS: "TOO_MANY_ROWS",
    TEMPLATE_SHAPE: "TEMPLATE_SHAPE",
    COLUMN_DRIFT: "COLUMN_DRIFT",
    VERIFY_FAILED: "VERIFY_FAILED",
});

class TemplateError extends Error {
    constructor(code, message, detalle) {
        super(message);
        this.name = "TemplateError";
        this.code = code;
        if (detalle !== undefined) this.detalle = detalle;
    }
}

function fail(code, message, detalle) {
    throw new TemplateError(code, message, detalle);
}

/* ------------------------------------------------------------------ *
 * Small XML helpers. This module PARSES two template parts (table1.xml
 * to learn the column layout and the twelve formulas) and SCANS one
 * output part (sheet4.xml, to verify). It never reserializes either.
 * ------------------------------------------------------------------ */

function xmlUnescape(s) {
    return String(s)
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        // last, so "&amp;lt;" does not become "<"
        .replace(/&amp;/g, "&");
}

function attr(tag, name) {
    const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
    return m ? m[1] : null;
}

/** 1-based column number -> "A", "Z", "AA", ... */
function columnName(n) {
    let out = "";
    let x = n;
    while (x > 0) {
        const r = (x - 1) % 26;
        out = String.fromCharCode(65 + r) + out;
        x = Math.floor((x - 1) / 26);
    }
    return out;
}

/* ------------------------------------------------------------------ *
 * Layout: what the template says the columns are
 * ------------------------------------------------------------------ */

/**
 * Parse `xl/tables/table1.xml` into the column layout.
 *
 * This is the single source of truth for BOTH placement and the twelve formulas
 * (05 Phase 3 task 5: "read them from there rather than mirroring formulas in JS, so the
 * template stays self-describing"). A `<tableColumn>`'s position in document order IS its
 * offset from column A, which is what makes the non-contiguous literal columns
 * (V, W, AG, AH, AI) placeable by name.
 *
 * @returns {{tableName: string, ref: string, columns: Array, byName: Map}}
 */
function readLayout(tableXml) {
    const open = /<table\b[^>]*>/.exec(tableXml);
    if (!open) fail(TEMPLATE_ERROR.TEMPLATE_SHAPE, `${TABLE_PART}: no se encontro <table>`);
    const tableName = attr(open[0], "name");
    const ref = attr(open[0], "ref");
    if (!tableName) fail(TEMPLATE_ERROR.TEMPLATE_SHAPE, `${TABLE_PART}: <table> sin name`);

    const columns = [];
    const re = /<tableColumn\b[\s\S]*?(?:\/>|<\/tableColumn>)/g;
    let m;
    while ((m = re.exec(tableXml)) !== null) {
        const el = m[0];
        const name = attr(el, "name");
        const id = Number(attr(el, "id"));
        if (name === null) {
            fail(TEMPLATE_ERROR.TEMPLATE_SHAPE, `${TABLE_PART}: <tableColumn> sin name`);
        }
        const f = /<calculatedColumnFormula\b([^>]*)>([\s\S]*?)<\/calculatedColumnFormula>/.exec(el);
        columns.push(Object.freeze({
            // The 1-based sheet column. Document order is the layout - that is the whole
            // point of reading it from here rather than counting keys (BUG-13).
            number: columns.length + 1,
            letter: columnName(columns.length + 1),
            name: xmlUnescape(name),
            id: Number.isInteger(id) ? id : null,
            formula: f ? xmlUnescape(f[2]) : null,
            array: f ? / array="1"/.test(f[1]) : false,
        }));
    }
    if (columns.length === 0) {
        fail(TEMPLATE_ERROR.TEMPLATE_SHAPE, `${TABLE_PART}: sin <tableColumn>`);
    }

    const byName = new Map();
    for (const c of columns) {
        if (byName.has(c.name)) {
            fail(TEMPLATE_ERROR.TEMPLATE_SHAPE,
                `${TABLE_PART}: columna duplicada ${JSON.stringify(c.name)}`);
        }
        byName.set(c.name, c);
    }
    return { tableName, ref, columns, byName };
}

/**
 * Split the layout into the three roles and prove the template still agrees with
 * `columns.js` and with `computed.js`.
 *
 * This is the BUG-13 guard. A rename or a reorder on either side is a load-time error
 * here rather than an entire table written one column to the left.
 */
function buildPlan(layout) {
    // A..R: the 18 canonical columns, in order, by name.
    const raw = [];
    for (let i = 0; i < CANONICAL.length; i++) {
        const expected = CANONICAL[i];
        const col = layout.columns[i];
        if (!col || col.name !== expected) {
            fail(TEMPLATE_ERROR.COLUMN_DRIFT,
                `columna ${i + 1} de ${layout.tableName}: la plantilla dice ` +
                `${JSON.stringify(col ? col.name : null)} y columns.js dice ` +
                `${JSON.stringify(expected)}`,
                { posicion: i + 1, plantilla: col ? col.name : null, canonical: expected });
        }
        if (col.formula !== null) {
            fail(TEMPLATE_ERROR.COLUMN_DRIFT,
                `${col.letter} ${JSON.stringify(col.name)} es una columna de datos y ` +
                `la plantilla le puso <calculatedColumnFormula>`);
        }
        raw.push({ canonical: expected, column: col });
    }

    // V, W, AG, AH, AI: the five Option-D literals, located BY NAME, never by offset.
    const literals = [];
    for (const spec of COMPUTED_COLUMNS) {
        const col = layout.byName.get(spec.name);
        if (!col) {
            fail(TEMPLATE_ERROR.COLUMN_DRIFT,
                `${layout.tableName} no tiene la columna calculada ${JSON.stringify(spec.name)}`);
        }
        if (col.formula !== null) {
            // template-v2 deletes these five <calculatedColumnFormula> elements. If one
            // came back, Excel would re-fill TODAY()-30 over our literals on the next
            // sort or refresh - the exact failure 05 Phase 4 task 3 exists to prevent.
            fail(TEMPLATE_ERROR.COLUMN_DRIFT,
                `${col.letter} ${JSON.stringify(col.name)} volvio a tener ` +
                `<calculatedColumnFormula>: la plantilla no es template-v2 (05 §5, Fase 4 tarea 3)`);
        }
        if (spec.index0 + 1 !== col.number) {
            fail(TEMPLATE_ERROR.COLUMN_DRIFT,
                `${JSON.stringify(spec.name)}: computed.js la ubica en ${spec.letter} y la ` +
                `plantilla en ${col.letter}`);
        }
        literals.push({ name: spec.name, column: col });
    }

    // Everything else that carries a formula: the twelve that stay Excel's.
    const literalNames = new Set(COMPUTED_COLUMN_NAMES);
    const formulas = layout.columns
        .filter(c => c.formula !== null && !literalNames.has(c.name))
        .map(c => ({ name: c.name, column: c }));

    // The 18 + 5 + 12 = 35 arithmetic, asserted rather than assumed.
    const accounted = raw.length + literals.length + formulas.length;
    if (accounted !== layout.columns.length) {
        fail(TEMPLATE_ERROR.COLUMN_DRIFT,
            `${layout.tableName} tiene ${layout.columns.length} columnas y solo ` +
            `${accounted} tienen rol (18 datos + ${literals.length} literales + ` +
            `${formulas.length} formulas)`);
    }
    return { raw, literals, formulas };
}

/* ------------------------------------------------------------------ *
 * The specimen row
 *
 * `Cuadro` row 2 is the one data row template-v2 kept. It carries every
 * per-column style index verbatim - F/M/O = s="4" = numFmtId 14, which
 * is what AC 9 asks for - plus AD2's `cm="1"` and its `t="array"`
 * marker. Cloning it is how every generated row gets the formatting a
 * hand-built row would have had. Reading it (rather than hard-coding
 * 35 style ids) means restyling the template needs no code change.
 * ------------------------------------------------------------------ */

function readSpecimen(cuadro, layout, plan) {
    const row = cuadro.row(FIRST_DATA_ROW);
    const cells = new Map();
    for (const col of layout.columns) {
        const cell = row.cell(col.number);
        cells.set(col.number, {
            styleId: cell._styleId === undefined ? null : cell._styleId,
            // AD2 carries cm="1" - the cell-metadata index that marks a dynamic array
            // formula. Drop it and Excel treats the column as a legacy CSE array; keep it
            // and xl/metadata.xml (which nothing here touches) stays consistent.
            extra: cell._remainingAttributes ? { ...cell._remainingAttributes } : null,
            formula: cell._formula === undefined ? null : cell._formula,
            formulaType: cell._formulaType === undefined ? null : cell._formulaType,
        });
    }

    // Anti-drift: the specimen's per-cell <f> must be the table's own
    // <calculatedColumnFormula>. build-template-v2.js generates one from the other, so a
    // mismatch means somebody hand-edited the workbook.
    for (const { column } of plan.formulas) {
        const s = cells.get(column.number);
        if (s.formula !== column.formula) {
            fail(TEMPLATE_ERROR.TEMPLATE_SHAPE,
                `${column.letter}${FIRST_DATA_ROW}: la formula de la celda no coincide con ` +
                `<calculatedColumnFormula> de ${JSON.stringify(column.name)}`,
                { celda: s.formula, tabla: column.formula });
        }
        const wantType = column.array ? "array" : "normal";
        if (s.formulaType !== wantType) {
            fail(TEMPLATE_ERROR.TEMPLATE_SHAPE,
                `${column.letter}${FIRST_DATA_ROW}: se esperaba t="${wantType}" y hay ` +
                `${JSON.stringify(s.formulaType)}`);
        }
    }
    for (const { column } of plan.literals) {
        const s = cells.get(column.number);
        if (s.formula !== null) {
            fail(TEMPLATE_ERROR.TEMPLATE_SHAPE,
                `${column.letter}${FIRST_DATA_ROW}: columna literal con formula ` +
                `${JSON.stringify(s.formula)}`);
        }
    }

    // Row-level attributes (ht / customHeight / dyDescent), so every generated row looks
    // like the one the template ships rather than like a default-height stub.
    const rowAttributes = {};
    for (const [k, v] of Object.entries(row._node.attributes || {})) {
        if (k === "r" || k === "s" || k === "customFormat") continue;
        rowAttributes[k] = v;
    }
    return { cells, rowAttributes };
}

/* ------------------------------------------------------------------ *
 * Value coercion - the last gate before a cell exists
 *
 * Contract, in order of precedence:
 *   - `null` result  => NO CELL AT ALL. Not "", not 0, not a space.
 *   - a date column  => a finite integer serial or nothing (BUG-09, AC 9).
 *   - RUC / DNI      => text, leading zeros intact (AC 13).
 *   - anything else  => the value verbatim, with NaN/Infinity and the literal strings
 *                       "undefined"/"NaN"/"null" refused outright (AC 11, AC 12).
 * ------------------------------------------------------------------ */

/** Refusal carrier: `{ value }` when a cell should exist, `null` when it should not. */
function keep(value) { return { value }; }

function coerceValue(canonical, raw, ctx, rowNumber, letter) {
    if (raw === null || raw === undefined) return null;

    if (DATE_COLUMNS.includes(canonical)) return coerceDate(canonical, raw, ctx, rowNumber, letter);
    if (TEXT_ID_COLUMNS.includes(canonical)) return coerceIdentifier(canonical, raw, ctx, rowNumber, letter);
    return coerceGeneric(canonical, raw, ctx, rowNumber, letter);
}

function coerceDate(canonical, raw, ctx, rowNumber, letter) {
    let serial = null;
    if (typeof raw === "number") {
        if (!Number.isFinite(raw)) {
            reject(ctx, canonical, raw, rowNumber, letter, CODE.CODE_OUT_OF_DOMAIN,
                "valor no finito en columna de fecha: se deja la celda vacia");
            return null;
        }
        if (!Number.isInteger(raw)) {
            // A time-of-day fraction on a date column is the "14/06/2021 07:00" case
            // (03 §3.7). The date is the datum; the clock time is noise.
            ctx.issues.add({
                severity: SEVERITY.INFO,
                code: CODE.DATE_FRACTIONAL_TRUNCATED,
                message: `${canonical}: serial fraccionario ${raw} truncado a ${Math.floor(raw)}`,
                columna: canonical,
                valor: raw,
                detalle: { celdaReporte: `${letter}${rowNumber}` },
            });
        }
        serial = Math.floor(raw);
    } else if (raw instanceof Date) {
        // Local components, never Date.UTC - 03 §3.6. A UTC read shifts a Lima date back
        // a day for every record written on a machine east of Greenwich.
        serial = dateToSerial(raw.getFullYear(), raw.getMonth() + 1, raw.getDate());
    } else {
        // Text in F/M/O is the defect this pipeline exists to remove: 103 / 4,894 / 100
        // text values in the last run, every one of them invisible to Altas/Bajas.
        reject(ctx, canonical, raw, rowNumber, letter, CODE.CODE_OUT_OF_DOMAIN,
            `${canonical} no es un serial de fecha (${typeof raw}): se deja la celda vacia`);
        return null;
    }

    if (serial === null || serial < MIN_SERIAL || serial > MAX_SERIAL) {
        reject(ctx, canonical, raw, rowNumber, letter, CODE.DATE_IMPLAUSIBLE,
            `${canonical}: serial ${serial} fuera del rango representable de Excel`);
        return null;
    }
    ctx.dateCells++;
    return keep(serial);
}

function coerceIdentifier(canonical, raw, ctx, rowNumber, letter) {
    if (typeof raw === "number") {
        if (!Number.isFinite(raw) || !Number.isInteger(raw)) {
            reject(ctx, canonical, raw, rowNumber, letter, CODE.CODE_OUT_OF_DOMAIN,
                `${canonical}: numero no entero, se deja la celda vacia`);
            return null;
        }
        // A numeric identifier reaching here already lost its leading zeros upstream
        // (BUG-23: "09994533" -> 9994533). We cannot restore them, but we can stop
        // pretending the column is numeric and we can say so.
        const text = String(raw);
        ctx.issues.add({
            severity: SEVERITY.WARNING,
            code: CODE.TEXT_NORMALIZED,
            message: `${canonical} llego como numero (${raw}); se escribe como texto ` +
                `"${text}". Los ceros a la izquierda ya se perdieron (BUG-23).`,
            columna: canonical,
            valor: raw,
            detalle: { celdaReporte: `${letter}${rowNumber}` },
        });
        return keep(text);
    }
    if (typeof raw !== "string") {
        reject(ctx, canonical, raw, rowNumber, letter, CODE.CODE_OUT_OF_DOMAIN,
            `${canonical}: tipo ${typeof raw} no admitido en una columna de identificador`);
        return null;
    }
    if (raw.trim() === "") return null;
    if (FORBIDDEN_LITERALS.includes(raw)) {
        reject(ctx, canonical, raw, rowNumber, letter, CODE.CODE_OUT_OF_DOMAIN,
            `${canonical}: literal ${JSON.stringify(raw)} rechazado`);
        return null;
    }
    return keep(raw);
}

function coerceGeneric(canonical, raw, ctx, rowNumber, letter) {
    if (typeof raw === "string") {
        if (raw.trim() === "") return null;
        if (FORBIDDEN_LITERALS.includes(raw)) {
            reject(ctx, canonical, raw, rowNumber, letter, CODE.CODE_OUT_OF_DOMAIN,
                `${canonical}: literal ${JSON.stringify(raw)} rechazado (BUG-18/BUG-20)`);
            return null;
        }
        return keep(raw);
    }
    if (typeof raw === "number") {
        if (!Number.isFinite(raw)) {
            reject(ctx, canonical, raw, rowNumber, letter, CODE.CODE_OUT_OF_DOMAIN,
                `${canonical}: ${String(raw)} rechazado, la celda queda vacia (AC 11)`);
            return null;
        }
        return keep(raw);
    }
    if (raw instanceof Date) {
        // Only F/M/O are date columns; a Date anywhere else is a pipeline bug, and
        // writing it would produce a serial under a text format.
        reject(ctx, canonical, raw, rowNumber, letter, CODE.CODE_OUT_OF_DOMAIN,
            `${canonical}: Date fuera de una columna de fecha`);
        return null;
    }
    reject(ctx, canonical, raw, rowNumber, letter, CODE.CODE_OUT_OF_DOMAIN,
        `${canonical}: tipo ${typeof raw} no escribible`);
    return null;
}

function reject(ctx, canonical, raw, rowNumber, letter, code, message) {
    ctx.rejected++;
    ctx.issues.add({
        severity: SEVERITY.WARNING,
        code,
        message,
        columna: canonical,
        valor: raw,
        // `celda` means the SOURCE cell everywhere else in issues.js, and this value never
        // came from one - it is where the value would have landed in the report.
        detalle: { celdaReporte: `${letter}${rowNumber}` },
    });
}

/* ------------------------------------------------------------------ *
 * BUG-08: which dates were unreadable, per row
 * ------------------------------------------------------------------ */

/**
 * `computed.js` needs to tell "no cese date" from "a cese date we could not read", and the
 * record cannot carry that: `dates.js` nulls both. Only the issue stream still knows. This
 * indexes the run's IssueList by source coordinates so every record can be asked.
 *
 * Without it `Bajas2`/`Altas` silently answer "No Aplica" for ~200 text-date rows a month,
 * which is BUG-08 exactly. The caller may override with `options.unparseableDates`.
 */
function buildUnparseableIndex(issues) {
    const items = Array.isArray(issues) ? issues : (issues && Array.isArray(issues.items) ? issues.items : []);
    const index = new Map();
    for (const i of items) {
        if (!i) continue;
        if (i.code !== CODE.DATE_UNPARSEABLE && i.code !== CODE.DATE_IMPLAUSIBLE) continue;
        if (typeof i.columna !== "string" || !i.columna) continue;
        const key = provenanceKey(i.subcontratista, i.archivo, i.hoja, i.fila);
        if (key === null) continue;
        let set = index.get(key);
        if (!set) index.set(key, (set = new Set()));
        set.add(i.columna);
    }
    return index;
}

function provenanceKey(subcontratista, archivo, hoja, fila) {
    if (!Number.isInteger(fila)) return null;
    return `${subcontratista ?? ""} ${archivo ?? ""} ${hoja ?? ""} ${fila}`;
}

function unparseableFor(index, record) {
    const p = record && record.provenance;
    if (!p) return null;
    return index.get(provenanceKey(p.subcontratista, p.archivo, p.hoja, p.filaOrigen)) || null;
}

/** Normalize whatever the caller passed for `options.unparseableDates` into a lookup. */
function resolveUnparseable(option, issues) {
    if (typeof option === "function") return (record, i) => option(record, i);
    if (option instanceof Map) return (record, i) => option.get(record) || option.get(i) || null;
    if (Array.isArray(option)) return (record, i) => option[i] || null;
    const index = buildUnparseableIndex(issues);
    return (record) => unparseableFor(index, record);
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

/**
 * Set a cell's style index directly.
 *
 * xlsx-populate has no public "give this cell style #4" API - `Cell.style()` only takes
 * named style properties, and a new cell otherwise inherits the COLUMN style, which for
 * `Cuadro!F` is numFmtId 164 (`dd.mm.yyyy`) rather than the numFmtId 14 the specimen row
 * and AC 9 require. `_styleId` is read straight back out in `Cell.toXml()`
 * (`node.attributes.s = this._styleId`), so assigning it is exactly equivalent to what the
 * parser does when it reads `s="4"` off the template.
 */
function applyStyle(cell, styleId) {
    if (styleId === null || styleId === undefined) delete cell._styleId;
    else cell._styleId = styleId;
}

/** Write one Excel formula into a cell, preserving `t="array"` / `ref` / `cm` (AD). */
function applyFormula(cell, column, specimenCell, rowNumber) {
    cell.clear();
    if (column.array) {
        cell._formulaType = "array";
        // The array formula's own range. It is per-row; a stale `ref="AD2"` on row 4,000
        // makes Excel recalculate row 2 four thousand times.
        cell._formulaRef = `${column.letter}${rowNumber}`;
    } else {
        cell._formulaType = "normal";
    }
    cell._formula = column.formula;
    if (specimenCell.extra) cell._remainingAttributes = { ...specimenCell.extra };
}

function writeRows(cuadro, records, plan, specimen, period, lookups, unparseableOf, ctx, opts) {
    const writeFormulas = opts.writeFormulas !== false;

    for (let i = 0; i < records.length; i++) {
        const record = records[i] || {};
        const rowNumber = FIRST_DATA_ROW + i;
        const row = cuadro.row(rowNumber);

        for (const [k, v] of Object.entries(specimen.rowAttributes)) {
            row._node.attributes[k] = v;
        }

        // --- A..R, by canonical name. Never `for (let k in record)`. (BUG-13) ---
        for (const { canonical, column } of plan.raw) {
            const cell = row.cell(column.number);
            const spec = specimen.cells.get(column.number);
            applyStyle(cell, spec.styleId);
            // hasOwnProperty, not truthiness: 0 is a legal HPT and a legal coded value.
            const raw = Object.prototype.hasOwnProperty.call(record, canonical)
                ? record[canonical]
                : null;
            const coerced = coerceValue(canonical, raw, ctx, rowNumber, column.letter);
            if (coerced === null) {
                cell.clear();          // genuinely empty: no <v>, no "", no <f>
                ctx.empty++;
            } else {
                cell.value(coerced.value);
                ctx.written++;
            }
        }

        // --- V, W, AG, AH, AI: Option-D literals, by name ---
        const computed = computeRow(record, period, lookups, {
            unparseableDates: unparseableOf(record, i),
        });
        for (const { name, column } of plan.literals) {
            const cell = row.cell(column.number);
            applyStyle(cell, specimen.cells.get(column.number).styleId);
            const value = computed[name];
            if (value === null || value === undefined || value === "") {
                // computed.js is contractually incapable of this - every branch returns a
                // named literal or a finite number. If it ever happens, an empty cell is a
                // (blank) pivot bucket, so it is worth a line rather than a silent pass.
                cell.clear();
                ctx.empty++;
                ctx.issues.add({
                    severity: SEVERITY.ERROR,
                    code: CODE.CODE_OUT_OF_DOMAIN,
                    message: `columna calculada ${JSON.stringify(name)} sin valor en la fila ${rowNumber}`,
                    columna: name,
                    valor: value === undefined ? null : value,
                    detalle: { celdaReporte: `${column.letter}${rowNumber}` },
                });
            } else if (typeof value === "number" && !Number.isFinite(value)) {
                cell.clear();
                ctx.empty++;
                ctx.issues.add({
                    severity: SEVERITY.ERROR,
                    code: CODE.CODE_OUT_OF_DOMAIN,
                    message: `columna calculada ${JSON.stringify(name)} devolvio ${String(value)}`,
                    columna: name,
                    valor: String(value),
                    detalle: { celdaReporte: `${column.letter}${rowNumber}` },
                });
            } else {
                cell.value(value);
                ctx.written++;
                ctx.literalCells++;
            }
        }

        // --- S, T, U, X, Y, Z, AA, AB, AC, AD, AE, AF: Excel keeps these ---
        if (writeFormulas) {
            for (const { column } of plan.formulas) {
                const cell = row.cell(column.number);
                const spec = specimen.cells.get(column.number);
                applyFormula(cell, column, spec, rowNumber);
                applyStyle(cell, spec.styleId);
                ctx.formulaCells++;
            }
        } else {
            for (const { column } of plan.formulas) {
                const cell = row.cell(column.number);
                cell.clear();
                applyStyle(cell, specimen.cells.get(column.number).styleId);
            }
        }
    }

    // Nothing below the last record may survive INSIDE the table. template-v2 ships one
    // data row, so this is normally a no-op - but blanking rather than deleting is exactly
    // how BUG-10 happened, and a template with more rows must not resurrect it.
    let removed = 0;
    const lastRow = FIRST_DATA_ROW + records.length - 1;
    for (let n = lastRow + 1; n < cuadro._rows.length; n++) {
        if (cuadro._rows[n]) {
            delete cuadro._rows[n];   // `_sheetDataNode.children === _rows`, so this deletes the <row>
            removed++;
        }
    }
    return { lastRow, removedRows: removed };
}

/* ------------------------------------------------------------------ *
 * The period, the caption and the Errores sheet
 * ------------------------------------------------------------------ */

function writePeriod(workbook, period, ctx) {
    const hoja1 = workbook.sheet(SHEET_HOJA1);
    if (!hoja1) {
        fail(TEMPLATE_ERROR.TEMPLATE_SHAPE, `la plantilla no tiene la hoja ${SHEET_HOJA1}`);
    }
    // The three defined names point at these cells in template-v2. output/ooxml.js then
    // ALSO rewrites the names to literal constants, so a formula resolves the period even
    // if a future template drops the placeholder cells. Writing both keeps the hidden
    // sheet self-documenting and the two can never disagree - they come from one `period`.
    hoja1.cell(PERIOD_CELLS.inicio).value(period.inicioSerial);
    hoja1.cell(PERIOD_CELLS.fin).value(period.finSerial);
    hoja1.cell(PERIOD_CELLS.etiqueta).value(period.etiqueta);

    const portada = workbook.sheet(SHEET_PORTADA);
    if (!portada) {
        fail(TEMPLATE_ERROR.TEMPLATE_SHAPE, `la plantilla no tiene la hoja ${JSON.stringify(SHEET_PORTADA)}`);
    }
    const caption = `${CAPTION_PREFIX}${period.mesNombre} ${period.year} (${period.etiqueta})`;
    portada.cell(CAPTION_CELL).value(caption);
    ctx.caption = caption;
    return caption;
}

/**
 * Append the `Errores` sheet from `runReport.buildErroresSheet()`'s array-of-arrays.
 *
 * Appended LAST so no existing sheet's position changes: `xl/worksheets/sheetN.xml` is
 * assigned by position at save time, and moving a sheet would renumber the parts that the
 * pivot rels point at.
 */
function writeErrores(workbook, aoa, ctx) {
    if (!Array.isArray(aoa)) return null;
    if (workbook.sheet(SHEET_ERRORES)) {
        fail(TEMPLATE_ERROR.TEMPLATE_SHAPE, `la plantilla ya tiene una hoja ${SHEET_ERRORES}`);
    }
    const sheet = workbook.addSheet(SHEET_ERRORES);

    const widths = [];
    let cells = 0;
    for (let r = 0; r < aoa.length; r++) {
        const rowValues = aoa[r];
        if (!Array.isArray(rowValues)) continue;
        for (let c = 0; c < rowValues.length; c++) {
            const raw = rowValues[c];
            if (raw === null || raw === undefined || raw === "") continue;
            let value = raw;
            if (typeof raw === "number" && !Number.isFinite(raw)) value = "(NaN)";
            else if (typeof raw === "object" && !(raw instanceof Date)) value = JSON.stringify(raw);
            else if (typeof raw === "boolean") value = raw ? "si" : "no";
            sheet.row(r + 1).cell(c + 1).value(value);
            cells++;
            const len = String(value).length;
            if (!widths[c] || widths[c] < len) widths[c] = len;
        }
    }
    // Deterministic widths: a pure function of the content, so two runs of the same data
    // produce the same bytes (AC 26).
    for (let c = 0; c < widths.length; c++) {
        if (!widths[c]) continue;
        sheet.column(c + 1).width(Math.min(70, Math.max(9, widths[c] + 2)));
    }

    registerSheetContentType(workbook, sheet, ctx);
    addSheetToAppProperties(workbook, SHEET_ERRORES, ctx);
    return { hoja: SHEET_ERRORES, filas: aoa.length, celdas: cells, columnas: widths.length };
}

/**
 * xlsx-populate adds the sheet part and its relationship but NOT its
 * `[Content_Types].xml` override, so the new part would inherit
 * `<Default Extension="xml" ContentType="application/xml"/>` and Excel would offer to
 * repair the file (AC 25). Add it here, keyed on the position the writer will use.
 */
function registerSheetContentType(workbook, sheet, ctx) {
    const types = workbook._contentTypes;
    if (!types || typeof types.add !== "function" || typeof types.findByPartName !== "function") {
        ctx.warnings.push("no se pudo registrar el content-type de la hoja Errores");
        return;
    }
    const index = workbook.sheets().indexOf(sheet);
    if (index < 0) {
        ctx.warnings.push("la hoja Errores no aparece en workbook.sheets()");
        return;
    }
    const partName = `/xl/worksheets/sheet${index + 1}.xml`;
    if (!types.findByPartName(partName)) types.add(partName, SHEET_CONTENT_TYPE);
}

/**
 * Keep `docProps/app.xml`'s `TitlesOfParts` in step with the sheet list. Cosmetic - Excel
 * rewrites it on save and tolerates a stale one - but "cosmetic" is not a reason to ship
 * a package whose own manifest disagrees with itself, and AC 25 asks for no repair prompt.
 * Degrades to a warning: a mangled app.xml must not fail a month's report.
 */
function addSheetToAppProperties(workbook, name, ctx) {
    try {
        const node = workbook._appProperties && workbook._appProperties._node;
        if (!node) return;
        const titles = (node.children || []).find(c => c && c.name === "TitlesOfParts");
        const vector = titles && (titles.children || []).find(c => c && c.name === "vt:vector");
        if (!vector) { ctx.warnings.push("docProps/app.xml sin TitlesOfParts/vt:vector"); return; }
        vector.children = vector.children || [];
        vector.children.push({ name: "vt:lpstr", attributes: {}, children: [name] });
        vector.attributes.size = vector.children.length;

        // HeadingPairs is (label, count) pairs. This workbook has exactly one - "Worksheets"
        // - and bumping the wrong counter in a workbook that also declared "Named Ranges"
        // would be worse than leaving it stale, so only the unambiguous case is touched.
        const pairs = (node.children || []).find(c => c && c.name === "HeadingPairs");
        const pairVector = pairs && (pairs.children || []).find(c => c && c.name === "vt:vector");
        const counters = pairVector
            ? (pairVector.children || [])
                .map(v => (v.children || []).find(c => c && c.name === "vt:i4"))
                .filter(Boolean)
            : [];
        if (counters.length === 1 && Number(counters[0].children[0]) === vector.children.length - 1) {
            counters[0].children = [vector.children.length];
        } else if (counters.length) {
            ctx.warnings.push("docProps/app.xml: HeadingPairs no actualizado (mas de un contador)");
        }
    } catch (e) {
        ctx.warnings.push(`docProps/app.xml no actualizado: ${e.message}`);
    }
}

/**
 * Restore `<dimension>` on `Cuadro`.
 *
 * xlsx-populate deletes the node on load (`Sheet._init`) and never writes one back, which
 * 03 §7.4 lists as one of the two OOXML integrity defects in the current output. It is
 * optional in the schema, so its absence is not fatal - but it is free to put back and it
 * is the cheapest thing in the file that tells a reader how big the sheet is.
 */
function setDimension(cuadro, lastColumnLetter, lastRow, ctx) {
    try {
        const node = cuadro._node;
        if (!node || !Array.isArray(node.children)) return null;
        if (node.children.some(c => c && c.name === "dimension")) return null;
        const ref = `A${HEADER_ROW}:${lastColumnLetter}${lastRow}`;
        // `dimension` is the first child in CT_Worksheet's sequence after the optional
        // `sheetPr`, which Cuadro does not have.
        const at = node.children[0] && node.children[0].name === "sheetPr" ? 1 : 0;
        node.children.splice(at, 0, { name: "dimension", attributes: { ref }, children: [] });
        return ref;
    } catch (e) {
        ctx.warnings.push(`<dimension> no restaurado: ${e.message}`);
        return null;
    }
}

/* ------------------------------------------------------------------ *
 * Verification - re-read what we actually shipped
 *
 * Everything below reads the SAVED, PATCHED file. Asserting on the
 * in-memory model would only prove that this module agrees with itself;
 * the defects this rework exists to kill (ghost rows, a table ref that
 * does not match the data, text in a date column) are all properties of
 * the bytes.
 * ------------------------------------------------------------------ */

/**
 * Attribute order inside `<c>` is NOT fixed. xlsx-populate emits any attribute it did not
 * model first (`AD`'s `cm="1"`), then `r`, then `s` - so a regex anchored on `<c r="` sees
 * every cell in the file EXCEPT the array-formula column, which is the one most worth
 * checking. Match the open tag, then pull `r` out of it.
 */
const CELL_RE = /<c\s([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g;
const CELL_REF_RE = /^([A-Z]+)(\d+)$/;

async function verifyOutput(filePath, expectation) {
    const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
    const sheetPart = expectation.sheetPart;
    const entry = zip.file(sheetPart);
    if (!entry) fail(TEMPLATE_ERROR.VERIFY_FAILED, `${sheetPart}: ausente en el archivo generado`);
    const xml = await entry.async("string");

    // Shared strings that are the EMPTY STRING. A `<c t="s"><v>K</v></c>` pointing at one
    // of these is a ghost cell - indistinguishable, from Excel's side, from the 3,757
    // `.value("")` cells of BUG-10.
    const emptyShared = new Set();
    const sst = zip.file("xl/sharedStrings.xml");
    if (sst) {
        const sstXml = await sst.async("string");
        let idx = 0;
        const siRe = /<si>([\s\S]*?)<\/si>/g;
        let sm;
        while ((sm = siRe.exec(sstXml)) !== null) {
            const text = sm[1].replace(/<[^>]*>/g, "");
            if (text === "") emptyShared.add(String(idx));
            idx++;
        }
    }

    const problems = [];
    const push = (what) => { if (problems.length < 25) problems.push(what); };

    const dateColumns = new Set(expectation.dateColumns);
    const literalColumns = new Set(expectation.literalColumns);
    const formulaColumns = new Set(expectation.formulaColumns);
    const rawColumns = new Set(expectation.rawColumns);
    const inTable = new Set([...rawColumns, ...literalColumns, ...formulaColumns]);

    const rowsSeen = new Set();
    const formulaSeen = new Map();
    let maxRow = 0;
    let m;
    CELL_RE.lastIndex = 0;
    while ((m = CELL_RE.exec(xml)) !== null) {
        const attrs = m[1];
        const body = m[3] || "";
        const ref = attr(` ${attrs}`, "r");
        const parts = ref === null ? null : CELL_REF_RE.exec(ref);
        if (!parts) {
            push(`celda sin referencia A1 valida: <c ${attrs}>`);
            continue;
        }
        const col = parts[1];
        const rowNumber = Number(parts[2]);
        if (rowNumber > maxRow) maxRow = rowNumber;
        if (rowNumber < FIRST_DATA_ROW) continue;
        rowsSeen.add(rowNumber);
        if (!inTable.has(col)) {
            push(`${col}${rowNumber}: celda fuera de las 35 columnas de la tabla`);
            continue;
        }

        const type = / t="([^"]*)"/.exec(attrs);
        const hasFormula = body.indexOf("<f") !== -1;
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);

        // 1. no empty strings inside the table (BUG-10, AC 15)
        if (type && type[1] === "s" && v && emptyShared.has(v[1])) {
            push(`${col}${rowNumber}: cadena vacia dentro de Tabla2`);
        }
        if ((type && (type[1] === "str" || type[1] === "inlineStr")) && v && v[1] === "") {
            push(`${col}${rowNumber}: cadena vacia dentro de Tabla2`);
        }

        // 2. the five literal columns carry no formula (05 Fase 4 tarea 3)
        if (literalColumns.has(col) && hasFormula) {
            push(`${col}${rowNumber}: columna literal con <f>`);
        }

        // 3. the twelve formula columns carry one
        if (formulaColumns.has(col)) {
            if (expectation.writeFormulas && !hasFormula) {
                push(`${col}${rowNumber}: columna de formula sin <f>`);
            }
            formulaSeen.set(col, (formulaSeen.get(col) || 0) + (hasFormula ? 1 : 0));
        }

        // 4. every populated date cell is numeric (AC 9)
        if (dateColumns.has(col) && v) {
            if (type) push(`${col}${rowNumber}: fecha con t="${type[1]}" en vez de numerica`);
            else if (!/^-?\d+(\.\d+)?$/.test(v[1])) push(`${col}${rowNumber}: fecha no numerica ${v[1]}`);
        }

        // 5. no #VALUE! and friends (AC 17)
        if (type && type[1] === "e") {
            push(`${col}${rowNumber}: error de formula almacenado (${v ? v[1] : "?"})`);
        }
    }

    // Row arithmetic: exactly `rowCount` data rows, ending exactly where Tabla2 does.
    const expectedLast = FIRST_DATA_ROW + expectation.rowCount - 1;
    if (maxRow !== expectedLast) {
        push(`la ultima fila de ${sheetPart} es ${maxRow} y deberia ser ${expectedLast}`);
    }
    if (rowsSeen.size !== expectation.rowCount) {
        push(`hay ${rowsSeen.size} filas de datos y deberia haber ${expectation.rowCount}`);
    }
    if (expectation.writeFormulas) {
        for (const col of formulaColumns) {
            const n = formulaSeen.get(col) || 0;
            if (n !== expectation.rowCount) {
                push(`${col}: ${n} formulas para ${expectation.rowCount} filas`);
            }
        }
    }

    // The literal strings the acceptance criteria name explicitly (AC 11, AC 12).
    for (const literal of ["undefined", "NaN"]) {
        if (xml.indexOf(`>${literal}<`) !== -1) {
            push(`${sheetPart} contiene el literal ${JSON.stringify(literal)}`);
        }
    }
    if (xml.indexOf("#VALUE!") !== -1) push(`${sheetPart} contiene #VALUE!`);

    // Tabla2 must describe exactly the rows we wrote - ooxml.js resized it, this checks it.
    const tableXml = await zip.file(TABLE_PART).async("string");
    const wantRef = `A1:${expectation.lastColumnLetter}${expectedLast}`;
    for (const [element, want] of [
        ["table", wantRef],
        ["autoFilter", wantRef],
        ["sortState", `A2:${expectation.lastColumnLetter}${expectedLast}`],
        ["sortCondition", `C1:C${expectedLast}`],
    ]) {
        const tag = new RegExp(`<${element}\\b[^>]*>`).exec(tableXml);
        const got = tag ? attr(tag[0], "ref") : null;
        if (got !== want) push(`${TABLE_PART}: <${element} ref="${got}"> deberia ser "${want}"`);
    }

    if (problems.length) {
        fail(TEMPLATE_ERROR.VERIFY_FAILED,
            `el reporte generado no pasa la verificacion estructural: ${problems.join("; ")}`,
            { problemas: problems });
    }
    return { filasVerificadas: rowsSeen.size, ultimaFila: maxRow, tabla: wantRef };
}

/* ------------------------------------------------------------------ *
 * The entry point
 * ------------------------------------------------------------------ */

/**
 * Write the monthly report.
 *
 * @param {Array<object>} records  consolidated records from `schema.parseRow` + `dedupe`.
 *                                 Read BY CANONICAL NAME; key order is irrelevant.
 * @param {object} options
 * @param {string|object} options.period      "YYYY-MM" or a `parsePeriod()` descriptor. Required.
 * @param {IssueList|Array} [options.issues]  appended to; also the default source of the
 *                                            per-row "this date was unreadable" signal.
 * @param {string} [options.templatePath]     defaults to `config.TEMPLATE` (template-v2).
 * @param {string} [options.outPath]          defaults to `<REPORTES_DIR>/<period.filename>`.
 * @param {object} [options.lookups]          `lookups.readLookups()`; passed through to
 *                                            computed.js, which does not use it.
 * @param {Array<Array>} [options.erroresSheet] `runReport.buildErroresSheet()`'s AOA.
 * @param {*} [options.unparseableDates]      override for the BUG-08 signal: a function
 *                                            `(record, i) => iterable`, a Map, or an array.
 * @param {boolean} [options.patch=true]      run `ooxml.patchWorkbook` after saving.
 * @param {boolean} [options.verify=true]     re-read and structurally check the result.
 * @param {boolean} [options.writeFormulas=true] see the header comment. Leave it alone.
 * @returns {Promise<object>} a frozen report.
 */
async function writeReport(records, options = {}) {
    const started = process.hrtime.bigint();
    const ms = (from) => Number(process.hrtime.bigint() - from) / 1e6;

    if (!Array.isArray(records)) {
        fail(TEMPLATE_ERROR.BAD_ARGUMENT, `records debe ser un array, llego ${typeof records}`);
    }
    if (!options || typeof options !== "object") {
        fail(TEMPLATE_ERROR.BAD_ARGUMENT, "writeReport requiere un objeto de opciones");
    }
    const period = typeof options.period === "string" ? parsePeriod(options.period) : options.period;
    if (!period || typeof period !== "object" || !Number.isInteger(period.inicioSerial)) {
        fail(TEMPLATE_ERROR.BAD_ARGUMENT,
            'period es obligatorio: "YYYY-MM" o el descriptor de period.parsePeriod()');
    }
    if (records.length === 0) {
        // A zero-row table has no meaning: `Tabla2` cannot be `A1:AI1`, every pivot would
        // be empty, and clamping to one row manufactures precisely the ghost row §7.2
        // exists to delete. ooxml.js refuses `rowCount < 1` for the same reason.
        fail(TEMPLATE_ERROR.NO_RECORDS,
            "no hay ningun trabajador aceptado: no se genera un reporte vacio, la corrida falla");
    }
    if (records.length > MAX_DATA_ROWS) {
        fail(TEMPLATE_ERROR.TOO_MANY_ROWS,
            `${records.length} filas superan el maximo de Excel (${MAX_DATA_ROWS})`);
    }

    const templatePath = options.templatePath || config.TEMPLATE;
    const outPath = options.outPath || path.join(config.REPORTES_DIR, period.filename);
    const issues = options.issues && typeof options.issues.add === "function"
        ? options.issues
        : new IssueList();
    const ctx = {
        issues,
        written: 0, empty: 0, rejected: 0,
        dateCells: 0, literalCells: 0, formulaCells: 0,
        warnings: [], caption: null,
    };
    const rss = [process.memoryUsage().rss];

    const tOpen = process.hrtime.bigint();
    const workbook = await XlsxPopulate.fromFileAsync(templatePath);
    const openMs = ms(tOpen);

    // The template's own zip is still open inside the workbook; reading table1.xml from it
    // avoids a second full read of an 0.9 MB archive and guarantees the layout we plan
    // against is the layout that will ship.
    if (!workbook._zip || typeof workbook._zip.file !== "function") {
        fail(TEMPLATE_ERROR.TEMPLATE_SHAPE, "xlsx-populate no expone el zip de la plantilla");
    }
    const tableEntry = workbook._zip.file(TABLE_PART);
    if (!tableEntry) fail(TEMPLATE_ERROR.TEMPLATE_SHAPE, `la plantilla no tiene ${TABLE_PART}`);
    const layout = readLayout(await tableEntry.async("string"));
    const plan = buildPlan(layout);

    const cuadro = workbook.sheet(SHEET_CUADRO);
    if (!cuadro) fail(TEMPLATE_ERROR.TEMPLATE_SHAPE, `la plantilla no tiene la hoja ${SHEET_CUADRO}`);
    const specimen = readSpecimen(cuadro, layout, plan);
    const unparseableOf = resolveUnparseable(options.unparseableDates, issues);

    const tWrite = process.hrtime.bigint();
    const { lastRow, removedRows } = writeRows(
        cuadro, records, plan, specimen, period, options.lookups, unparseableOf, ctx, options);
    const writeMs = ms(tWrite);
    rss.push(process.memoryUsage().rss);

    writePeriod(workbook, period, ctx);
    const errores = writeErrores(workbook, options.erroresSheet, ctx);
    const lastColumnLetter = layout.columns[layout.columns.length - 1].letter;
    const dimension = setDimension(cuadro, lastColumnLetter, lastRow, ctx);

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const tSave = process.hrtime.bigint();
    await workbook.toFileAsync(outPath);
    const saveMs = ms(tSave);
    rss.push(process.memoryUsage().rss);

    let ooxml = null;
    if (options.patch !== false) {
        const tPatch = process.hrtime.bigint();
        ooxml = await patchWorkbook(outPath, { rowCount: records.length, period });
        ctx.patchMs = ms(tPatch);
        for (const w of ooxml.warnings || []) {
            issues.add({
                severity: SEVERITY.WARNING,
                code: CODE.CODE_OUT_OF_DOMAIN,
                message: `ooxml: ${w}`,
            });
        }
    }

    let verification = null;
    if (options.verify !== false && options.patch !== false) {
        const tVerify = process.hrtime.bigint();
        verification = await verifyOutput(outPath, {
            sheetPart: sheetPartFor(workbook, cuadro),
            rowCount: records.length,
            lastColumnLetter,
            writeFormulas: options.writeFormulas !== false,
            rawColumns: plan.raw.map(r => r.column.letter),
            literalColumns: plan.literals.map(l => l.column.letter),
            formulaColumns: plan.formulas.map(f => f.column.letter),
            dateColumns: plan.raw
                .filter(r => DATE_COLUMNS.includes(r.canonical))
                .map(r => r.column.letter),
        });
        ctx.verifyMs = ms(tVerify);
    }

    for (const w of ctx.warnings) {
        issues.add({ severity: SEVERITY.WARNING, code: CODE.CODE_OUT_OF_DOMAIN, message: `template: ${w}` });
    }

    return Object.freeze({
        path: outPath,
        templatePath,
        bytes: fs.statSync(outPath).size,
        hoja: SHEET_CUADRO,
        tabla: layout.tableName,
        periodo: period.key,
        filas: records.length,
        ultimaFila: lastRow,
        filasEliminadas: removedRows,
        columnas: Object.freeze({
            total: layout.columns.length,
            datos: plan.raw.length,
            literales: plan.literals.map(l => `${l.column.letter} ${l.name}`),
            formulas: plan.formulas.map(f => `${f.column.letter} ${f.name}`),
        }),
        celdas: Object.freeze({
            escritas: ctx.written,
            vacias: ctx.empty,
            rechazadas: ctx.rejected,
            fechas: ctx.dateCells,
            literales: ctx.literalCells,
            formulas: ctx.formulaCells,
        }),
        caption: ctx.caption,
        dimension,
        errores,
        ooxml,
        verificacion: verification,
        tiempos: Object.freeze({
            abrirMs: round2(openMs),
            escribirMs: round2(writeMs),
            guardarMs: round2(saveMs),
            parcheMs: ctx.patchMs === undefined ? null : round2(ctx.patchMs),
            verificarMs: ctx.verifyMs === undefined ? null : round2(ctx.verifyMs),
            totalMs: round2(ms(started)),
        }),
        rssPicoBytes: Math.max(...rss),
        issues,
    });
}

function round2(n) { return Math.round(n * 100) / 100; }

/** `xl/worksheets/sheetN.xml` for a sheet, using the position xlsx-populate saves by. */
function sheetPartFor(workbook, sheet) {
    const index = workbook.sheets().indexOf(sheet);
    if (index < 0) fail(TEMPLATE_ERROR.TEMPLATE_SHAPE, "la hoja Cuadro no aparece en el libro");
    return `xl/worksheets/sheet${index + 1}.xml`;
}

module.exports = {
    writeReport,

    // structural errors, so callers can tell "the template moved" from "the disk is full"
    TemplateError,
    TEMPLATE_ERROR,

    // the pieces, exported for tests and for anything that needs to reason about layout
    readLayout,
    buildPlan,
    verifyOutput,
    buildUnparseableIndex,
    coerceValue,

    // names and addresses this module writes to
    SHEET_CUADRO,
    SHEET_HOJA1,
    SHEET_PORTADA,
    SHEET_ERRORES,
    PERIOD_CELLS,
    CAPTION_CELL,
    CAPTION_PREFIX,
    HEADER_ROW,
    FIRST_DATA_ROW,
    MAX_DATA_ROWS,
    TABLE_PART,
};

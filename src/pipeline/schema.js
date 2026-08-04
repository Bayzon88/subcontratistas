"use strict";
/**
 * The canonical row schema: where dates, codes, identity and text compose into one
 * validated record (03-expected-output.md §2, 05-implementation-plan.md Phase 2 tasks 4-6).
 *
 * Three rules govern everything below.
 *
 * 1. `z.preprocess`, NEVER `z.coerce`. The raw cell value has to survive into the
 *    `Errores` sheet so the operator can see what the subcontratista actually typed, and
 *    `z.coerce.number("")` quietly yields 0 - the exact class of silent coercion this
 *    rework exists to remove (05 §3 Phase 2 task 5).
 * 2. `safeParse`, and EVERY failing field is collected. One bad cell must not discard the
 *    other 17. The whole 5,065-row corpus was measured at 11.9 ms, so there is no
 *    performance argument for bailing early.
 * 3. Nothing here throws for a data problem and nothing here returns NaN or `undefined`.
 *    A wiring problem (no period, unknown identity mode) still throws, because that is a
 *    bug in the caller, not a defect in a subcontratista's workbook.
 *
 * WHY ZOD IS HERE AT ALL, given that the sibling normalizers already return clean values:
 * it is the second, independent gate. `codes.js` promises `ESTADO` is 1|2|3|null and
 * `dates.js` promises an integer serial or null - but acceptance criteria 11 and 12
 * ("zero NaN", "the literal string \"undefined\" appears zero times") are absolute, and
 * an absolute claim wants a check that does not depend on the module it is checking. The
 * validators below are that check: if any normalizer ever regresses, the field is nulled
 * here and reported, rather than reaching `Cuadro`.
 */

const { z } = require("zod");
const XLSX = require("xlsx");

const {
    CANONICAL,
    DATE_COLUMNS,
    CODED_COLUMNS,
    TEXT_COLUMNS,
    UPPERCASE_COLUMNS,
    TEXT_ID_COLUMNS,
} = require("./columns");
const { CODE, SEVERITY, IssueList } = require("./issues");
const dates = require("./dates");
const codes = require("./codes");
const identity = require("./identity");
const text = require("./text");

/* ------------------------------------------------------------------ *
 * Per-column dispatch
 * ------------------------------------------------------------------ */

const KIND = Object.freeze({
    ruc: "ruc",
    dni: "dni",
    date: "date",
    code: "code",
    text: "text",
    number: "number",
});

/** canonical column -> which sibling module owns it. Built from columns.js so the two
 *  can never drift; a column that belongs to nobody is a build error, asserted below. */
const COLUMN_KIND = Object.freeze(
    CANONICAL.reduce((acc, name) => {
        if (name === "RUC") acc[name] = KIND.ruc;
        else if (name === "Nro. DNI / CE") acc[name] = KIND.dni;
        else if (DATE_COLUMNS.includes(name)) acc[name] = KIND.date;
        else if (CODED_COLUMNS.includes(name)) acc[name] = KIND.code;
        else if (TEXT_COLUMNS.includes(name) || UPPERCASE_COLUMNS.includes(name)) acc[name] = KIND.text;
        else if (name === "HPT") acc[name] = KIND.number;
        return acc;
    }, Object.create(null))
);

for (const name of CANONICAL) {
    if (!COLUMN_KIND[name]) throw new Error(`schema.js: no handler for canonical column ${name}`);
}
if (TEXT_ID_COLUMNS.some(n => COLUMN_KIND[n] !== KIND.ruc && COLUMN_KIND[n] !== KIND.dni)) {
    throw new Error("schema.js: TEXT_ID_COLUMNS drifted from the identity handlers");
}

/**
 * The `Required` column of 03 §2, verbatim.
 *
 * "Required" here means "its absence is worth a line in the Errores sheet", NOT "the row
 * dies without it" - see ROW_REQUIRED below. 03 §8.3 is explicit that a WARNING is "a row
 * accepted with a field nulled", and the measured blank counts make the distinction
 * matter: 660 blank RUC, 723 blank Nro. DNI / CE and 173 blank FECHA NACIMIENTO in the
 * last run. Rejecting those rows would delete a seventh of the workforce from a
 * compliance report to punish a missing field.
 *
 * FECHA CESE/BAJA is "conditional" in §2 and is deliberately absent: its emptiness IS the
 * signal that the worker is still active, and 3,802 of 5,065 rows are empty.
 */
const REQUIRED_COLUMNS = Object.freeze([
    "RUC",
    "EMPRESA",
    "CONTRATISTA PRNCIPAL",
    "Nro. DNI / CE",
    "APELLIDOS Y NOMBRES",
    "FECHA NACIMIENTO",
    "TITULO DE PUESTO/CARGO",
    "DISTRITO SEGÚN DNI",
    "GENERO",
    "NACIONALIDAD",
    "FECHA INICIO DE LABORES EN OBRA",
    "ESTADO",
    "HPT",
]);

/**
 * The only field whose absence kills the row.
 *
 * 03 §8.3 lists three ERROR (row-rejected) cases: "numeric name; unparseable required
 * date; no APELLIDOS Y NOMBRES". The middle one is NOT implemented as a row rejection,
 * and that is a deliberate reading of the spec against itself: §3.7's worked examples
 * write `"3/5/65"` in column F as "*(empty)* + run-report entry" with the row surviving,
 * and acceptance criterion 17 asks for a named `"Sin Fecha"` bucket in `Rango Edades` -
 * which can only exist if rows without a birth date reach the workbook. An unparseable
 * required date therefore nulls its cell at ERROR severity (dates.js's own call) and the
 * row lives. Flip `ctx.rejectOn` to change it without editing this file.
 */
const ROW_REQUIRED = Object.freeze(["APELLIDOS Y NOMBRES"]);

/** Codes that mean "this row was not written to Cuadro". Read by metrics/runReport. */
const ROW_REJECTIONS = Object.freeze([
    CODE.ROW_EMPTY,
    CODE.ROW_NUMERIC_NAME,
    CODE.REQUIRED_MISSING,
]);

/**
 * A shifted row's "name". Same rule as workbook.js (a number, or 8-11 digits of text),
 * reimplemented rather than imported so schema.js does not depend on the file reader -
 * this module is pure and must stay testable without a workbook.
 *
 * Defence in depth for the 643-row header-shift block (03 §2.3): workbook.js rejects it
 * at read time, but only when it managed to resolve the APELLIDOS Y NOMBRES header. When
 * the header is missing, or when schema.js is driven from any other source, this is the
 * remaining guard between `20101155588` and a COUNTIF that turns 643 workers into 1.
 */
const NUMERIC_NAME_RE = /^\d{8,11}$/;

function isNumericName(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value === "boolean") return false;
    return NUMERIC_NAME_RE.test(String(value).trim());
}

/* ------------------------------------------------------------------ *
 * The validators - the independent gate described in the header comment
 * ------------------------------------------------------------------ */

/** Identifiers are TEXT so leading zeros survive: "09994533" must not become 9994533. */
const IDENTIFIER = z.string().min(1).nullable();
/** A date is an integer Excel serial or a genuinely empty cell (BUG-09). Never "". */
const SERIAL = z.number().int().nullable();
/** Free text: a non-empty string or null. "" is never emitted (criterion 15). */
const FREE_TEXT = z.string().min(1).nullable();
/** APELLIDOS Y NOMBRES is the one non-nullable field: no name, no row. */
const NAME = z.string().min(1);

const oneOf = (...values) => z.union(values.map(v => z.literal(v))).nullable();

const VALIDATORS = Object.freeze({
    "RUC": IDENTIFIER,
    "EMPRESA": FREE_TEXT,
    "CONTRATISTA PRNCIPAL": FREE_TEXT,
    "Nro. DNI / CE": IDENTIFIER,
    "APELLIDOS Y NOMBRES": NAME,
    "FECHA NACIMIENTO": SERIAL,
    "TIPO TRABAJADOR": oneOf(1, 2, 3),
    "TITULO DE PUESTO/CARGO": FREE_TEXT,
    "NOMBRE DE OBRA DONDE ESTA ASIGNADO DURANTE EL MES REPORTADO": FREE_TEXT,
    "DOMICILIO DE TRABAJADOR": FREE_TEXT,
    "DISTRITO SEGÚN DNI": FREE_TEXT,
    // The word, lowercase - never the code and never "MASCULINO", which splits the column
    // axis of four pivots (03 §4.4). z.enum makes the literal "undefined" unrepresentable.
    "GENERO": z.enum(["masculino", "femenino"]).nullable(),
    "FECHA CESE/BAJA": SERIAL,
    "NACIONALIDAD": FREE_TEXT,
    "FECHA INICIO DE LABORES EN OBRA": SERIAL,
    "ESTADO": oneOf(1, 2, 3),
    "TIPO DE CONTRATO LABORAL": oneOf(1, 2, 3, 4),
    // `# Horas` on CJ Y EPC - 985,872 hours in FEBRERO_2026. finite() bars NaN/Infinity.
    "HPT": z.number().finite().nonnegative().nullable(),
});

/* ------------------------------------------------------------------ *
 * Provenance helpers
 * ------------------------------------------------------------------ */

/** Which 0-based sheet column this canonical column was read from, or null when the
 *  caller did not pass a headerMap. */
function sheetColumnOf(ctx, canonical) {
    const map = ctx.headerMap;
    if (!map || typeof map !== "object") return null;
    const entry = Object.prototype.hasOwnProperty.call(map, canonical) ? map[canonical] : null;
    if (!entry || !Number.isInteger(entry.col)) return null;
    return entry.col;
}

/**
 * True when the whole COLUMN is absent from the source workbook, as opposed to this one
 * cell being blank. workbook.js already recorded exactly one COLUMN_MISSING warning per
 * file for those, so re-reporting them per row would add 5,065 lines saying the same
 * thing - the HPT case on the older input format (BUG-55).
 */
function columnAbsent(ctx, canonical) {
    if (Array.isArray(ctx.missingColumns)) return ctx.missingColumns.includes(canonical);
    const map = ctx.headerMap;
    if (!map || typeof map !== "object") return false;
    return !Object.prototype.hasOwnProperty.call(map, canonical);
}

/** `{subcontratista, archivo, hoja, fila, celda, columna}` for one cell of one row. */
function cellLocation(ctx, state, canonical) {
    const prov = state.prov;
    const col = sheetColumnOf(ctx, canonical);
    const fila = Number.isInteger(prov.filaOrigen) ? prov.filaOrigen : null;
    // "cell F1743 of SUBCONTRATA X/reporte.xlsx" is the difference between a report that
    // is accurate and one that is actionable (03 §2). Without a headerMap we still know
    // the row and the column name, so we report those and leave celda null rather than
    // inventing the template's own letter, which is not where the value came from.
    const celda = col !== null && fila !== null
        ? XLSX.utils.encode_cell({ r: fila - 1, c: col })
        : null;
    return {
        subcontratista: prov.subcontratista ?? null,
        archivo: prov.archivo ?? null,
        hoja: prov.hoja ?? null,
        fila,
        celda,
        columna: canonical,
    };
}

function normalizeProvenance(source) {
    const p = source && typeof source === "object" ? source : {};
    return {
        subcontratista: p.subcontratista ?? null,
        archivo: p.archivo ?? null,
        hoja: p.hoja ?? null,
        filaOrigen: Number.isInteger(p.filaOrigen) ? p.filaOrigen : null,
        celdaAncla: p.celdaAncla ?? null,
    };
}

/* ------------------------------------------------------------------ *
 * Per-kind preparation. Each returns the value the validator will see.
 * ------------------------------------------------------------------ */

function prepareRuc(raw, ctx, state, canonical) {
    const r = identity.normalizeRuc(raw);
    // identity.js is pure by design and never builds an IssueList: it returns the verdict
    // and the code/severity, and the caller stamps it because the caller is the one that
    // knows celda/archivo/subcontratista.
    if (r.code) {
        state.said.add(canonical);
        addIssue(ctx, r.severity, {
            code: r.code,
            message: r.reason,
            ...cellLocation(ctx, state, canonical),
            valor: raw,
            detalle: { valid: r.valid },
        });
    }
    return r.text === "" ? null : r.text;
}

function prepareDni(raw, ctx, state, canonical) {
    const r = identity.normalizeDni(raw);
    if (r.code) {
        state.said.add(canonical);
        addIssue(ctx, r.severity, {
            code: r.code,
            message: r.reason,
            ...cellLocation(ctx, state, canonical),
            valor: raw,
            detalle: { valid: r.valid, kind: r.kind, padded: r.padded },
        });
    }
    return r.text === "" ? null : r.text;
}

function prepareDate(raw, ctx, state, canonical) {
    const r = dates.parseDateCell(raw, canonical, {
        period: ctx.period,
        issues: ctx.issues,
        location: cellLocation(ctx, state, canonical),
        date1904: ctx.date1904 === true,
        config: ctx.config,
    });
    state.dateResults[canonical] = r;
    if (!r.ok && !r.empty) state.said.add(canonical);
    return r.ok ? r.serial : null;
}

function prepareCode(raw, ctx, state, canonical) {
    const loc = cellLocation(ctx, state, canonical);
    const r = codes.normalizeCode(canonical, raw, {
        issues: ctx.issues,
        subcontratista: loc.subcontratista,
        archivo: loc.archivo,
        hoja: loc.hoja,
        fila: loc.fila,
        celda: loc.celda,
    });
    if (!r.ok) state.said.add(canonical);
    return r.value;
}

function prepareText(raw, ctx, state, canonical) {
    const r = text.normalizeForColumn(canonical, raw);

    // `coerced` (a number, a Date, a boolean in a text column) is a misfiling, not a
    // whitespace defect - text.js keeps the two flags apart precisely so this one can be
    // reported and the other one cannot bury it. issues.js is a frozen contract with no
    // "wrong type in a text column" code, so this rides on TEXT_NORMALIZED, distinguished
    // by severity (WARNING) and by detalle.coerced.
    if (r.coerced) {
        state.said.add(canonical);
        addIssue(ctx, SEVERITY.WARNING, {
            code: CODE.TEXT_NORMALIZED,
            message: `${canonical} recibio un valor que no es texto (${describeType(raw)})` +
                (r.value === null ? " y no tiene forma textual: se anula" : `: se convierte a "${r.value}"`),
            ...cellLocation(ctx, state, canonical),
            valor: raw,
            detalle: { coerced: true, tipo: describeType(raw), normalizado: r.value },
        });
    } else if (r.changed) {
        // 4,000+ cells in the last run are altered by trim/collapse/uppercase alone
        // (1,988 in NACIONALIDAD, 835 in APELLIDOS Y NOMBRES, 343 in CONTRATISTA
        // PRNCIPAL). One INFO line each would be four times the size of every other
        // finding combined and would make the Errores sheet unreadable - the exact
        // failure mode zip.js aggregated SKIPPED_MACOSX to avoid. They are returned on
        // `result.normalizations` instead, for runReport.js to present as the grouped
        // "spellings that differ only by whitespace" section 03 §8.2 asks for.
        // Set ctx.emitTextNormalizedIssues = true to get the per-cell INFO line.
        state.normalizations.push({ columna: canonical, valor: raw, normalizado: r.value });
        if (ctx.emitTextNormalizedIssues === true) {
            addIssue(ctx, SEVERITY.INFO, {
                code: CODE.TEXT_NORMALIZED,
                message: `${canonical} normalizado: "${raw}" -> "${r.value}"`,
                ...cellLocation(ctx, state, canonical),
                valor: raw,
                detalle: { normalizado: r.value },
            });
        }
    }
    return r.value;
}

/** Decimal comma: "8,5" is 8.5 in a Peruvian locale. Accepted only when there is exactly
 *  one comma with 1-2 digits after it and no dot, so "1,234" stays a rejection rather
 *  than silently becoming 1.234 hours. */
const PLAIN_NUMBER_RE = /^-?(?:\d+|\d*\.\d+)$/;
const DECIMAL_COMMA_RE = /^-?\d+,\d{1,2}$/;

function prepareNumber(raw, ctx, state, canonical) {
    if (raw === null || raw === undefined) return null;

    if (typeof raw === "number") {
        if (Number.isFinite(raw)) return raw;
        return rejectNumber(raw, ctx, state, canonical, "no es finito");
    }
    // A boolean would become 1 or 0 under Number(); an hours column has no true/false.
    if (typeof raw !== "string") {
        return rejectNumber(raw, ctx, state, canonical, `es ${describeType(raw)}`);
    }

    const trimmed = raw.replace(/\s+/g, "");
    if (trimmed === "") return null;

    let parsed = null;
    if (PLAIN_NUMBER_RE.test(trimmed)) parsed = Number(trimmed);
    else if (DECIMAL_COMMA_RE.test(trimmed)) parsed = Number(trimmed.replace(",", "."));
    else return rejectNumber(raw, ctx, state, canonical, "no es numerico");

    if (!Number.isFinite(parsed)) return rejectNumber(raw, ctx, state, canonical, "no es finito");

    addIssue(ctx, SEVERITY.INFO, {
        code: CODE.TEXT_NORMALIZED,
        message: `${canonical} llego como texto "${raw}" y se interpreta como ${parsed}`,
        ...cellLocation(ctx, state, canonical),
        valor: raw,
        detalle: { normalizado: parsed },
    });
    return parsed;
}

function rejectNumber(raw, ctx, state, canonical, motivo) {
    state.said.add(canonical);
    // No NUMBER_* code exists and issues.js is a contract this module must not extend.
    // CODE_OUT_OF_DOMAIN carries the same meaning here: the value is outside the column's
    // allowed set (finite, >= 0) and the field is nulled with the row accepted (03 §8.3).
    addIssue(ctx, SEVERITY.WARNING, {
        code: CODE.CODE_OUT_OF_DOMAIN,
        message: `${canonical} ${motivo}: se anula`,
        ...cellLocation(ctx, state, canonical),
        valor: raw,
        detalle: { esperado: "numero finito >= 0" },
    });
    return null;
}

/** dates.fmtYMD throws on null, and serialToYMD returns null outside 1..2958465. */
function showSerial(serial) {
    const ymd = dates.serialToYMD(serial);
    return ymd ? dates.fmtYMD(ymd) : String(serial);
}

function describeType(v) {
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    if (v instanceof Date) return "Date";
    return typeof v;
}

const PREPARERS = Object.freeze({
    [KIND.ruc]: prepareRuc,
    [KIND.dni]: prepareDni,
    [KIND.date]: prepareDate,
    [KIND.code]: prepareCode,
    [KIND.text]: prepareText,
    [KIND.number]: prepareNumber,
});

/**
 * Run one column's normalizer exactly once per row.
 *
 * The memo is not an optimisation. zod may evaluate a field more than once across the
 * two-pass repair below, and a normalizer that records issues is not idempotent from the
 * IssueList's point of view - without the memo, a bad ESTADO would appear twice in the
 * Errores sheet and criterion 7's row arithmetic would stop reconciling.
 */
function prepare(canonical, raw, ctx, state) {
    if (state.memo.has(canonical)) return state.memo.get(canonical);
    const value = PREPARERS[COLUMN_KIND[canonical]](raw, ctx, state, canonical);
    state.memo.set(canonical, value);
    return value;
}

function addIssue(ctx, severity, o) {
    return ctx.issues.add({ ...o, severity });
}

/* ------------------------------------------------------------------ *
 * Schema construction
 * ------------------------------------------------------------------ */

/** Where parseRow parks the row currently being parsed, so the schema can be built once
 *  per ctx instead of once per row (5,065 rows x 18 fields is 91k schema objects
 *  otherwise). Safe because a parse is synchronous and single-threaded start to finish. */
const ROW_STATE = Symbol("schema.rowState");

function freshState() {
    return {
        raw: null,
        prov: normalizeProvenance(null),
        memo: new Map(),
        dateResults: Object.create(null),
        normalizations: [],
        said: new Set(),   // columns that already produced an issue - see requiredness
    };
}

/**
 * Build the row schema for one context.
 *
 * @param {object} ctx
 * @param {*}        ctx.period   report period; anything dates.resolvePeriodEnd accepts. REQUIRED.
 * @param {IssueList} [ctx.issues] collector; a fresh one is created when omitted
 * @param {object}   [ctx.provenance] default provenance when a row carries none
 * @param {object}   [ctx.headerMap]  canonical -> {col} from workbook.js; gives real cell addresses
 * @param {string[]} [ctx.missingColumns] canonical columns absent from the source workbook
 * @param {boolean}  [ctx.date1904]   the workbook's date system
 * @param {object}   [ctx.config]     tunable overrides for dates.js
 * @param {boolean}  [ctx.emitTextNormalizedIssues] per-cell INFO for whitespace/case fixes
 * @returns {import("zod").ZodObject} keys in CANONICAL order
 */
function buildRowSchema(ctx) {
    const bound = prepareContext(ctx);
    const state = freshState();

    const shape = Object.create(null);
    for (const canonical of CANONICAL) {
        // z.preprocess, never z.coerce: the preprocessor hands the validator a value the
        // sibling module already vouched for, and the RAW value is still in `state.raw`
        // and in every issue's `valor` field.
        shape[canonical] = z.preprocess(
            raw => prepare(canonical, raw, bound, state),
            VALIDATORS[canonical]
        );
    }

    // .strip() (the default) drops `provenance`, which workbook.js stamps on every row.
    // parseRow re-attaches it afterwards - 03 §2 requires provenance to survive to the
    // output, and today's pipeline deletes it at excelConsolidation.js:66.
    const schema = z.object(shape);
    Object.defineProperty(schema, ROW_STATE, { value: { state, ctx: bound }, enumerable: false });
    return schema;
}

/**
 * Validate and freeze the caller's context.
 *
 * A missing period throws. It is a wiring bug, and the wall-clock fallback that would
 * "fix" it is the single defect this rework exists to remove (period.js keeps the only
 * clock read in the pipeline at the CLI/server boundary).
 */
function prepareContext(ctx) {
    if (!ctx || typeof ctx !== "object") {
        throw new TypeError("schema.js: ctx is required and must carry a period");
    }
    if (ctx.period === undefined || ctx.period === null) {
        throw new TypeError(
            "schema.js: ctx.period is required - date plausibility is evaluated against the " +
            "report period, never against the wall clock (03 §3.5, 05 §8 Q1)"
        );
    }
    // Fail here rather than 5,065 times inside parseDateCell.
    dates.resolvePeriodEnd(ctx.period);

    return {
        period: ctx.period,
        issues: ctx.issues instanceof IssueList ? ctx.issues : (ctx.issues || new IssueList()),
        provenance: ctx.provenance || null,
        headerMap: ctx.headerMap || null,
        missingColumns: ctx.missingColumns || null,
        date1904: ctx.date1904 === true,
        config: ctx.config,
        emitTextNormalizedIssues: ctx.emitTextNormalizedIssues === true,
        rejectOn: Array.isArray(ctx.rejectOn) ? ctx.rejectOn : ROW_REQUIRED,
    };
}

/** A record with all 18 canonical keys in order, every value null. */
function emptyRecord() {
    const out = {};
    for (const canonical of CANONICAL) out[canonical] = null;
    return out;
}

/** True when not one of the 18 canonical cells carries anything. */
function rowIsEmpty(rawRow) {
    if (!rawRow || typeof rawRow !== "object") return true;
    for (const canonical of CANONICAL) {
        const v = rawRow[canonical];
        if (v === null || v === undefined) continue;
        if (typeof v === "string" && v.trim() === "") continue;
        return false;
    }
    return true;
}

/* ------------------------------------------------------------------ *
 * Parsing one row
 * ------------------------------------------------------------------ */

function rejectedResult(ctx, prov, reason, issuesFrom) {
    return {
        ok: false,
        record: null,
        rejected: true,
        reason,
        issues: ctx.issues.items.slice(issuesFrom),
        normalizations: [],
        provenance: prov,
    };
}

/**
 * Parse one raw row into a canonical record.
 *
 * @param {object} rawRow  the 18 canonical keys with RAW cell values, plus the optional
 *                         `provenance` key workbook.js stamps. Extra keys are ignored.
 * @param {object} ctx     see buildRowSchema
 * @returns {{ok: boolean, record: object|null, issues: object[], rejected: boolean,
 *            reason: string|null, normalizations: object[], provenance: object}}
 *
 * `record` carries the 18 canonical keys in CANONICAL order followed by `provenance`.
 * That order is a convenience for readers and for diffing - output/template.js still
 * places every value by NAME, not by position (BUG-13).
 */
function parseRow(rawRow, ctx) {
    return parseWithSchema(rawRow, schemaFor(ctx));
}

/** The body of parseRow, against an already-compiled schema. */
function parseWithSchema(rawRow, schema) {
    const bag = schema[ROW_STATE];
    const bound = bag.ctx;
    const state = bag.state;
    const issuesFrom = bound.issues.items.length;

    // Reset the per-row scratch space. Reusing one object keeps the schema build off the
    // hot path; the fields below are the entirety of the mutable state.
    state.raw = rawRow;
    state.prov = normalizeProvenance(
        (rawRow && rawRow.provenance) || bound.provenance
    );
    state.memo.clear();
    state.dateResults = Object.create(null);
    state.normalizations = [];
    state.said.clear();

    // ---- row viability, before any field work ---------------------------
    //
    // This is not "bailing on the first failure": the two checks below decide whether the
    // row exists at all, and a row we are going to discard should contribute ONE line to
    // the Errores sheet naming the reason - not eighteen lines about the cells of a row
    // nobody will ever see. Every FIELD failure still collects independently (below).
    if (rowIsEmpty(rawRow)) {
        // INFO, not ERROR: a blank row is a non-event (workbook.js already drops them),
        // and counting it as a rejection would make criterion 7's
        // "found - rejected = accepted" arithmetic report noise as damage.
        bound.issues.info({
            code: CODE.ROW_EMPTY,
            message: `fila ${state.prov.filaOrigen ?? "?"} vacia: se omite`,
            subcontratista: state.prov.subcontratista,
            archivo: state.prov.archivo,
            hoja: state.prov.hoja,
            fila: state.prov.filaOrigen,
        });
        return rejectedResult(bound, state.prov, CODE.ROW_EMPTY, issuesFrom);
    }

    const NAME_COLUMN = identity.NAME_COLUMN;
    const rawName = rawRow[NAME_COLUMN];
    if (bound.rejectOn.includes(NAME_COLUMN) && isNumericName(rawName)) {
        bound.issues.error({
            code: CODE.ROW_NUMERIC_NAME,
            message: `fila ${state.prov.filaOrigen ?? "?"} rechazada: "${NAME_COLUMN}" es numerico ` +
                `("${rawName}") - la hoja probablemente tiene las columnas desplazadas (03 §2.3)`,
            ...cellLocation(bound, state, NAME_COLUMN),
            valor: rawName,
        });
        return rejectedResult(bound, state.prov, CODE.ROW_NUMERIC_NAME, issuesFrom);
    }

    // ---- every field, every failure -------------------------------------
    const result = schema.safeParse(rawRow);

    let record;
    let rejected = false;
    let reason = null;

    if (result.success) {
        record = result.data;
    } else {
        // safeParse discards `data` on failure, so the surviving 17 fields are recovered
        // from the memo. Nulling the offenders is enough to make the record valid by
        // construction: every validator except NAME accepts null.
        record = emptyRecord();
        for (const canonical of CANONICAL) {
            record[canonical] = state.memo.has(canonical) ? state.memo.get(canonical) : null;
        }
        for (const zi of result.error.issues) {
            const canonical = Array.isArray(zi.path) ? zi.path[0] : null;
            if (typeof canonical !== "string" || !(canonical in record)) continue;
            const raw = rawRow[canonical];

            if (bound.rejectOn.includes(canonical)) {
                rejected = true;
                reason = CODE.REQUIRED_MISSING;
                bound.issues.error({
                    code: CODE.REQUIRED_MISSING,
                    message: `fila ${state.prov.filaOrigen ?? "?"} rechazada: "${canonical}" es obligatorio (${zi.message})`,
                    ...cellLocation(bound, state, canonical),
                    valor: raw,
                });
                continue;
            }

            record[canonical] = null;
            // Reaching here means a sibling normalizer returned something its own contract
            // forbids - the second gate the header comment describes. It is a code defect,
            // reported at WARNING so the field is nulled and the row survives.
            bound.issues.warning({
                code: CODE.CODE_OUT_OF_DOMAIN,
                message: `${canonical} no cumple el esquema (${zi.message}): se anula`,
                ...cellLocation(bound, state, canonical),
                valor: raw,
                detalle: { zod: zi.code, esperado: zi.message },
            });
            state.said.add(canonical);
        }
        if (rejected) return rejectedResult(bound, state.prov, reason, issuesFrom);
    }

    // ---- requiredness (03 §2 "Required"), after the field work ----------
    for (const canonical of REQUIRED_COLUMNS) {
        if (record[canonical] !== null) continue;
        if (state.said.has(canonical)) continue;        // already explained by its own module
        if (columnAbsent(bound, canonical)) continue;   // workbook.js said it once, per file
        if (COLUMN_KIND[canonical] === KIND.date && state.dateResults[canonical]
            && !state.dateResults[canonical].empty) continue;  // dates.js already spoke
        bound.issues.warning({
            code: CODE.REQUIRED_MISSING,
            message: `${canonical} es obligatorio y llego vacio`,
            ...cellLocation(bound, state, canonical),
            valor: rawRow[canonical] ?? null,
        });
    }

    // ---- the one cross-field rule (03 §3.5) -----------------------------
    // "A cese before the start date is a data error." dates.js range-checks each column in
    // isolation and exports compareYMD for exactly this; the pair is schema.js's to own.
    const cese = record["FECHA CESE/BAJA"];
    const inicio = record["FECHA INICIO DE LABORES EN OBRA"];
    if (cese !== null && inicio !== null && cese < inicio) {
        record["FECHA CESE/BAJA"] = null;
        bound.issues.warning({
            code: CODE.DATE_IMPLAUSIBLE,
            message: `FECHA CESE/BAJA (${showSerial(cese)}) es anterior a ` +
                `FECHA INICIO DE LABORES EN OBRA (${showSerial(inicio)}): se anula el cese`,
            ...cellLocation(bound, state, "FECHA CESE/BAJA"),
            valor: rawRow["FECHA CESE/BAJA"],
            detalle: {
                ceseSerial: cese,
                inicioSerial: inicio,
                cese: showSerial(cese),
                inicio: showSerial(inicio),
            },
        });
    }

    record.provenance = state.prov;

    return {
        ok: true,
        record,
        rejected: false,
        reason: null,
        issues: bound.issues.items.slice(issuesFrom),
        normalizations: state.normalizations,
        provenance: state.prov,
    };
}

/**
 * One compiled schema per ctx object.
 *
 * Callers that hold one ctx per workbook (the intended shape - run.js builds it from the
 * readWorkbook result) pay for the build once. A caller that hands parseRow a fresh
 * object literal per row pays per row; use createRowParser to make the cost obvious.
 */
const SCHEMA_CACHE = new WeakMap();

function schemaFor(ctx) {
    if (!ctx || typeof ctx !== "object") return buildRowSchema(ctx);
    let schema = SCHEMA_CACHE.get(ctx);
    if (!schema) {
        schema = buildRowSchema(ctx);
        SCHEMA_CACHE.set(ctx, schema);
    }
    return schema;
}

/**
 * The explicit form: compile once, parse many.
 * @returns {{schema, ctx, parseRow: (rawRow: object) => object}}
 */
function createRowParser(ctx) {
    const schema = buildRowSchema(ctx);
    const bound = schema[ROW_STATE].ctx;
    return {
        schema,
        ctx: bound,
        issues: bound.issues,
        parseRow: rawRow => parseWithSchema(rawRow, schema),
    };
}

module.exports = {
    buildRowSchema,
    createRowParser,
    parseRow,
    emptyRecord,
    rowIsEmpty,
    isNumericName,
    NUMERIC_NAME_RE,
    COLUMN_KIND,
    KIND,
    VALIDATORS,
    REQUIRED_COLUMNS,
    ROW_REQUIRED,
    ROW_REJECTIONS,
};

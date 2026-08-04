"use strict";
/**
 * The three business-owned lookup tables, read out of the report template at run time.
 *
 * They are NEVER hard-coded here (05-implementation-plan.md §2.1 and §5): the business
 * curates them in Excel, and moving them into JS moves ownership away from the people
 * who maintain them. This module's whole job is the geometry - where the tables live,
 * how their keys are matched, and what is wrong with them today.
 *
 *   Hoja1!A2:B61   distrito -> Zona de Influencia   (60 slots, 56 populated)
 *   Hoja1!L5:M9    contratista -> EPC               (header at row 5 + 4 entries)
 *   Sheet1!A:B     Razon Social -> Nombre Comercial (header + 82 data rows)
 *
 * The template consumes the first two from calculated columns in xl/tables/table1.xml:
 *   Zona de Influencia  +IFERROR(VLOOKUP(TRIM([DISTRITO SEGÚN DNI]),Hoja1!$A$2:$B$61,2,FALSE),"No")
 *   EPC/CJV              IFERROR(VLOOKUP([CONTRATISTA PRNCIPAL],Hoja1!$L$5:$M$9,2,FALSE),"CJV")
 * so "No" and "CJV" are the template's own sentinels, exported below. They are formula
 * literals, not table data, which is why they may live in code.
 *
 * Excel's VLOOKUP(..., FALSE) is exact-match and case-insensitive. Our Map is keyed on a
 * stronger normalization (trim + collapse internal whitespace + accent-fold + upper), so
 * it resolves strings the live template cannot - most importantly the 14 padded keys of
 * BUG-29. That is a fix, and it is deliberate; the defect record below counts exactly how
 * many keys it papered over so Phase 4 task 7 (which cleans them in template-v2.xlsx) is
 * verifiable rather than asserted.
 */

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

const { normalizeHeader } = require("./columns");
const { CODE } = require("./issues");

/**
 * Lookup keys use the SAME normalizer as the header matcher. One implementation, so the
 * two can never drift, and so "CERCADO DE  LIMA" (doubled internal space) resolves through
 * both. columns.js owns the rule; this is an alias for readability, not a second copy.
 */
const normalizeKey = normalizeHeader;

/** The template's own IFERROR sentinels. Callers pass them as the fallback to `get`. */
const ZONA_DEFAULT = "No";
const EPC_DEFAULT = "CJV";

/**
 * Table geometry.
 *
 * `last: null` means "derive the last row from the sheet's !ref" - Sheet1 is referenced by
 * no formula anywhere in the workbook (a grep for `Sheet1!` across every worksheet, table
 * and pivot part returns zero hits, 03-expected-output.md §5.3), so it has no fixed range
 * to honour; the other two are pinned by the calculated-column formulas above.
 *
 * `consumed` says whether a VLOOKUP reads the table today. It gates the "this key can never
 * match" report: an unreachable key only strands data if something actually looks it up.
 */
const TABLES = Object.freeze({
    zona: Object.freeze({
        sheet: "Hoja1", keyCol: "A", valueCol: "B",
        first: 2, last: 61, headerRow: null, defaultValue: ZONA_DEFAULT, consumed: true,
    }),
    epc: Object.freeze({
        sheet: "Hoja1", keyCol: "L", valueCol: "M",
        first: 5, last: 9, headerRow: 5, defaultValue: EPC_DEFAULT, consumed: true,
    }),
    nombre: Object.freeze({
        sheet: "Sheet1", keyCol: "A", valueCol: "B",
        first: 1, last: null, headerRow: 1, defaultValue: null, consumed: false,
    }),
});

/** Guard on the derived range so a corrupt !ref cannot make us walk millions of rows. */
const MAX_DERIVED_ROWS = 5000;

/* ------------------------------------------------------------------ helpers */

/** Excel's TRIM: strip leading/trailing whitespace and collapse internal runs to one space. */
function excelTrim(value) {
    return String(value).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

/** A cell holds nothing we care about. Blank strings count as empty; the number 0 does not. */
function isBlank(v) {
    return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

/* ------------------------------------------------------------- LookupTable */

/**
 * One table. `get` normalizes its argument the same way the keys were normalized, which is
 * what makes padded and case-varied input resolve.
 *
 * On duplicate normalized keys, FIRST wins - VLOOKUP(..., FALSE) returns the first match,
 * and this module must not disagree with the workbook it read.
 */
class LookupTable {
    /**
     * @param {string} name
     * @param {Array<{fila:number, clave:*, valor:*}>} rows verbatim, in sheet order
     * @param {*} defaultValue the template's IFERROR sentinel, or null
     */
    constructor(name, rows, defaultValue) {
        this.name = name;
        this.rows = rows;
        this.defaultValue = defaultValue === undefined ? null : defaultValue;
        this.byNormalized = new Map();
        for (const r of rows) {
            if (isBlank(r.clave)) continue;
            const k = normalizeKey(r.clave);
            if (!k) continue;
            if (!this.byNormalized.has(k)) this.byNormalized.set(k, r.valor);
        }
    }

    /**
     * @param {*} value raw lookup value, normalized here
     * @param {*} [fallback] what the caller wants when the key is unknown; defaults to null,
     *                       NOT to the template sentinel - the caller decides (03 §5.1 Y/S).
     */
    get(value, fallback = null) {
        if (isBlank(value)) return fallback;
        const hit = this.byNormalized.get(normalizeKey(value));
        return hit === undefined ? fallback : hit;
    }

    has(value) {
        if (isBlank(value)) return false;
        return this.byNormalized.has(normalizeKey(value));
    }

    /** Distinct normalized keys. Lower than rows.length wherever the table has twins. */
    get size() { return this.byNormalized.size; }

    keys() { return [...this.byNormalized.keys()]; }
    entries() { return [...this.byNormalized.entries()]; }

    /** Distinct values, verbatim (so `"SAN LUIS "` keeps its trailing space - see defects). */
    values() {
        const seen = new Set();
        const out = [];
        for (const v of this.byNormalized.values()) {
            const k = String(v);
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(v);
        }
        return out;
    }
}

/* ---------------------------------------------------------- defect analysis */

/**
 * What is wrong with one table, measured rather than assumed. Nothing here is repaired -
 * the repair belongs in template-v2.xlsx (05 §3 Phase 4 task 7) and these counts are how
 * that repair is proved.
 *
 * `unreachableKeys` models the LIVE template, so it uses Excel's rules and not ours: a key
 * is reachable iff some input string could equal it after TRIM(), i.e. iff the key already
 * has no padding and no doubled internal space. `strandedKeys` are the unreachable ones
 * with no reachable case-insensitive twin carrying the same value - those, and only those,
 * are keys that always fall through to the IFERROR sentinel.
 */
function analyzeTable(rows) {
    const paddedKeys = [];
    const internalWhitespaceKeys = [];
    const paddedValues = [];
    const blankKeys = [];
    const unreachableKeys = [];

    for (const r of rows) {
        if (isBlank(r.clave)) {
            blankKeys.push(r);
        } else if (typeof r.clave === "string") {
            if (r.clave !== r.clave.trim()) paddedKeys.push(r);
            else if (excelTrim(r.clave) !== r.clave) internalWhitespaceKeys.push(r);
            if (excelTrim(r.clave) !== r.clave) unreachableKeys.push(r);
        }
        if (typeof r.valor === "string" && r.valor !== r.valor.trim()) paddedValues.push(r);
    }

    // Reachable keys, indexed the way Excel compares them: exact bytes, case-insensitive.
    const reachableByUpper = new Map();
    for (const r of rows) {
        if (typeof r.clave !== "string" || excelTrim(r.clave) !== r.clave) continue;
        const u = r.clave.toUpperCase();
        if (!reachableByUpper.has(u)) reachableByUpper.set(u, []);
        reachableByUpper.get(u).push(r);
    }
    const strandedKeys = unreachableKeys.filter(r => {
        const twins = reachableByUpper.get(excelTrim(r.clave).toUpperCase()) || [];
        return !twins.some(t => String(t.valor) === String(r.valor));
    });

    // Groups under OUR normalization. A group with more than one distinct value is a real
    // ambiguity; a group with one value is a deliberate twin (case, accent or padding) and
    // is NOT reported as a duplicate - VLOOKUP is case-insensitive, so twins are by design.
    const groups = new Map();
    for (const r of rows) {
        if (isBlank(r.clave)) continue;
        const k = normalizeKey(r.clave);
        if (!k) continue;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
    }
    const collisions = [];
    let twinRows = 0;
    for (const [k, g] of groups) {
        if (g.length > 1) twinRows += g.length - 1;
        const distinct = new Set(g.map(r => String(r.valor)));
        if (distinct.size > 1) {
            collisions.push({ clave: k, entradas: g.map(r => ({ fila: r.fila, valor: r.valor })) });
        }
    }

    // Exact-string duplicate keys, the number BUG-29 quotes (5 for the zona table).
    const exactCounts = new Map();
    for (const r of rows) {
        if (typeof r.clave !== "string") continue;
        exactCounts.set(r.clave, (exactCounts.get(r.clave) || 0) + 1);
    }
    const exactDuplicateKeys = [...exactCounts.entries()]
        .filter(([, n]) => n > 1)
        .map(([clave, veces]) => ({ clave, veces }));

    return {
        /** Keys with leading or trailing whitespace. 14 in Hoja1!A2:B61 (BUG-29). */
        paddedKeys,
        /** Keys with a doubled internal space but no padding. 1: "CERCADO DE  LIMA" (r47). */
        internalWhitespaceKeys,
        /** Union of the two above: every key our normalization had to repair. 15 for zona. */
        keysNormalized: unreachableKeys.length,
        /** The same list, named for what it means in the live template. */
        unreachableKeys,
        /** Unreachable AND untwinned: permanently resolves to the IFERROR sentinel. */
        strandedKeys,
        /** Values with padding. "SAN LUIS " propagates verbatim into every pivot label. */
        paddedValues,
        /** Rows with a value but no key. */
        blankKeys,
        /** Two keys that normalize alike but map to DIFFERENT values. A real ambiguity. */
        collisions,
        /** Rows absorbed by an identical normalized key. Informational, not a defect. */
        twinRows,
        /** Byte-identical repeated keys. */
        exactDuplicateKeys,
    };
}

/* ------------------------------------------------------------------ reading */

/** Pull one rectangular key/value table out of a parsed sheet. */
function readTable(sheet, spec) {
    if (!sheet) return { rows: [], slots: 0, last: spec.last, header: null, missing: true };

    let last = spec.last;
    if (last === null) {
        const ref = sheet["!ref"];
        if (!ref) return { rows: [], slots: 0, last: spec.first, header: null, missing: true };
        last = Math.min(XLSX.utils.decode_range(ref).e.r + 1, spec.first + MAX_DERIVED_ROWS);
    }

    const rows = [];
    let header = null;
    for (let r = spec.first; r <= last; r++) {
        const kc = sheet[spec.keyCol + r];
        const vc = sheet[spec.valueCol + r];
        const clave = kc ? kc.v : undefined;
        const valor = vc ? vc.v : undefined;
        if (isBlank(clave) && isBlank(valor)) continue;   // Hoja1 rows 28-31 are genuinely empty
        const row = { fila: r, clave: clave === undefined ? null : clave, valor: valor === undefined ? null : valor };
        if (spec.headerRow !== null && r === spec.headerRow) { header = row; continue; }
        rows.push(row);
    }
    return { rows, slots: last - spec.first + 1, last, header, missing: false };
}

function buildOne(workbook, name, spec) {
    const read = readTable(workbook.Sheets[spec.sheet], spec);
    const table = new LookupTable(name, read.rows, spec.defaultValue);
    return {
        table,
        raw: {
            sheet: spec.sheet,
            keyCol: spec.keyCol,
            valueCol: spec.valueCol,
            range: `${spec.keyCol}${spec.first}:${spec.valueCol}${read.last}`,
            consumed: spec.consumed,
            slots: read.slots,
            missing: read.missing,
            header: read.header,
            rows: read.rows,
            populated: read.rows.length,
            distinctKeys: table.size,
            distinctValues: table.values(),
            defaultValue: spec.defaultValue,
            defects: analyzeTable(read.rows),
        },
    };
}

/* -------------------------------------------------------------------- cache */

/**
 * Parsed result per template path + mtime + size. template.xlsx is 3.7 MB and a full
 * SheetJS parse costs ~800 ms; the targeted two-sheet read below costs ~140 ms and the
 * pipeline needs it once per run, but the tests call it repeatedly.
 */
const CACHE = new Map();

function stamp(st) { return `${st.mtimeMs}:${st.size}`; }

/** Test hook. Nothing on the pipeline's path calls this. */
function clearLookupCache() { CACHE.clear(); }

/**
 * Read the three lookup tables from a template workbook.
 *
 * Throws only if the file itself cannot be read or parsed - that is an I/O failure, not a
 * data problem, and there is no report without a template. A template that parses but is
 * missing Hoja1 or Sheet1 yields an empty table with `raw.<name>.missing === true`, which
 * reportLookupDefects turns into a FAILED issue.
 *
 * @param {string} templatePath
 * @returns {{zonaByDistrito: LookupTable, epcByContratista: LookupTable,
 *            nombreComercial: LookupTable, raw: object}}
 */
function readLookups(templatePath) {
    const resolved = path.resolve(templatePath);
    const st = fs.statSync(resolved);
    const key = stamp(st);

    const hit = CACHE.get(resolved);
    if (hit && hit.stamp === key) return hit.value;

    // Only the two lookup sheets are parsed. Styles/formulas/props are dead weight here,
    // and Cuadro alone is 8,600 rows wide of formulas we would immediately discard.
    const workbook = XLSX.readFile(resolved, {
        sheets: [TABLES.zona.sheet, TABLES.nombre.sheet],
        cellFormula: false,
        cellHTML: false,
        cellStyles: false,
        cellDates: false,
        bookDeps: false,
        bookProps: false,
        bookVBA: false,
    });

    const zona = buildOne(workbook, "zona", TABLES.zona);
    const epc = buildOne(workbook, "epc", TABLES.epc);
    const nombre = buildOne(workbook, "nombre", TABLES.nombre);

    const value = {
        zonaByDistrito: zona.table,
        epcByContratista: epc.table,
        nombreComercial: nombre.table,
        raw: {
            templatePath: resolved,
            mtimeMs: st.mtimeMs,
            size: st.size,
            zona: zona.raw,
            epc: epc.raw,
            nombre: nombre.raw,
        },
    };

    CACHE.set(resolved, { stamp: key, value });
    return value;
}

/* ---------------------------------------------------- surfacing the defects */

/** Human label per table, for issue messages. Spanish domain terms stay verbatim. */
const TABLE_LABELS = {
    zona: "Zona de Influencia",
    epc: "EPC",
    nombre: "Nombre Comercial",
};

/**
 * Push the measured defects onto an IssueList so they appear in "Errores" and run.json.
 *
 * Opt-in: readLookups is cached, so it cannot emit issues itself without going silent on
 * the second call. The caller (run.js) calls this once per run.
 *
 * CODE.TEXT_NORMALIZED is the nearest existing code; issues.js is a contract and this
 * module does not extend its frozen CODE table. `detalle.tabla` distinguishes these from
 * row-level normalizations.
 */
function reportLookupDefects(lookups, issues) {
    for (const name of ["zona", "epc", "nombre"]) {
        const t = lookups.raw[name];
        const label = TABLE_LABELS[name];

        if (t.missing) {
            issues.failed({
                code: CODE.SHEET_NOT_FOUND,
                message: `La hoja ${t.sheet} no existe en la plantilla; la tabla ${label} quedo vacia`,
                hoja: t.sheet,
                detalle: { tabla: name, rango: t.range },
            });
            continue;
        }

        // Only a table something actually looks up can strand data. Sheet1's padded keys
        // are still counted below; they just do not misroute anybody today.
        for (const r of (t.consumed ? t.defects.strandedKeys : [])) {
            issues.warning({
                code: CODE.TEXT_NORMALIZED,
                message: `Clave inalcanzable en ${t.sheet}!${t.range}: ${JSON.stringify(r.clave)} nunca coincide en la plantilla y siempre resuelve a ${JSON.stringify(t.defaultValue)} (BUG-29)`,
                hoja: t.sheet,
                fila: r.fila,
                celda: `${t.keyCol}${r.fila}`,
                valor: r.clave,
                detalle: { tabla: name, valorEsperado: r.valor, corregidoPorNormalizacion: true },
            });
        }

        if (t.defects.keysNormalized > 0) {
            issues.info({
                code: CODE.TEXT_NORMALIZED,
                message: `${t.defects.keysNormalized} claves de ${label} requirieron normalizacion de espacios (${t.defects.paddedKeys.length} con relleno, ${t.defects.internalWhitespaceKeys.length} con espacio interno doble)`,
                hoja: t.sheet,
                detalle: {
                    tabla: name,
                    filas: t.defects.unreachableKeys.map(r => r.fila),
                },
            });
        }

        for (const r of t.defects.paddedValues) {
            issues.warning({
                code: CODE.TEXT_NORMALIZED,
                message: `Valor con espacio sobrante en ${t.sheet} fila ${r.fila}: ${JSON.stringify(r.valor)} se propaga literal a las tablas dinamicas`,
                hoja: t.sheet,
                fila: r.fila,
                valor: r.valor,
                detalle: { tabla: name, clave: r.clave },
            });
        }

        for (const c of t.defects.collisions) {
            issues.error({
                code: CODE.HEADER_DUPLICATE,
                message: `Colision de claves en ${label}: ${JSON.stringify(c.clave)} apunta a valores distintos (${c.entradas.map(e => `${e.fila}=${JSON.stringify(e.valor)}`).join(", ")})`,
                hoja: t.sheet,
                detalle: { tabla: name, entradas: c.entradas },
            });
        }

        for (const r of t.defects.blankKeys) {
            issues.info({
                code: CODE.REQUIRED_MISSING,
                message: `Fila ${r.fila} de ${label} tiene valor ${JSON.stringify(r.valor)} sin clave`,
                hoja: t.sheet,
                fila: r.fila,
                detalle: { tabla: name },
            });
        }
    }
    return issues;
}

module.exports = {
    readLookups,
    reportLookupDefects,
    clearLookupCache,
    LookupTable,
    normalizeKey,
    excelTrim,
    TABLES,
    ZONA_DEFAULT,
    EPC_DEFAULT,
};

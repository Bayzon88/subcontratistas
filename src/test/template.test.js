"use strict";
/**
 * output/template.js against the REAL template-v2.
 *
 * The assertions here are almost all made on the BYTES of the generated workbook, not on
 * the in-memory model: "the cell is absent" versus "the cell holds the empty string" is
 * invisible through every read API and is exactly the difference between a correct report
 * and BUG-10's 3,757 ghost rows. So most tests unzip `xl/worksheets/sheet4.xml` and look.
 *
 * Measured facts this file depends on, all read off src/template-v2.xlsx:
 *   Tabla2 = A1:AI2 (one specimen data row), 35 tableColumns
 *   the 18 raw columns A..R carry no <calculatedColumnFormula>
 *   V/W/AG/AH/AI carry none either (Option D, 05 Fase 4 tarea 3)
 *   the other twelve carry exactly one each; AD's has array="1"
 *   Cuadro row 2 styles: A=1 B..E=2 F=4 G..K=2 L=7 M=4 N=12 O=4 P=89 Q,R=8
 *   AD2 carries cm="1" and <f t="array" ref="AD2">
 *   29 pivot parts (13 pivotTable + 13 rels + 2 pivotCache + 1 rels)
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const JSZip = require("jszip");
const XlsxPopulate = require("xlsx-populate");
const XLSX = require("xlsx");

const config = require("../config");
const { CANONICAL } = require("../pipeline/columns");
const { IssueList, SEVERITY, CODE } = require("../pipeline/issues");
const { parsePeriod } = require("../pipeline/period");
const { LITERALS, COMPUTED_COLUMN_NAMES } = require("../output/computed");
const {
    writeReport,
    TemplateError,
    TEMPLATE_ERROR,
    readLayout,
    buildPlan,
    verifyOutput,
    buildUnparseableIndex,
    coerceValue,
    SHEET_ERRORES,
    PERIOD_CELLS,
    CAPTION_CELL,
    CAPTION_PREFIX,
    TABLE_PART,
} = require("../output/template");

const TEMPLATE = config.TEMPLATE;
const PERIOD = "2026-02";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "template-test-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** Synthetic. Real districts (they drive Hoja1's lookup), invented identities. */
function record(i, over = {}) {
    const base = {
        "RUC": "20504039123",
        "EMPRESA": `SUBCONTRATA ${i} SAC`,
        "CONTRATISTA PRNCIPAL": "COSAPI SA",
        // Leading zero: AC 13's "09994533 does not become 9994533".
        "Nro. DNI / CE": `0999453${i % 10}`,
        "APELLIDOS Y NOMBRES": `PEREZ GOMEZ JUAN ${i}`,
        "FECHA NACIMIENTO": 30000 + i,                 // 1982-02-2x
        "TIPO TRABAJADOR": 1,
        "TITULO DE PUESTO/CARGO": "OPERARIO",
        "NOMBRE DE OBRA DONDE ESTA ASIGNADO DURANTE EL MES REPORTADO": "OBRA CENTRAL",
        "DOMICILIO DE TRABAJADOR": "AV LIMA 100",
        "DISTRITO SEGÚN DNI": "ATE",
        "GENERO": "masculino",
        "FECHA CESE/BAJA": null,
        "NACIONALIDAD": "PERUANA",
        "FECHA INICIO DE LABORES EN OBRA": 46054,      // 2026-02-01, inside the period
        "ESTADO": 1,
        "TIPO DE CONTRATO LABORAL": 2,
        "HPT": 180,
        provenance: {
            subcontratista: `SUBCONTRATA ${i}`, archivo: "lista.xlsx",
            hoja: "Cuadro", filaOrigen: i + 2, celdaAncla: "A1",
        },
    };
    return Object.assign(base, over);
}

function records(n) {
    return Array.from({ length: n }, (_, i) => record(i));
}

let runs = 0;
async function build(recs, opts = {}) {
    const out = path.join(TMP, `report-${runs++}.xlsx`);
    const report = await writeReport(recs, {
        period: PERIOD, templatePath: TEMPLATE, outPath: out, ...opts,
    });
    return report;
}

/* ------------------------------------------------------------------ *
 * Byte-level readers
 * ------------------------------------------------------------------ */

async function openZip(file) {
    return JSZip.loadAsync(fs.readFileSync(file));
}

async function part(file, name) {
    const zip = await openZip(file);
    const entry = zip.file(name);
    assert.ok(entry, `${name} ausente`);
    return entry.async("string");
}

const CUADRO_PART = "xl/worksheets/sheet4.xml";

/** Attribute-order-agnostic cell scanner; `AD` is emitted as `<c cm="1" r="AD3" ...>`. */
function scanCells(xml) {
    const out = new Map();
    const re = /<c\s([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
        // The leading space matters: `r` is not always the first attribute (`AD` is emitted
        // as `<c cm="1" r="AD3" s="64">`), so the attribute regexes need one to anchor on.
        const attrs = ` ${m[1]}`;
        const body = m[3] || "";
        const ref = / r="([^"]*)"/.exec(attrs);
        if (!ref) continue;
        const t = / t="([^"]*)"/.exec(attrs);
        const s = / s="([^"]*)"/.exec(attrs);
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        const f = /<f\b([^>]*)>([\s\S]*?)<\/f>|<f\b([^>]*)\/>/.exec(body);
        out.set(ref[1], {
            ref: ref[1],
            attrs,
            type: t ? t[1] : null,
            style: s ? s[1] : null,
            v: v ? v[1] : null,
            hasFormula: f !== null,
            formulaAttrs: f ? (f[1] !== undefined ? f[1] : f[3]) : null,
            formula: f ? f[2] : null,
            empty: body === "",
        });
    }
    return out;
}

function sharedStrings(xml) {
    const out = [];
    const re = /<si>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = re.exec(xml)) !== null) out.push(m[1].replace(/<[^>]*>/g, ""));
    return out;
}

/** The literal value a cell resolves to, or null for a genuinely empty cell. */
function cellValue(cell, sst) {
    if (!cell || cell.v === null) return null;
    if (cell.type === "s") return sst[Number(cell.v)];
    if (cell.type === "str" || cell.type === "inlineStr") return cell.v;
    return Number(cell.v);
}

function sha1(buf) {
    return crypto.createHash("sha1").update(buf).digest("hex");
}

async function partHashes(file, filter) {
    const zip = await openZip(file);
    const out = new Map();
    for (const name of Object.keys(zip.files)) {
        if (zip.files[name].dir) continue;
        if (!filter(name)) continue;
        out.set(name, sha1(await zip.file(name).async("nodebuffer")));
    }
    return out;
}

const isPivotPart = (n) => n.startsWith("xl/pivotTables/") || n.startsWith("xl/pivotCache/");

/* ------------------------------------------------------------------ *
 * 1. Row count and the absence of ghost rows (BUG-10, BUG-12, AC 15)
 * ------------------------------------------------------------------ */

test("5 records produce exactly 5 data rows, and Tabla2 says so", async () => {
    const r = await build(records(5));
    assert.equal(r.filas, 5);
    assert.equal(r.ultimaFila, 6);

    const xml = await part(r.path, CUADRO_PART);
    const rows = [...xml.matchAll(/<row r="(\d+)"/g)].map(m => Number(m[1]));
    assert.deepEqual(rows, [1, 2, 3, 4, 5, 6], "cabecera + 5 filas de datos, nada mas");

    // All four refs of table1.xml move together (05 Fase 3 tarea 3).
    const table = await part(r.path, TABLE_PART);
    assert.match(table, /<table [^>]*ref="A1:AI6"/);
    assert.match(table, /<autoFilter ref="A1:AI6"/);
    assert.match(table, /<sortState ref="A2:AI6"/);
    assert.match(table, /<sortCondition ref="C1:C6"/);
});

test("zero empty-string cells inside the table (BUG-10)", async () => {
    // Row 0 leaves five columns empty, which is exactly where `.value("")` used to go.
    const recs = records(5);
    recs[0]["FECHA CESE/BAJA"] = null;
    recs[1]["EMPRESA"] = "";
    recs[1]["DOMICILIO DE TRABAJADOR"] = "   ";
    recs[2]["HPT"] = null;
    recs[3]["Nro. DNI / CE"] = "";
    const r = await build(recs);

    const zip = await openZip(r.path);
    const sst = sharedStrings(await zip.file("xl/sharedStrings.xml").async("string"));
    const emptyIndices = new Set(sst.map((s, i) => (s === "" ? String(i) : null)).filter(Boolean));
    const cells = scanCells(await zip.file(CUADRO_PART).async("string"));

    let emptyStringCells = 0;
    for (const cell of cells.values()) {
        if (cell.type === "s" && cell.v !== null && emptyIndices.has(cell.v)) emptyStringCells++;
        if ((cell.type === "str" || cell.type === "inlineStr") && cell.v === "") emptyStringCells++;
    }
    assert.equal(emptyStringCells, 0);

    // And the cells that should be absent really are absent - no <v> at all.
    assert.equal(cells.get("M2").v, null, "FECHA CESE/BAJA vacia");
    assert.equal(cells.get("B3").v, null, 'EMPRESA "" -> celda vacia');
    assert.equal(cells.get("J3").v, null, 'DOMICILIO "   " -> celda vacia');
    assert.equal(cells.get("R4").v, null, "HPT null -> celda vacia");
    assert.equal(cells.get("D5").v, null, 'DNI "" -> celda vacia');
});

test("the literal strings undefined / NaN / #VALUE! appear nowhere (AC 11, 12, 17)", async () => {
    const recs = records(4);
    recs[0]["GENERO"] = "undefined";
    recs[1]["ESTADO"] = NaN;
    recs[2]["HPT"] = Infinity;
    recs[3]["NACIONALIDAD"] = "NaN";
    const issues = new IssueList();
    const r = await build(recs, { issues });

    const xml = await part(r.path, CUADRO_PART);
    for (const bad of ["undefined", "NaN", "#VALUE!", "Infinity"]) {
        assert.equal(xml.includes(bad), false, `sheet4.xml contiene ${bad}`);
    }
    assert.equal(r.celdas.rechazadas, 4);
    assert.equal(issues.bySeverity(SEVERITY.WARNING).length >= 4, true);

    // This run must not ADD a bad string to the table. template-v2 already ships one
    // orphaned `<si>undefined</si>` (index 449, referenced by no cell - a leftover of the
    // OCTUBRE_2025 gender regression that the junk sweep did not blank). Assert it stays
    // orphaned rather than pretending the count is zero.
    const before = sharedStrings(await part(TEMPLATE, "xl/sharedStrings.xml"));
    const after = sharedStrings(await part(r.path, "xl/sharedStrings.xml"));
    const count = (list, s) => list.filter(x => x === s).length;
    for (const bad of ["undefined", "NaN", "Infinity", "null"]) {
        assert.equal(count(after, bad), count(before, bad), `se agrego "${bad}" a sharedStrings`);
    }
    const orphan = before.indexOf("undefined");
    assert.equal(orphan, 449);
    const zip = await openZip(r.path);
    for (const name of Object.keys(zip.files)) {
        if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue;
        const sheet = await zip.file(name).async("string");
        assert.equal(new RegExp(`<v>${orphan}</v>`).test(sheet), false,
            `${name} referencia la cadena "undefined"`);
    }
});

/* ------------------------------------------------------------------ *
 * 2. Placement by name, never by key order (BUG-13)
 * ------------------------------------------------------------------ */

test("a record whose keys are in REVERSED order still lands in A..R correctly", async () => {
    const forward = record(0);
    // Rebuild with the 18 canonical keys in reverse, provenance first, plus a stray key
    // the old `for (let data in row)` writer would have written into a real column.
    const reversed = { provenance: forward.provenance, sobrante: "NO ESCRIBIR" };
    for (let i = CANONICAL.length - 1; i >= 0; i--) reversed[CANONICAL[i]] = forward[CANONICAL[i]];
    assert.notDeepEqual(Object.keys(reversed), Object.keys(forward));

    const a = await build([forward]);
    const b = await build([reversed]);

    const za = await openZip(a.path);
    const zb = await openZip(b.path);
    const sa = sharedStrings(await za.file("xl/sharedStrings.xml").async("string"));
    const sb = sharedStrings(await zb.file("xl/sharedStrings.xml").async("string"));
    const ca = scanCells(await za.file(CUADRO_PART).async("string"));
    const cb = scanCells(await zb.file(CUADRO_PART).async("string"));

    for (let i = 0; i < CANONICAL.length; i++) {
        const ref = `${String.fromCharCode(65 + i)}2`;
        assert.deepEqual(
            cellValue(cb.get(ref), sb), cellValue(ca.get(ref), sa),
            `${ref} (${CANONICAL[i]}) cambio al invertir el orden de las claves`);
    }
    assert.equal(cellValue(ca.get("A2"), sa), "20504039123");
    assert.equal(cellValue(ca.get("R2"), sa), 180);
    // The stray key never becomes a column.
    assert.equal((await zb.file("xl/sharedStrings.xml").async("string")).includes("NO ESCRIBIR"), false);
});

test("buildPlan refuses a template whose column names drift from columns.js", () => {
    const layout = readLayout(`<table name="Tabla2" ref="A1:AI2">${
        CANONICAL.map((n, i) => `<tableColumn id="${i + 1}" name="${n === "EMPRESA" ? "EMPRESAS" : n}"/>`).join("")
    }</table>`);
    assert.throws(() => buildPlan(layout), (e) =>
        e instanceof TemplateError && e.code === TEMPLATE_ERROR.COLUMN_DRIFT);
});

test("buildPlan refuses a template where a literal column got its formula back", async () => {
    const xml = await part(TEMPLATE, TABLE_PART);
    const poisoned = xml.replace(
        /<tableColumn ([^>]*name="Edad"[^>]*)\/>/,
        '<tableColumn $1><calculatedColumnFormula>TODAY()</calculatedColumnFormula></tableColumn>');
    assert.notEqual(poisoned, xml, "la sustitucion de prueba no hizo nada");
    assert.throws(() => buildPlan(readLayout(poisoned)), (e) =>
        e instanceof TemplateError && e.code === TEMPLATE_ERROR.COLUMN_DRIFT);
});

test("the layout read from the template is 18 + 5 + 12 = 35", async () => {
    const layout = readLayout(await part(TEMPLATE, TABLE_PART));
    const plan = buildPlan(layout);
    assert.equal(layout.tableName, "Tabla2");
    assert.equal(layout.columns.length, 35);
    assert.equal(plan.raw.length, 18);
    assert.equal(plan.literals.length, 5);
    assert.equal(plan.formulas.length, 12);
    assert.deepEqual(plan.literals.map(l => l.column.letter), ["V", "W", "AG", "AH", "AI"]);
    assert.deepEqual(plan.literals.map(l => l.name), COMPUTED_COLUMN_NAMES);
    assert.deepEqual(plan.formulas.map(f => f.column.letter),
        ["S", "T", "U", "X", "Y", "Z", "AA", "AB", "AC", "AD", "AE", "AF"]);
    assert.equal(plan.formulas.find(f => f.column.letter === "AD").column.array, true);
    assert.equal(plan.formulas.filter(f => f.column.array).length, 1);
});

/* ------------------------------------------------------------------ *
 * 3. Option D: five literals with no formula, twelve formulas
 * ------------------------------------------------------------------ */

test("V/W/AG/AH/AI carry literal values and no <f> on every row", async () => {
    const recs = records(5);
    recs[1]["FECHA NACIMIENTO"] = null;                 // -> "Sin Fecha"
    recs[2]["FECHA CESE/BAJA"] = 46060;                 // inside the period -> "2-2026"
    recs[3]["FECHA CESE/BAJA"] = 45000;                 // an earlier period -> "Borrar"
    recs[3]["FECHA INICIO DE LABORES EN OBRA"] = 44000; // -> "No Aplica" => BajasAntiguas "Si"
    const r = await build(recs);

    const zip = await openZip(r.path);
    const sst = sharedStrings(await zip.file("xl/sharedStrings.xml").async("string"));
    const cells = scanCells(await zip.file(CUADRO_PART).async("string"));

    for (let row = 2; row <= 6; row++) {
        for (const col of ["V", "W", "AG", "AH", "AI"]) {
            const cell = cells.get(`${col}${row}`);
            assert.ok(cell, `${col}${row} ausente`);
            assert.equal(cell.hasFormula, false, `${col}${row} tiene <f>`);
            assert.notEqual(cellValue(cell, sst), null, `${col}${row} sin valor`);
        }
    }
    assert.equal(cellValue(cells.get("W3"), sst), LITERALS.SIN_FECHA);
    assert.equal(cellValue(cells.get("AH4"), sst), "2-2026");
    assert.equal(cellValue(cells.get("AH5"), sst), LITERALS.BORRAR);
    assert.equal(cellValue(cells.get("AI5"), sst), LITERALS.NO_APLICA);
    assert.equal(cellValue(cells.get("AG5"), sst), LITERALS.SI);
    assert.equal(cellValue(cells.get("AI2"), sst), "2-2026");
    assert.equal(typeof cellValue(cells.get("V2"), sst), "number");
});

test("Altas/Bajas2 use period.etiqueta VERBATIM - the pivot page filters depend on it", async () => {
    const recs = [record(0, { "FECHA CESE/BAJA": 46060 })];
    const r = await build(recs, { period: "2026-02" });
    const zip = await openZip(r.path);
    const sst = sharedStrings(await zip.file("xl/sharedStrings.xml").async("string"));
    const cells = scanCells(await zip.file(CUADRO_PART).async("string"));
    const etiqueta = parsePeriod("2026-02").etiqueta;
    assert.equal(etiqueta, "2-2026", "sin relleno de ceros");
    assert.equal(cellValue(cells.get("AI2"), sst), etiqueta);
    assert.equal(cellValue(cells.get("AH2"), sst), etiqueta);
    // ooxml.js repoints the filters at exactly this string.
    const cache = await zip.file("xl/pivotCache/pivotCacheDefinition1.xml").async("string");
    assert.ok(cache.includes(`<s v="${etiqueta}"/>`), "la etiqueta no llego al cache de pivotes");
});

test("the twelve formula columns are regenerated per cell, from table1.xml", async () => {
    const r = await build(records(5));
    const layout = readLayout(await part(TEMPLATE, TABLE_PART));
    const plan = buildPlan(layout);
    const cells = scanCells(await part(r.path, CUADRO_PART));

    for (const { column } of plan.formulas) {
        for (let row = 2; row <= 6; row++) {
            const cell = cells.get(`${column.letter}${row}`);
            assert.ok(cell, `${column.letter}${row} ausente`);
            assert.equal(cell.hasFormula, true, `${column.letter}${row} sin <f>`);
            // The cell formula IS the calculated-column formula. They cannot drift.
            const decoded = cell.formula
                .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
                .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
            assert.equal(decoded, column.formula, `${column.letter}${row}`);
        }
    }
    assert.equal(r.celdas.formulas, 60);
});

test("AD keeps t=\"array\", cm=\"1\" and a PER-ROW ref", async () => {
    const r = await build(records(4));
    const cells = scanCells(await part(r.path, CUADRO_PART));
    for (let row = 2; row <= 5; row++) {
        const cell = cells.get(`AD${row}`);
        assert.match(cell.formulaAttrs, / t="array"/);
        assert.match(cell.formulaAttrs, new RegExp(` ref="AD${row}"`));
        assert.match(cell.attrs, / cm="1"/);
    }
});

test("writeFormulas:false leaves the twelve empty - the documented escape hatch only", async () => {
    const r = await build(records(3), { writeFormulas: false });
    const cells = scanCells(await part(r.path, CUADRO_PART));
    for (const col of ["S", "T", "U", "X", "Y", "Z", "AA", "AB", "AC", "AD", "AE", "AF"]) {
        for (let row = 2; row <= 4; row++) {
            assert.equal(cells.get(`${col}${row}`).hasFormula, false);
        }
    }
    assert.equal(r.celdas.formulas, 0);
});

/* ------------------------------------------------------------------ *
 * 4. Types: dates, identifiers, empties
 * ------------------------------------------------------------------ */

test("F/M/O hold real serials with style 4 (numFmtId 14), never text (AC 9)", async () => {
    const recs = records(3);
    recs[1]["FECHA NACIMIENTO"] = "04/07/1994";   // text must NOT be written
    recs[2]["FECHA CESE/BAJA"] = "ACTIVO";        // a sentinel (AC 10)
    recs[2]["FECHA INICIO DE LABORES EN OBRA"] = new Date(2026, 1, 3);
    const issues = new IssueList();
    const r = await build(recs, { issues });

    const cells = scanCells(await part(r.path, CUADRO_PART));
    for (const col of ["F", "M", "O"]) {
        for (let row = 2; row <= 4; row++) {
            const cell = cells.get(`${col}${row}`);
            assert.equal(cell.style, "4", `${col}${row} deberia llevar el estilo 4`);
            if (cell.v !== null) {
                assert.equal(cell.type, null, `${col}${row} no es numerica`);
                assert.match(cell.v, /^\d+$/);
            }
        }
    }
    assert.equal(cells.get("F3").v, null, "la fecha en texto no se escribe");
    assert.equal(cells.get("M4").v, null, '"ACTIVO" no se escribe');
    assert.equal(Number(cells.get("O4").v), 46056, "Date -> serial con componentes locales");
    assert.equal(r.celdas.rechazadas, 2);
    assert.equal(issues.byCode(CODE.CODE_OUT_OF_DOMAIN).length >= 2, true);

    // style 4 is numFmtId 14 in the template's cellXfs - assert it rather than trust it.
    const styles = await part(r.path, "xl/styles.xml");
    const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)[1];
    const list = xfs.match(/<xf\b[\s\S]*?(?:\/>|<\/xf>)/g);
    assert.match(list[4], /numFmtId="14"/);
});

test("RUC and DNI are text, leading zeros intact (AC 13)", async () => {
    const recs = [
        record(0, { "Nro. DNI / CE": "09994533", "RUC": "20504039123" }),
        record(1, { "Nro. DNI / CE": 9994533 }),      // arrived numeric: BUG-23
    ];
    const issues = new IssueList();
    const r = await build(recs, { issues });
    const zip = await openZip(r.path);
    const sst = sharedStrings(await zip.file("xl/sharedStrings.xml").async("string"));
    const cells = scanCells(await zip.file(CUADRO_PART).async("string"));

    assert.equal(cells.get("D2").type, "s");
    assert.equal(cellValue(cells.get("D2"), sst), "09994533");
    assert.equal(cells.get("A2").type, "s");
    assert.equal(cellValue(cells.get("A2"), sst), "20504039123");
    assert.equal(cells.get("D3").type, "s", "un DNI numerico se escribe igualmente como texto");
    assert.equal(cellValue(cells.get("D3"), sst), "9994533");
    assert.equal(issues.byCode(CODE.TEXT_NORMALIZED).length, 1);
});

test("coerceValue is the last gate", () => {
    const ctx = () => ({ issues: new IssueList(), rejected: 0, dateCells: 0 });
    const c = (col, raw) => coerceValue(col, raw, ctx(), 2, "A");
    assert.equal(c("FECHA NACIMIENTO", "04/07/1994"), null);
    assert.equal(c("FECHA NACIMIENTO", ""), null);
    assert.equal(c("FECHA NACIMIENTO", NaN), null);
    assert.equal(c("FECHA NACIMIENTO", 1e9), null, "fuera del rango de Excel");
    assert.deepEqual(c("FECHA NACIMIENTO", 30000.79), { value: 30000 });
    assert.deepEqual(c("FECHA NACIMIENTO", 60), { value: 60 }, "el 29/02/1900 fantasma es escribible");
    assert.equal(c("ESTADO", NaN), null);
    assert.equal(c("ESTADO", Infinity), null);
    assert.equal(c("GENERO", "undefined"), null);
    assert.equal(c("GENERO", "null"), null);
    assert.equal(c("EMPRESA", "  "), null);
    assert.equal(c("EMPRESA", null), null);
    assert.equal(c("EMPRESA", undefined), null);
    assert.deepEqual(c("ESTADO", 0), { value: 0 }, "0 es un valor, no una ausencia");
    assert.deepEqual(c("EMPRESA", " ACME "), { value: " ACME " }, "el texto va verbatim");
    assert.equal(c("EMPRESA", true), null, "los booleanos no se escriben");
    assert.equal(c("EMPRESA", new Date(2026, 0, 1)), null, "Date fuera de F/M/O");
    assert.equal(c("RUC", "undefined"), null);
});

/* ------------------------------------------------------------------ *
 * 5. BUG-08: an unreadable date is not an absent one
 * ------------------------------------------------------------------ */

test("an unreadable FECHA CESE/BAJA becomes \"Revisar\", not \"No Aplica\"", async () => {
    const recs = records(2);
    const issues = new IssueList();
    // What schema.js/dates.js would have logged for row 2 of the first workbook.
    issues.error({
        code: CODE.DATE_UNPARSEABLE,
        message: "FECHA CESE/BAJA ilegible",
        subcontratista: "SUBCONTRATA 0", archivo: "lista.xlsx", hoja: "Cuadro",
        fila: 2, columna: "FECHA CESE/BAJA", valor: "10-11-202-6",
    });
    const r = await build(recs, { issues });
    const zip = await openZip(r.path);
    const sst = sharedStrings(await zip.file("xl/sharedStrings.xml").async("string"));
    const cells = scanCells(await zip.file(CUADRO_PART).async("string"));

    assert.equal(cellValue(cells.get("AH2"), sst), LITERALS.REVISAR);
    assert.equal(cellValue(cells.get("AG2"), sst), LITERALS.NO, "Revisar no es evidencia de baja");
    assert.equal(cellValue(cells.get("AH3"), sst), LITERALS.NO_APLICA, "la otra fila no se contagia");
});

test("buildUnparseableIndex keys on the full source coordinates", () => {
    const issues = new IssueList();
    issues.error({
        code: CODE.DATE_UNPARSEABLE, message: "x",
        subcontratista: "S", archivo: "a.xlsx", hoja: "Cuadro", fila: 7,
        columna: "FECHA NACIMIENTO",
    });
    issues.error({
        code: CODE.DATE_IMPLAUSIBLE, message: "y",
        subcontratista: "S", archivo: "a.xlsx", hoja: "Cuadro", fila: 7,
        columna: "FECHA CESE/BAJA",
    });
    issues.warning({ code: CODE.TEXT_NORMALIZED, message: "z", subcontratista: "S", archivo: "a.xlsx", hoja: "Cuadro", fila: 7, columna: "EMPRESA" });
    const index = buildUnparseableIndex(issues);
    assert.equal(index.size, 1);
    const set = [...index.values()][0];
    assert.deepEqual([...set].sort(), ["FECHA CESE/BAJA", "FECHA NACIMIENTO"]);
});

test("unparseableDates can be overridden by the caller", async () => {
    // dates.js nulls an unreadable cell, so the override describes a record whose serial
    // is already null - "we could not read it", not "there was nothing there".
    const r = await build([record(0, { "FECHA INICIO DE LABORES EN OBRA": null })], {
        unparseableDates: () => ["FECHA INICIO DE LABORES EN OBRA"],
    });
    const zip = await openZip(r.path);
    const sst = sharedStrings(await zip.file("xl/sharedStrings.xml").async("string"));
    const cells = scanCells(await zip.file(CUADRO_PART).async("string"));
    assert.equal(cellValue(cells.get("AI2"), sst), LITERALS.REVISAR);
});

/* ------------------------------------------------------------------ *
 * 6. The pivot layer must survive
 * ------------------------------------------------------------------ */

test("the xlsx-populate round trip leaves all 29 pivot parts SHA-1 identical", async () => {
    // patch:false isolates THIS module: whatever changes here was changed by the writer.
    const r = await build(records(50), { patch: false, verify: false });
    const before = await partHashes(TEMPLATE, isPivotPart);
    const after = await partHashes(r.path, isPivotPart);
    assert.equal(before.size, 29);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
    for (const [name, hash] of before) {
        assert.equal(after.get(name), hash, `${name} cambio`);
    }
    // The theme and the pivot cache RECORDS too.
    const t = await partHashes(TEMPLATE, n => n === "xl/theme/theme1.xml" || n === "xl/metadata.xml");
    const t2 = await partHashes(r.path, n => n === "xl/theme/theme1.xml" || n === "xl/metadata.xml");
    assert.deepEqual([...t2], [...t]);
});

test("after the ooxml patch exactly two pivot parts differ, and they are the documented two", async () => {
    const r = await build(records(50));
    const before = await partHashes(TEMPLATE, isPivotPart);
    const after = await partHashes(r.path, isPivotPart);
    const changed = [...before.keys()].filter(n => after.get(n) !== before.get(n)).sort();
    assert.deepEqual(changed, [
        // refreshOnLoad="1" (AC 21)
        "xl/pivotCache/pivotCacheDefinition1.xml",
        // "Detalle Cesados" repointed off Bajas2="Borrar" onto the period (AC 19)
        "xl/pivotTables/pivotTable2.xml",
    ]);
    assert.equal(
        [...before.keys()].filter(n => n.startsWith("xl/pivotTables/pivotTable")
            && n.endsWith(".xml") && after.get(n) === before.get(n)).length,
        12, "12 de las 13 tablas dinamicas intactas");
    const records1 = "xl/pivotCache/pivotCacheRecords1.xml";
    assert.equal(after.get(records1), before.get(records1));
});

test("the nine template sheets survive, plus Errores, and both readers open the file", async () => {
    const r = await build(records(10), { erroresSheet: [["ESTADO", "OK"]] });
    const expected = [
        "Reporte Social - RRHH", "CJ Y EPC", "Hoja1", "Cuadro", "Contratistas",
        "Tabla", "Sheet1", "Dos Subcontratas por Mes", "Validacion", "Errores",
    ];
    const wb = await XlsxPopulate.fromFileAsync(r.path);
    assert.deepEqual(wb.sheets().map(s => s.name()), expected);
    // 03 §7.4 tier 1: the workbook must be readable without Excel.
    const sj = XLSX.read(fs.readFileSync(r.path), { type: "buffer", bookSheets: true });
    assert.deepEqual(sj.SheetNames, expected);
});

/* ------------------------------------------------------------------ *
 * 7. The 8,823-row ceiling is gone by construction (AC 16)
 * ------------------------------------------------------------------ */

test("9,000 records produce a 9,000-row table, not a truncation at 8,823", async () => {
    const r = await build(records(9000));
    assert.equal(r.filas, 9000);
    assert.equal(r.ultimaFila, 9001);

    const table = await part(r.path, TABLE_PART);
    assert.match(table, /<table [^>]*ref="A1:AI9001"/);
    assert.match(table, /<sortCondition ref="C1:C9001"/);

    const xml = await part(r.path, CUADRO_PART);
    const rows = [...xml.matchAll(/<row r="(\d+)"/g)].map(m => Number(m[1]));
    assert.equal(rows.length, 9001);
    assert.equal(rows[rows.length - 1], 9001);
    // Row 8824 - the first row that used to fall outside Tabla2 - is a normal data row.
    const cells = scanCells(xml);
    assert.ok(cells.get("A8824"));
    assert.equal(cells.get("AD8824").hasFormula, true);
    assert.match(cells.get("AD8824").formulaAttrs, / ref="AD8824"/);
    // And it stayed inside the budget.
    assert.ok(r.tiempos.totalMs < 20000, `demasiado lento: ${r.tiempos.totalMs} ms`);
});

/* ------------------------------------------------------------------ *
 * 8. The period and the Errores sheet
 * ------------------------------------------------------------------ */

test("the period lands in Hoja1, in the defined names and in the visible caption", async () => {
    const period = parsePeriod(PERIOD);
    const r = await build(records(3));

    const hoja1 = scanCells(await part(r.path, "xl/worksheets/sheet3.xml"));
    assert.equal(Number(hoja1.get(PERIOD_CELLS.inicio).v), period.inicioSerial);
    assert.equal(Number(hoja1.get(PERIOD_CELLS.fin).v), period.finSerial);
    assert.equal(hoja1.get(PERIOD_CELLS.inicio).style, "4", "serial con formato de fecha");
    assert.equal(hoja1.get(PERIOD_CELLS.fin).style, "4");

    const sst = sharedStrings(await part(r.path, "xl/sharedStrings.xml"));
    assert.equal(cellValue(hoja1.get(PERIOD_CELLS.etiqueta), sst), period.etiqueta);

    const portada = scanCells(await part(r.path, "xl/worksheets/sheet1.xml"));
    const caption = cellValue(portada.get(CAPTION_CELL), sst);
    assert.equal(caption, `${CAPTION_PREFIX}FEBRERO 2026 (2-2026)`);
    assert.equal(r.caption, caption);

    const wb = await part(r.path, "xl/workbook.xml");
    assert.match(wb, new RegExp(`<definedName name="PeriodoInicio">${period.inicioSerial}</definedName>`));
    assert.match(wb, new RegExp(`<definedName name="PeriodoFin">${period.finSerial}</definedName>`));
    assert.match(wb, /<definedName name="PeriodoEtiqueta">&quot;2-2026&quot;<\/definedName>/);
    assert.match(wb, /<calcPr calcId="191029" fullCalcOnLoad="1"\/>/);
    assert.equal(r.periodo, "2026-02");
    assert.equal(path.basename(parsePeriod(PERIOD).filename), "Reporte_Subcontratistas_FEBRERO_2026.xlsx");
});

test("the Errores sheet is written, declared in [Content_Types] and listed in app.xml", async () => {
    const aoa = [
        ["ESTADO", "INCOMPLETO"],
        ["Subcontratistas fallidos", 2, "ACME SAC", "OTRA SAC"],
        [],
        ["codigo", "mensaje", "severidad", null, "", undefined],
        ["DATE_UNPARSEABLE", "fila 7: 10-11-202-6", "ERROR", 7, true],
    ];
    const r = await build(records(2), { erroresSheet: aoa });
    assert.equal(r.errores.hoja, SHEET_ERRORES);
    assert.equal(r.errores.filas, 5);

    const zip = await openZip(r.path);
    const ct = await zip.file("[Content_Types].xml").async("string");
    // The Errores sheet is appended last, so it is the 10th part.
    assert.ok(ct.includes('PartName="/xl/worksheets/sheet10.xml"'),
        "sin Override, Excel pide reparar el archivo (AC 25)");

    const sst = sharedStrings(await zip.file("xl/sharedStrings.xml").async("string"));
    const cells = scanCells(await zip.file("xl/worksheets/sheet10.xml").async("string"));
    assert.equal(cellValue(cells.get("A1"), sst), "ESTADO");
    assert.equal(cellValue(cells.get("B1"), sst), "INCOMPLETO");
    assert.equal(cellValue(cells.get("D2"), sst), "OTRA SAC");
    assert.equal(cells.get("D4"), undefined, "null no crea celda");
    assert.equal(cells.get("E4"), undefined, '"" no crea celda');
    assert.equal(cellValue(cells.get("D5"), sst), 7);
    assert.equal(cellValue(cells.get("E5"), sst), "si", "los booleanos se rinden en texto");

    const app = await zip.file("docProps/app.xml").async("string");
    assert.match(app, /<vt:vector size="10" baseType="lpstr">/);
    assert.match(app, /<vt:lpstr>Errores<\/vt:lpstr>/);
    assert.match(app, /<vt:i4>10<\/vt:i4>/);
});

test("no Errores array means no extra sheet", async () => {
    const r = await build(records(2));
    assert.equal(r.errores, null);
    const wb = await XlsxPopulate.fromFileAsync(r.path);
    assert.equal(wb.sheets().length, 9);
});

test("<dimension> is restored on Cuadro (03 §7.4)", async () => {
    const r = await build(records(7));
    assert.equal(r.dimension, "A1:AI8");
    const xml = await part(r.path, CUADRO_PART);
    assert.match(xml, /<dimension ref="A1:AI8"\/>/);
});

/* ------------------------------------------------------------------ *
 * 9. Determinism (AC 26)
 * ------------------------------------------------------------------ */

test("the same records and the same period produce byte-identical files", async () => {
    const recs = records(25);
    const a = await build(recs.map(r => ({ ...r })));
    const b = await build(recs.map(r => ({ ...r })));
    assert.equal(sha1(fs.readFileSync(a.path)), sha1(fs.readFileSync(b.path)));
});

test("no clock is read anywhere in the module", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "output", "template.js"), "utf8");
    // Strip comments; `new Date(0)` is discussed in prose.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.equal(/\bnew Date\s*\(\s*\)/.test(code), false);
    assert.equal(/\bDate\.now\s*\(/.test(code), false);
    assert.equal(/TODAY\s*\(/.test(code), false);
});

/* ------------------------------------------------------------------ *
 * 10. Caller errors, and a verification that is not vacuous
 * ------------------------------------------------------------------ */

test("a zero-record run fails loudly rather than shipping a one-ghost-row table", async () => {
    await assert.rejects(
        () => build([]),
        (e) => e instanceof TemplateError && e.code === TEMPLATE_ERROR.NO_RECORDS);
});

test("wiring mistakes throw, they do not produce a file", async () => {
    await assert.rejects(() => writeReport("no soy un array", { period: PERIOD }),
        (e) => e instanceof TemplateError && e.code === TEMPLATE_ERROR.BAD_ARGUMENT);
    await assert.rejects(() => writeReport(records(1), {}),
        (e) => e instanceof TemplateError && e.code === TEMPLATE_ERROR.BAD_ARGUMENT);
    await assert.rejects(() => writeReport(records(1), { period: 202602 }),
        (e) => e instanceof TemplateError && e.code === TEMPLATE_ERROR.BAD_ARGUMENT);
});

test("verifyOutput actually catches a ghost row, and a table ref that lies", async () => {
    const r = await build(records(4));
    const expectation = {
        sheetPart: CUADRO_PART,
        rowCount: 4,
        lastColumnLetter: "AI",
        writeFormulas: true,
        rawColumns: CANONICAL.map((_, i) => String.fromCharCode(65 + i)),
        literalColumns: ["V", "W", "AG", "AH", "AI"],
        formulaColumns: ["S", "T", "U", "X", "Y", "Z", "AA", "AB", "AC", "AD", "AE", "AF"],
        dateColumns: ["F", "M", "O"],
    };
    // The good file passes.
    const ok = await verifyOutput(r.path, expectation);
    assert.equal(ok.filasVerificadas, 4);

    // Now inject exactly what BUG-10 shipped: a cell holding the empty string.
    const zip = await openZip(r.path);
    let sst = await zip.file("xl/sharedStrings.xml").async("string");
    const emptyIndex = (sst.match(/<si>/g) || []).length;
    sst = sst.replace("</sst>", "<si><t></t></si></sst>");
    let sheet = await zip.file(CUADRO_PART).async("string");
    sheet = sheet.replace(/<c r="B3"[^>]*>[\s\S]*?<\/c>/,
        `<c r="B3" t="s" s="2"><v>${emptyIndex}</v></c>`);
    zip.file("xl/sharedStrings.xml", sst);
    zip.file(CUADRO_PART, sheet);
    const ghost = path.join(TMP, "ghost.xlsx");
    fs.writeFileSync(ghost, await zip.generateAsync({ type: "nodebuffer" }));

    await assert.rejects(() => verifyOutput(ghost, expectation), (e) =>
        e instanceof TemplateError
        && e.code === TEMPLATE_ERROR.VERIFY_FAILED
        && /cadena vacia dentro de Tabla2/.test(e.message));

    // And an unresized table is caught too - the other half of BUG-10.
    const unpatched = await build(records(4), { patch: false, verify: false });
    await assert.rejects(() => verifyOutput(unpatched.path, expectation), (e) =>
        e instanceof TemplateError && /table ref/.test(e.message));
});

test("the run report reconciles: escritas + vacias == filas * 23", async () => {
    const recs = records(6);
    recs[0]["HPT"] = null;
    recs[1]["FECHA CESE/BAJA"] = null;
    const r = await build(recs);
    // 18 raw + 5 literals; the twelve formula columns are counted separately.
    assert.equal(r.celdas.escritas + r.celdas.vacias, 6 * 23);
    assert.equal(r.celdas.literales, 6 * 5);
    assert.equal(r.celdas.formulas, 6 * 12);
    assert.equal(r.filasEliminadas, 0);
});

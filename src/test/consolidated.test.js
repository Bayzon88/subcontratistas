"use strict";
/**
 * output/consolidated.js - the diffable intermediate.
 *
 * The assertions here are the ones the artefact exists to make checkable, and they are
 * made against the FILE, not against the in-memory worksheet: the sheet XML and the
 * styles XML are unzipped and read directly, because "the cell is absent" and "the cell
 * holds an empty string" are indistinguishable through most read APIs and the whole
 * difference between a clean table and 3,757 ghost rows lives in that distinction
 * (03-expected-output.md §7.2).
 *
 * Coverage map, by acceptance criterion:
 *   AC 9  - zero text values in F, M and O; every populated date cell is numFmtId 14
 *   AC 11 - zero NaN
 *   AC 12 - the literal string "undefined" appears zero times
 *   AC 13 - RUC / Nro. DNI / CE are text; "09994533" does not become 9994533
 *   AC 15 - no empty-string cells (an absent value has no <c> element at all)
 *   AC 16 - no row ceiling
 *   AC 26 - determinism: same records + same period => byte-identical file
 *   BUG-13 - placement by canonical name, proved with reversed key order
 */

const test = require("node:test");
const { after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const XLSX = require("xlsx");
const AdmZip = require("adm-zip");

const {
    writeConsolidated,
    buildSheet,
    SHEET_NAME,
    DATE_NUMFMT_ID,
    DATE_FORMAT_CODE,
} = require("../output/consolidated");
const { CANONICAL, DATE_COLUMNS, INDEX_BY_CANONICAL } = require("../pipeline/columns");
const { IssueList, SEVERITY, CODE } = require("../pipeline/issues");
const dates = require("../pipeline/dates");

/* ------------------------------------------------------------------ helpers */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "consolidado-test-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
function outPath(name) {
    return path.join(TMP, `${String(++seq).padStart(3, "0")}-${name}.xlsx`);
}

/** A record with all 18 canonical keys present and null, then the overrides. */
function record(overrides = {}) {
    const r = {};
    for (const c of CANONICAL) r[c] = null;
    return Object.assign(r, overrides);
}

/** One plausible, fully-populated worker. Synthetic identity (fixture rule, 05 §6 risk 11). */
function worker(overrides = {}) {
    return record({
        "RUC": "20512345678",
        "EMPRESA": "CONSTRUCTORA EJEMPLO SAC",
        "CONTRATISTA PRNCIPAL": "CONTRATISTA EJEMPLO SA",
        "Nro. DNI / CE": "09994533",
        "APELLIDOS Y NOMBRES": "PEREZ QUISPE JUAN CARLOS",
        "FECHA NACIMIENTO": 25569,           // 1970-01-01
        "TIPO TRABAJADOR": 2,
        "TITULO DE PUESTO/CARGO": "OPERARIO",
        "NOMBRE DE OBRA DONDE ESTA ASIGNADO DURANTE EL MES REPORTADO": "OBRA LIMA NORTE",
        "DOMICILIO DE TRABAJADOR": "AV. SIEMPRE VIVA 742",
        "DISTRITO SEGÚN DNI": "SAN MARTIN DE PORRES",
        "GENERO": "masculino",
        "FECHA CESE/BAJA": null,
        "NACIONALIDAD": "PERUANA",
        "FECHA INICIO DE LABORES EN OBRA": 46054,   // 2026-02-01
        "ESTADO": 1,
        "TIPO DE CONTRATO LABORAL": 1,
        "HPT": 180.5,
        ...overrides,
    });
}

/** The three XML parts every structural assertion below reads. */
function parts(file) {
    const zip = new AdmZip(file);
    return {
        sheet: zip.readAsText("xl/worksheets/sheet1.xml"),
        styles: zip.readAsText("xl/styles.xml"),
        shared: zip.getEntry("xl/sharedStrings.xml") ? zip.readAsText("xl/sharedStrings.xml") : "",
        core: zip.getEntry("docProps/core.xml") ? zip.readAsText("docProps/core.xml") : "",
        names: zip.getEntries().map(e => e.entryName),
    };
}

/** cellXfs index -> numFmtId. */
function cellXfs(stylesXml) {
    const block = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
    assert.ok(block, "styles.xml has no cellXfs block");
    return [...block[1].matchAll(/<xf\b[^>]*?>/g)].map(m => {
        const id = /numFmtId="(\d+)"/.exec(m[0]);
        return id ? Number(id[1]) : 0;
    });
}

/** The raw <c> element for an address, or null when the cell does not exist at all. */
function cellNode(sheetXml, address) {
    const re = new RegExp(`<c r="${address}"(?![0-9])([^>]*)(?:/>|>([\\s\\S]*?)</c>)`);
    const m = re.exec(sheetXml);
    if (!m) return null;
    const attrs = m[1] || "";
    const type = /\bt="([^"]+)"/.exec(attrs);
    const style = /\bs="(\d+)"/.exec(attrs);
    return {
        xml: m[0],
        t: type ? type[1] : null,          // null = numeric, SheetJS omits t for numbers
        s: style ? Number(style[1]) : 0,
        inner: m[2] || "",
    };
}

/** Every <c> element in the sheet, as {address, col, t, s}. */
function allCells(sheetXml) {
    return [...sheetXml.matchAll(/<c r="([A-Z]+)(\d+)"([^>]*)(?:\/>|>[\s\S]*?<\/c>)/g)].map(m => ({
        address: m[1] + m[2],
        col: m[1],
        row: Number(m[2]),
        t: (/\bt="([^"]+)"/.exec(m[3]) || [null, null])[1],
        s: Number((/\bs="(\d+)"/.exec(m[3]) || [null, 0])[1]),
    }));
}

function sha1(file) {
    return crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
}

/** The values SheetJS reads back, raw (no date coercion, number formats kept). */
function readBack(file) {
    const wb = XLSX.readFile(file, { cellNF: true, cellStyles: true, cellDates: false, raw: true });
    return { wb, ws: wb.Sheets[SHEET_NAME] };
}

/* --------------------------------------------------------- the shape of the file */

test("writes one sheet named Cuadro with the 18 canonical headers in A..R", () => {
    const file = outPath("shape");
    const result = writeConsolidated([worker()], file, { period: "2026-02" });

    assert.ok(fs.existsSync(file));
    const { wb, ws } = readBack(file);
    assert.deepEqual(wb.SheetNames, [SHEET_NAME]);

    // Byte-exact, typo and accent included: these strings are the Tabla2 column names
    // every structured formula in the template references.
    for (const [canonical, col] of INDEX_BY_CANONICAL) {
        const address = XLSX.utils.encode_cell({ r: 0, c: col });
        assert.equal(ws[address].v, canonical, `header at ${address}`);
        assert.equal(ws[address].t, "s");
    }
    assert.equal(ws["C1"].v, "CONTRATISTA PRNCIPAL");
    assert.equal(ws["K1"].v, "DISTRITO SEGÚN DNI");

    assert.equal(result.hoja, SHEET_NAME);
    assert.equal(result.ref, "A1:R2");
    assert.equal(result.filas, 1);
    assert.equal(result.columnas, 18);
    assert.equal(result.periodo, "2026-02");
    assert.equal(result.path, path.resolve(file));
    assert.ok(result.bytes > 0);
});

test("creates missing parent directories and reports the resolved path", () => {
    const file = path.join(TMP, "anidado", "mas", "ReporteConsolidado.xlsx");
    const result = writeConsolidated([worker()], file, { period: "2026-02" });
    assert.ok(fs.existsSync(file));
    assert.equal(result.path, path.resolve(file));
});

test("zero records still produces a valid header-only sheet, ref A1:R1", () => {
    const file = outPath("vacio");
    const result = writeConsolidated([], file, { period: "2026-02" });
    assert.equal(result.ref, "A1:R1");
    assert.equal(result.filas, 0);
    const { ws } = readBack(file);
    assert.equal(ws["A1"].v, "RUC");
    assert.equal(ws["A2"], undefined);
});

test("ref grows past the template's 8,823-row ceiling (AC 16)", () => {
    const file = outPath("nueve-mil");
    const rows = [];
    for (let i = 0; i < 9000; i++) {
        rows.push(worker({ "APELLIDOS Y NOMBRES": `TRABAJADOR SINTETICO ${i}` }));
    }
    const result = writeConsolidated(rows, file, { period: "2026-02" });
    assert.equal(result.ref, "A1:R9001");
    assert.equal(result.filas, 9000);
    const { ws } = readBack(file);
    assert.equal(ws["E9001"].v, "TRABAJADOR SINTETICO 8999");
});

/* ------------------------------------------------------------------- dates (AC 9) */

test("dates are real serials carrying numFmtId 14, never text", () => {
    const file = outPath("fechas");
    writeConsolidated([worker({ "FECHA CESE/BAJA": 46081 })], file, { period: "2026-02" });

    const { sheet, styles } = parts(file);
    const xfs = cellXfs(styles);
    for (const address of ["F2", "M2", "O2"]) {
        const cell = cellNode(sheet, address);
        assert.ok(cell, `${address} must exist`);
        assert.equal(cell.t, null, `${address} must be numeric (no t attribute)`);
        assert.equal(xfs[cell.s], DATE_NUMFMT_ID, `${address} must carry numFmtId ${DATE_NUMFMT_ID}`);
    }

    const { ws } = readBack(file);
    assert.equal(ws["F2"].t, "n");
    assert.equal(ws["F2"].v, 25569);
    assert.equal(ws["F2"].z, DATE_FORMAT_CODE);
    assert.equal(ws["M2"].v, 46081);
    assert.equal(ws["O2"].v, 46054);
});

test("zero text values in F, M and O whatever arrives in them (AC 9, BUG-09)", () => {
    // Every shape measured in today's ReporteConsolidado.xlsx: 103 text values in F,
    // 4,894 in M (mostly ""), 100 in O, plus the FECHA CESE/BAJA sentinels of AC 10.
    const garbage = ["", " ", "-", " -", "---", "ACTIVO", "04/07/1994", "09/10/205", "undefined"];
    const rows = garbage.map(v => worker({
        "FECHA NACIMIENTO": v,
        "FECHA CESE/BAJA": v,
        "FECHA INICIO DE LABORES EN OBRA": v,
    }));
    rows.push(worker({ "FECHA NACIMIENTO": NaN, "FECHA CESE/BAJA": Infinity, "FECHA INICIO DE LABORES EN OBRA": 0 }));
    rows.push(worker());   // one good row, so the assertion is not vacuous

    const file = outPath("fechas-basura");
    const issues = new IssueList();
    const result = writeConsolidated(rows, file, { period: "2026-02", issues });

    const { sheet } = parts(file);
    const dateCells = allCells(sheet).filter(c => ["F", "M", "O"].includes(c.col) && c.row > 1);
    assert.ok(dateCells.length > 0);
    for (const c of dateCells) {
        assert.equal(c.t, null, `${c.address} must not be a text cell`);
    }
    // Only the good row survives: 3 date cells (F, M is null on the good row -> 2).
    assert.deepEqual(dateCells.map(c => c.address).sort(), ["F12", "O12"]);

    // Nothing threw; every refusal is a WARNING that names the column.
    assert.equal(issues.bySeverity(SEVERITY.ERROR).length, 0);
    assert.ok(result.celdas.rechazadas >= garbage.length * 3);
    const codes = new Set(issues.items.map(i => i.code));
    assert.ok(codes.has(CODE.CODE_OUT_OF_DOMAIN));
    for (const column of DATE_COLUMNS) {
        assert.ok(issues.items.some(i => i.columna === column), `no issue for ${column}`);
    }
});

test("a Date lands as the serial of its LOCAL components, an invalid Date does not land", () => {
    const file = outPath("fecha-objeto");
    const issues = new IssueList();
    writeConsolidated(
        [
            worker({ "FECHA NACIMIENTO": new Date(1994, 6, 4) }),     // 4 July 1994, local
            worker({ "FECHA NACIMIENTO": new Date("no es una fecha") }),
        ],
        file,
        { period: "2026-02", issues },
    );
    const { ws } = readBack(file);
    assert.equal(ws["F2"].t, "n");
    assert.equal(ws["F2"].v, dates.dateToSerial({ y: 1994, m: 7, d: 4 }));
    assert.equal(ws["F3"], undefined);
    assert.ok(issues.items.some(i => i.columna === "FECHA NACIMIENTO" && /Date invalida/.test(i.message)));
});

test("a fractional serial is truncated to its day and reported", () => {
    const file = outPath("fraccion");
    const issues = new IssueList();
    // .79166667 = 19:00, the exact offset of the 643-row broken export (03 §3.3).
    const result = writeConsolidated([worker({ "FECHA NACIMIENTO": 25569.79166667 })], file,
        { period: "2026-02", issues });
    const { ws } = readBack(file);
    assert.equal(ws["F2"].v, 25569);
    assert.equal(result.celdas.truncadas, 1);
    assert.equal(issues.byCode(CODE.DATE_FRACTIONAL_TRUNCATED).length, 1);
});

test("a serial outside Excel's range is refused, not written", () => {
    const file = outPath("rango");
    const issues = new IssueList();
    writeConsolidated(
        [worker({ "FECHA NACIMIENTO": 0, "FECHA CESE/BAJA": dates.MAX_SERIAL + 1, "FECHA INICIO DE LABORES EN OBRA": -5 })],
        file,
        { period: "2026-02", issues },
    );
    const { sheet } = parts(file);
    for (const address of ["F2", "M2", "O2"]) assert.equal(cellNode(sheet, address), null);
    assert.equal(issues.items.filter(i => /fuera del rango/.test(i.message)).length, 3);
});

/* -------------------------------------------------------------- identifiers (AC 13) */

test("RUC and Nro. DNI / CE are text cells; the leading zero of 09994533 survives", () => {
    const file = outPath("identificadores");
    writeConsolidated([worker({ "RUC": "09994533001", "Nro. DNI / CE": "09994533" })], file,
        { period: "2026-02" });

    const { sheet, shared } = parts(file);
    // The type is explicit in the XML, not inferred: t="s" (a shared string).
    assert.equal(cellNode(sheet, "A2").t, "s");
    assert.equal(cellNode(sheet, "D2").t, "s");
    assert.ok(shared.includes("09994533001"));
    assert.ok(shared.includes(">09994533<"));

    const { ws } = readBack(file);
    assert.equal(ws["A2"].t, "s");
    assert.equal(ws["A2"].v, "09994533001");
    assert.equal(ws["D2"].t, "s");
    assert.equal(ws["D2"].v, "09994533");          // not 9994533
    assert.notEqual(typeof ws["D2"].v, "number");
});

test("a numeric identifier is written as text and reported (BUG-23)", () => {
    const file = outPath("identificador-numerico");
    const issues = new IssueList();
    writeConsolidated([worker({ "RUC": 20604191883, "Nro. DNI / CE": 9994533 })], file,
        { period: "2026-02", issues });

    const { ws } = readBack(file);
    assert.equal(ws["A2"].t, "s");
    assert.equal(ws["A2"].v, "20604191883");
    assert.equal(ws["D2"].t, "s");
    assert.equal(ws["D2"].v, "9994533");
    assert.equal(issues.byCode(CODE.TEXT_NORMALIZED).length, 2);
    assert.ok(issues.items.every(i => i.severity === SEVERITY.WARNING));
});

/* ------------------------------------------------------- empties are truly empty (AC 15) */

test("an absent value has no <c> element at all - not \"\", not null, not 0", () => {
    const file = outPath("vacios");
    const row = record({
        "APELLIDOS Y NOMBRES": "SOLO EL NOMBRE",
        "EMPRESA": "",              // empty string
        "CONTRATISTA PRNCIPAL": "   ",   // whitespace only
        "NACIONALIDAD": undefined,
        "DISTRITO SEGÚN DNI": null,
    });
    const result = writeConsolidated([row], file, { period: "2026-02" });

    const { sheet } = parts(file);
    for (const address of ["A2", "B2", "C2", "D2", "F2", "K2", "N2", "R2"]) {
        assert.equal(cellNode(sheet, address), null, `${address} must not exist`);
    }
    assert.ok(cellNode(sheet, "E2"), "E2 must exist");

    // and nowhere in the file is there a cell holding the empty string
    assert.equal(/<c [^>]*><v><\/v><\/c>/.test(sheet), false);
    assert.equal(/<is><t\/><\/is>/.test(sheet), false);

    const { ws } = readBack(file);
    assert.equal(ws["B2"], undefined);
    for (const address of Object.keys(ws)) {
        if (address.startsWith("!")) continue;
        assert.notEqual(ws[address].v, "", `${address} holds an empty string`);
    }
    assert.equal(result.celdas.escritas, 1);
    assert.equal(result.celdas.vacias, 17);
});

/* ---------------------------------------------------- placement by name (BUG-13) */

test("a record whose keys are in REVERSED order still lands in the correct columns", () => {
    const straight = worker({ "FECHA CESE/BAJA": 46081 });

    const reversed = {};
    for (const key of Object.keys(straight).reverse()) reversed[key] = straight[key];
    assert.deepEqual(Object.keys(reversed), CANONICAL.slice().reverse());   // guard the guard

    const fileA = outPath("orden-normal");
    const fileB = outPath("orden-invertido");
    writeConsolidated([straight], fileA, { period: "2026-02" });
    writeConsolidated([reversed], fileB, { period: "2026-02" });

    // Placement is by name, so the two files are indistinguishable - byte for byte.
    assert.equal(sha1(fileA), sha1(fileB));

    const { ws } = readBack(fileB);
    assert.equal(ws["A2"].v, "20512345678");
    assert.equal(ws["E2"].v, "PEREZ QUISPE JUAN CARLOS");
    assert.equal(ws["F2"].v, 25569);
    assert.equal(ws["L2"].v, "masculino");
    assert.equal(ws["M2"].v, 46081);
    assert.equal(ws["R2"].v, 180.5);
});

test("unknown keys are ignored and missing keys are empty - no shifting", () => {
    const file = outPath("claves-extra");
    const row = {
        provenance: { subcontratista: "SUBCONTRATA X", archivo: "reporte.xlsx", hoja: "Cuadro", filaOrigen: 1743 },
        errorEnArchivo: "reporte.xlsx",       // the old pipeline's stray key
        "HPT": 8,
        "APELLIDOS Y NOMBRES": "SOLO DOS CAMPOS",
    };
    const result = writeConsolidated([row], file, { period: "2026-02" });
    const { ws } = readBack(file);
    assert.equal(ws["E2"].v, "SOLO DOS CAMPOS");
    assert.equal(ws["R2"].v, 8);
    assert.equal(ws["A2"], undefined);
    assert.equal(ws["S2"], undefined);          // nothing past R
    assert.equal(result.ref, "A1:R2");
    assert.equal(result.celdas.escritas, 2);
});

test("provenance travels into the issue, so a bad value names its source workbook (BUG-22)", () => {
    const file = outPath("procedencia");
    const issues = new IssueList();
    writeConsolidated(
        [worker({
            "FECHA NACIMIENTO": "3/5/65",
            provenance: { subcontratista: "SUBCONTRATA X", archivo: "reporte.xlsx", hoja: "Cuadro", filaOrigen: 1743 },
        })],
        file,
        { period: "2026-02", issues },
    );
    const issue = issues.items.find(i => i.columna === "FECHA NACIMIENTO");
    assert.ok(issue);
    assert.equal(issue.subcontratista, "SUBCONTRATA X");
    assert.equal(issue.archivo, "reporte.xlsx");
    assert.equal(issue.fila, 1743);
    assert.equal(issue.valor, "3/5/65");
    assert.equal(issue.detalle.celdaConsolidado, "F2");
});

/* ------------------------------------------- NaN and "undefined" (AC 11, AC 12) */

test("NaN, Infinity and the literal strings undefined/NaN/null never reach a cell", () => {
    const file = outPath("artefactos");
    const issues = new IssueList();
    const rows = [
        worker({ "GENERO": "undefined", "HPT": NaN, "ESTADO": NaN }),
        worker({ "NACIONALIDAD": "NaN", "TIPO TRABAJADOR": Infinity, "EMPRESA": "null" }),
        worker({ "TITULO DE PUESTO/CARGO": true, "DOMICILIO DE TRABAJADOR": { a: 1 } }),
        worker(),
    ];
    const result = writeConsolidated(rows, file, { period: "2026-02", issues });

    const { sheet, shared } = parts(file);
    // AC 12 is absolute and so is the check: the literal must not be anywhere in the file.
    assert.equal(/undefined/.test(shared), false);
    assert.equal(/undefined/.test(sheet), false);
    assert.equal(/>NaN</.test(shared), false);
    assert.equal(/NaN/.test(sheet), false);
    assert.equal(/>null</.test(shared), false);

    for (const address of ["L2", "R2", "P2", "N3", "G3", "B3", "H4", "J4"]) {
        assert.equal(cellNode(sheet, address), null, `${address} must not exist`);
    }
    assert.equal(result.celdas.rechazadas, 8);
    assert.equal(issues.bySeverity(SEVERITY.WARNING).length, 8);
    assert.equal(issues.bySeverity(SEVERITY.ERROR).length, 0);

    // the untouched row is intact
    const { ws } = readBack(file);
    assert.equal(ws["L5"].v, "masculino");
    assert.equal(ws["R5"].v, 180.5);
});

test("text is written verbatim - a trailing space is data, not something to fix here", () => {
    const file = outPath("verbatim");
    writeConsolidated([worker({ "APELLIDOS Y NOMBRES": "HUARCAYA COCCHE JESUS " })], file,
        { period: "2026-02" });
    const { ws } = readBack(file);
    assert.equal(ws["E2"].v, "HUARCAYA COCCHE JESUS ");
});

/* ------------------------------------------------------------- rows, not throws */

test("a non-object in the records array is skipped with a warning, never thrown", () => {
    const file = outPath("fila-invalida");
    const issues = new IssueList();
    const result = writeConsolidated([worker(), null, "una fila", 42, [], worker()], file,
        { period: "2026-02", issues });
    assert.equal(result.filas, 2);
    assert.equal(result.filasOmitidas, 4);
    assert.equal(result.ref, "A1:R3");
    assert.equal(issues.bySeverity(SEVERITY.WARNING).length, 4);
});

test("the cell counters conserve: escritas + vacias == filas x 18, rechazadas subset of vacias", () => {
    const file = outPath("conservacion");
    const rows = [
        worker(),
        worker({ "HPT": NaN, "FECHA CESE/BAJA": "ACTIVO" }),
        record({ "APELLIDOS Y NOMBRES": "CASI VACIO" }),
        "no soy un registro",
    ];
    const result = writeConsolidated(rows, file, { period: "2026-02" });
    assert.equal(result.filas, 3);
    assert.equal(result.filasOmitidas, 1);
    assert.equal(result.celdas.escritas + result.celdas.vacias, result.filas * CANONICAL.length);
    assert.ok(result.celdas.rechazadas <= result.celdas.vacias);
    assert.equal(result.celdas.rechazadas, 2);
    // one issue per refusal, plus one for the row that was not a record
    assert.equal(result.issues.length, 3);
});

test("issues are appended to the caller's list, and a fresh one is returned when none is given", () => {
    const file = outPath("lista-propia");
    const issues = new IssueList();
    issues.info({ code: CODE.ANCHOR_FOUND, message: "preexistente" });
    const result = writeConsolidated([worker({ "HPT": NaN })], file, { period: "2026-02", issues });
    assert.equal(result.issues, issues);
    assert.equal(issues.length, 2);

    const otro = writeConsolidated([worker({ "HPT": NaN })], outPath("lista-nueva"), { period: "2026-02" });
    assert.ok(otro.issues instanceof IssueList);
    assert.equal(otro.issues.length, 1);
});

/* ----------------------------------------------------------- period and determinism */

test("the period is stamped in docProps and never inferred when absent", () => {
    const conPeriodo = outPath("con-periodo");
    writeConsolidated([worker()], conPeriodo, { period: "2026-02" });
    assert.ok(parts(conPeriodo).core.includes("Reporte consolidado - FEBRERO 2026"));

    // A descriptor is accepted as well as the string.
    const desc = require("../pipeline/period").parsePeriod("2026-05");
    const conDescriptor = outPath("con-descriptor");
    const r = writeConsolidated([worker()], conDescriptor, { period: desc });
    assert.equal(r.periodo, "2026-05");
    assert.ok(parts(conDescriptor).core.includes("MAYO 2026"));

    // Absent: no title, no clock read, no guess.
    const sinPeriodo = outPath("sin-periodo");
    const sin = writeConsolidated([worker()], sinPeriodo);
    assert.equal(sin.periodo, null);
    assert.equal(/dc:title/.test(parts(sinPeriodo).core), false);
});

test("same records + same period => byte-identical file (AC 26)", () => {
    const rows = [worker(), worker({ "APELLIDOS Y NOMBRES": "OTRO TRABAJADOR", "FECHA CESE/BAJA": 46081 })];
    const a = outPath("determinismo-a");
    const b = outPath("determinismo-b");
    writeConsolidated(rows, a, { period: "2026-02" });
    writeConsolidated(rows, b, { period: "2026-02" });
    assert.equal(sha1(a), sha1(b));
});

test("re-running the same period overwrites in place", () => {
    const file = outPath("sobrescribe");
    writeConsolidated([worker(), worker(), worker()], file, { period: "2026-02" });
    const first = fs.statSync(file).size;
    const result = writeConsolidated([worker()], file, { period: "2026-02" });
    assert.equal(result.filas, 1);
    assert.ok(fs.statSync(file).size < first);
    const { ws } = readBack(file);
    assert.equal(ws["A3"], undefined);
});

/* -------------------------------------------------------- wiring bugs still throw */

test("bad arguments throw - they are caller bugs, not data problems", () => {
    assert.throws(() => writeConsolidated(null, outPath("x")), TypeError);
    assert.throws(() => writeConsolidated({}, outPath("x")), TypeError);
    assert.throws(() => writeConsolidated([], ""), TypeError);
    assert.throws(() => writeConsolidated([], outPath("x"), { period: "febrero" }));
    assert.throws(() => writeConsolidated([], outPath("x"), { period: 202602 }), TypeError);
});

/* ------------------------------------------------------------- buildSheet directly */

test("buildSheet is usable without touching the filesystem", () => {
    const ws = buildSheet([worker()]);
    assert.equal(ws["!ref"], "A1:R2");
    assert.equal(ws["A1"].v, "RUC");
    assert.equal(ws["F2"].z, DATE_FORMAT_CODE);
    assert.equal(ws["M2"], undefined);
});

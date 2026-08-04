"use strict";
/**
 * Tests for pipeline/workbook.js.
 *
 * The Phase-0 fixture corpus does not exist yet, so every workbook here is built in
 * memory with XLSX.utils.aoa_to_sheet and written to a temp directory. Each one
 * reproduces a pathology measured in the plan, not a toy input:
 *   - a preamble above the header and a leading blank column (BUG-02/BUG-03)
 *   - EMPRESA to the LEFT of RUC (03-expected-output.md §1.2 step 4)
 *   - accent-stripped / space-padded headers, the correctly spelled
 *     CONTRATISTA PRINCIPAL (BUG-03)
 *   - a duplicate header (BUG-05)
 *   - a sheet named "CUADRO " and a workbook with no Cuadro sheet at all (BUG-01)
 *   - the column-shifted shape with a RUC in the name column - the 643-row block of
 *     03-expected-output.md §2.3 in miniature
 *   - a decoy "RUC" title cell above the real table (§1.2 step 6)
 *   - the older input format with no HPT column (BUG-55)
 * Assertions are on the exact issue CODE and SEVERITY, never on success/failure alone.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const XLSX = require("xlsx");

const { readWorkbook, matchSheetName, isNumericName } = require("../pipeline/workbook");
const { IssueList, SEVERITY, CODE } = require("../pipeline/issues");
const { CANONICAL } = require("../pipeline/columns");
const config = require("../config");
const CASES = require("./cases/workbook.json");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "workbook-test-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
/** Write a workbook from {sheetName: aoa} and return its path. */
function build(sheets, opts = {}) {
    const wb = XLSX.utils.book_new();
    for (const [name, aoa] of Object.entries(sheets)) {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
    }
    if (opts.date1904) wb.Workbook = { WBProps: { date1904: true } };
    const file = path.join(TMP, `wb-${++seq}.xlsx`);
    XLSX.writeFile(wb, file);
    return file;
}

/** Read with a fresh IssueList. */
function read(file, subcontratista = "SUBCONTRATA X") {
    const issues = new IssueList();
    const result = readWorkbook(file, { subcontratista, issues });
    return { result, issues };
}

function codes(issues) {
    return issues.items.map(i => i.code);
}
function only(issues, code) {
    return issues.byCode(code);
}
function one(issues, code) {
    const hits = issues.byCode(code);
    assert.equal(hits.length, 1, `expected exactly one ${code}, got ${hits.length} (${codes(issues).join(",")})`);
    return hits[0];
}

/** Two realistic rows, in canonical order. Synthetic identities. */
const ROW_A = [
    "20512345678", "CONSTRUCTORA ALFA SAC", "CJ INGENIEROS SAC", "09994533",
    "PEREZ QUISPE, JUAN CARLOS", 30000, 1, "OPERARIO",
    "OBRA LIMA NORTE", "AV. LOS OLIVOS 123", "SANTA ANITA", "masculino",
    null, "PERUANA", 45000, 1, 1, 176,
];
const ROW_B = [
    "20512345678", "CONSTRUCTORA ALFA SAC", "CJ INGENIEROS SAC", "45678912",
    "MAMANI CONDORI, ROSA", 28000, 2, "AYUDANTE",
    "OBRA LIMA NORTE", "JR. UNION 456", "ATE", "femenino",
    45100, "PERUANA", 45010, 2, 2, 96,
];

/** The canonical header row, optionally with per-index overrides. */
function headerRow(overrides = {}) {
    return CANONICAL.map((name, i) => (i in overrides ? overrides[i] : name));
}

// --------------------------------------------------------------------------
// case table
// --------------------------------------------------------------------------

test("case table: matchSheetName folds case, accents and whitespace", () => {
    for (const c of CASES.sheetMatch) {
        const got = matchSheetName(c.input);
        if (c.expected === null) {
            assert.equal(got, null, `expected no match for ${JSON.stringify(c.input)}`);
            assert.equal(c.expectedIssue, CODE.SHEET_NOT_FOUND);
        } else {
            assert.deepEqual(got, c.expected, `for ${JSON.stringify(c.input)}`);
            assert.equal(
                c.expectedIssue,
                got.exact ? null : CODE.SHEET_MATCHED_LOOSELY,
                `issue expectation for ${JSON.stringify(c.input)}`
            );
        }
    }
});

test("case table: isNumericName catches the shifted-row artefacts", () => {
    for (const c of CASES.numericName) {
        assert.equal(isNumericName(c.input), c.expected, `for ${JSON.stringify(c.input)}`);
        assert.equal(c.expectedIssue, c.expected ? CODE.ROW_NUMERIC_NAME : null);
    }
});

// --------------------------------------------------------------------------
// 1. sheet location (BUG-01)
// --------------------------------------------------------------------------

test("sheet named 'CUADRO ' with trailing space and different case is matched loosely", () => {
    const file = build({ "CUADRO ": [headerRow(), ROW_A] });
    const { result, issues } = read(file);
    assert.equal(result.ok, true);
    assert.equal(result.rows.length, 1);
    assert.equal(result.provenance.hoja, "CUADRO ");
    const i = one(issues, CODE.SHEET_MATCHED_LOOSELY);
    assert.equal(i.severity, SEVERITY.INFO);
    assert.equal(i.detalle.nombreReal, "CUADRO ");
});

test("exactly named 'Cuadro' raises no loose-match issue", () => {
    const file = build({ Hoja1: [["x"]], Cuadro: [headerRow(), ROW_A] });
    const { result, issues } = read(file);
    assert.equal(result.ok, true);
    assert.equal(only(issues, CODE.SHEET_MATCHED_LOOSELY).length, 0);
});

test("no Cuadro sheet fails LOUDLY naming folder, file and the sheets present", () => {
    const file = build({ Hoja1: [["a"]], "Cuadro 2026": [headerRow(), ROW_A] });
    const { result, issues } = read(file, "SUBCONTRATA OMEGA");
    assert.equal(result.ok, false);
    assert.deepEqual(result.rows, []);
    const i = one(issues, CODE.SHEET_NOT_FOUND);
    assert.equal(i.severity, SEVERITY.FAILED);
    assert.equal(i.subcontratista, "SUBCONTRATA OMEGA");
    assert.match(i.message, /SUBCONTRATA OMEGA/);
    assert.match(i.message, /wb-\d+\.xlsx/);
    assert.match(i.message, /Hoja1/);
    assert.match(i.message, /Cuadro 2026/);
    assert.deepEqual(i.detalle.hojasPresentes, ["Hoja1", "Cuadro 2026"]);
    // BUG-01: a failed file must never look like "this company has no workers".
    assert.equal(issues.hasBlockingIssues(), true);
});

test("a corrupt file is FAILED, never a throw", () => {
    const file = path.join(TMP, "corrupto.xlsx");
    fs.writeFileSync(file, Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.from("basura".repeat(40))]));
    const { result, issues } = read(file);
    assert.equal(result.ok, false);
    const i = one(issues, CODE.WORKBOOK_UNREADABLE);
    assert.equal(i.severity, SEVERITY.FAILED);
    assert.match(i.message, /SUBCONTRATA X/);
});

test("a file that is not a workbook at all still fails loudly (no Cuadro sheet)", () => {
    // SheetJS sniffs a plain text file as a one-sheet CSV rather than throwing, so the
    // loud failure arrives as SHEET_NOT_FOUND. Either way it is never a silent zero.
    const file = path.join(TMP, "no-es-libro.xlsx");
    fs.writeFileSync(file, "esto no es un libro de excel");
    const { result, issues } = read(file);
    assert.equal(result.ok, false);
    assert.equal(issues.hasBlockingIssues(), true);
    assert.equal(issues.bySeverity(SEVERITY.FAILED).length, 1);
});

// --------------------------------------------------------------------------
// 2. anchoring
// --------------------------------------------------------------------------

test("three-row preamble plus a leading blank column: anchor found at B4", () => {
    const pad = r => [null, ...r];
    const file = build({
        Cuadro: [
            [null, "REPORTE MENSUAL DE PERSONAL"],
            [null, "Empresa: CONSTRUCTORA ALFA SAC"],
            [],
            pad(headerRow()),
            pad(ROW_A),
            pad(ROW_B),
        ],
    });
    const { result, issues } = read(file);
    assert.equal(result.ok, true);
    assert.equal(result.anchor.celda, "B4");
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0]["APELLIDOS Y NOMBRES"], "PEREZ QUISPE, JUAN CARLOS");
    const i = one(issues, CODE.ANCHOR_FOUND);
    assert.equal(i.severity, SEVERITY.INFO);
    assert.equal(i.celda, "B4");
    assert.equal(i.detalle.filaEncabezado, 4);
    assert.equal(i.detalle.encabezadosResueltos, 18);
});

test("provenance is stamped on every row with the 1-based sheet row", () => {
    const file = build({ Cuadro: [[], [], headerRow(), ROW_A, ROW_B] });
    const { result } = read(file, "SUBCONTRATA X");
    assert.equal(result.rows.length, 2);
    assert.deepEqual(result.rows[0].provenance, {
        subcontratista: "SUBCONTRATA X",
        archivo: path.basename(result.provenance.archivo),
        hoja: "Cuadro",
        filaOrigen: 4,
        celdaAncla: "A3",
    });
    assert.equal(result.rows[1].provenance.filaOrigen, 5);
});

test("EMPRESA to the LEFT of RUC is recovered, not discarded", () => {
    // The anchor fixes the ROW only. Left-edge anchoring would drop B and C here and
    // still resolve 16 of 18, so the >=8 threshold would never see it.
    const shifted = [
        "EMPRESA", "CONTRATISTA PRNCIPAL", "RUC",
        ...CANONICAL.filter(n => !["EMPRESA", "CONTRATISTA PRNCIPAL", "RUC"].includes(n)),
    ];
    const values = shifted.map(name => ROW_A[CANONICAL.indexOf(name)]);
    const file = build({ Cuadro: [shifted, values] });
    const { result, issues } = read(file);
    assert.equal(result.ok, true);
    assert.equal(result.rows[0].EMPRESA, "CONSTRUCTORA ALFA SAC");
    assert.equal(result.rows[0]["CONTRATISTA PRNCIPAL"], "CJ INGENIEROS SAC");
    assert.equal(result.rows[0].RUC, "20512345678");
    const i = one(issues, CODE.LEFT_EDGE_EXTENDED);
    assert.equal(i.severity, SEVERITY.INFO);
    assert.equal(i.detalle.columnasAdicionales, 2);
    assert.deepEqual(i.detalle.columnasRecuperadas, ["EMPRESA", "CONTRATISTA PRNCIPAL"]);
    assert.match(i.message, /left edge resolved at A1/);
});

test("no LEFT_EDGE_EXTENDED when RUC really is the left edge", () => {
    const file = build({ Cuadro: [headerRow(), ROW_A] });
    const { issues } = read(file);
    assert.equal(only(issues, CODE.LEFT_EDGE_EXTENDED).length, 0);
});

test("columns in a different order land under the right canonical keys", () => {
    const order = [...CANONICAL].reverse();
    const values = order.map(name => ROW_B[CANONICAL.indexOf(name)]);
    const file = build({ Cuadro: [order, values] });
    const { result } = read(file);
    assert.equal(result.ok, true);
    for (const name of CANONICAL) {
        assert.equal(result.rows[0][name], ROW_B[CANONICAL.indexOf(name)], `column ${name}`);
    }
    assert.equal(result.anchor.celda, "R1");   // RUC is last after reversing
});

test("a decoy 'RUC' title cell above the table does not win the anchor", () => {
    const file = build({
        Cuadro: [
            ["RUC"],                                  // a lone title cell, 0 canonical neighbours
            ["20512345678"],
            [],
            headerRow(),
            ROW_A,
        ],
    });
    const { result, issues } = read(file);
    assert.equal(result.ok, true);
    assert.equal(result.anchor.celda, "A4");
    assert.equal(result.rows.length, 1);
    assert.equal(one(issues, CODE.ANCHOR_FOUND).celda, "A4");
});

test("a header row resolving fewer than ANCHOR_MIN_HEADERS is rejected, never read", () => {
    const file = build({
        Cuadro: [
            ["RUC", "EMPRESA", "OBSERVACIONES", "COMENTARIO"],
            ["20512345678", "CONSTRUCTORA ALFA SAC", "nada", "nada"],
        ],
    });
    const { result, issues } = read(file);
    assert.equal(result.ok, false);
    assert.deepEqual(result.rows, []);
    const i = one(issues, CODE.ANCHOR_NOT_FOUND);
    assert.equal(i.severity, SEVERITY.FAILED);
    assert.equal(i.detalle.candidatosRUC, 1);
    assert.equal(i.detalle.minimoEncabezados, config.ANCHOR_MIN_HEADERS);
    assert.ok(i.detalle.primerasCeldas.length > 0);
});

test("no RUC anywhere fails with the first non-empty cell values, never a fallback to A1", () => {
    const file = build({
        Cuadro: [
            ["PLANILLA DE PERSONAL"],
            ["NOMBRE", "CARGO", "FECHA"],
            ["PEREZ QUISPE, JUAN CARLOS", "OPERARIO", 45000],
        ],
    });
    const { result, issues } = read(file);
    assert.equal(result.ok, false);
    const i = one(issues, CODE.ANCHOR_NOT_FOUND);
    assert.equal(i.severity, SEVERITY.FAILED);
    assert.equal(i.detalle.candidatosRUC, 0);
    assert.ok(i.detalle.primerasCeldas.length >= 1 && i.detalle.primerasCeldas.length <= 10);
    assert.equal(i.detalle.primerasCeldas[0].valor, "PLANILLA DE PERSONAL");
});

test("a RUC below the search window is out of reach and fails loudly", () => {
    const filler = Array.from({ length: config.ANCHOR_MAX_ROWS }, (_, i) => [`nota ${i}`]);
    const file = build({ Cuadro: [...filler, headerRow(), ROW_A] });
    const { result, issues } = read(file);
    assert.equal(result.ok, false);
    assert.equal(one(issues, CODE.ANCHOR_NOT_FOUND).detalle.candidatosRUC, 0);
});

// --------------------------------------------------------------------------
// 3. header resolution
// --------------------------------------------------------------------------

test("accent-stripped, space-padded and mixed-case headers resolve via the normalizer", () => {
    const headers = headerRow({ 0: "RUC ", 10: "  distrito  según   dni", 1: "Empresa", 13: "nacionalidad" });
    const file = build({ Cuadro: [headers, ROW_A] });
    const { result, issues } = read(file);
    assert.equal(result.ok, true);
    assert.equal(result.rows[0]["DISTRITO SEGÚN DNI"], "SANTA ANITA");
    assert.equal(result.rows[0].EMPRESA, "CONSTRUCTORA ALFA SAC");
    assert.deepEqual(result.missingColumns, []);
    // The normalizer, not the alias table: no alias issue for these.
    assert.equal(only(issues, CODE.HEADER_ALIAS_ACCEPTED).length, 0);
    assert.equal(only(issues, CODE.HEADER_UNRECOGNIZED).length, 0);
});

test("unaccented DISTRITO SEGUN DNI produces a populated column, not a blank one", () => {
    const file = build({ Cuadro: [headerRow({ 10: "DISTRITO SEGUN DNI" }), ROW_A] });
    const { result } = read(file);
    assert.equal(result.rows[0]["DISTRITO SEGÚN DNI"], "SANTA ANITA");
    assert.deepEqual(result.missingColumns, []);
});

test("the correctly spelled CONTRATISTA PRINCIPAL is accepted via the alias table and logged", () => {
    const file = build({ Cuadro: [headerRow({ 2: "CONTRATISTA PRINCIPAL" }), ROW_A] });
    const { result, issues } = read(file);
    assert.equal(result.rows[0]["CONTRATISTA PRNCIPAL"], "CJ INGENIEROS SAC");
    const i = one(issues, CODE.HEADER_ALIAS_ACCEPTED);
    assert.equal(i.severity, SEVERITY.INFO);
    assert.equal(i.columna, "CONTRATISTA PRNCIPAL");
    assert.equal(i.valor, "CONTRATISTA PRINCIPAL");
    assert.match(i.message, /accepted alias "CONTRATISTA PRINCIPAL" as "CONTRATISTA PRNCIPAL"/);
});

test("an unrecognized header is reported and listed, never silently dropped", () => {
    const file = build({ Cuadro: [[...headerRow(), "OBSERVACIONES"], [...ROW_A, "ninguna"]] });
    const { result, issues } = read(file);
    assert.equal(result.ok, true);
    const i = one(issues, CODE.HEADER_UNRECOGNIZED);
    assert.equal(i.severity, SEVERITY.INFO);
    assert.equal(i.valor, "OBSERVACIONES");
    assert.equal(i.celda, "S1");
    assert.deepEqual(result.unrecognizedHeaders.map(h => h.raw), ["OBSERVACIONES"]);
    assert.equal("OBSERVACIONES" in result.rows[0], false);
});

test("a duplicate canonical header rejects the workbook instead of suffixing _1", () => {
    // BUG-05: sheet_to_json would name the second column ESTADO_1 and the old cleanup
    // loop would delete it, so one of the two wins with no message.
    const file = build({ Cuadro: [[...headerRow(), "ESTADO"], [...ROW_A, 3]] });
    const { result, issues } = read(file);
    assert.equal(result.ok, false);
    assert.deepEqual(result.rows, []);
    const i = one(issues, CODE.HEADER_DUPLICATE);
    assert.equal(i.severity, SEVERITY.FAILED);
    assert.equal(i.columna, "ESTADO");
    assert.deepEqual(i.detalle.celdas, ["P1", "S1"]);
});

test("two competing ALIASES for one canonical column are a fatal duplicate", () => {
    // Neither claimant carries the exact spelling, so the choice would be arbitrary.
    const headers = headerRow({ 11: "SEXO" });          // GENERO -> SEXO
    const file = build({ Cuadro: [[...headers, "GENERO / SEXO"], [...ROW_A, "masculino"]] });
    const { result, issues } = read(file);
    assert.equal(result.ok, false);
    const i = one(issues, CODE.HEADER_DUPLICATE);
    assert.equal(i.severity, SEVERITY.FAILED);
    assert.equal(i.columna, "GENERO");
    assert.deepEqual(i.detalle.celdas, ["L1", "S1"]);
});

test("the exact canonical spelling beats an alias claim on the same column", () => {
    // The live case: the format the client distributes (Formato Reporte
    // subcontratas.xlsx) carries the template's computed column "Trabajador" at AA1,
    // an alias of APELLIDOS Y NOMBRES, alongside the real APELLIDOS Y NOMBRES at E1.
    // Failing that workbook would reject the client's own format.
    const file = build({
        Cuadro: [[...headerRow(), "Edad", "Trabajador"], [...ROW_A, 31, 1]],
    });
    const { result, issues } = read(file);
    assert.equal(result.ok, true);
    assert.equal(result.rows[0]["APELLIDOS Y NOMBRES"], "PEREZ QUISPE, JUAN CARLOS");
    assert.equal(result.headerMap["APELLIDOS Y NOMBRES"].celda, "E1");
    const i = one(issues, CODE.HEADER_DUPLICATE);
    assert.equal(i.severity, SEVERITY.WARNING);          // visible, but not fatal
    assert.equal(i.columna, "APELLIDOS Y NOMBRES");
    assert.equal(i.celda, "T1");
    assert.equal(i.detalle.ganadora, "E1");
    assert.equal(only(issues, CODE.HEADER_ALIAS_ACCEPTED).length, 0);
});

test("the exact spelling wins even when the alias comes first", () => {
    const headers = headerRow({ 4: "TRABAJADOR" });      // alias in column E
    const file = build({ Cuadro: [[...headers, "APELLIDOS Y NOMBRES"], [...ROW_A, "MAMANI CONDORI, ROSA"]] });
    const { result, issues } = read(file);
    assert.equal(result.ok, true);
    assert.equal(result.headerMap["APELLIDOS Y NOMBRES"].celda, "S1");
    assert.equal(result.rows[0]["APELLIDOS Y NOMBRES"], "MAMANI CONDORI, ROSA");
    assert.equal(one(issues, CODE.HEADER_DUPLICATE).celda, "E1");
});

test("a missing HPT column is a WARNING with the affected row count (BUG-55)", () => {
    // The older format, src/Formato Reporte subcontratas.xlsx, stops at
    // TIPO DE CONTRATO LABORAL. HPT is the "# Horas" measure on CJ Y EPC.
    const headers = CANONICAL.slice(0, 17);
    const file = build({ Cuadro: [headers, ROW_A.slice(0, 17), ROW_B.slice(0, 17)] });
    const { result, issues } = read(file);
    assert.equal(result.ok, true);
    assert.deepEqual(result.missingColumns, ["HPT"]);
    const i = one(issues, CODE.COLUMN_MISSING);
    assert.equal(i.severity, SEVERITY.WARNING);
    assert.equal(i.columna, "HPT");
    assert.equal(i.detalle.filasAfectadas, 2);
    assert.equal(i.detalle.senalDeVersion, true);
    // The field is nulled EXPLICITLY - never absent, never undefined.
    for (const row of result.rows) {
        assert.equal("HPT" in row, true);
        assert.equal(row.HPT, null);
    }
});

test("every row carries all 18 canonical keys, and an empty cell is null not undefined", () => {
    const sparse = [...ROW_A];
    sparse[10] = null;                       // DISTRITO SEGÚN DNI empty
    const file = build({ Cuadro: [headerRow(), sparse] });
    const { result } = read(file);
    const row = result.rows[0];
    for (const name of CANONICAL) {
        assert.equal(name in row, true, `${name} key missing`);
        assert.notEqual(row[name], undefined, `${name} is undefined`);
    }
    assert.equal(row["DISTRITO SEGÚN DNI"], null);
    assert.equal(row["FECHA CESE/BAJA"], null);
});

// --------------------------------------------------------------------------
// 4. rows
// --------------------------------------------------------------------------

test("the column-shifted block: every numeric name is an ERROR row rejection", () => {
    // 03-expected-output.md §2.3 in miniature: headers intact, VALUES off by four
    // columns, so the RUC lands in APELLIDOS Y NOMBRES. 643 rows of the last real run
    // (12.7%) looked exactly like this and counted as ONE person between them.
    const shift = r => [null, null, null, null, ...r.slice(0, 14)];
    const file = build({ Cuadro: [headerRow(), shift(ROW_A), shift(ROW_B), ROW_A] });
    const { result, issues } = read(file);
    assert.equal(result.ok, true);
    assert.equal(result.rows.length, 1);              // only the intact row survives
    assert.equal(result.stats.rowsFound, 3);
    assert.equal(result.stats.rowsRejected, 2);
    const rejections = only(issues, CODE.ROW_NUMERIC_NAME);
    assert.equal(rejections.length, 2);
    for (const r of rejections) {
        assert.equal(r.severity, SEVERITY.ERROR);
        assert.equal(r.columna, "APELLIDOS Y NOMBRES");
        assert.equal(r.subcontratista, "SUBCONTRATA X");
        assert.equal(r.valor, "20512345678");
    }
    assert.equal(rejections[0].fila, 2);
    assert.equal(rejections[0].celda, "E2");
    assert.equal(rejections[1].fila, 3);
    assert.equal(rejections[1].celda, "E3");
    // AC 14: zero rows where APELLIDOS Y NOMBRES is numeric.
    assert.equal(result.rows.filter(r => isNumericName(r["APELLIDOS Y NOMBRES"])).length, 0);
});

test("a numeric name stored as a number is rejected too", () => {
    const numeric = [...ROW_A];
    numeric[4] = 20101155588;
    const file = build({ Cuadro: [headerRow(), numeric] });
    const { result, issues } = read(file);
    assert.equal(result.rows.length, 0);
    assert.equal(one(issues, CODE.ROW_NUMERIC_NAME).valor, 20101155588);
});

test("interior blank rows are skipped and trailing blank rows are discarded", () => {
    const file = build({
        Cuadro: [headerRow(), ROW_A, [], ROW_B, [], [], [null, null, null]],
    });
    const { result, issues } = read(file);
    assert.equal(result.rows.length, 2);
    assert.equal(result.stats.blankRows, 1);          // only the interior one is seen
    assert.equal(result.stats.rowsFound, 2);
    assert.equal(only(issues, CODE.ROW_EMPTY).length, 1);
    assert.equal(only(issues, CODE.ROW_EMPTY)[0].severity, SEVERITY.INFO);
    assert.equal(result.rows[1].provenance.filaOrigen, 4);
});

test("a header with zero data rows below it fails the workbook", () => {
    const file = build({ Cuadro: [headerRow()] });
    const { result, issues } = read(file);
    assert.equal(result.ok, false);
    const i = one(issues, CODE.ROW_EMPTY);
    assert.equal(i.severity, SEVERITY.FAILED);
    assert.match(i.message, /no hay filas de datos/);
});

// --------------------------------------------------------------------------
// 5. workbook-level flags
// --------------------------------------------------------------------------

test("the 1904 date system is read and reported, not silently shifted by 1462 days", () => {
    const file = build({ Cuadro: [headerRow(), ROW_A] }, { date1904: true });
    const { result, issues } = read(file);
    assert.equal(result.ok, true);
    assert.equal(result.provenance.date1904, true);
    assert.equal(one(issues, CODE.DATE_SYSTEM_1904).severity, SEVERITY.WARNING);
});

test("a normal workbook reports date1904 false and raises no date-system issue", () => {
    const file = build({ Cuadro: [headerRow(), ROW_A] });
    const { result, issues } = read(file);
    assert.equal(result.provenance.date1904, false);
    assert.equal(only(issues, CODE.DATE_SYSTEM_1904).length, 0);
});

test("values are returned raw: serials stay numbers, text stays text", () => {
    const file = build({ Cuadro: [headerRow(), ROW_A] });
    const { result } = read(file);
    assert.equal(result.rows[0]["FECHA NACIMIENTO"], 30000);
    assert.equal(typeof result.rows[0]["FECHA NACIMIENTO"], "number");
    assert.equal(result.rows[0]["Nro. DNI / CE"], "09994533");   // leading zero survives
    assert.equal(result.rows[0].HPT, 176);
});

test("headerMap reports where each canonical column was found", () => {
    const file = build({ Cuadro: [[], headerRow({ 2: "CONTRATISTA PRINCIPAL" }), ROW_A] });
    const { result } = read(file);
    assert.equal(result.headerMap.RUC.col, 0);
    assert.equal(result.headerMap.RUC.celda, "A2");
    assert.equal(result.headerMap.RUC.via, "canonical");
    assert.equal(result.headerMap["CONTRATISTA PRNCIPAL"].via, "alias");
    assert.equal(result.headerMap["CONTRATISTA PRNCIPAL"].raw, "CONTRATISTA PRINCIPAL");
    assert.equal(result.anchor.rangoEncabezados, "A2:R2");
    assert.equal(result.anchor.rangoDatos, "A2:R3");
});

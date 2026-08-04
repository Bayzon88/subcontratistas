"use strict";
/**
 * Tests for src/output/runReport.js.
 *
 * The load-bearing assertions are the ones the old pipeline could not make at all:
 *
 *   - a subcontratista whose workbook could not be read is NAMED in the first rows of
 *     the sheet, and the FAILED count is never zero-suppressed (05 §1 principle 4 - the
 *     console.log/console.clear defect this module is the answer to);
 *   - the conservation identity `leidas - rechazadas - colapsadas = escritas` is
 *     restated per subcontratista and in total, and a mismatch produces a loud row
 *     rather than two numbers nobody subtracts (03 AC 7);
 *   - the folder-name check fires on a real disagreement and does NOT fire on a
 *     case/whitespace-only one (05 §8 Q8).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { SEVERITY, CODE, IssueList } = require("../pipeline/issues");
const {
    SHEET_NAME,
    ERRORES_COLUMNS,
    DISPLAY_SEVERITY_ORDER,
    buildErroresSheet,
    buildRunLog,
    checkFolderNames,
    summarize,
    sortIssues,
    agreementLevel,
} = require("../output/runReport");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PERIOD = "2026-02";

/** Every severity, and a representative spread of codes across the four origins. */
function makeIssues() {
    const issues = new IssueList();

    // container-level, no subcontratista attached
    issues.info({
        code: CODE.SKIPPED_LOCKFILE,
        message: 'skipped Excel lock file "~$alfa.xlsx" - not opened',
        archivo: "~$alfa.xlsx",
    });

    // ALFA SAC - read, with row- and value-level problems
    issues.info({
        code: CODE.HEADER_ALIAS_ACCEPTED,
        message: 'accepted alias "CONTRATISTA PRINCIPAL" as "CONTRATISTA PRNCIPAL"',
        subcontratista: "ALFA SAC", archivo: "alfa.xlsx", hoja: "Cuadro",
        fila: 1, celda: "C1", columna: "CONTRATISTA PRNCIPAL", valor: "CONTRATISTA PRINCIPAL",
    });
    issues.warning({
        code: CODE.CODE_OUT_OF_DOMAIN,
        message: 'ESTADO = "184" fuera del dominio {1,2,3}',
        subcontratista: "ALFA SAC", archivo: "alfa.xlsx", hoja: "Cuadro",
        fila: 9, celda: "P9", columna: "ESTADO", valor: 184,
    });
    issues.error({
        code: CODE.DATE_UNPARSEABLE,
        message: 'FECHA NACIMIENTO = "09/10/205" no se pudo interpretar',
        subcontratista: "ALFA SAC", archivo: "alfa.xlsx", hoja: "Cuadro",
        fila: 7, celda: "F7", columna: "FECHA NACIMIENTO", valor: "09/10/205",
    });
    issues.error({
        code: CODE.ROW_NUMERIC_NAME,
        message: 'fila 5 rechazada: "APELLIDOS Y NOMBRES" es numerico ("20101155588")',
        subcontratista: "ALFA SAC", archivo: "alfa.xlsx", hoja: "Cuadro",
        fila: 5, celda: "E5", columna: "APELLIDOS Y NOMBRES", valor: 20101155588,
    });

    // BETA EIRL - read, with an identifier warning and the anchor line
    issues.info({
        code: CODE.ANCHOR_FOUND,
        message: 'ancla "RUC" en C12 de "Cuadro" (beta.xlsx)',
        subcontratista: "BETA EIRL", archivo: "beta.xlsx", hoja: "Cuadro",
        fila: 12, celda: "C12",
    });
    issues.warning({
        code: CODE.RUC_CHECK_DIGIT,
        message: 'RUC "20504039123" no pasa el digito verificador mod-11',
        subcontratista: "BETA EIRL", archivo: "beta.xlsx", hoja: "Cuadro",
        fila: 14, celda: "A14", columna: "RUC", valor: "20504039123",
    });
    issues.info({
        code: CODE.DUPLICATE_COLLAPSED,
        message: '2 filas comparten la identidad "PEREZ LOPEZ JUAN"',
        subcontratista: "BETA EIRL", archivo: "beta.xlsx", hoja: "Cuadro",
        fila: 13, celda: "E13", columna: "APELLIDOS Y NOMBRES", valor: "PEREZ LOPEZ JUAN",
        detalle: { copias: 2, descartadas: 1 },
    });

    // GAMMA SRL - the workbook could not be read at all
    issues.failed({
        code: CODE.SHEET_NOT_FOUND,
        message: 'el archivo "gamma.xlsx" del subcontratista "GAMMA SRL" no tiene una hoja "Cuadro"; hojas presentes: "Hoja1"',
        subcontratista: "GAMMA SRL", archivo: "gamma.xlsx",
        detalle: { hojasPresentes: ["Hoja1"] },
    });

    // DELTA SAC - the folder itself failed; it never reached readWorkbook, so it exists
    // ONLY in the IssueList and must still get a rollup row.
    issues.failed({
        code: CODE.FOLDER_NO_XLSX,
        message: 'folder "DELTA SAC" contains no .xlsx - subcontratista skipped, this is NOT "no workers this month"',
        subcontratista: "DELTA SAC",
    });

    return issues;
}

function makeStats(overrides = {}) {
    return {
        expected: 4,
        workbooks: [
            {
                subcontratista: "ALFA SAC", archivo: "alfa.xlsx", hoja: "Cuadro", ok: true,
                anchor: { celda: "A1", fila: 1, rangoEncabezados: "A1:R1" },
                headerMap: {
                    "CONTRATISTA PRNCIPAL": { col: 2, celda: "C1", raw: "CONTRATISTA PRINCIPAL", via: "alias" },
                    RUC: { col: 0, celda: "A1", raw: "RUC", via: "exacto" },
                },
                missingColumns: ["HPT"],
                stats: { rowsFound: 10, rowsRejected: 2, rowsReturned: 8, blankRows: 1 },
            },
            {
                subcontratista: "BETA EIRL", archivo: "beta.xlsx", hoja: "Cuadro", ok: true,
                anchor: { celda: "C12", fila: 12, rangoEncabezados: "C12:T12" },
                missingColumns: [],
                stats: { rowsFound: 5, rowsRejected: 0, rowsReturned: 5, blankRows: 0 },
            },
            { subcontratista: "GAMMA SRL", archivo: "gamma.xlsx", ok: false },
        ],
        // one BETA row lost to the dedupe, attributed to the DISCARDED copy's folder
        collapsed: [{
            key: "PEREZ LOPEZ JUAN", copies: 2, removed: 1,
            winner: { subcontratista: "BETA EIRL", archivo: "beta.xlsx", fila: 13 },
            discarded: [{ subcontratista: "BETA EIRL", archivo: "beta.xlsx", fila: 14 }],
        }],
        written: 12,   // 15 leidas - 2 rechazadas - 1 colapsada
        ...overrides,
    };
}

function findRow(rows, label) {
    return rows.find(r => Array.isArray(r) && r[0] === label) || null;
}

function flat(rows) {
    return rows.flat();
}

// ---------------------------------------------------------------------------
// The FAILED-first rule
// ---------------------------------------------------------------------------

test("the sheet leads with the failure banner and names every failed subcontratista", () => {
    const rows = buildErroresSheet(makeIssues(), makeStats(), PERIOD);

    assert.equal(rows[1][0], "ESTADO");
    assert.equal(rows[1][1], "INCOMPLETO");
    assert.match(String(rows[1][2]), /NO se procesaron/);

    assert.equal(rows[2][0], "Subcontratistas fallidos");
    assert.equal(rows[2][1], 2);                       // GAMMA SRL + DELTA SAC
    assert.equal(rows[2][2], "DELTA SAC, GAMMA SRL");  // named, sorted, in row 3

    // Both names appear inside the first ten rows, not under 4,000 INFO lines.
    const head = flat(rows.slice(0, 10)).map(String).join(" | ");
    assert.match(head, /GAMMA SRL/);
    assert.match(head, /DELTA SAC/);
    assert.match(head, /no tiene una hoja "Cuadro"/);
    assert.match(head, /contains no \.xlsx/);
});

test("the failed count is never zero-suppressed on a clean run", () => {
    const rows = buildErroresSheet(new IssueList(), makeStats({
        workbooks: [], collapsed: [], written: 0, expected: 0,
    }), PERIOD);

    assert.equal(rows[1][1], "OK");
    assert.equal(rows[2][0], "Subcontratistas fallidos");
    assert.equal(rows[2][1], 0);          // present as a literal 0, not omitted
    assert.equal(rows[2][2], null);
    // No FALLOS block on a clean run.
    assert.equal(findRow(rows, "FALLOS"), null);
});

test("run.json carries the failures as a first-class top-level list", () => {
    const log = buildRunLog(makeIssues(), makeStats(), PERIOD);

    assert.equal(log.ok, false);
    assert.equal(log.resumen.subcontratistas.fallidos, 2);
    assert.deepEqual(log.resumen.subcontratistas.nombresFallidos, ["DELTA SAC", "GAMMA SRL"]);
    assert.equal(log.fallos.length, 2);
    assert.deepEqual(log.fallos.map(f => f.subcontratista), ["DELTA SAC", "GAMMA SRL"]);
    assert.deepEqual(log.fallos.map(f => f.codigo), [CODE.FOLDER_NO_XLSX, CODE.SHEET_NOT_FOUND]);
    assert.equal(log.periodo.etiqueta, "2-2026");
    assert.equal(log.periodo.archivo, "Reporte_Subcontratistas_FEBRERO_2026.xlsx");
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

test("issues sort FAILED, ERROR, WARNING, INFO and group by subcontratista", () => {
    const model = summarize(makeIssues(), makeStats(), PERIOD);
    const order = model.incidencias.map(i => i.severity);
    const rank = s => DISPLAY_SEVERITY_ORDER.indexOf(s);

    for (let i = 1; i < order.length; i++) {
        assert.ok(rank(order[i]) >= rank(order[i - 1]),
            `severity out of order at ${i}: ${order[i - 1]} then ${order[i]}`);
    }
    assert.equal(order[0], SEVERITY.FAILED);
    assert.equal(order[order.length - 1], SEVERITY.INFO);

    // Within one severity, the rows are grouped by subcontratista: each name occupies a
    // single contiguous run, so the operator reads one company at a time.
    for (const sev of DISPLAY_SEVERITY_ORDER) {
        const names = model.incidencias.filter(i => i.severity === sev)
            .map(i => i.subcontratista === null ? "￿" : i.subcontratista);
        const runs = names.filter((n, i) => i === 0 || n !== names[i - 1]);
        assert.equal(new Set(runs).size, runs.length, `${sev} rows are not grouped by subcontratista`);
        assert.deepEqual([...runs].sort(), runs.length ? [...runs].sort() : runs);
    }

    // Inside one (severity, subcontratista) the rows are ordered by source row.
    const alfaErrors = model.incidencias
        .filter(i => i.severity === SEVERITY.ERROR && i.subcontratista === "ALFA SAC")
        .map(i => i.fila);
    assert.deepEqual(alfaErrors, [5, 7]);
});

test("sortIssues is stable and deterministic over the same list", () => {
    const items = makeIssues().items;
    const a = sortIssues(items).map(i => `${i.severity}|${i.code}|${i.fila}`);
    const b = sortIssues(items).map(i => `${i.severity}|${i.code}|${i.fila}`);
    assert.deepEqual(a, b);
    // Sorting does not mutate the caller's array.
    assert.deepEqual(items.map(i => i.code), makeIssues().items.map(i => i.code));
});

test("truncation drops INFO, never FAILED", () => {
    const rows = buildErroresSheet(makeIssues(), makeStats(), PERIOD, { maxRows: 2 });
    const header = rows.findIndex(r => r[0] === ERRORES_COLUMNS[0] && r[8] === "severidad");
    assert.ok(header > 0);
    assert.equal(rows[header + 1][8], SEVERITY.FAILED);
    assert.equal(rows[header + 2][8], SEVERITY.FAILED);
    assert.match(String(rows[header + 3][0]), /incidencias omitidas/);
});

// ---------------------------------------------------------------------------
// Rollup arithmetic and conservation
// ---------------------------------------------------------------------------

test("per-subcontratista rollup: files, rows, anchor and accepted aliases", () => {
    const model = summarize(makeIssues(), makeStats(), PERIOD);
    const by = new Map(model.subcontratistas.map(r => [r.subcontratista, r]));

    const alfa = by.get("ALFA SAC");
    assert.equal(alfa.fallado, false);
    assert.equal(alfa.archivosVistos, 1);
    assert.equal(alfa.archivosProcesados, 1);
    assert.equal(alfa.archivosFallidos, 0);
    assert.equal(alfa.filasLeidas, 10);
    assert.equal(alfa.filasRechazadas, 2);
    assert.equal(alfa.filasAceptadas, 8);
    assert.equal(alfa.filasColapsadas, 0);
    assert.equal(alfa.filasEscritas, 8);
    assert.equal(alfa.conserva, true);
    assert.equal(alfa.ancla, "A1");
    assert.deepEqual(alfa.columnasAusentes, ["HPT"]);
    assert.deepEqual(alfa.aliases, ['CONTRATISTA PRNCIPAL <- "CONTRATISTA PRINCIPAL"']);
    assert.equal(alfa.incidencias[SEVERITY.ERROR], 2);

    // The wrong-anchor tell: seventeen folders on A1 and one on C12.
    const beta = by.get("BETA EIRL");
    assert.equal(beta.ancla, "C12");
    assert.equal(beta.filasColapsadas, 1);   // attributed to the DISCARDED copy's folder
    assert.equal(beta.filasEscritas, 4);
    assert.equal(beta.conserva, true);

    // A workbook that FAILED reports no row counts at all - not zeros, which would read
    // as "this company submitted nobody this month", and not a spurious "conserva: si".
    const gamma = by.get("GAMMA SRL");
    assert.equal(gamma.fallado, true);
    assert.equal(gamma.archivosVistos, 1);
    assert.equal(gamma.archivosProcesados, 0);
    assert.equal(gamma.archivosFallidos, 1);
    assert.equal(gamma.filasLeidas, null);
    assert.equal(gamma.filasEscritas, null);
    assert.equal(gamma.conserva, null);

    // A folder that failed before anything could be read still gets a row, and its
    // counts are null - "we never read a row" is not "we read zero rows".
    const delta = by.get("DELTA SAC");
    assert.equal(delta.fallado, true);
    assert.equal(delta.filasLeidas, null);
    assert.equal(delta.filasEscritas, null);
    assert.equal(delta.conserva, null);
    assert.equal(delta.severidadMaxima, SEVERITY.FAILED);
    assert.equal(delta.motivosFallo.length, 1);

    // Failures sort to the top of the rollup too.
    assert.deepEqual(model.subcontratistas.map(r => r.subcontratista),
        ["DELTA SAC", "GAMMA SRL", "ALFA SAC", "BETA EIRL"]);
});

test("conservation reconciles and is reported OK", () => {
    const model = summarize(makeIssues(), makeStats(), PERIOD);
    assert.equal(model.totales.filasLeidas, 15);
    assert.equal(model.totales.filasRechazadas, 2);
    assert.equal(model.totales.filasColapsadas, 1);
    assert.equal(model.totales.filasEscritas, 12);
    assert.equal(model.conservacion.estado, "OK");
    assert.equal(model.conservacion.ok, true);
    assert.equal(model.conservacion.diferencia, 0);

    const rows = buildErroresSheet(makeIssues(), makeStats(), PERIOD);
    const line = findRow(rows, "Conservacion");
    assert.equal(line[1], "OK");
    assert.match(String(line[2]), /15 leidas - 2 rechazadas - 1 colapsadas = 12 escritas/);
    assert.equal(findRow(rows, "*** CONSERVACION ROTA ***"), null);
});

test("a broken conservation is a loud row, not a silent inconsistency", () => {
    const stats = makeStats({ written: 11 });
    const model = summarize(makeIssues(), stats, PERIOD);
    assert.equal(model.conservacion.estado, "ROTA");
    assert.equal(model.conservacion.esperado, 12);
    assert.equal(model.conservacion.escritas, 11);
    assert.equal(model.conservacion.diferencia, -1);

    const rows = buildErroresSheet(makeIssues(), stats, PERIOD);
    assert.equal(findRow(rows, "Conservacion")[1], "ROTA");
    const loud = findRow(rows, "*** CONSERVACION ROTA ***");
    assert.ok(loud, "the broken-conservation row must exist");
    assert.equal(loud[1], -1);
    assert.match(String(loud[2]), /se esperaban 12 filas y se escribieron 11/);

    assert.equal(buildRunLog(makeIssues(), stats, PERIOD).resumen.conservacion.estado, "ROTA");
});

test("an unknown term is NO VERIFICABLE, never a silent OK", () => {
    // No `written` anywhere: the run report must not invent it by subtraction, because a
    // derived figure makes the check tautological.
    const stats = makeStats({ written: undefined });
    delete stats.written;
    const model = summarize(makeIssues(), stats, PERIOD);
    assert.equal(model.conservacion.estado, "NO VERIFICABLE");
    assert.equal(model.conservacion.ok, false);
    assert.match(String(model.conservacion.motivo), /written/);
});

test("the summary counts by severity and by code", () => {
    const rows = buildErroresSheet(makeIssues(), makeStats(), PERIOD);
    assert.equal(findRow(rows, SEVERITY.FAILED)[1], 2);
    assert.equal(findRow(rows, SEVERITY.ERROR)[1], 2);
    assert.equal(findRow(rows, SEVERITY.WARNING)[1], 2);
    assert.equal(findRow(rows, SEVERITY.INFO)[1], 4);
    assert.equal(findRow(rows, CODE.SHEET_NOT_FOUND)[1], 1);
    assert.equal(findRow(rows, CODE.DATE_UNPARSEABLE)[1], 1);

    const log = buildRunLog(makeIssues(), makeStats(), PERIOD);
    assert.equal(log.resumen.severidades[SEVERITY.FAILED], 2);
    assert.equal(log.resumen.codigos[CODE.ROW_NUMERIC_NAME], 1);
    assert.equal(log.resumen.incidencias, 10);
});

// ---------------------------------------------------------------------------
// The folder-name check (05 §8 Q8)
// ---------------------------------------------------------------------------

function record(subcontratista, archivo, empresa, contratista) {
    return {
        EMPRESA: empresa,
        "CONTRATISTA PRNCIPAL": contratista === undefined ? "EPC PRINCIPAL SA" : contratista,
        "APELLIDOS Y NOMBRES": "PEREZ LOPEZ JUAN",
        provenance: { subcontratista, archivo, hoja: "Cuadro", filaOrigen: 2 },
    };
}

test("folder-name check: whitespace- and case-only differences do NOT fire", () => {
    const { carpetas, issues } = checkFolderNames([
        record("CLJ CONTRUCTORA SAC", "clj.xlsx", "  clj   contructora   sac "),
        record("CLJ CONTRUCTORA SAC", "clj.xlsx", "CLJ CONTRUCTORA SAC"),
    ]);
    assert.equal(issues.byCode(CODE.FOLDER_NAME_MISMATCH).length, 0);
    assert.equal(carpetas.length, 1);
    assert.equal(carpetas[0].coincide, true);
    assert.equal(carpetas[0].nivel, "exacto");   // the exact spelling is the best match found
    assert.equal(carpetas[0].columna, "EMPRESA");
});

test("folder-name check: punctuation and accent-form differences do NOT fire", () => {
    const { carpetas, issues } = checkFolderNames([
        record("ACIS PROCESS SAC", "acis.xlsx", "ACIS PROCESS S.A.C."),
        // macOS zips carry folder names decomposed; the workbook has them precomposed.
        record("CONSTRUCCIÓN SAC", "c.xlsx", "CONSTRUCCIÓN SAC"),
    ]);
    assert.equal(issues.byCode(CODE.FOLDER_NAME_MISMATCH).length, 0);
    assert.deepEqual(carpetas.map(c => c.nivel).sort(), ["normalizado", "simplificado"]);
});

test("folder-name check: a real disagreement fires at WARNING", () => {
    const { carpetas, issues } = checkFolderNames([
        record("DELTA SAC", "delta.xlsx", "EPSILON SRL"),
        record("DELTA SAC", "delta.xlsx", "EPSILON SRL"),
    ]);
    const fired = issues.byCode(CODE.FOLDER_NAME_MISMATCH);
    assert.equal(fired.length, 1);
    assert.equal(fired[0].severity, SEVERITY.WARNING);
    assert.equal(fired[0].subcontratista, "DELTA SAC");
    assert.equal(fired[0].archivo, "delta.xlsx");
    assert.equal(fired[0].columna, "EMPRESA");
    assert.match(fired[0].message, /"EPSILON SRL" \(2\)/);
    assert.equal(carpetas[0].coincide, false);
    assert.equal(carpetas[0].nivel, "ninguno");
    assert.deepEqual(carpetas[0].empresas, [{ valor: "EPSILON SRL", filas: 2 }]);
});

test("folder-name check: a match on CONTRATISTA PRNCIPAL is agreement", () => {
    const { carpetas, issues } = checkFolderNames([
        record("MCORP SAC", "m.xlsx", "OTRA EMPRESA SRL", "MCORP  SAC"),
    ]);
    assert.equal(issues.byCode(CODE.FOLDER_NAME_MISMATCH).length, 0);
    assert.equal(carpetas[0].columna, "CONTRATISTA PRNCIPAL");
    assert.equal(carpetas[0].nivel, "normalizado");
});

test("folder-name check: a workbook declaring neither column fires", () => {
    const { issues } = checkFolderNames([
        record("ZETA SAC", "z.xlsx", null, null),
        record("ZETA SAC", "z.xlsx", "   ", "  "),
    ]);
    const fired = issues.byCode(CODE.FOLDER_NAME_MISMATCH);
    assert.equal(fired.length, 1);
    assert.match(fired[0].message, /no declara EMPRESA ni CONTRATISTA PRNCIPAL/);
});

test("folder-name check: judged per workbook, and appended to a caller's IssueList", () => {
    const issues = new IssueList();
    const { carpetas } = checkFolderNames([
        record("ROOT", "alfa.xlsx", "ALFA SAC"),
        record("ROOT", "root.xlsx", "ROOT"),
    ], issues);
    // Two files in one folder are two judgements, not one.
    assert.equal(carpetas.length, 2);
    assert.equal(issues.byCode(CODE.FOLDER_NAME_MISMATCH).length, 1);
    assert.equal(issues.byCode(CODE.FOLDER_NAME_MISMATCH)[0].archivo, "alfa.xlsx");
});

test("folder-name check: records without a folder name are skipped, not guessed at", () => {
    const { carpetas, issues } = checkFolderNames([
        { EMPRESA: "ALFA SAC", provenance: { subcontratista: null, archivo: "a.xlsx" } },
        { EMPRESA: "ALFA SAC" },
        null,
    ]);
    assert.equal(carpetas.length, 0);
    assert.equal(issues.length, 0);
});

test("agreementLevel ranks the four tiers", () => {
    assert.equal(agreementLevel("ALFA SAC", "ALFA SAC"), "exacto");
    assert.equal(agreementLevel("ALFA SAC", " alfa  sac "), "normalizado");
    assert.equal(agreementLevel("ALFA SAC", "ALFA S.A.C."), "simplificado");
    assert.equal(agreementLevel("ALFA SAC", "BETA EIRL"), "ninguno");
    assert.equal(agreementLevel("ALFA SAC", ""), "ninguno");
    assert.equal(agreementLevel("ALFA SAC", null), "ninguno");
});

test("the folder-name findings reach the sheet through the IssueList", () => {
    const issues = makeIssues();
    checkFolderNames([record("DELTA SAC", "delta.xlsx", "EPSILON SRL")], issues);
    const rows = buildErroresSheet(issues, makeStats(), PERIOD);
    assert.equal(findRow(rows, CODE.FOLDER_NAME_MISMATCH)[1], 1);
    const cells = flat(rows).map(String);
    assert.ok(cells.some(c => c.includes("no coincide con ningun EMPRESA")));
});

// ---------------------------------------------------------------------------
// An empty run, and cell hygiene
// ---------------------------------------------------------------------------

test("an empty IssueList still produces a well-formed sheet with a clean summary", () => {
    const rows = buildErroresSheet(new IssueList(), null, PERIOD);

    assert.ok(Array.isArray(rows) && rows.length > 0);
    for (const r of rows) assert.ok(Array.isArray(r), "every sheet row must be an array");

    assert.equal(rows[0][0], "REPORTE DE INCIDENCIAS");
    assert.equal(rows[0][1], "Periodo 2-2026");
    assert.equal(rows[1][1], "OK");
    assert.equal(rows[2][1], 0);
    assert.equal(findRow(rows, "PeriodoInicio")[1], "2026-02-01");
    assert.equal(findRow(rows, "PeriodoFin")[1], "2026-02-28");
    assert.equal(findRow(rows, "Subcontratistas esperados")[1], 0);
    assert.equal(findRow(rows, "Filas escritas en Cuadro")[1], 0);
    assert.equal(findRow(rows, "Conservacion")[1], "OK");
    assert.equal(findRow(rows, SEVERITY.FAILED)[1], 0);
    assert.equal(findRow(rows, SEVERITY.INFO)[1], 0);

    // The issue table still has its header, and says so rather than trailing off.
    const header = rows.findIndex(r => r[0] === ERRORES_COLUMNS[0] && r[8] === "severidad");
    assert.ok(header > 0);
    assert.deepEqual(rows[header], [...ERRORES_COLUMNS]);
    assert.equal(rows[header + 1][0], "(sin incidencias)");
    assert.equal(findRow(rows, "(ningun subcontratista procesado)")[0], "(ningun subcontratista procesado)");

    const log = buildRunLog(new IssueList(), null, PERIOD);
    assert.equal(log.ok, true);
    assert.deepEqual(log.fallos, []);
    assert.deepEqual(log.incidencias, []);
    assert.equal(log.resumen.subcontratistas.fallidos, 0);
});

test("the period may be absent without breaking the sheet", () => {
    const rows = buildErroresSheet(new IssueList(), null, null);
    assert.equal(rows[0][1], "Periodo (sin periodo)");
    assert.equal(findRow(rows, "PeriodoEtiqueta")[1], null);
    assert.equal(buildRunLog(new IssueList(), null, null).periodo, null);
});

test("no cell is undefined, the string \"undefined\", or NaN", () => {
    const issues = makeIssues();
    // The three values the old pipeline actually emitted.
    issues.warning({
        code: CODE.CODE_OUT_OF_DOMAIN, message: "GENERO indefinido",
        subcontratista: "ALFA SAC", archivo: "alfa.xlsx", columna: "GENERO", valor: undefined,
    });
    issues.warning({
        code: CODE.DATE_UNPARSEABLE, message: "serial no numerico",
        subcontratista: "ALFA SAC", archivo: "alfa.xlsx", columna: "FECHA CESE/BAJA", valor: NaN,
    });
    issues.info({
        code: CODE.TEXT_NORMALIZED, message: "sentinel vacio",
        subcontratista: "ALFA SAC", archivo: "alfa.xlsx", columna: "FECHA CESE/BAJA", valor: "",
    });

    const rows = buildErroresSheet(issues, makeStats(), PERIOD);
    for (const [y, row] of rows.entries()) {
        for (const [x, cell] of row.entries()) {
            assert.notEqual(cell, undefined, `undefined cell at ${y},${x}`);
            assert.ok(!(typeof cell === "number" && !Number.isFinite(cell)), `NaN cell at ${y},${x}`);
            if (typeof cell === "string") {
                assert.ok(!/\bundefined\b/.test(cell), `literal "undefined" at ${y},${x}: ${cell}`);
            }
        }
    }

    const raw = rows.filter(r => r[9] === CODE.DATE_UNPARSEABLE).map(r => r[6]);
    assert.ok(raw.includes("(NaN)"), "a NaN raw value must survive as evidence, parenthesised");
    const empty = rows.filter(r => r[9] === CODE.TEXT_NORMALIZED).map(r => r[6]);
    assert.deepEqual(empty, ["(vacio)"]);
});

test("the issue table carries the 03 section 8.1 columns in order", () => {
    assert.deepEqual(ERRORES_COLUMNS.slice(0, 9), [
        "subcontratista", "archivo", "hoja", "fila", "celda", "columna",
        "valor crudo", "motivo", "severidad",
    ]);
    assert.equal(SHEET_NAME, "Errores");

    const rows = buildErroresSheet(makeIssues(), makeStats(), PERIOD);
    const header = rows.findIndex(r => r[0] === ERRORES_COLUMNS[0] && r[8] === "severidad");
    const first = rows[header + 1];
    assert.equal(first[0], "DELTA SAC");
    assert.equal(first[8], SEVERITY.FAILED);
    assert.equal(first[9], CODE.FOLDER_NO_XLSX);
    // `fila` is a real number, so the column sorts and filters in Excel.
    const dated = rows.find(r => r[9] === CODE.DATE_UNPARSEABLE && r[4] === "F7");
    assert.equal(dated[3], 7);
    assert.equal(typeof dated[3], "number");
});

// ---------------------------------------------------------------------------
// Determinism (05 §1 principle 3, AC 26)
// ---------------------------------------------------------------------------

test("the same inputs produce byte-identical artifacts, with no timestamp", () => {
    const a = JSON.stringify(buildRunLog(makeIssues(), makeStats(), PERIOD));
    const b = JSON.stringify(buildRunLog(makeIssues(), makeStats(), PERIOD));
    assert.equal(a, b);

    const s1 = JSON.stringify(buildErroresSheet(makeIssues(), makeStats(), PERIOD));
    const s2 = JSON.stringify(buildErroresSheet(makeIssues(), makeStats(), PERIOD));
    assert.equal(s1, s2);

    // Nothing that looks like a wall-clock reading may appear anywhere in run.json.
    assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:/.test(a), "run.json must not carry a timestamp");
    assert.ok(!/generatedAt|timestamp|fechaEjecucion/i.test(a));
});

test("stats may be a whole dedupe() result and is read the same way", () => {
    const stats = makeStats();
    const equivalent = {
        expected: stats.expected,
        workbooks: stats.workbooks,
        dedupe: {
            kept: new Array(12).fill(null),
            collapsed: stats.collapsed,
            stats: { rowsIn: 13, rowsOut: 12, rowsCollapsed: 1 },
            crossSubcontratista: [],
        },
    };
    const a = summarize(makeIssues(), stats, PERIOD).totales;
    const b = summarize(makeIssues(), equivalent, PERIOD).totales;
    assert.deepEqual(b, a);
});

test("issues may be a plain array instead of an IssueList", () => {
    const list = makeIssues();
    const fromList = buildErroresSheet(list, makeStats(), PERIOD);
    const fromArray = buildErroresSheet(list.items, makeStats(), PERIOD);
    assert.deepEqual(fromArray, fromList);
});

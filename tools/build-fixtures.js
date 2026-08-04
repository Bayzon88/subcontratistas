"use strict";
/**
 * The fixture corpus generator - 05-implementation-plan.md Phase 0 task 2,
 * 03-expected-output.md acceptance criteria 30-31.
 *
 * Run with `npm run fixtures`. Emits into src/fixtures/:
 *
 *   17 workbook fixtures   <name>.xlsx           + <name>.expected.json
 *    4 container fixtures  containers/<name>/    + containers/<name>.expected.json
 *      a manifest          manifest.json
 *
 * WHY A GENERATOR AND NOT 21 COMMITTED BINARIES HAND-MADE IN EXCEL.
 * A reviewer has to be able to see what each fixture tests. An .xlsx is opaque in a diff
 * and unreadable in a review, so the pathology would live only in a filename. Here it
 * lives in the source, next to the expectation it produces - and 05 §4.2 is explicit that
 * the quality of this corpus is the ceiling on everything the offline suite can catch
 * (§6 row 10). Re-runnability is the second reason: a fixture that has to be rebuilt by
 * hand is a fixture that stops being rebuilt.
 *
 * THE EXPECTATION IS AUTHORED, NOT OBSERVED. Nothing in this file calls the modules under
 * test to decide what the answer should be. Every expected serial, code, severity and
 * count below is written from 03-expected-output.md (§1.2 anchoring, §2 the schema table,
 * §3.7 the worked date examples, §4 the coded domains, §8.3 severity) and the date serials
 * are the ones §3.7 states. The one arithmetic helper that could be circular - the SUNAT
 * mod-11 check digit - is reimplemented here from the spec rather than imported from
 * pipeline/identity.js, so a wrong weight vector in that module cannot silently propagate
 * into the fixtures that are supposed to catch it.
 *
 * SYNTHETIC IDENTITIES ONLY - 05 §6 risk row 11. Every person, DNI, company and RUC below
 * is invented. Nothing is copied out of src/ReporteConsolidado.xlsx, which is used only as
 * reference for SHAPE and VOCABULARY (the 18 headers, the value vocabularies, the sheet
 * naming, the observed defect shapes). The three literals that ARE quoted from the plan -
 * the DNI "09994533", the RUC "20101155588" of the 643-row shift block, and the company
 * spelling " CLJ CONTRUCTORA SAC" - are named verbatim in 03 §9 criteria 13/31 and §2.3 as
 * the cases to encode, and none of them is a person.
 *
 * REAL DISTRICTS, deliberately: DISTRITO SEGUN DNI is the sole input to Zona de Influencia
 * (column Y), which is VLOOKUP over Hoja1!A2:B61. A made-up district would resolve to the
 * "No" sentinel and the fixture would be testing nothing. Every district used below was
 * read out of the template's own Hoja1 table.
 *
 * DETERMINISM. No wall clock anywhere: the report period is the constant PERIOD, and the
 * zip fixture's entry timestamps are pinned to a fixed date. SheetJS's writer is already
 * byte-deterministic (verified: two writes of the same workbook hash identically), so
 * re-running this script produces no git churn unless a fixture actually changed.
 */

const fs = require("node:fs");
const path = require("node:path");
const XLSX = require("xlsx");
const AdmZip = require("adm-zip");

const { CANONICAL } = require("../src/pipeline/columns");

const FIXTURES = path.join(__dirname, "..", "src", "fixtures");
const CONTAINERS = path.join(FIXTURES, "containers");

/** Every fixture is evaluated against this period. FEBRERO 2026 is the month 03 §9
 *  criterion 28 uses as its reference, and it fixes the plausibility windows the date
 *  expectations below are written against:
 *      FECHA NACIMIENTO  1946-02-28 .. 2010-02-28  (serials 16861 .. 40237)
 *      the two obra dates 2015-01-01 .. 2026-03-28 (serials 42005 .. 46109)  */
const PERIOD = "2026-02";

/** Zip entry timestamp for the container fixture. A constant, not `new Date()`. */
const ZIP_EPOCH = new Date(Date.UTC(2026, 2, 1, 12, 0, 0));

/* ------------------------------------------------------------------ *
 * Synthetic identifiers
 * ------------------------------------------------------------------ */

/**
 * SUNAT mod-11, written out from 03-expected-output.md §2 row 1 rather than imported:
 * weights 5,4,3,2,7,6,5,4,3,2 over digits 1-10, r = 11 - sum%11, 10 -> 0 and 11 -> 1.
 *
 * Deliberately a second implementation. If pipeline/identity.js ever acquires a wrong
 * weight vector, importing it here would generate fixtures that agree with the bug and
 * dni-leading-zero.xlsx would go on passing.
 */
function rucCheckDigit(stem10) {
    const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += weights[i] * Number(stem10[i]);
    const r = 11 - (sum % 11);
    return String(r === 10 ? 0 : r === 11 ? 1 : r);
}

/** A synthetic 11-digit RUC that PASSES the check digit. Stems start with 20, the SUNAT
 *  prefix for a company, so the shape is right as well as the arithmetic. */
function ruc(stem10) {
    if (!/^\d{10}$/.test(stem10)) throw new Error(`ruc stem must be 10 digits: ${stem10}`);
    return stem10 + rucCheckDigit(stem10);
}

/** The same stem with the WRONG check digit - shape-valid, arithmetic-invalid. This is
 *  the ~16% of distinct RUCs that fail the check today (pipeline/identity.js measured 23
 *  of 146), and it must be a WARNING, never a dropped company. */
function rucBad(stem10) {
    const good = Number(rucCheckDigit(stem10));
    return stem10 + String((good + 1) % 10);
}

/* ------------------------------------------------------------------ *
 * Synthetic population and vocabulary
 * ------------------------------------------------------------------ */

/** Districts, all read from the template's own Hoja1!A2:B61 lookup table. */
const D = {
    ATE: "ATE",
    BRENA: "BREÑA",
    CALLAO: "CALLAO",
    AGUSTINO: "EL AGUSTINO",
    VICTORIA: "LA VICTORIA",
    SAN_LUIS: "SAN LUIS",
    SANTA_ANITA: "SANTA ANITA",
    VENTANILLA: "VENTANILLA",
    LA_PERLA: "LA PERLA",
    CERCADO: "CERCADO DE LIMA",
};

const OBRA = "AMPLIACION PLANTA INDUSTRIAL LOTE 7 - LIMA";

/**
 * Ten invented workers. Birth serials are all inside the 1946-02-28 .. 2010-02-28 window
 * the FEBRERO 2026 period implies, and start serials inside 2015-01-01 .. 2026-03-28, so
 * a fixture that overrides one field isolates exactly one pathology and never trips the
 * plausibility check by accident.
 *
 * DNIs are a synthetic 401000xx sequence; they identify nobody.
 */
const PEOPLE = [
    { dni: "40100001", nombre: "QUISPE HUAMANI CARLOS ALBERTO", nacimiento: 29295, genero: "MASCULINO", distrito: D.ATE, cargo: "OPERARIO ELECTRICISTA", domicilio: "AV. NICOLAS AYLLON 1420", inicio: 45516, hpt: 184 },
    { dni: "40100002", nombre: "SALAZAR QUIROZ MILENA BEATRIZ", nacimiento: 31218, genero: "FEMENINO", distrito: D.BRENA, cargo: "ASISTENTA SOCIAL", domicilio: "JR. HUARAZ 288", inicio: 44991, hpt: 176 },
    { dni: "40100003", nombre: "TORREBLANCA ÑAUPA HECTOR IVAN", nacimiento: 28796, genero: "MASCULINO", distrito: D.CALLAO, cargo: "OPERARIO DE ANDAMIOS", domicilio: "CALLE LOS GERANIOS 55", inicio: 45978, hpt: 168 },
    { dni: "40100004", nombre: "VILLANUEVA ARCE SANDRA LUCIA", nacimiento: 33631, genero: "FEMENINO", distrito: D.AGUSTINO, cargo: "PREVENCIONISTA DE RIESGOS", domicilio: "AV. RIVA AGUERO 902", inicio: 43773, hpt: 192 },
    { dni: "40100005", nombre: "CHAVEZ MENDOZA RAUL ESTEBAN", nacimiento: 25455, genero: "MASCULINO", distrito: D.VICTORIA, cargo: "CAPATAZ", domicilio: "JR. HUANUCO 1711", inicio: 44743, hpt: 200 },
    { dni: "40100006", nombre: "ROJAS PAREDES KATIA MERCEDES", nacimiento: 35402, genero: "FEMENINO", distrito: D.SAN_LUIS, cargo: "ALMACENERA", domicilio: "AV. CIRCUNVALACION 340", inicio: 46027, hpt: 160 },
    { dni: "40100007", nombre: "MENDIVIL SOTO JORGE ARMANDO", nacimiento: 27136, genero: "MASCULINO", distrito: D.SANTA_ANITA, cargo: "OPERADOR DE MINICARGADOR", domicilio: "CALLE LOS CLAVELES 118", inicio: 42663, hpt: 208 },
    { dni: "40100008", nombre: "ESCALANTE VARGAS DIEGO MARTIN", nacimiento: 37097, genero: "MASCULINO", distrito: D.VENTANILLA, cargo: "AYUDANTE DE OBRA", domicilio: "MZ. K LT. 12 PACHACUTEC", inicio: 44452, hpt: 152 },
    { dni: "40100009", nombre: "LLERENA BAUTISTA PILAR ROSA", nacimiento: 32202, genero: "FEMENINO", distrito: D.LA_PERLA, cargo: "TOPOGRAFA", domicilio: "AV. LA PAZ 615", inicio: 45516, hpt: 176 },
    { dni: "40100010", nombre: "ZEGARRA COAQUIRA NESTOR FELIPE", nacimiento: 23134, genero: "MASCULINO", distrito: D.CERCADO, cargo: "MAESTRO DE OBRA", domicilio: "JR. AZANGARO 470", inicio: 43773, hpt: 216 },
];

/** Two invented companies. Neither name appears in any real month. */
const EMPRESAS = [
    { ruc: ruc("2050012345"), empresa: "SINTETICA ANDINA CONTRATISTAS S.A.C.", contratista: "CONSORCIO SINTETICO LIMA" },
    { ruc: ruc("2060098765"), empresa: "MONTAJES SINTETICOS DEL SUR E.I.R.L.", contratista: "CONSORCIO SINTETICO LIMA" },
];

/* ------------------------------------------------------------------ *
 * Row construction
 * ------------------------------------------------------------------ */

/**
 * One clean row: every one of the 18 fields satisfies its rule in 03 §2, so parsing it
 * produces exactly zero issues. Fixtures override one field at a time.
 */
function cleanRow(i, over) {
    const p = PEOPLE[i % PEOPLE.length];
    const e = EMPRESAS[i % EMPRESAS.length];
    return Object.assign({
        "RUC": e.ruc,
        "EMPRESA": e.empresa,
        "CONTRATISTA PRNCIPAL": e.contratista,
        "Nro. DNI / CE": p.dni,
        "APELLIDOS Y NOMBRES": p.nombre,
        "FECHA NACIMIENTO": p.nacimiento,
        "TIPO TRABAJADOR": 2,
        "TITULO DE PUESTO/CARGO": p.cargo,
        "NOMBRE DE OBRA DONDE ESTA ASIGNADO DURANTE EL MES REPORTADO": OBRA,
        "DOMICILIO DE TRABAJADOR": p.domicilio,
        "DISTRITO SEGÚN DNI": p.distrito,
        // The WORD, not the code: 03 §4.4. The pipeline stores the lowercase word, so this
        // input also exercises the case fold that criterion 12 turns on.
        "GENERO": p.genero,
        "FECHA CESE/BAJA": null,
        "NACIONALIDAD": "PERUANA",
        "FECHA INICIO DE LABORES EN OBRA": p.inicio,
        "ESTADO": 1,
        "TIPO DE CONTRATO LABORAL": 1,
        "HPT": p.hpt,
    }, over || {});
}

/**
 * The record a clean row must parse to. Restates the three normalizations 03 §2 specifies
 * for these particular values - GENERO lowercased (§4.4), text trimmed/collapsed (§2.1),
 * APELLIDOS Y NOMBRES and NACIONALIDAD uppercased - rather than importing them.
 *
 * Fixtures whose point IS a normalization override the field explicitly instead.
 */
function cleanExpect(row, over) {
    const out = {};
    for (const name of CANONICAL) out[name] = row[name] === undefined ? null : row[name];
    out["GENERO"] = row["GENERO"] === null ? null : String(row["GENERO"]).toLowerCase();
    return Object.assign(out, over || {});
}

/** Default column layout: the 18 canonical headers in A..R order. */
function cols() {
    return CANONICAL.map(name => ({ header: name, key: name }));
}

/** Build one worksheet AOA from a column layout, a header offset and the data rows. */
function sheet(layout, rows, opts) {
    const o = opts || {};
    const aoa = [];
    for (const line of o.preamble || []) aoa.push(line);
    aoa.push(layout.map(c => c.header));
    for (const row of rows) {
        aoa.push(layout.map(c => {
            const v = c.key === null ? null : row[c.key];
            return v === undefined ? null : v;
        }));
    }
    return aoa;
}

/* ------------------------------------------------------------------ *
 * Expectation helpers
 * ------------------------------------------------------------------ */

/** One entry of an expected issue multiset. */
function iss(code, severity, count) {
    return { code, severity, count: count === undefined ? 1 : count };
}

/** Sorted so the committed JSON has a stable order and the test can deep-compare. */
function issues(list) {
    return list.slice().sort((a, b) =>
        a.code < b.code ? -1 : a.code > b.code ? 1 : a.severity < b.severity ? -1 : a.severity > b.severity ? 1 : 0);
}

/** The expected records block: {fila, valores} per accepted row, in sheet order. */
function records(firstRow, expects) {
    return expects.map((valores, i) => ({ fila: firstRow + i, valores }));
}

/* ------------------------------------------------------------------ *
 * The 17 workbook fixtures
 * ------------------------------------------------------------------ */

const WORKBOOKS = [];

function workbook(spec) {
    WORKBOOKS.push(spec);
}

/* ---- 1. header-row-4 ---------------------------------------------------- */
// 03 §1.2 steps 1-2 / AC 2. The reader must find the header row rather than assume row 1,
// which is what sheet_to_json with default options does today (BUG-02).
{
    const rows = [0, 1, 2, 3, 4, 5].map(i => cleanRow(i));
    workbook({
        name: "header-row-4",
        pathology: "the header block does not start at A1 - a three-row preamble sits above it",
        spec: ["03 §1.2 steps 1-2", "AC 2", "BUG-02"],
        subcontratista: "SINTETICA ANDINA CONTRATISTAS",
        sheets: {
            Cuadro: sheet(cols(), rows, {
                preamble: [
                    ["REPORTE MENSUAL DE PERSONAL DE SUBCONTRATISTAS"],
                    ["OBRA: " + OBRA, null, null, "PERIODO: FEBRERO 2026"],
                    [],
                ],
            }),
        },
        expected: {
            read: {
                ok: true, hoja: "Cuadro", celdaAncla: "A4", filaEncabezado: 4,
                rangoEncabezados: "A4:R4", rangoDatos: "A4:R10",
                rowsFound: 6, rowsRejected: 0, rowsReturned: 6, blankRows: 0,
                missingColumns: [], unrecognizedHeaders: [],
                issues: issues([iss("ANCHOR_FOUND", "INFO")]),
            },
            parse: { accepted: 6, rejected: 0, issues: [] },
            records: records(5, rows.map(r => cleanExpect(r))),
        },
    });
}

/* ---- 2. leading-blank-column -------------------------------------------- */
// 03 §1.2 step 4. Column A is present in the used range but empty, so the left-edge walk
// must stop there rather than treat A as part of the table.
{
    const rows = [1, 2, 3, 4, 5].map(i => cleanRow(i));
    const layout = [{ header: "", key: null }].concat(cols());
    workbook({
        name: "leading-blank-column",
        pathology: "column A is blank; the table starts at B",
        spec: ["03 §1.2 step 4", "AC 2"],
        subcontratista: "MONTAJES SINTETICOS DEL SUR",
        sheets: { Cuadro: sheet(layout, rows) },
        expected: {
            read: {
                ok: true, hoja: "Cuadro", celdaAncla: "B1", filaEncabezado: 1,
                rangoEncabezados: "B1:S1", rangoDatos: "B1:S6",
                rowsFound: 5, rowsRejected: 0, rowsReturned: 5, blankRows: 0,
                missingColumns: [], unrecognizedHeaders: [],
                issues: issues([iss("ANCHOR_FOUND", "INFO")]),
            },
            parse: { accepted: 5, rejected: 0, issues: [] },
            records: records(2, rows.map(r => cleanExpect(r))),
        },
    });
}

/* ---- 3. columns-reordered ----------------------------------------------- */
// The owner's own premise: column ORDER may vary. Values must be placed by NAME (BUG-13).
// RUC lands at C, so the left-edge walk also has to recover A and B - 03 §1.2 step 4.
{
    const rows = [2, 3, 4, 5, 6, 7].map(i => cleanRow(i));
    const order = [
        "APELLIDOS Y NOMBRES", "Nro. DNI / CE", "RUC", "EMPRESA", "CONTRATISTA PRNCIPAL",
        "DISTRITO SEGÚN DNI", "GENERO", "FECHA NACIMIENTO", "NACIONALIDAD",
        "TITULO DE PUESTO/CARGO", "TIPO TRABAJADOR", "ESTADO",
        "FECHA INICIO DE LABORES EN OBRA", "FECHA CESE/BAJA",
        "TIPO DE CONTRATO LABORAL", "HPT",
        "NOMBRE DE OBRA DONDE ESTA ASIGNADO DURANTE EL MES REPORTADO",
        "DOMICILIO DE TRABAJADOR",
    ];
    workbook({
        name: "columns-reordered",
        pathology: "the 18 canonical columns in a different order; RUC sits at C",
        spec: ["03 §1.2 steps 3-4", "AC 2", "BUG-13"],
        subcontratista: "SINTETICA ANDINA CONTRATISTAS",
        sheets: { Cuadro: sheet(order.map(n => ({ header: n, key: n })), rows) },
        expected: {
            read: {
                ok: true, hoja: "Cuadro", celdaAncla: "C1", filaEncabezado: 1,
                rangoEncabezados: "A1:R1", rangoDatos: "A1:R7",
                rowsFound: 6, rowsRejected: 0, rowsReturned: 6, blankRows: 0,
                missingColumns: [], unrecognizedHeaders: [],
                // LEFT_EDGE_EXTENDED is the visibility rule of §1.2: an unexpected span is
                // reported, never merely tolerated.
                issues: issues([iss("ANCHOR_FOUND", "INFO"), iss("LEFT_EDGE_EXTENDED", "INFO")]),
            },
            parse: { accepted: 6, rejected: 0, issues: [] },
            records: records(2, rows.map(r => cleanExpect(r))),
        },
    });
}

/* ---- 4. empresa-left-of-ruc --------------------------------------------- */
// 03 §1.2 step 4, stated as its own case because the >=8-of-18 threshold cannot see it:
// 17 of 18 still resolve while EMPRESA is silently discarded.
{
    const rows = [3, 4, 5, 6, 7].map(i => cleanRow(i));
    const order = ["EMPRESA", "RUC"].concat(CANONICAL.filter(n => n !== "EMPRESA" && n !== "RUC"));
    workbook({
        name: "empresa-left-of-ruc",
        pathology: "EMPRESA sits to the LEFT of the RUC anchor and must survive",
        spec: ["03 §1.2 step 4", "AC 2", "BUG-03"],
        subcontratista: "MONTAJES SINTETICOS DEL SUR",
        sheets: { Cuadro: sheet(order.map(n => ({ header: n, key: n })), rows) },
        expected: {
            read: {
                ok: true, hoja: "Cuadro", celdaAncla: "B1", filaEncabezado: 1,
                rangoEncabezados: "A1:R1", rangoDatos: "A1:R6",
                rowsFound: 5, rowsRejected: 0, rowsReturned: 5, blankRows: 0,
                missingColumns: [], unrecognizedHeaders: [],
                issues: issues([iss("ANCHOR_FOUND", "INFO"), iss("LEFT_EDGE_EXTENDED", "INFO")]),
            },
            parse: { accepted: 5, rejected: 0, issues: [] },
            records: records(2, rows.map(r => cleanExpect(r))),
        },
    });
}

/* ---- 5. headers-accent-stripped ----------------------------------------- */
// 03 §1.3: one normalizer - trim, collapse, accent-fold, case-fold - resolves every
// FORMATTING variant. Note DISTRITO SEGUN DNI resolves as CANONICAL, not as an alias:
// the canonical spelling normalizes to the same key, so no alias entry is consulted and
// no HEADER_ALIAS_ACCEPTED line is expected.
{
    const rows = [4, 5, 6, 7, 8].map(i => cleanRow(i));
    const headers = {
        "RUC": "RUC ",                                   // trailing space
        "EMPRESA": "empresa",                            // lower case
        "CONTRATISTA PRNCIPAL": "CONTRATISTA  PRNCIPAL", // doubled internal space
        "Nro. DNI / CE": "nro.  dni / ce",               // case + doubled space
        "APELLIDOS Y NOMBRES": "Apellidos Y Nombres",    // mixed case
        "FECHA NACIMIENTO": "FECHA NACIMIENTO ",
        "TIPO TRABAJADOR": "tipo trabajador",
        "TITULO DE PUESTO/CARGO": "Titulo de Puesto/Cargo",
        "NOMBRE DE OBRA DONDE ESTA ASIGNADO DURANTE EL MES REPORTADO":
            "Nombre de obra donde esta asignado durante el mes reportado",
        "DOMICILIO DE TRABAJADOR": "domicilio de trabajador",
        "DISTRITO SEGÚN DNI": "DISTRITO SEGUN DNI",      // accent stripped
        "GENERO": "  genero  ",                          // padded both sides
        "FECHA CESE/BAJA": "Fecha Cese/Baja",
        "NACIONALIDAD": "nacionalidad",
        "FECHA INICIO DE LABORES EN OBRA": "FECHA INICIO DE  LABORES EN OBRA",
        "ESTADO": "Estado",
        "TIPO DE CONTRATO LABORAL": "Tipo De Contrato Laboral",
        "HPT": "hpt ",
    };
    workbook({
        name: "headers-accent-stripped",
        pathology: "accent-stripped, case-varied, space-padded and doubled-space headers",
        spec: ["03 §1.3", "AC 3"],
        subcontratista: "SINTETICA ANDINA CONTRATISTAS",
        sheets: { Cuadro: sheet(CANONICAL.map(n => ({ header: headers[n], key: n })), rows) },
        expected: {
            read: {
                ok: true, hoja: "Cuadro", celdaAncla: "A1", filaEncabezado: 1,
                rangoEncabezados: "A1:R1", rangoDatos: "A1:R6",
                rowsFound: 5, rowsRejected: 0, rowsReturned: 5, blankRows: 0,
                missingColumns: [], unrecognizedHeaders: [],
                issues: issues([iss("ANCHOR_FOUND", "INFO")]),
            },
            parse: { accepted: 5, rejected: 0, issues: [] },
            records: records(2, rows.map(r => cleanExpect(r))),
        },
    });
}

/* ---- 6. contratista-spelled-correctly ----------------------------------- */
// 03 §1.3 row 1 / AC 3. The canonical name carries the typo PRNCIPAL because it is
// load-bearing in xl/tables/table1.xml; the CORRECT spelling is the one alias the old app
// had, and it must resolve with a visible INFO line rather than by accident.
{
    const rows = [5, 6, 7, 8, 9].map(i => cleanRow(i));
    const layout = CANONICAL.map(n => ({
        header: n === "CONTRATISTA PRNCIPAL" ? "CONTRATISTA PRINCIPAL" : n,
        key: n,
    }));
    workbook({
        name: "contratista-spelled-correctly",
        pathology: "CONTRATISTA PRINCIPAL - the correct spelling, which the canonical typo would discard",
        spec: ["03 §1.3", "AC 3"],
        subcontratista: "MONTAJES SINTETICOS DEL SUR",
        sheets: { Cuadro: sheet(layout, rows) },
        expected: {
            read: {
                ok: true, hoja: "Cuadro", celdaAncla: "A1", filaEncabezado: 1,
                rangoEncabezados: "A1:R1", rangoDatos: "A1:R6",
                rowsFound: 5, rowsRejected: 0, rowsReturned: 5, blankRows: 0,
                missingColumns: [], unrecognizedHeaders: [],
                issues: issues([iss("ANCHOR_FOUND", "INFO"), iss("HEADER_ALIAS_ACCEPTED", "INFO")]),
            },
            parse: { accepted: 5, rejected: 0, issues: [] },
            records: records(2, rows.map(r => cleanExpect(r))),
        },
    });
}

/* ---- 7. duplicate-header ------------------------------------------------ */
// 03 §1.4 rule 3 / AC 6. SheetJS would suffix the second one `ESTADO_1` and the old
// cleanup loop would delete it, so one of the two columns wins with no message (BUG-05).
// Two cells carrying the EXACT canonical spelling is unresolvable by construction: there
// is no rule that could prefer one over the other, so the workbook is refused.
{
    const rows = [6, 7, 8].map(i => cleanRow(i, { "ESTADO_DUPLICADO": 2 }));
    const layout = cols().concat([{ header: "ESTADO", key: "ESTADO_DUPLICADO" }]);
    workbook({
        name: "duplicate-header",
        pathology: "the canonical header ESTADO appears twice - a hard error, not a _1 suffix",
        spec: ["03 §1.4 rule 3", "AC 6", "BUG-05"],
        subcontratista: "SINTETICA ANDINA CONTRATISTAS",
        sheets: { Cuadro: sheet(layout, rows) },
        expected: {
            read: {
                ok: false, hoja: "Cuadro",
                rowsFound: 0, rowsRejected: 0, rowsReturned: 0, blankRows: 0,
                // failedResult() reports every canonical column as missing: nothing was read.
                missingColumns: CANONICAL.slice(), unrecognizedHeaders: [],
                issues: issues([iss("ANCHOR_FOUND", "INFO"), iss("HEADER_DUPLICATE", "FAILED")]),
            },
            parse: null,
            records: null,
        },
    });
}

/* ---- 8. sheet-not-named-cuadro ------------------------------------------ */
// 03 §1.2 "Sheet selection" / AC 1. Three sheets: a near-miss that must NOT match
// ("Cuadro 2026" - equality after normalization, never prefix), the real table under
// "CUADRO " (trailing space), and a second loose match "cuadro" carrying decoy rows, so
// picking the wrong sheet shows up as wrong DATA and not merely as a wrong name.
{
    const rows = [7, 8, 9, 0, 1].map(i => cleanRow(i));
    const decoy = [{
        "RUC": ruc("2070011111"), "EMPRESA": "DECOY NO DEBE LEERSE S.A.C.",
        "CONTRATISTA PRNCIPAL": "DECOY", "Nro. DNI / CE": "49999999",
        "APELLIDOS Y NOMBRES": "DECOY DECOY DECOY", "FECHA NACIMIENTO": 29295,
        "TIPO TRABAJADOR": 1, "TITULO DE PUESTO/CARGO": "DECOY",
        "NOMBRE DE OBRA DONDE ESTA ASIGNADO DURANTE EL MES REPORTADO": "DECOY",
        "DOMICILIO DE TRABAJADOR": "DECOY", "DISTRITO SEGÚN DNI": D.ATE,
        "GENERO": "MASCULINO", "FECHA CESE/BAJA": null, "NACIONALIDAD": "PERUANA",
        "FECHA INICIO DE LABORES EN OBRA": 45516, "ESTADO": 1,
        "TIPO DE CONTRATO LABORAL": 1, "HPT": 1,
    }];
    workbook({
        name: "sheet-not-named-cuadro",
        pathology: "the worker table lives on \"CUADRO \"; \"Cuadro 2026\" must not match and \"cuadro\" must not win",
        spec: ["03 §1.2 Sheet selection", "AC 1", "BUG-01"],
        subcontratista: "MONTAJES SINTETICOS DEL SUR",
        sheets: {
            "Cuadro 2026": [["RESUMEN DEL PERIODO"], ["TOTAL TRABAJADORES", 5]],
            "CUADRO ": sheet(cols(), rows),
            "cuadro": sheet(cols(), decoy),
        },
        expected: {
            read: {
                ok: true, hoja: "CUADRO ", celdaAncla: "A1", filaEncabezado: 1,
                rangoEncabezados: "A1:R1", rangoDatos: "A1:R6",
                rowsFound: 5, rowsRejected: 0, rowsReturned: 5, blankRows: 0,
                missingColumns: [], unrecognizedHeaders: [],
                issues: issues([iss("SHEET_MATCHED_LOOSELY", "INFO"), iss("ANCHOR_FOUND", "INFO")]),
            },
            parse: { accepted: 5, rejected: 0, issues: [] },
            records: records(2, rows.map(r => cleanExpect(r))),
        },
    });
}

/* ---- 9. no-cuadro-sheet ------------------------------------------------- */
// 03 §1.4 rule 1 / AC 1. Today SheetNames.indexOf("Cuadro") returns -1, Sheets[undefined]
// is undefined, sheet_to_json throws, and the catch logs to a console that console.clear()
// has already wiped - an entire subcontratista's workforce disappears and the report still
// looks complete (BUG-01). The failure must name the sheets that ARE present.
workbook({
    name: "no-cuadro-sheet",
    pathology: "no sheet resolves to Cuadro; the worker table is on a sheet called PERSONAL",
    spec: ["03 §1.4 rule 1", "AC 1", "BUG-01"],
    subcontratista: "SINTETICA ANDINA CONTRATISTAS",
    sheets: {
        "Hoja1": [["INSTRUCCIONES"], ["Complete el formato adjunto"]],
        "PERSONAL": sheet(cols(), [8, 9, 0, 1].map(i => cleanRow(i))),
        "Resumen": [["TOTAL", 4]],
    },
    expected: {
        read: {
            ok: false, hoja: null,
            rowsFound: 0, rowsRejected: 0, rowsReturned: 0, blankRows: 0,
            missingColumns: CANONICAL.slice(), unrecognizedHeaders: [],
            issues: issues([iss("SHEET_NOT_FOUND", "FAILED")]),
            hojasPresentes: ["Hoja1", "PERSONAL", "Resumen"],
        },
        parse: null,
        records: null,
    },
});

/* ---- 10. column-shifted ------------------------------------------------- */
// 03 §2.3 - the 643-row block, 12.7% of the last real run, in miniature. The HEADERS are
// intact, so the >=8-of-18 threshold cannot see it; every VALUE is shifted left by four
// columns, so the RUC 20101155588 sits in APELLIDOS Y NOMBRES. Because Trabajador (AB) is
// COUNTIF over the name column, all 643 rows shared one "name" and 643 real workers
// contributed a combined headcount of exactly 1.
//
// The two intact rows at the end are the point of the fixture as much as the eight broken
// ones: a shifted block must not condemn the rest of the workbook.
{
    const SHIFT_RUC = 20101155588;                 // §2.3, quoted verbatim; a company, not a person
    const shifted = [];
    for (let i = 0; i < 8; i++) {
        shifted.push({
            "RUC": null, "EMPRESA": null, "CONTRATISTA PRNCIPAL": null, "Nro. DNI / CE": null,
            "APELLIDOS Y NOMBRES": SHIFT_RUC,
            // The same block is the entire source of fractional serials in the real file:
            // 643 in F and 637 in O, at 19:00 and 20:00. Reproduced for shape.
            "FECHA NACIMIENTO": 29295.791666666664,
            "TIPO TRABAJADOR": 2,
            "TITULO DE PUESTO/CARGO": PEOPLE[i].cargo,
            "NOMBRE DE OBRA DONDE ESTA ASIGNADO DURANTE EL MES REPORTADO": OBRA,
            "DOMICILIO DE TRABAJADOR": PEOPLE[i].domicilio,
            "DISTRITO SEGÚN DNI": PEOPLE[i].distrito,
            "GENERO": PEOPLE[i].genero,
            "FECHA CESE/BAJA": null,
            "NACIONALIDAD": "PERUANA",
            "FECHA INICIO DE LABORES EN OBRA": 45516.833333333336,
            "ESTADO": 1, "TIPO DE CONTRATO LABORAL": 1, "HPT": 160,
        });
    }
    const intact = [8, 9].map(i => cleanRow(i));
    workbook({
        name: "column-shifted",
        pathology: "eight rows with A-D empty and a RUC number in APELLIDOS Y NOMBRES, plus two intact rows",
        spec: ["03 §2.3", "AC 14", "BUG-04"],
        subcontratista: "SINTETICA ANDINA CONTRATISTAS",
        sheets: { Cuadro: sheet(cols(), shifted.concat(intact)) },
        expected: {
            read: {
                ok: true, hoja: "Cuadro", celdaAncla: "A1", filaEncabezado: 1,
                rangoEncabezados: "A1:R1", rangoDatos: "A1:R11",
                rowsFound: 10, rowsRejected: 8, rowsReturned: 2, blankRows: 0,
                missingColumns: [], unrecognizedHeaders: [],
                // ERROR, not FAILED: a row was rejected, the workbook was not (03 §8.3).
                issues: issues([iss("ANCHOR_FOUND", "INFO"), iss("ROW_NUMERIC_NAME", "ERROR", 8)]),
            },
            parse: { accepted: 2, rejected: 0, issues: [] },
            records: records(10, intact.map(r => cleanExpect(r))),
        },
    });
}

/* ---- 11. text-dates ----------------------------------------------------- */
// 03 §3.7, the worked-examples table, verbatim. Day-first always; month-first is never
// attempted, not even as a fallback, because that is how 03/05/1965 silently becomes
// 5 March. Serials below are the ones §3.7 states.
{
    const rows = [
        // 1-3: the three day-first shapes. §3.7 rows 3-5.
        cleanRow(0, { "FECHA NACIMIENTO": "04/07/1994" }),          // -> 34519
        cleanRow(1, { "FECHA NACIMIENTO": "14/2/1989" }),           // -> 32553
        cleanRow(2, { "FECHA NACIMIENTO": "3/5/1965" }),            // -> 23865
        // 4-5: two-digit years in an OBRA column, where the pivot applies. §3.7 rows 6-7.
        cleanRow(3, { "FECHA INICIO DE LABORES EN OBRA": "30/1/26" }),   // -> 46052
        cleanRow(4, { "FECHA INICIO DE LABORES EN OBRA": "27/05/25" }),  // -> 45804
        // 6: a two-digit year on a BIRTH date - unrecoverable, so rejected. §3.7 row 8.
        cleanRow(5, { "FECHA NACIMIENTO": "3/5/65" }),
        // 7-9: the malformed years. §3.7 rows 9-11.
        cleanRow(6, { "FECHA NACIMIENTO": "09/10/205" }),
        cleanRow(7, { "FECHA NACIMIENTO": "05/09/20258" }),
        cleanRow(8, { "FECHA NACIMIENTO": "10-11-202-6" }),
        // 10: calendar-impossible. §3.7 row 12.
        cleanRow(9, { "FECHA INICIO DE LABORES EN OBRA": "31/02/2026" }),
    ];
    workbook({
        name: "text-dates",
        pathology: "text dates in every observed shape plus the malformed years of 03 §3.7",
        spec: ["03 §3.1-§3.4", "03 §3.7", "AC 9", "BUG-06"],
        subcontratista: "MONTAJES SINTETICOS DEL SUR",
        sheets: { Cuadro: sheet(cols(), rows) },
        expected: {
            read: {
                ok: true, hoja: "Cuadro", celdaAncla: "A1", filaEncabezado: 1,
                rangoEncabezados: "A1:R1", rangoDatos: "A1:R11",
                rowsFound: 10, rowsRejected: 0, rowsReturned: 10, blankRows: 0,
                missingColumns: [], unrecognizedHeaders: [],
                issues: issues([iss("ANCHOR_FOUND", "INFO")]),
            },
            parse: {
                accepted: 10, rejected: 0,
                issues: issues([
                    iss("DATE_TWO_DIGIT_YEAR", "INFO", 2),    // 30/1/26 and 27/05/25 expanded
                    iss("DATE_TWO_DIGIT_YEAR", "ERROR", 1),   // 3/5/65 on a birth date
                    iss("DATE_UNPARSEABLE", "ERROR", 4),      // 205, 20258, 202-6, 31/02
                ]),
            },
            records: records(2, [
                cleanExpect(rows[0], { "FECHA NACIMIENTO": 34519 }),
                cleanExpect(rows[1], { "FECHA NACIMIENTO": 32553 }),
                cleanExpect(rows[2], { "FECHA NACIMIENTO": 23865 }),
                cleanExpect(rows[3], { "FECHA INICIO DE LABORES EN OBRA": 46052 }),
                cleanExpect(rows[4], { "FECHA INICIO DE LABORES EN OBRA": 45804 }),
                // Rejected dates null their own cell and the row survives - 03 §3.7 writes
                // these as "(empty) + run-report entry", not as a lost row, and AC 17 needs
                // a "Sin Fecha" bucket, which can only exist if such rows reach the workbook.
                cleanExpect(rows[5], { "FECHA NACIMIENTO": null }),
                cleanExpect(rows[6], { "FECHA NACIMIENTO": null }),
                cleanExpect(rows[7], { "FECHA NACIMIENTO": null }),
                cleanExpect(rows[8], { "FECHA NACIMIENTO": null }),
                cleanExpect(rows[9], { "FECHA INICIO DE LABORES EN OBRA": null }),
            ]),
        },
    });
}

/* ---- 12. fractional-serials --------------------------------------------- */
// 03 §2.3 / §3.4. 1,280 cells in the last run carry a fractional serial - 586 at
// .79166667 (19:00) and 694 at .83333333 (20:00) - and every one sits inside the shifted
// block. Truncate to the day, but SAY SO. Serial 60 is Excel's fictitious 1900-02-29: it
// parses (XLSX.SSF reproduces it) and is then rejected by the plausibility window, which
// is a WARNING with the field nulled, never a lost row.
{
    const rows = [
        cleanRow(0, {
            "FECHA NACIMIENTO": 29295.791666666664,               // 1980-03-15 19:00 -> 29295
            "FECHA INICIO DE LABORES EN OBRA": 43139.791666666664, // 2018-02-08 19:00 -> 43139 (§3.7 row 2)
        }),
        cleanRow(1, {
            "FECHA NACIMIENTO": 31218.833333333332,               // 1985-06-20 20:00 -> 31218
            "FECHA INICIO DE LABORES EN OBRA": 44991.833333333336, // 2023-03-06 20:00 -> 44991
        }),
        cleanRow(2, { "FECHA NACIMIENTO": 60 }),                   // 1900-02-29, implausible
        cleanRow(3, { "FECHA INICIO DE LABORES EN OBRA": 60 }),    // 1900-02-29, implausible
        cleanRow(4),                                               // control: clean serials
    ];
    workbook({
        name: "fractional-serials",
        pathology: "serials carrying 19:00 and 20:00 time components, plus Excel's fictitious serial 60",
        spec: ["03 §2.3", "03 §3.4", "03 §3.5", "AC 9"],
        subcontratista: "SINTETICA ANDINA CONTRATISTAS",
        sheets: { Cuadro: sheet(cols(), rows) },
        expected: {
            read: {
                ok: true, hoja: "Cuadro", celdaAncla: "A1", filaEncabezado: 1,
                rangoEncabezados: "A1:R1", rangoDatos: "A1:R6",
                rowsFound: 5, rowsRejected: 0, rowsReturned: 5, blankRows: 0,
                missingColumns: [], unrecognizedHeaders: [],
                issues: issues([iss("ANCHOR_FOUND", "INFO")]),
            },
            parse: {
                accepted: 5, rejected: 0,
                issues: issues([
                    iss("DATE_FRACTIONAL_TRUNCATED", "INFO", 4),
                    iss("DATE_IMPLAUSIBLE", "WARNING", 2),
                ]),
            },
            records: records(2, [
                cleanExpect(rows[0], { "FECHA NACIMIENTO": 29295, "FECHA INICIO DE LABORES EN OBRA": 43139 }),
                cleanExpect(rows[1], { "FECHA NACIMIENTO": 31218, "FECHA INICIO DE LABORES EN OBRA": 44991 }),
                cleanExpect(rows[2], { "FECHA NACIMIENTO": null }),
                cleanExpect(rows[3], { "FECHA INICIO DE LABORES EN OBRA": null }),
                cleanExpect(rows[4]),
            ]),
        },
    });
}

/* ---- 13. cese-sentinels ------------------------------------------------- */
// 03 §3.7 and AC 10. Measured in FECHA CESE/BAJA: "" x3801, "-" x754, " -" x154,
// "---" x125, "ACTIVO" x58, " " x1. Every one becomes a GENUINELY EMPTY cell - never the
// literal "", which is a TEXT value in a numFmtId-14 column (BUG-09) and is precisely why
// Bajas2 needs the IFERROR wrapper that now hides every genuine failure.
//
// A sentinel that FIRED is an INFO ("a normalization fired"); a cell that was already
// blank is not, because nothing was normalized.
{
    const rows = [
        cleanRow(0, { "FECHA CESE/BAJA": "-" }),
        cleanRow(1, { "FECHA CESE/BAJA": " - " }),
        cleanRow(2, { "FECHA CESE/BAJA": "---" }),
        cleanRow(3, { "FECHA CESE/BAJA": "ACTIVO" }),
        cleanRow(4, { "FECHA CESE/BAJA": "" }),
        cleanRow(5, { "FECHA CESE/BAJA": " " }),
        // A real cese: ESTADO 2 = CESADO, cese after the start date, inside the window.
        cleanRow(6, { "FECHA CESE/BAJA": 46073, "ESTADO": 2 }),     // 2026-02-20
    ];
    workbook({
        name: "cese-sentinels",
        pathology: "the FECHA CESE/BAJA sentinels - \"-\", \" - \", \"---\", \"ACTIVO\", \"\" and \" \"",
        spec: ["03 §3.7", "AC 10", "BUG-09"],
        subcontratista: "MONTAJES SINTETICOS DEL SUR",
        sheets: { Cuadro: sheet(cols(), rows) },
        expected: {
            read: {
                ok: true, hoja: "Cuadro", celdaAncla: "A1", filaEncabezado: 1,
                rangoEncabezados: "A1:R1", rangoDatos: "A1:R8",
                rowsFound: 7, rowsRejected: 0, rowsReturned: 7, blankRows: 0,
                missingColumns: [], unrecognizedHeaders: [],
                issues: issues([iss("ANCHOR_FOUND", "INFO")]),
            },
            parse: {
                accepted: 7, rejected: 0,
                // Four sentinels fired; "" and " " were already blank and say nothing.
                issues: issues([iss("TEXT_NORMALIZED", "INFO", 4)]),
            },
            records: records(2, [
                cleanExpect(rows[0], { "FECHA CESE/BAJA": null }),
                cleanExpect(rows[1], { "FECHA CESE/BAJA": null }),
                cleanExpect(rows[2], { "FECHA CESE/BAJA": null }),
                cleanExpect(rows[3], { "FECHA CESE/BAJA": null }),
                cleanExpect(rows[4], { "FECHA CESE/BAJA": null }),
                cleanExpect(rows[5], { "FECHA CESE/BAJA": null }),
                cleanExpect(rows[6]),
            ]),
        },
    });
}

/* ---- 14. dni-leading-zero ----------------------------------------------- */
// 03 §2 rows 1 and 4, AC 13. Measured DNI length distribution: 4 values at 7 characters
// (the leading-zero casualties), 4,202 at 8, 134 at 9 (legitimate CE), 2 at 10 - so the
// length rule is CONDITIONAL on document type, and a blanket 8-digit rule would call the
// 134 legitimate CE values errors while hiding the 4 real ones.
//
// The RUC pair is the other half: ~16% of distinct RUCs fail the mod-11 check today, and
// dropping them would delete whole subcontratistas from a compliance report, so a failing
// check digit is a WARNING with the value kept.
{
    // Right shape, wrong check digit. The CE and the RUC-column intruder are synthetic
    // (004100031, 40100099); the real corpus values quoted in pipeline/identity.js's
    // comments - 001079894 and 71514158 - are deliberately NOT reused here, because they
    // are somebody's actual document numbers (05 §6 risk row 11). Only the shape matters.
    const BAD_RUC = rucBad("2050012345");
    const rows = [
        cleanRow(0, { "Nro. DNI / CE": "09994533" }),   // 8 chars, leading zero preserved as TEXT
        cleanRow(1, { "Nro. DNI / CE": "9994533" }),    // 7 chars: the casualty, zero-padded + flagged
        cleanRow(2, { "Nro. DNI / CE": "004100031" }),  // 9 chars: a legitimate CE, INFO not error
        cleanRow(3, { "RUC": BAD_RUC }),                // fails mod-11
        cleanRow(4, { "RUC": "40100099" }),             // an 8-digit DNI sitting in the RUC column
        cleanRow(5, { "Nro. DNI / CE": 8123456 }),      // arrived as a NUMBER: the same casualty
    ];
    workbook({
        name: "dni-leading-zero",
        pathology: "a text DNI with a leading zero, a 7-char casualty, a 9-char CE, and RUCs that pass and fail mod-11",
        spec: ["03 §2 rows 1 and 4", "AC 13", "BUG-23"],
        subcontratista: "SINTETICA ANDINA CONTRATISTAS",
        sheets: { Cuadro: sheet(cols(), rows) },
        expected: {
            read: {
                ok: true, hoja: "Cuadro", celdaAncla: "A1", filaEncabezado: 1,
                rangoEncabezados: "A1:R1", rangoDatos: "A1:R7",
                rowsFound: 6, rowsRejected: 0, rowsReturned: 6, blankRows: 0,
                missingColumns: [], unrecognizedHeaders: [],
                issues: issues([iss("ANCHOR_FOUND", "INFO")]),
            },
            parse: {
                accepted: 6, rejected: 0,
                issues: issues([
                    iss("DNI_LENGTH", "WARNING", 2),      // the two 7-character casualties
                    iss("DNI_LENGTH", "INFO", 1),         // the 9-character CE
                    iss("RUC_CHECK_DIGIT", "WARNING", 1),
                    iss("RUC_FORMAT", "WARNING", 1),
                ]),
            },
            records: records(2, [
                cleanExpect(rows[0]),
                // Zero-padded to 8 AND flagged: the padding restores what numeric coercion
                // destroyed, but it is an inference, so it is reported rather than silent.
                cleanExpect(rows[1], { "Nro. DNI / CE": "09994533" }),
                cleanExpect(rows[2]),
                cleanExpect(rows[3]),
                // Never laundered into 00071514158: it stays a FORMAT error, kept as text.
                cleanExpect(rows[4]),
                cleanExpect(rows[5], { "Nro. DNI / CE": "08123456" }),
            ]),
        },
    });
}

/* ---- 15. codes-out-of-domain -------------------------------------------- */
// 03 §4 and AC 11-12, and the fixture 03 §9 criterion 30 names by file. Every value here
// is one the last run actually contains: ESTADO 184 and 160, TIPO DE CONTRATO LABORAL
// 0 / 0.03 / 5 / 10 / 11 / 14 - all products of the old `default: parseInt(...)`, which
// writes NaN or, worse, a plausible-looking partial parse (BUG-20).
//
// The GENERO pair is criterion 30's own pathology: an unrecognised value and an EMPTY
// cell. The empty cell is the one that produced the literal string "undefined" in
// OCTUBRE_2025, which became a third gender column, pushed the Total from F to G, let the
// pivot body expand over G53:G60 and overwrote the +F53/$F$60 percentage formulas (BUG-18).
{
    const rows = [
        cleanRow(0, { "ESTADO": 184 }),
        cleanRow(1, { "ESTADO": 160 }),
        cleanRow(2, { "TIPO DE CONTRATO LABORAL": 0 }),
        cleanRow(3, { "TIPO DE CONTRATO LABORAL": 0.03 }),
        cleanRow(4, { "TIPO DE CONTRATO LABORAL": 5 }),
        cleanRow(5, { "TIPO DE CONTRATO LABORAL": 10 }),
        cleanRow(6, { "TIPO DE CONTRATO LABORAL": 11, "GENERO": "OTRO" }),
        cleanRow(7, { "TIPO DE CONTRATO LABORAL": 14, "GENERO": null }),
    ];
    workbook({
        name: "codes-out-of-domain",
        pathology: "ESTADO 184/160, TIPO DE CONTRATO LABORAL 0/0.03/5/10/11/14, and a GENERO outside the two-item domain",
        spec: ["03 §4", "AC 11", "AC 12", "AC 30", "BUG-18", "BUG-19", "BUG-20"],
        subcontratista: "MONTAJES SINTETICOS DEL SUR",
        sheets: { Cuadro: sheet(cols(), rows) },
        expected: {
            read: {
                ok: true, hoja: "Cuadro", celdaAncla: "A1", filaEncabezado: 1,
                rangoEncabezados: "A1:R1", rangoDatos: "A1:R9",
                rowsFound: 8, rowsRejected: 0, rowsReturned: 8, blankRows: 0,
                missingColumns: [], unrecognizedHeaders: [],
                issues: issues([iss("ANCHOR_FOUND", "INFO")]),
            },
            parse: {
                accepted: 8, rejected: 0,
                issues: issues([
                    // 2 ESTADO + 6 TIPO DE CONTRATO LABORAL + 1 GENERO "OTRO".
                    iss("CODE_OUT_OF_DOMAIN", "WARNING", 9),
                    // The blank GENERO: absence of a REQUIRED field, reported once, nulled.
                    // Never String(undefined).toLowerCase().
                    iss("REQUIRED_MISSING", "WARNING", 1),
                ]),
            },
            records: records(2, [
                cleanExpect(rows[0], { "ESTADO": null }),
                cleanExpect(rows[1], { "ESTADO": null }),
                cleanExpect(rows[2], { "TIPO DE CONTRATO LABORAL": null }),
                cleanExpect(rows[3], { "TIPO DE CONTRATO LABORAL": null }),
                cleanExpect(rows[4], { "TIPO DE CONTRATO LABORAL": null }),
                cleanExpect(rows[5], { "TIPO DE CONTRATO LABORAL": null }),
                cleanExpect(rows[6], { "TIPO DE CONTRATO LABORAL": null, "GENERO": null }),
                cleanExpect(rows[7], { "TIPO DE CONTRATO LABORAL": null, "GENERO": null }),
            ]),
        },
    });
}

/* ---- 16. no-hpt-column -------------------------------------------------- */
// BUG-55 / 03 §1.3 last bullet. The older input format - the one the client actually hands
// out, src/Formato Reporte subcontratas.xlsx - has a Cuadro header row that stops at
// TIPO DE CONTRATO LABORAL. HPT is the `# Horas` measure on CJ Y EPC (985,872 hours in
// FEBRERO_2026), so a whole-file miss silently subtracts that company's hours from a
// compliance figure. One WARNING per FILE, flagged as a version signal - not one per row,
// which would be 5,065 lines saying the same thing.
{
    const rows = [1, 3, 5, 7, 9, 0].map(i => cleanRow(i));
    const layout = CANONICAL.filter(n => n !== "HPT").map(n => ({ header: n, key: n }));
    workbook({
        name: "no-hpt-column",
        pathology: "the older input format: the HPT column is absent entirely",
        spec: ["03 §1.3", "AC 4", "BUG-55"],
        subcontratista: "SINTETICA ANDINA CONTRATISTAS",
        sheets: { Cuadro: sheet(layout, rows) },
        expected: {
            read: {
                ok: true, hoja: "Cuadro", celdaAncla: "A1", filaEncabezado: 1,
                rangoEncabezados: "A1:Q1", rangoDatos: "A1:Q7",
                rowsFound: 6, rowsRejected: 0, rowsReturned: 6, blankRows: 0,
                missingColumns: ["HPT"], unrecognizedHeaders: [],
                issues: issues([iss("ANCHOR_FOUND", "INFO"), iss("COLUMN_MISSING", "WARNING")]),
            },
            // Zero per-row noise: workbook.js said it once, for the file.
            parse: { accepted: 6, rejected: 0, issues: [] },
            records: records(2, rows.map(r => cleanExpect(r, { "HPT": null }))),
        },
    });
}

/* ---- 17. text-columns-dirty --------------------------------------------- */
// 03 §2.1. CONTRATISTA PRNCIPAL carries 352 distinct spellings for roughly 84 real
// companies, and that distinct count drives Contratistas!C91, column U's
// distinct-contratista weight and every pivot filter list. DISTRITO SEGUN DNI matters even
// more: Zona de Influencia is VLOOKUP(TRIM(distrito), Hoja1!$A$2:$B$61, 2, FALSE), and
// Excel's TRIM strips only LEADING/TRAILING space - so "CERCADO DE  LIMA" survives it,
// misses the exact-match lookup, resolves to "No", and the worker drops out of the zone
// report while still counting toward headcount (BUG-29).
//
// These normalizations are deliberately NOT issues: 4,000+ cells in the last run are
// altered by trim/collapse/uppercase alone, and one INFO line each would be four times the
// size of every other finding combined. They are returned on result.normalizations for the
// run report's grouped section, and that is what this fixture asserts.
{
    const rows = [
        cleanRow(0, { "CONTRATISTA PRNCIPAL": " CLJ CONTRUCTORA SAC" }),
        // A line break embedded in a company name. It is written as a bare LF, not CRLF,
        // and that is a property of the CONTAINER, not a shortcut: XML line-ending
        // normalization collapses a CRLF inside <t> to a single LF, so no .xlsx can deliver
        // "\r\n" to the reader. Verified by round-tripping "A\r\nB" through
        // XLSX.writeFile/readFile - it comes back "A\nB". The lone CR on row 6 is the other
        // half of the "strip embedded CR/LF" rule in 03 §2 row 2, and that one DOES survive.
        cleanRow(1, { "EMPRESA": "SINTETICA GENERAL SOLUTIONS\nAND CONSULTING S.A.C" }),
        cleanRow(2, { "DISTRITO SEGÚN DNI": "CERCADO DE  LIMA" }),
        cleanRow(3, { "APELLIDOS Y NOMBRES": "villanueva arce sandra lucia " }),
        // The next row's TITULO carries a U+00A0 NBSP where the space looks to be -
        // measured 48x in APELLIDOS Y NOMBRES, 21x in DOMICILIO, 7x in TITULO and 3x in
        // DISTRITO in the last run. JavaScript's \s covers NBSP; Excel's TRIM does not, so
        // an untouched one is a second pivot label for one job title.
        cleanRow(4, { "NACIONALIDAD": "Peruano ", "TITULO DE PUESTO/CARGO": "OPERARIO ELECTRICISTA" }),
        cleanRow(5, {
            // A leading carriage return - what "_x000d__x000a_MCORP SAC" in the pivot cache
            // looks like once it is a real control character in a cell.
            //
            // The LITERAL 7-character escape "_x000d_" deliberately does NOT appear in any
            // workbook fixture, because it CANNOT: SheetJS's reader decodes every
            // _xHHHH_ escape on the way in, and even the OOXML-correct double form
            // "_x005F_x000d_" comes back decoded (verified by round trip). Those literals
            // were measured in xl/pivotCache/pivotCacheDefinition*.xml, not in a data cell,
            // and text.js's OOXML_WHITESPACE_ESCAPE branch is covered where it belongs -
            // src/test/text.test.js and src/test/cases/text.json.
            "CONTRATISTA PRNCIPAL": "\rSINTETICA MODULAR SAC",
            "EMPRESA": "BK SINTETICA  S.A.C",
        }),
    ];
    workbook({
        name: "text-columns-dirty",
        pathology: "leading space, embedded LF and CR, doubled internal space and an NBSP in the free-text columns",
        spec: ["03 §2.1", "03 §2.2", "BUG-24", "BUG-25", "BUG-29"],
        subcontratista: "MONTAJES SINTETICOS DEL SUR",
        sheets: { Cuadro: sheet(cols(), rows) },
        expected: {
            read: {
                ok: true, hoja: "Cuadro", celdaAncla: "A1", filaEncabezado: 1,
                rangoEncabezados: "A1:R1", rangoDatos: "A1:R7",
                rowsFound: 6, rowsRejected: 0, rowsReturned: 6, blankRows: 0,
                missingColumns: [], unrecognizedHeaders: [],
                issues: issues([iss("ANCHOR_FOUND", "INFO")]),
            },
            parse: { accepted: 6, rejected: 0, issues: [] },
            records: records(2, [
                cleanExpect(rows[0], { "CONTRATISTA PRNCIPAL": "CLJ CONTRUCTORA SAC" }),
                cleanExpect(rows[1], { "EMPRESA": "SINTETICA GENERAL SOLUTIONS AND CONSULTING S.A.C" }),
                cleanExpect(rows[2], { "DISTRITO SEGÚN DNI": "CERCADO DE LIMA" }),
                cleanExpect(rows[3], { "APELLIDOS Y NOMBRES": "VILLANUEVA ARCE SANDRA LUCIA" }),
                cleanExpect(rows[4], { "NACIONALIDAD": "PERUANO", "TITULO DE PUESTO/CARGO": "OPERARIO ELECTRICISTA" }),  // NBSP -> space
                cleanExpect(rows[5], {
                    "CONTRATISTA PRNCIPAL": "SINTETICA MODULAR SAC",
                    "EMPRESA": "BK SINTETICA S.A.C",
                }),
            ]),
            // Sorted; the test sorts the observed list the same way.
            normalizations: [
                { columna: "APELLIDOS Y NOMBRES", valor: "villanueva arce sandra lucia ", normalizado: "VILLANUEVA ARCE SANDRA LUCIA" },
                { columna: "CONTRATISTA PRNCIPAL", valor: " CLJ CONTRUCTORA SAC", normalizado: "CLJ CONTRUCTORA SAC" },
                { columna: "CONTRATISTA PRNCIPAL", valor: "\rSINTETICA MODULAR SAC", normalizado: "SINTETICA MODULAR SAC" },
                { columna: "DISTRITO SEGÚN DNI", valor: "CERCADO DE  LIMA", normalizado: "CERCADO DE LIMA" },
                { columna: "EMPRESA", valor: "BK SINTETICA  S.A.C", normalizado: "BK SINTETICA S.A.C" },
                { columna: "EMPRESA", valor: "SINTETICA GENERAL SOLUTIONS\nAND CONSULTING S.A.C", normalizado: "SINTETICA GENERAL SOLUTIONS AND CONSULTING S.A.C" },
                { columna: "NACIONALIDAD", valor: "Peruano ", normalizado: "PERUANO" },
                { columna: "TITULO DE PUESTO/CARGO", valor: "OPERARIO ELECTRICISTA", normalizado: "OPERARIO ELECTRICISTA" },
            ],
        },
    });
}

/* ------------------------------------------------------------------ *
 * The four container fixtures - 03 §1.1, folder and zip level
 * ------------------------------------------------------------------ */

/** A minimal but complete subcontratista workbook: three clean rows, canonical layout. */
function miniWorkbook(startIndex) {
    return { Cuadro: sheet(cols(), [0, 1, 2].map(i => cleanRow(startIndex + i))) };
}

const CONTAINER_FIXTURES = [
    {
        name: "folder-two-xlsx",
        kind: "folder",
        pathology: "one subcontratista folder holds TWO .xlsx - the choice is arbitrary, so it is refused",
        spec: ["03 §1.1", "BUG-33"],
        // Today readdirSync's order silently decides which one wins, and src/app.js:73
        // passes that ARRAY straight into a path template.
        tree: {
            "SUBCONTRATA BUENA": { "lista.xlsx": miniWorkbook(0) },
            "SUBCONTRATA DOS ARCHIVOS": {
                "lista-a.xlsx": miniWorkbook(3),
                "lista-b.xlsx": miniWorkbook(6),
            },
        },
        expected: {
            walk: {
                records: [{ subcontratista: "SUBCONTRATA BUENA", archivo: "lista.xlsx" }],
                summary: { wrapper: false, topLevelFolders: 2, foldersOk: 1, foldersFailed: 1, looseFiles: 0 },
                issues: issues([iss("FOLDER_MULTIPLE_XLSX", "FAILED")]),
            },
        },
    },
    {
        name: "folder-zero-xlsx",
        kind: "folder",
        pathology: "one subcontratista folder holds ZERO .xlsx - NOT \"no workers this month\"",
        spec: ["03 §1.1"],
        tree: {
            "SUBCONTRATA BUENA": { "lista.xlsx": miniWorkbook(0) },
            "SUBCONTRATA VACIA": { "observaciones.txt": "El listado se envia por correo.\n" },
        },
        expected: {
            walk: {
                records: [{ subcontratista: "SUBCONTRATA BUENA", archivo: "lista.xlsx" }],
                summary: { wrapper: false, topLevelFolders: 2, foldersOk: 1, foldersFailed: 1, looseFiles: 0 },
                issues: issues([
                    iss("SKIPPED_NON_XLSX", "INFO"),
                    iss("FOLDER_NO_XLSX", "FAILED"),
                ]),
            },
        },
    },
    {
        name: "folder-lockfile",
        kind: "folder",
        pathology: "an Excel ~$ lock file sits next to the real workbook and must be skipped BY NAME, never opened",
        spec: ["03 §1.1"],
        // One is sitting in src/reportes/ right now. It is not a workbook and opening it
        // throws; it must also not make the folder look like it holds two workbooks.
        tree: {
            "SUBCONTRATA CON LOCK": {
                "lista.xlsx": miniWorkbook(0),
                "~$lista.xlsx": Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
            },
        },
        expected: {
            walk: {
                records: [{ subcontratista: "SUBCONTRATA CON LOCK", archivo: "lista.xlsx" }],
                summary: { wrapper: false, topLevelFolders: 1, foldersOk: 1, foldersFailed: 0, looseFiles: 0 },
                issues: issues([iss("SKIPPED_LOCKFILE", "INFO")]),
            },
        },
    },
    {
        name: "zip-macosx-resource-fork",
        kind: "zip",
        pathology: "a macOS zip carrying a __MACOSX/ tree and a ._ resource fork beside the real workbook",
        spec: ["03 §1.1", "BUG-34"],
        // Never materialized on disk: recreating __MACOSX/ would hand walkInput a
        // top-level folder with zero .xlsx, i.e. a fake FAILED subcontratista.
        zip: [
            { name: "SUBCONTRATA MAC/", dir: true },
            { name: "SUBCONTRATA MAC/lista.xlsx", workbook: miniWorkbook(0) },
            { name: "SUBCONTRATA MAC/._lista.xlsx", data: "Mac OS X resource fork\n" },
            { name: "__MACOSX/", dir: true },
            { name: "__MACOSX/SUBCONTRATA MAC/", dir: true },
            { name: "__MACOSX/SUBCONTRATA MAC/._lista.xlsx", data: "Mac OS X resource fork\n" },
        ],
        expected: {
            extract: {
                entries: 6,
                extracted: 1,
                // Only "SUBCONTRATA MAC/" is created. The two __MACOSX/ directory entries
                // classify as MACOSX, not DIRECTORY, so they are never materialized.
                directories: 1,
                // The ._ fork beside the workbook, "__MACOSX/", "__MACOSX/SUBCONTRATA MAC/"
                // and the fork inside it.
                skipped: { macosx: 4, lockfile: 0, nonXlsx: 0 },
                // Aggregated into ONE line on purpose: a macOS zip carries one __MACOSX
                // entry per file and 150 identical INFO lines would drown the Errores sheet.
                issues: issues([iss("SKIPPED_MACOSX", "INFO")]),
            },
            walk: {
                records: [{ subcontratista: "SUBCONTRATA MAC", archivo: "lista.xlsx" }],
                summary: { wrapper: false, topLevelFolders: 1, foldersOk: 1, foldersFailed: 0, looseFiles: 0 },
                issues: [],
            },
        },
    },
];

/* ------------------------------------------------------------------ *
 * Emit
 * ------------------------------------------------------------------ */

function writeWorkbook(sheets, file) {
    const wb = XLSX.utils.book_new();
    for (const [name, aoa] of Object.entries(sheets)) {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
    }
    XLSX.writeFile(wb, file);
}

function writeJson(file, value) {
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

/** Materialize a {name: contents} tree; contents is a sheet map, a Buffer or a string. */
function writeTree(dir, tree) {
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, value] of Object.entries(tree)) {
        const target = path.join(dir, name);
        if (Buffer.isBuffer(value)) fs.writeFileSync(target, value);
        else if (typeof value === "string") fs.writeFileSync(target, value, "utf8");
        else if (name.toLowerCase().endsWith(".xlsx")) writeWorkbook(value, target);
        else writeTree(target, value);
    }
}

function build() {
    fs.rmSync(FIXTURES, { recursive: true, force: true });
    fs.mkdirSync(CONTAINERS, { recursive: true });

    const manifest = { period: PERIOD, workbooks: [], containers: [] };

    for (const f of WORKBOOKS) {
        const file = path.join(FIXTURES, `${f.name}.xlsx`);
        writeWorkbook(f.sheets, file);
        writeJson(path.join(FIXTURES, `${f.name}.expected.json`), {
            fixture: `${f.name}.xlsx`,
            kind: "workbook",
            pathology: f.pathology,
            spec: f.spec,
            period: PERIOD,
            subcontratista: f.subcontratista,
            read: f.expected.read,
            parse: f.expected.parse,
            records: f.expected.records,
            normalizations: f.expected.normalizations || null,
        });
        manifest.workbooks.push(f.name);
    }

    for (const c of CONTAINER_FIXTURES) {
        if (c.kind === "folder") {
            writeTree(path.join(CONTAINERS, c.name), c.tree);
        } else {
            const zip = new AdmZip();
            for (const e of c.zip) {
                if (e.dir) {
                    zip.addFile(e.name, Buffer.alloc(0));
                } else if (e.workbook) {
                    const wb = XLSX.utils.book_new();
                    for (const [name, aoa] of Object.entries(e.workbook)) {
                        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
                    }
                    zip.addFile(e.name, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
                } else {
                    zip.addFile(e.name, Buffer.from(e.data, "utf8"));
                }
            }
            // Pin every entry's timestamp: adm-zip defaults to the wall clock, which would
            // make the committed zip churn on every regeneration.
            for (const entry of zip.getEntries()) entry.header.time = ZIP_EPOCH;
            zip.writeZip(path.join(CONTAINERS, `${c.name}.zip`));
        }
        writeJson(path.join(CONTAINERS, `${c.name}.expected.json`), {
            fixture: c.kind === "zip" ? `containers/${c.name}.zip` : `containers/${c.name}`,
            kind: c.kind,
            pathology: c.pathology,
            spec: c.spec,
            period: PERIOD,
            extract: c.expected.extract || null,
            walk: c.expected.walk,
        });
        manifest.containers.push({ name: c.name, kind: c.kind });
    }

    writeJson(path.join(FIXTURES, "manifest.json"), manifest);

    process.stdout.write(
        `fixtures: ${manifest.workbooks.length} workbooks, ${manifest.containers.length} containers -> ${FIXTURES}\n`
    );
}

if (require.main === module) build();

module.exports = { build, rucCheckDigit, PERIOD };

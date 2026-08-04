"use strict";
/**
 * Coded-domain tests. The case table lives in cases/codes.json so the assertions are
 * written once and the corpus can grow; the property tests below cover what a table
 * cannot - "no input of any shape ever produces NaN or the literal string 'undefined'".
 *
 * Regression coverage: BUG-18 (unreachable numeric cases / "undefined" gender),
 * BUG-19 (raw untrimmed switch), BUG-20 (parseInt default writing NaN).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

const codes = require("../pipeline/codes");
const { CODED_COLUMNS } = require("../pipeline/columns");
const { IssueList, SEVERITY, CODE } = require("../pipeline/issues");

const CASES = JSON.parse(
    fs.readFileSync(path.join(__dirname, "cases", "codes.json"), "utf8")
).cases;

/** Per-domain normalizers, keyed the way the case table names them. */
const BY_COLUMN = {
    "TIPO TRABAJADOR": codes.normalizeTipoTrabajador,
    ESTADO: codes.normalizeEstado,
    "TIPO DE CONTRATO LABORAL": codes.normalizeTipoContratoLaboral,
    GENERO: codes.normalizeGenero,
};

const describeCase = c => `${c.column} <- ${JSON.stringify(c.input)}`;

test("the case table drives the per-domain normalizers", () => {
    assert.ok(CASES.length >= 100, `expected a real corpus, got ${CASES.length} cases`);
    for (const c of CASES) {
        const fn = BY_COLUMN[c.column];
        assert.ok(fn, `no normalizer for ${c.column}`);
        const result = fn(c.input);
        assert.deepEqual(result.value, c.expected, describeCase(c));
        // ok is about recognition, not about emptiness: an empty cell is legal.
        assert.equal(result.ok, c.expectedIssue !== "CODE_OUT_OF_DOMAIN", describeCase(c));
    }
});

test("the case table drives the generic entry point, including the issue it records", () => {
    for (const c of CASES) {
        const issues = new IssueList();
        const result = codes.normalizeCode(c.column, c.input, { issues });
        assert.deepEqual(result.value, c.expected, describeCase(c));

        if (c.expectedIssue === null) {
            assert.equal(issues.length, 0, `${describeCase(c)} should be silent`);
            continue;
        }
        assert.equal(issues.length, 1, `${describeCase(c)} should record exactly one issue`);
        const [issue] = issues.items;
        assert.equal(issue.code, c.expectedIssue, describeCase(c));
        assert.equal(issue.columna, c.column);
        // The RAW value must survive into the report verbatim (03 §8.2).
        assert.deepEqual(issue.valor, c.input === undefined ? null : c.input, describeCase(c));
    }
});

test("BUG-20: no input in the corpus ever yields NaN, undefined or a raw passthrough", () => {
    for (const c of CASES) {
        const { value } = codes.normalizeCode(c.column, c.input);
        if (value === null) continue;
        assert.notEqual(typeof value, "undefined");
        if (typeof value === "number") {
            assert.ok(Number.isInteger(value), `${describeCase(c)} produced ${value}`);
            assert.ok(
                codes.allowedValues(c.column).includes(value),
                `${describeCase(c)} produced out-of-domain ${value}`
            );
        } else {
            assert.ok(["masculino", "femenino"].includes(value), `${describeCase(c)} produced ${value}`);
        }
    }
});

test("BUG-18: numeric 1 and 2 reach GENERO (the unreachable `case 1:` branches)", () => {
    // The old switch lower-cased its scrutinee to a string and then compared it against
    // numeric cases, which strict equality can never match. Feed the numbers directly.
    assert.equal(codes.normalizeGenero(1).value, "masculino");
    assert.equal(codes.normalizeGenero(2).value, "femenino");
    assert.equal(codes.normalizeTipoTrabajador(1).value, 1);
    assert.equal(codes.normalizeEstado(3).value, 3);
    assert.equal(codes.normalizeTipoContratoLaboral(4).value, 4);
});

test('BUG-18: a missing GENERO can never become the literal string "undefined"', () => {
    for (const empty of [undefined, null, "", "   ", "\n", "\t \r\n"]) {
        const issues = new IssueList();
        const result = codes.normalizeCode("GENERO", empty, { issues });
        assert.equal(result.value, null);
        assert.equal(result.empty, true);
        assert.equal(result.ok, true);
        // Absence is not an error; flagging it would bury the Errores sheet.
        assert.equal(issues.length, 0);
    }
    // ...and if a literal "undefined" arrives from upstream it is rejected, not stored.
    const issues = new IssueList();
    assert.equal(codes.normalizeCode("GENERO", "undefined", { issues }).value, null);
    assert.equal(issues.byCode(CODE.CODE_OUT_OF_DOMAIN).length, 1);
});

test("BUG-18: GENERO stores the lowercase Spanish word, never the uppercase form or a code", () => {
    // 03 §4.4 - the template validates LOWER([GENERO]); storing "MASCULINO" produced a
    // second pivot item and split the gender columns.
    for (const raw of ["MASCULINO", "Masculino", "masculino", "1", 1, "m", "hombre", "VARÓN"]) {
        assert.equal(codes.normalizeGenero(raw).value, "masculino", `raw=${raw}`);
    }
    for (const raw of ["FEMENINO", "Femenino", "femenino", "2", 2, "f", "mujer"]) {
        assert.equal(codes.normalizeGenero(raw).value, "femenino", `raw=${raw}`);
    }
});

test("BUG-19: TIPO DE CONTRATO LABORAL matches regardless of case, padding or accents", () => {
    const variants = [
        "plazo fijo",
        "PLAZO FIJO",
        "PLAZO FIJO ",
        " Plazo Fijo",
        "\tPlazo   fijo\n",
        "Plazo fijo",
    ];
    for (const v of variants) {
        assert.equal(codes.normalizeTipoContratoLaboral(v).value, 1, `raw=${JSON.stringify(v)}`);
    }
    assert.equal(codes.normalizeTipoContratoLaboral("sin contrato régimen civil").value, 4);
    assert.equal(codes.normalizeTipoContratoLaboral("SIN CONTRATO REGIMEN CIVIL ").value, 4);
});

test("every declared synonym round-trips, in any casing, padding or accent form", () => {
    for (const domain of Object.values(codes.DOMAINS)) {
        for (const entry of domain.entries) {
            const all = [...entry.synonyms, ...(entry.lowConfidence || [])];
            for (const synonym of all) {
                const deaccented = synonym.normalize("NFD").replace(/[̀-ͯ]/g, "");
                const forms = [
                    synonym,
                    deaccented,
                    synonym.toUpperCase(),
                    synonym.toLowerCase(),
                    `  ${synonym}  `,
                    `\n${synonym}\t`,
                    synonym.replace(/ /g, "   "),
                ];
                for (const form of forms) {
                    const result = codes.normalizeInDomain(domain.column, form);
                    assert.equal(
                        result.value,
                        entry.value,
                        `${domain.column} <- ${JSON.stringify(form)}`
                    );
                    assert.equal(result.ok, true);
                    assert.equal(result.label, entry.label);
                }
            }
        }
    }
});

test("zero-padded and zero-decimal numeric forms resolve, but 0 and 0.03 do not", () => {
    assert.equal(codes.normalizeEstado("001").value, 1);
    assert.equal(codes.normalizeEstado("1.0").value, 1);
    assert.equal(codes.normalizeTipoContratoLaboral("04").value, 4);
    assert.equal(codes.normalizeTipoContratoLaboral("4,00").value, 4);
    for (const junk of [0, "0", "00", 0.03, "0.03", "0,03", 5, 10, 11, 14, 184, 160, 2.5]) {
        const result = codes.normalizeTipoContratoLaboral(junk);
        assert.equal(result.value, null, `junk=${junk}`);
        assert.equal(result.ok, false, `junk=${junk}`);
    }
});

test('the low-confidence "SI" mapping is accepted but reported', () => {
    const issues = new IssueList();
    const result = codes.normalizeCode("TIPO DE CONTRATO LABORAL", " Si ", { issues });
    assert.equal(result.value, 4);
    assert.equal(result.ok, true);
    assert.equal(result.lowConfidence, true);
    assert.equal(issues.length, 1);
    assert.equal(issues.items[0].severity, SEVERITY.INFO);
    assert.equal(issues.items[0].detalle.lowConfidence, true);
    // No other synonym is low-confidence today; the run report counts these.
    assert.equal(codes.normalizeTipoContratoLaboral("planilla").lowConfidence, false);
});

test("an out-of-domain value is a WARNING carrying the raw value and full provenance", () => {
    const issues = new IssueList();
    const result = codes.normalizeCode("ESTADO", 184, {
        issues,
        subcontratista: "ACME SAC",
        archivo: "acme.xlsx",
        hoja: "Cuadro",
        fila: 1743,
        celda: "P1743",
    });
    assert.equal(result.value, null);
    assert.equal(result.ok, false);
    assert.equal(issues.length, 1);
    const [issue] = issues.items;
    assert.equal(issue.severity, SEVERITY.WARNING);
    assert.equal(issue.code, CODE.CODE_OUT_OF_DOMAIN);
    assert.equal(issue.valor, 184);
    assert.equal(issue.celda, "P1743");
    assert.equal(issue.fila, 1743);
    assert.equal(issue.subcontratista, "ACME SAC");
    assert.equal(issue.archivo, "acme.xlsx");
    assert.equal(issue.hoja, "Cuadro");
    assert.deepEqual(issue.detalle.allowed, [1, 2, 3]);
    assert.match(issue.message, /ESTADO/);
});

test("the module is pure: no IssueList, no side effect, and repeated calls agree", () => {
    const first = codes.normalizeCode("ESTADO", "activo en obra");
    const second = codes.normalizeCode("ESTADO", "activo en obra");
    assert.deepEqual(first, second);
    // Calling without a collector must not throw and must still report ok=false.
    assert.equal(codes.normalizeCode("ESTADO", 184).ok, false);
});

test("the domain tables match the coded columns declared in columns.js", () => {
    assert.deepEqual(Object.keys(codes.DOMAINS).sort(), [...CODED_COLUMNS].sort());
    assert.deepEqual(codes.allowedValues("TIPO TRABAJADOR"), [1, 2, 3]);
    assert.deepEqual(codes.allowedValues("ESTADO"), [1, 2, 3]);
    assert.deepEqual(codes.allowedValues("TIPO DE CONTRATO LABORAL"), [1, 2, 3, 4]);
    assert.deepEqual(codes.allowedValues("GENERO"), ["masculino", "femenino"]);
    for (const column of CODED_COLUMNS) assert.equal(codes.isCodedColumn(column), true);
    assert.equal(codes.isCodedColumn("NACIONALIDAD"), false);
    assert.equal(codes.isCodedColumn("constructor"), false);
});

test("the case table covers every synonym in every domain", () => {
    // A synonym nobody tests is a synonym that can be dropped by accident.
    const covered = new Set(CASES.map(c => `${c.column}|${codes.normalizeCodeKey(c.input)}`));
    const missing = [];
    for (const domain of Object.values(codes.DOMAINS)) {
        for (const entry of domain.entries) {
            for (const synonym of [...entry.synonyms, ...(entry.lowConfidence || [])]) {
                const key = `${domain.column}|${codes.normalizeCodeKey(synonym)}`;
                if (!covered.has(key)) missing.push(key);
            }
        }
    }
    assert.deepEqual(missing, [], `synonyms absent from cases/codes.json: ${missing.join(", ")}`);
});

test("an unknown column is a programming error, not a data problem", () => {
    assert.throws(() => codes.normalizeCode("NACIONALIDAD", "PERUANA"), /unknown coded column/);
});

test("non-string, non-number inputs are rejected cleanly rather than stringified into a code", () => {
    for (const weird of [true, false, {}, [], [1], new Date(0)]) {
        for (const column of CODED_COLUMNS) {
            const result = codes.normalizeInDomain(column, weird);
            assert.equal(result.ok, false, `${column} <- ${String(weird)}`);
            assert.equal(result.value, null);
        }
    }
});

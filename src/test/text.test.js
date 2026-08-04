"use strict";
/**
 * Tests for src/pipeline/text.js.
 *
 * The bulk of the coverage is the committed case table in cases/text.json, whose inputs
 * are values MEASURED in src/ReporteConsolidado.xlsx and src/template.xlsx - not toys.
 * The cases the table cannot express (undefined, NaN, Date, objects) and the properties
 * that hold across every case (idempotence, the 352 -> N fold, the 7 -> 2 fold) are
 * asserted here.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
    NORMALIZED_COLUMNS,
    normalizeText,
    normalizeForColumn,
    isNormalizedColumn,
    isUppercaseColumn,
} = require("../pipeline/text");
const {
    CANONICAL,
    TEXT_COLUMNS,
    UPPERCASE_COLUMNS,
    DATE_COLUMNS,
    CODED_COLUMNS,
} = require("../pipeline/columns");
const { CODE } = require("../pipeline/issues");

const CASES = JSON.parse(
    fs.readFileSync(path.join(__dirname, "cases", "text.json"), "utf8")
);

/** The issue code schema.js is expected to raise for a given result. */
function issueFor(result) {
    return result.changed ? CODE.TEXT_NORMALIZED : null;
}

// ---------------------------------------------------------------------------
// The committed case table
// ---------------------------------------------------------------------------

test("normalizeText - measured case table", async (t) => {
    for (const c of CASES.normalizeText) {
        await t.test(c.name, () => {
            const r = normalizeText(c.input, { uppercase: c.uppercase === true });
            assert.equal(r.value, c.expected);
            assert.equal(
                issueFor(r),
                c.expectedIssue,
                `changed=${r.changed} but expectedIssue=${c.expectedIssue}`
            );
        });
    }
});

test("normalizeForColumn - measured case table", async (t) => {
    for (const c of CASES.normalizeForColumn) {
        await t.test(c.name, () => {
            const r = normalizeForColumn(c.column, c.input);
            assert.deepEqual(r.value, c.expected);
            assert.equal(issueFor(r), c.expectedIssue);
            assert.equal(r.applied, isNormalizedColumn(c.column));
        });
    }
});

test("case table is not silently empty", () => {
    assert.ok(CASES.normalizeText.length >= 40);
    assert.ok(CASES.normalizeForColumn.length >= 10);
});

// ---------------------------------------------------------------------------
// Idempotence: normalizing twice equals normalizing once
// ---------------------------------------------------------------------------

test("normalizeText is idempotent over every case in the table", () => {
    for (const c of CASES.normalizeText) {
        const opts = { uppercase: c.uppercase === true };
        const once = normalizeText(c.input, opts);
        const twice = normalizeText(once.value, opts);
        assert.equal(twice.value, once.value, `not idempotent: ${c.name}`);
        assert.equal(twice.changed, false, `second pass still changed: ${c.name}`);
        assert.equal(twice.coerced, false);
    }
});

test("normalizeForColumn is idempotent over every case in the table", () => {
    for (const c of CASES.normalizeForColumn) {
        const once = normalizeForColumn(c.column, c.input);
        const twice = normalizeForColumn(c.column, once.value);
        assert.deepEqual(twice.value, once.value, `not idempotent: ${c.name}`);
        assert.equal(twice.changed, false, `second pass still changed: ${c.name}`);
    }
});

// ---------------------------------------------------------------------------
// The measured folds this module exists to produce
// ---------------------------------------------------------------------------

test("the 7 measured spellings of PERUANA/PERUANO fold to 2 (03 §2.1)", () => {
    // Verbatim from 03-expected-output.md §2.1, with their row counts.
    const spellings = ["PERUANA", "Peruano", "PERUANO", "Peruana", "PERUANA ", "peruana", "PERUANO "];
    const folded = new Set(
        spellings.map(s => normalizeText(s, { uppercase: true }).value)
    );
    assert.equal(spellings.length, 7);
    assert.deepEqual([...folded].sort(), ["PERUANA", "PERUANO"]);
});

test("the whitespace variants of one contratista fold to one label", () => {
    // All measured in template.xlsx's pivot cache / ReporteConsolidado.xlsx. The
    // distinct count of this column drives Contratistas!C91, column U's weight and
    // every pivot filter list.
    const mcorp = ["MCORP SAC", "_x000d__x000a_MCORP SAC", " MCORP SAC ", "MCORP  SAC"];
    const folded = new Set(mcorp.map(s => normalizeText(s).value));
    assert.deepEqual([...folded], ["MCORP SAC"]);

    const clj = [" CLJ CONTRUCTORA SAC", "CLJ CONTRUCTORA SAC", "CLJ CONTRUCTORA SAC "];
    assert.deepEqual([...new Set(clj.map(s => normalizeText(s).value))], ["CLJ CONTRUCTORA SAC"]);
});

test("punctuation residue is NOT folded - it is Sheet1's job, not code's (03 §2.1)", () => {
    const acis = ["ACIS PROCESS S.A.C", "ACIS PROCESS S.A.C."];
    const folded = new Set(acis.map(s => normalizeText(s).value));
    assert.equal(folded.size, 2, "punctuation must survive normalization");
});

test("gender is NOT folded - PERUANO does not become PERUANA (03 §2.1)", () => {
    assert.equal(normalizeText("Peruano", { uppercase: true }).value, "PERUANO");
    assert.notEqual(
        normalizeText("Peruano", { uppercase: true }).value,
        normalizeText("Peruana", { uppercase: true }).value
    );
});

test("accents survive on data values - only headers are accent-folded", () => {
    // BREÑA is a real district; MIRELLES LOBATÓN is a real surname; folding either
    // would corrupt a compliance artefact.
    assert.equal(normalizeText("BREÑA ").value, "BREÑA");
    assert.equal(normalizeText("breña ", { uppercase: true }).value, "BREÑA");
    assert.equal(normalizeText(" LOBATÓN ", { uppercase: true }).value, "LOBATÓN");
    assert.equal(normalizeText("Ñ").value, "Ñ");
    assert.equal(normalizeText("ñ", { uppercase: true }).value, "Ñ");
});

test("uppercasing is locale-independent", () => {
    // toLocaleUpperCase on a tr-TR box maps "i" to "İ". This module must not.
    assert.equal(normalizeText("minicargador", { uppercase: true }).value, "MINICARGADOR");
    assert.equal(normalizeText("Iquitos", { uppercase: true }).value, "IQUITOS");
});

// ---------------------------------------------------------------------------
// CR/LF, the escaped forms, and the word-joining hazard
// ---------------------------------------------------------------------------

test("CR, LF and CRLF become a single space, never nothing", () => {
    const expected = "GM Y M GENERAL SOLUTIONS AND CONSULTING S.A.C";
    for (const sep of ["\r\n", "\n", "\r", "_x000d__x000a_", "_x000a_", "_x000d_", "_x000D__x000A_"]) {
        assert.equal(
            normalizeText(`GM Y M GENERAL SOLUTIONS${sep}AND CONSULTING S.A.C`).value,
            expected,
            `separator ${JSON.stringify(sep)} did not become a space`
        );
    }
});

test("all five C0 whitespace escapes are recognised, in either hex case", () => {
    for (const esc of ["_x0009_", "_x000a_", "_x000b_", "_x000c_", "_x000d_",
        "_x0009_".toUpperCase(), "_X000D_"]) {
        assert.equal(normalizeText(`A${esc}B`).value, "A B", `escape ${esc}`);
    }
});

test("a non-whitespace OOXML escape is left alone", () => {
    // A blanket /_x[0-9a-f]{4}_/ would eat this out of a company name.
    assert.equal(normalizeText("ACERO_x0041_ SAC").value, "ACERO_x0041_ SAC");
    assert.equal(normalizeText("ACERO_x0041_ SAC").changed, false);
    assert.equal(normalizeText("_x0020_").value, "_x0020_");
});

test("U+00A0 NBSP is collapsed - Excel TRIM never removes it (measured 48x in E)", () => {
    const nbsp = " ";
    assert.equal(normalizeText(`OPERARIO${nbsp}ELECTRICISTA`).value, "OPERARIO ELECTRICISTA");
    assert.equal(normalizeText(`RAMOS VEGA JOE${nbsp}`).value, "RAMOS VEGA JOE");
    assert.equal(normalizeText(`${nbsp}EMPLEADO /SUPERVISOR SST${nbsp}`).value, "EMPLEADO /SUPERVISOR SST");
    // The whole point: the NBSP form and the space form become ONE pivot label.
    assert.equal(
        normalizeText(`OPERARIO${nbsp}ELECTRICISTA`).value,
        normalizeText("OPERARIO ELECTRICISTA").value
    );
});

test("the DISTRITO case Excel TRIM cannot fix (Zona de Influencia / BUG-29)", () => {
    // VLOOKUP(TRIM(distrito), Hoja1!$A$2:$B$61, 2, FALSE): Excel's TRIM strips only
    // leading/trailing space, so a doubled internal space misses the exact match and
    // the worker resolves to "No" while still counting toward headcount.
    assert.equal(normalizeText("CERCADO DE  LIMA").value, "CERCADO DE LIMA");
    assert.equal(normalizeText("SAN JUAN DE  MIRAFLORES").value, "SAN JUAN DE MIRAFLORES");
    assert.equal(normalizeText("STA  ANITA").value, "STA ANITA");
    assert.equal(normalizeText("\nSAN MARTIN DE PORRES").value, "SAN MARTIN DE PORRES");
});

// ---------------------------------------------------------------------------
// Non-string inputs
// ---------------------------------------------------------------------------

test("null and undefined pass through as null with no issue", () => {
    for (const raw of [null, undefined]) {
        const r = normalizeText(raw);
        assert.equal(r.value, null);
        assert.equal(r.changed, false);
        assert.equal(r.coerced, false);
    }
});

test("finite numbers are stringified without being flagged as normalized", () => {
    // The 643-row header-shift block puts the RUC 20101155588 into APELLIDOS Y NOMBRES
    // (03 §2.3). It must arrive as text, not as a number, and `coerced` must say so.
    const r = normalizeText(20101155588, { uppercase: true });
    assert.equal(r.value, "20101155588");
    assert.equal(r.changed, false, "a plain coercion is not a whitespace collapse");
    assert.equal(r.coerced, true);

    assert.equal(normalizeText(0).value, "0");
    assert.equal(normalizeText(-1.5).value, "-1.5");
    assert.equal(normalizeText(176).value, "176");
});

test("non-finite numbers become null rather than the string NaN", () => {
    for (const raw of [NaN, Infinity, -Infinity]) {
        const r = normalizeText(raw);
        assert.equal(r.value, null);
        assert.equal(r.coerced, true, "the caller must still see that something arrived");
    }
});

test("booleans and bigints are stringified", () => {
    assert.equal(normalizeText(true).value, "true");
    assert.equal(normalizeText(false).value, "false");
    assert.equal(normalizeText(20101155588n).value, "20101155588");
});

test("a Date is stringified deterministically, never via toString()", () => {
    // Date#toString() is timezone- and locale-dependent; the whole point of the rework
    // is that nothing depends on the environment.
    const r = normalizeText(new Date(Date.UTC(1994, 6, 4)));
    assert.equal(r.value, "1994-07-04T00:00:00.000Z");
    assert.equal(r.coerced, true);
    assert.equal(normalizeText(new Date(NaN)).value, null);
});

test("values with no text form become null and are still marked coerced", () => {
    for (const raw of [{}, [], () => {}, Symbol("x")]) {
        const r = normalizeText(raw);
        assert.equal(r.value, null);
        assert.equal(r.coerced, true, "never silently dropped - the caller holds the raw value");
    }
});

test("value is never undefined and never the empty string", () => {
    for (const raw of [null, undefined, "", "   ", " ", "\t\n", "_x000d_", {}, NaN, "ATE"]) {
        const r = normalizeText(raw);
        assert.ok(r.value === null || (typeof r.value === "string" && r.value.length > 0),
            `bad value for ${JSON.stringify(String(raw))}`);
    }
});

// ---------------------------------------------------------------------------
// Column wiring
// ---------------------------------------------------------------------------

test("NORMALIZED_COLUMNS is exactly TEXT_COLUMNS + UPPERCASE_COLUMNS", () => {
    const expected = new Set([...TEXT_COLUMNS, ...UPPERCASE_COLUMNS]);
    assert.equal(NORMALIZED_COLUMNS.length, expected.size, "no duplicates");
    assert.deepEqual(new Set(NORMALIZED_COLUMNS), expected);
    // NACIONALIDAD is uppercase-only: it is not in TEXT_COLUMNS but must be normalized.
    assert.ok(NORMALIZED_COLUMNS.includes("NACIONALIDAD"));
    assert.ok(!TEXT_COLUMNS.includes("NACIONALIDAD"));
});

test("every normalized column is a real canonical column", () => {
    for (const c of NORMALIZED_COLUMNS) assert.ok(CANONICAL.includes(c), c);
});

test("only APELLIDOS Y NOMBRES and NACIONALIDAD are uppercased", () => {
    const upper = CANONICAL.filter(isUppercaseColumn);
    assert.deepEqual(upper, ["APELLIDOS Y NOMBRES", "NACIONALIDAD"]);
    // DISTRITO stays as written: VLOOKUP is case-insensitive and the business owns the
    // vocabulary (03 §2.2). This assertion exists so the omission reads as deliberate.
    assert.equal(isUppercaseColumn("DISTRITO SEGÚN DNI"), false);
    assert.equal(isUppercaseColumn("CONTRATISTA PRNCIPAL"), false);
    assert.equal(isUppercaseColumn("EMPRESA"), false);
});

test("dates, codes and identifiers are not this module's business", () => {
    for (const c of [...DATE_COLUMNS, ...CODED_COLUMNS, "RUC", "Nro. DNI / CE", "HPT"]) {
        assert.equal(isNormalizedColumn(c), false, c);
        const r = normalizeForColumn(c, "  raw  ");
        assert.equal(r.value, "  raw  ", `${c} must pass through untouched`);
        assert.equal(r.applied, false);
        assert.equal(r.changed, false);
    }
});

test("a pass-through column still never emits undefined", () => {
    assert.equal(normalizeForColumn("RUC", undefined).value, null);
    assert.equal(normalizeForColumn("HPT", undefined).value, null);
    assert.equal(normalizeForColumn("EMPRESA", undefined).value, null);
});

test("an unknown column name passes through rather than throwing", () => {
    const r = normalizeForColumn("NO SUCH COLUMN", "  x  ");
    assert.equal(r.applied, false);
    assert.equal(r.value, "  x  ");
});

test("normalizeForColumn covers every column it claims to", () => {
    for (const c of NORMALIZED_COLUMNS) {
        const r = normalizeForColumn(c, "  A  B  ");
        assert.equal(r.applied, true, c);
        assert.equal(r.changed, true, c);
        assert.equal(r.value, "A B", c);
    }
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

test("normalizeText does not mutate its options object", () => {
    const opts = { uppercase: true };
    normalizeText("peruana", opts);
    assert.deepEqual(opts, { uppercase: true });
});

test("normalizeText is stable across repeated calls (no regex lastIndex leak)", () => {
    // /g regexes are stateful under .test()/.exec(); this proves .replace() usage is not.
    const input = "A_x000d_B_x000a_C  D ";
    const first = normalizeText(input).value;
    for (let i = 0; i < 5; i++) assert.equal(normalizeText(input).value, first);
    assert.equal(first, "A B C D");
});

test("omitting the options argument means uppercase:false", () => {
    assert.equal(normalizeText(" Santa Anita ").value, "Santa Anita");
    assert.equal(normalizeText(" Santa Anita ", {}).value, "Santa Anita");
    assert.equal(normalizeText(" Santa Anita ", { uppercase: false }).value, "Santa Anita");
});

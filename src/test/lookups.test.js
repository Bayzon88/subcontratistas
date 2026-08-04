"use strict";
/**
 * pipeline/lookups.js against the REAL template.
 *
 * Every count asserted here was measured on src/template.xlsx and is quoted in
 * rework-plan/02-shortcomings.md BUG-29 and 03-expected-output.md §2.2. When Phase 4
 * task 7 cleans the table in template-v2.xlsx, the defect assertions below are what
 * proves the clean-up happened - so they are expected to change, deliberately, once.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../config");
const { IssueList, SEVERITY, CODE } = require("../pipeline/issues");
const {
    readLookups,
    reportLookupDefects,
    clearLookupCache,
    normalizeKey,
    excelTrim,
    TABLES,
    ZONA_DEFAULT,
    EPC_DEFAULT,
} = require("../pipeline/lookups");

const TEMPLATE = config.TEMPLATE_LEGACY;
const CASES = require("./cases/lookups.json");

const LOOKUPS = readLookups(TEMPLATE);

/** casos address the tables by name; map that to the exported LookupTable. */
function tableFor(name) {
    return {
        zona: LOOKUPS.zonaByDistrito,
        epc: LOOKUPS.epcByContratista,
        nombre: LOOKUPS.nombreComercial,
    }[name];
}

/* ------------------------------------------------------- the tables exist */

test("the template used by the tests is the real 3.7 MB legacy template", () => {
    assert.ok(fs.existsSync(TEMPLATE), `missing ${TEMPLATE}`);
    assert.ok(fs.statSync(TEMPLATE).size > 3_000_000);
});

test("readLookups returns the three tables plus the raw record", () => {
    assert.deepEqual(
        Object.keys(LOOKUPS).sort(),
        ["epcByContratista", "nombreComercial", "raw", "zonaByDistrito"],
    );
    assert.equal(LOOKUPS.raw.templatePath, path.resolve(TEMPLATE));
    for (const name of ["zona", "epc", "nombre"]) {
        assert.equal(LOOKUPS.raw[name].missing, false, `${name} table not found`);
    }
});

/* --------------------------------------------- Hoja1!A2:B61 - distrito -> zona */

test("zona table geometry matches Hoja1!A2:B61 as measured", () => {
    const z = LOOKUPS.raw.zona;
    assert.equal(z.sheet, "Hoja1");
    assert.equal(z.range, "A2:B61");
    assert.equal(z.slots, 60, "60 slots in the VLOOKUP range");
    assert.equal(z.populated, 56, "56 populated rows (28-31 are empty)");
    assert.equal(z.header, null, "the zona table has no header row");
    assert.equal(z.defaultValue, ZONA_DEFAULT);
    assert.equal(LOOKUPS.zonaByDistrito.size, 38, "38 distinct normalized keys");
});

test("zona resolves onto exactly the 7 zones plus the 'No' sentinel", () => {
    // 03-expected-output.md §2.2. SAN LUIS keeps its trailing space on purpose: the value
    // is returned verbatim so JS metrics agree cell-for-cell with the Excel formula.
    assert.deepEqual(
        LOOKUPS.zonaByDistrito.values().slice().sort(),
        ["ATE", "BREÑA", "CALLAO", "EL AGUSTINO", "LA VICTORIA", "SAN LUIS ", "SANTA ANITA"],
    );
    assert.equal(LOOKUPS.zonaByDistrito.get("NO EXISTE", ZONA_DEFAULT), "No");
});

/* ------------------------------------------------ Hoja1!L5:M9 - contratista -> EPC */

test("epc table is 4 entries behind a header row at L5/M5", () => {
    const e = LOOKUPS.raw.epc;
    assert.equal(e.range, "L5:M9");
    assert.equal(e.populated, 4, "4 EPC suppliers");
    assert.deepEqual(e.header, { fila: 5, clave: "CONTRATISTA PRNCIPAL", valor: "CONSORCIO" });
    assert.equal(e.defaultValue, EPC_DEFAULT);
    assert.equal(LOOKUPS.epcByContratista.size, 4);
    assert.deepEqual(LOOKUPS.epcByContratista.values(), ["EPC"]);
});

/* -------------------------------------------- Sheet1!A:B - razon -> nombre comercial */

test("nombre comercial table is 82 data rows behind a header, 80 of them keyed", () => {
    const n = LOOKUPS.raw.nombre;
    assert.equal(n.sheet, "Sheet1");
    assert.equal(n.range, "A1:B83");
    assert.equal(n.populated, 82, "83 rows minus the header");
    assert.deepEqual(n.header, { fila: 1, clave: "Razon Social", valor: "Nombre Comercial" });
    assert.equal(n.defects.blankKeys.length, 2, "Sheet1 rows 31 and 77 have no Razon Social");
    assert.equal(LOOKUPS.nombreComercial.size, 80, "82 rows - 2 without a key");
});

/* ------------------------------------------------------------- BUG-29 defects */

test("BUG-29: 14 padded keys + 1 doubled-internal-space key needed normalization", () => {
    const d = LOOKUPS.raw.zona.defects;
    assert.equal(d.paddedKeys.length, 14, "14 keys with leading/trailing whitespace");
    assert.deepEqual(
        d.paddedKeys.map(r => r.fila),
        [8, 12, 13, 14, 16, 23, 32, 35, 42, 45, 50, 52, 53, 61],
    );
    assert.equal(d.internalWhitespaceKeys.length, 1);
    assert.equal(d.internalWhitespaceKeys[0].fila, 47);
    assert.equal(d.internalWhitespaceKeys[0].clave, "CERCADO DE  LIMA");
    assert.equal(d.keysNormalized, 15, "the total our Map silently repaired");
});

test("BUG-29: exactly two padded keys are stranded - both real Callao districts", () => {
    const d = LOOKUPS.raw.zona.defects;
    assert.equal(d.strandedKeys.length, 2);
    assert.deepEqual(
        d.strandedKeys.map(r => [r.fila, r.clave, r.valor]),
        [
            [14, "CARMEN DE LA LEGUA -REYNOSO ", "CALLAO"],
            [50, " LA PERLA CALLAO", "CALLAO"],
        ],
    );
    // The other 13 whitespace-defective keys have a reachable twin, which is why BUG-29
    // is MEDIUM and not HIGH.
    assert.equal(d.unreachableKeys.length - d.strandedKeys.length, 13);
});

test("both stranded keys resolve through our normalized Map", () => {
    // The live template returns "No" for these two. That is the whole point of the defect.
    assert.equal(LOOKUPS.zonaByDistrito.get("CARMEN DE LA LEGUA -REYNOSO", ZONA_DEFAULT), "CALLAO");
    assert.equal(LOOKUPS.zonaByDistrito.get("LA PERLA CALLAO", ZONA_DEFAULT), "CALLAO");
    // ...and so does the padded input form, which is what the workers actually type.
    assert.equal(LOOKUPS.zonaByDistrito.get(" la perla  callao ", ZONA_DEFAULT), "CALLAO");
});

test("BUG-29: the SAN LUIS value carries a trailing space and is NOT silently fixed", () => {
    const d = LOOKUPS.raw.zona.defects;
    assert.equal(d.paddedValues.length, 2, "Hoja1!B60 and B61");
    assert.deepEqual(d.paddedValues.map(r => r.fila), [60, 61]);
    assert.deepEqual(new Set(d.paddedValues.map(r => r.valor)), new Set(["SAN LUIS "]));
    assert.equal(LOOKUPS.zonaByDistrito.get("SAN LUIS", ZONA_DEFAULT), "SAN LUIS ");
});

test("deliberate twins are not reported as duplicates; genuine collisions are zero", () => {
    const d = LOOKUPS.raw.zona.defects;
    assert.equal(d.collisions.length, 0, "no normalized key maps to two different zones");
    // Twins differing only by case/accent/padding are by design - VLOOKUP is
    // case-insensitive - so they are counted, not flagged.
    assert.equal(d.twinRows, 18, "56 rows collapse onto 38 distinct keys");
    assert.equal(d.exactDuplicateKeys.length, 5, "5 byte-identical repeated keys (BUG-29)");
    // The twins the brief names explicitly.
    assert.equal(LOOKUPS.zonaByDistrito.get("AGUSTINO", ZONA_DEFAULT), "EL AGUSTINO");
    assert.equal(LOOKUPS.zonaByDistrito.get("EL AGUSTINO", ZONA_DEFAULT), "EL AGUSTINO");
    assert.equal(LOOKUPS.zonaByDistrito.get("ATE VITARTE", ZONA_DEFAULT), "ATE");
    assert.equal(LOOKUPS.zonaByDistrito.get("ATE", ZONA_DEFAULT), "ATE");
});

test("epc and nombre have no key collisions either", () => {
    assert.equal(LOOKUPS.raw.epc.defects.collisions.length, 0);
    assert.equal(LOOKUPS.raw.nombre.defects.collisions.length, 0);
});

/* -------------------------------------------------------------- the case table */

test("committed case table", async (t) => {
    assert.ok(CASES.casos.length >= 25, "the case table must cover all three tables");
    for (const c of CASES.casos) {
        await t.test(`${c.tabla}: ${JSON.stringify(c.input)} -> ${JSON.stringify(c.expected)}`, () => {
            const table = tableFor(c.tabla);
            assert.ok(table, `unknown tabla ${c.tabla}`);
            assert.equal(table.get(c.input, c.fallback), c.expected, c.nota);
            if (c.expectedIssue) {
                const list = LOOKUPS.raw[c.tabla].defects[c.expectedIssue];
                assert.ok(Array.isArray(list) && list.length > 0,
                    `case claims defect ${c.expectedIssue} on ${c.tabla} but none was recorded`);
            }
        });
    }
});

/* -------------------------------------------------------------- lookup semantics */

test("get falls through to the CALLER's default, not to a baked-in sentinel", () => {
    assert.equal(LOOKUPS.zonaByDistrito.get("SURQUILLO"), null, "no fallback given -> null");
    assert.equal(LOOKUPS.zonaByDistrito.get("SURQUILLO", "No"), "No");
    assert.equal(LOOKUPS.zonaByDistrito.get("SURQUILLO", "FUERA"), "FUERA");
    assert.equal(LOOKUPS.epcByContratista.get("EMPRESA X SAC", EPC_DEFAULT), "CJV");
    assert.equal(LOOKUPS.epcByContratista.get("2A TECH SCRL", EPC_DEFAULT), "EPC");
});

test("blank, null and undefined lookups return the fallback rather than a hit", () => {
    for (const v of [undefined, null, "", "   ", "\r\n"]) {
        assert.equal(LOOKUPS.zonaByDistrito.get(v, ZONA_DEFAULT), "No");
        assert.equal(LOOKUPS.zonaByDistrito.has(v), false);
    }
});

test("has() agrees with get()", () => {
    assert.equal(LOOKUPS.zonaByDistrito.has("ate "), true);
    assert.equal(LOOKUPS.zonaByDistrito.has("SURQUILLO"), false);
});

test("normalizeKey is the columns.js rule, and excelTrim is Excel's", () => {
    assert.equal(normalizeKey("  cercado   de  lima "), "CERCADO DE LIMA");
    assert.equal(normalizeKey("BREÑA"), "BRENA", "accent-folded");
    assert.equal(excelTrim("  cercado   de  lima "), "cercado de lima", "no case folding");
    assert.equal(excelTrim("BREÑA"), "BREÑA", "no accent folding - Excel does not fold");
});

/* ------------------------------------------------------------------- caching */

test("the parsed result is cached per path and invalidated by mtime", () => {
    const again = readLookups(TEMPLATE);
    assert.equal(again, LOOKUPS, "same path + same mtime -> the identical object");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lookups-cache-"));
    const copy = path.join(dir, "template.xlsx");
    try {
        fs.copyFileSync(TEMPLATE, copy);
        const a = readLookups(copy);
        assert.equal(readLookups(copy), a, "cached");
        assert.equal(a.raw.zona.populated, 56, "a copy parses identically");
        assert.notEqual(a, LOOKUPS, "a different path is a different cache entry");

        // Bump mtime by a day; the cache key must change. Explicit Date argument only -
        // nothing in the pipeline may read the wall clock.
        const future = new Date("2030-01-01T00:00:00Z");
        fs.utimesSync(copy, future, future);
        const b = readLookups(copy);
        assert.notEqual(b, a, "mtime change invalidates the cache entry");
        assert.equal(b.raw.zona.populated, a.raw.zona.populated);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }

    clearLookupCache();
    const fresh = readLookups(TEMPLATE);
    assert.notEqual(fresh, LOOKUPS, "clearLookupCache forces a reparse");
    assert.deepEqual(fresh.raw.zona.defects.strandedKeys, LOOKUPS.raw.zona.defects.strandedKeys);
});

test("a missing template is an I/O failure, not a silent empty table", () => {
    assert.throws(() => readLookups(path.join(os.tmpdir(), "no-such-template-9f2a.xlsx")),
        /ENOENT/);
});

/* ---------------------------------------------------- defects reach the run report */

test("reportLookupDefects surfaces the defects on an IssueList", () => {
    const issues = new IssueList();
    reportLookupDefects(readLookups(TEMPLATE), issues);

    const stranded = issues.items.filter(i => /inalcanzable/.test(i.message));
    assert.equal(stranded.length, 2, "one WARNING per stranded key");
    assert.deepEqual(stranded.map(i => i.celda), ["A14", "A50"]);
    for (const i of stranded) {
        assert.equal(i.severity, SEVERITY.WARNING);
        assert.equal(i.code, CODE.TEXT_NORMALIZED);
        assert.equal(i.hoja, "Hoja1");
    }

    const normalized = issues.items.filter(
        i => i.severity === SEVERITY.INFO && /normalizacion de espacios/.test(i.message));
    assert.equal(normalized.length, 2, "zona and nombre both have whitespace-defective keys");
    assert.match(normalized[0].message, /^15 claves de Zona de Influencia/);

    const paddedValues = issues.items.filter(i => /espacio sobrante/.test(i.message));
    assert.equal(paddedValues.length, 6, "2 on Hoja1 (SAN LUIS) + 4 on Sheet1");

    assert.equal(issues.byCode(CODE.HEADER_DUPLICATE).length, 0, "no collisions to report");
    assert.equal(issues.hasBlockingIssues(), false, "none of this blocks a run");
});

/* --------------------------------------------- the tables must not live in JS */

test("the lookup tables are not hard-coded in the module source", () => {
    // 05-implementation-plan.md §5: the business owns these tables in Excel. A future edit
    // that pastes a district list into JS moves that ownership, and this catches it.
    const src = fs.readFileSync(path.join(__dirname, "..", "pipeline", "lookups.js"), "utf8");
    for (const forbidden of [
        "EL AGUSTINO", "SANTA ANITA", "LA VICTORIA", "BELLAVISTA", "VENTANILLA",
        "2A TECH", "A2 TECH", "PROSEGURIDAD", "RESGUARDO", "SOCIAL CAPITAL",
    ]) {
        assert.ok(!src.includes(forbidden), `lookups.js hard-codes ${forbidden}`);
    }
    // The geometry, by contrast, IS the module's job and must be declared.
    assert.equal(TABLES.zona.sheet, "Hoja1");
    assert.equal(TABLES.nombre.sheet, "Sheet1");
});

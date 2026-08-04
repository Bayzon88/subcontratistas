"use strict";
/**
 * Tests for src/output/computed.js - the five JS-computed columns of Option D
 * (05-implementation-plan.md §5 / Phase 4 task 3, 03-expected-output.md §5, §6).
 *
 * Two things are being defended here.
 *
 * 1. THE LITERAL STRINGS. Six pivots page-filter on `BajasAntiguas`, two on `Altas`, one
 *    on `Bajas2`, and the front-page age table takes `Rango Edades` as its row axis. A
 *    one-character difference in any of those does not raise an error - it empties a pivot
 *    row on the client's copy. So the labels are asserted against the strings actually
 *    present in `src/template.xlsx` (`xl/tables/table1.xml` +
 *    `xl/pivotCache/pivotCacheDefinition1.xml`), not against this file's own constants.
 *
 * 2. DETERMINISM. The whole phase exists because `TODAY()-30` made a delivered report
 *    unreproducible. `mock.timers` moves the system clock by years between two identical
 *    calls; the outputs must be byte-identical.
 */

const test = require("node:test");
const { mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const XLSX = require("xlsx");

const {
    computeRow,
    computeEdad,
    computeRangoEdades,
    computeAltas,
    computeBajas2,
    computeBajasAntiguas,
    edadAlCierre,
    completedYears,
    unparseableDatesFromIssues,
    excelTextEquals,
    COMPUTED_COLUMNS,
    COMPUTED_COLUMN_NAMES,
    LITERALS,
    RANGO_EDADES,
    RANGO_LABELS,
    EDAD_MIN,
    EDAD_MAX,
    COL_NACIMIENTO,
    COL_CESE,
    COL_INICIO,
} = require("../output/computed.js");

const { parsePeriod } = require("../pipeline/period.js");
const { dateToSerial } = require("../pipeline/dates.js");
const { CODE, SEVERITY, IssueList } = require("../pipeline/issues.js");

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const FEB = parsePeriod("2026-02");        // 2026-02-01 .. 2026-02-28, etiqueta "2-2026"
const DIC = parsePeriod("2024-12");        // a December, to catch year-boundary mistakes

/** {y,m,d} -> serial, failing loudly rather than feeding null into an assertion. */
function s(y, m, d) {
    const serial = dateToSerial(y, m, d);
    assert.ok(Number.isInteger(serial), `fixture date ${y}-${m}-${d} is not representable`);
    return serial;
}

/** A record with only the three date columns that matter; the rest is irrelevant here. */
function rec({ nacimiento = null, inicio = null, cese = null } = {}) {
    return {
        [COL_NACIMIENTO]: nacimiento,
        [COL_CESE]: cese,
        [COL_INICIO]: inicio,
    };
}

/* ------------------------------------------------------------------ *
 * 1. The literals, read back out of the template
 * ------------------------------------------------------------------ */

const TEMPLATE = path.join(__dirname, "..", "template.xlsx");

test("literals match src/template.xlsx", async t => {
    if (!fs.existsSync(TEMPLATE)) {
        t.skip("src/template.xlsx not present");
        return;
    }
    const AdmZip = require("adm-zip");
    const zip = new AdmZip(TEMPLATE);
    const tableXml = zip.readAsText("xl/tables/table1.xml");
    const cacheXml = zip.readAsText("xl/pivotCache/pivotCacheDefinition1.xml");
    assert.ok(tableXml && cacheXml, "template is missing table1.xml or pivotCacheDefinition1.xml");

    await t.test("the five column names and ids match <tableColumn>", () => {
        for (const col of COMPUTED_COLUMNS) {
            const re = new RegExp(`<tableColumn[^>]*\\bid="${col.tableColumnId}"[^>]*\\bname="([^"]*)"`);
            const m = re.exec(tableXml);
            assert.ok(m, `no <tableColumn id="${col.tableColumnId}"> in table1.xml`);
            assert.equal(m[1], col.name, `tableColumn id=${col.tableColumnId} is not ${col.name}`);
        }
    });

    await t.test("the five columns sit at V, W, AG, AH, AI", () => {
        // <tableColumn> order IS the sheet column order; A is index 0.
        const order = [...tableXml.matchAll(/<tableColumn\b[^>]*\bname="([^"]*)"/g)].map(m => m[1]);
        assert.equal(order.length, 35, "expected 35 tableColumns (A..AI)");
        for (const col of COMPUTED_COLUMNS) {
            assert.equal(order.indexOf(col.name), col.index0,
                `${col.name} is not at column ${col.letter} (index ${col.index0})`);
        }
    });

    await t.test("Rango Edades labels are byte-identical to the template's formula", () => {
        const m = /<tableColumn[^>]*name="Rango Edades"[^>]*>([\s\S]*?)<\/tableColumn>/.exec(tableXml);
        assert.ok(m, "no Rango Edades tableColumn");
        const formula = m[1];
        for (const label of RANGO_LABELS) {
            assert.ok(formula.includes(`"${label}"`), `template formula does not contain "${label}"`);
        }
        // ...and nothing else. Six quoted strings, six labels.
        const quoted = [...formula.matchAll(/"([^"]*)"/g)].map(q => q[1]).filter(q => q !== "");
        assert.deepEqual([...new Set(quoted)].sort(), [...RANGO_LABELS].sort(),
            "the template's Rango Edades formula emits a label this module does not know");
    });

    await t.test("the pivot cache carries exactly these Rango Edades items", () => {
        const m = /<cacheField[^>]*name="Rango Edades"[^>]*>([\s\S]*?)<\/cacheField>/.exec(cacheXml);
        assert.ok(m, "no Rango Edades cacheField");
        const items = [...m[1].matchAll(/<s v="([^"]*)"/g)].map(q => q[1]);
        assert.deepEqual(items, [...RANGO_LABELS],
            "pivot row labels differ from RANGO_LABELS - a changed label creates a new pivot row");
    });

    await t.test("Corregir / No Aplica / Borrar / Si / No come from the template", () => {
        const edad = /<tableColumn[^>]*name="Edad"[^>]*>([\s\S]*?)<\/tableColumn>/.exec(tableXml)[1];
        assert.ok(edad.includes(`"${LITERALS.CORREGIR}"`), "Edad guard literal changed");

        const altas = /<tableColumn[^>]*name="Altas"[^>]*>([\s\S]*?)<\/tableColumn>/.exec(tableXml)[1];
        assert.ok(altas.includes(`"${LITERALS.NO_APLICA}"`), "Altas else-branch literal changed");

        const bajas = /<tableColumn[^>]*name="Bajas2"[^>]*>([\s\S]*?)<\/tableColumn>/.exec(tableXml)[1];
        assert.ok(bajas.includes(`"${LITERALS.BORRAR}"`), "Bajas2 else-branch literal changed");

        const ag = /<tableColumn[^>]*name="BajasAntiguas"[^>]*>([\s\S]*?)<\/tableColumn>/.exec(tableXml)[1];
        assert.ok(ag.includes(`"${LITERALS.SI}"`) && ag.includes(`"${LITERALS.NO}"`),
            "BajasAntiguas literals changed");
        // The trap this whole module is written around: the template compares against
        // LOWERCASE "borrar" while Bajas2 emits "Borrar".
        assert.ok(ag.includes('="borrar"'),
            "BajasAntiguas no longer compares against lowercase \"borrar\" - re-check excelTextEquals");

        const cache = cacheXml;
        for (const lit of [LITERALS.NO_APLICA, LITERALS.BORRAR, LITERALS.SI, LITERALS.NO, LITERALS.CORREGIR]) {
            assert.ok(cache.includes(`<s v="${lit}"/>`), `pivot cache has no item "${lit}"`);
        }
    });

    await t.test("the period label has the template's <M>-<YYYY> shape", () => {
        // MONTH(...)&"-"&YEAR(...) is unpadded: "2-2026", never "02-2026".
        const m = /<cacheField[^>]*name="Altas"[^>]*>([\s\S]*?)<\/cacheField>/.exec(cacheXml);
        const items = [...m[1].matchAll(/<s v="([^"]*)"/g)].map(q => q[1])
            .filter(v => v !== LITERALS.NO_APLICA);
        assert.ok(items.length > 0, "no period labels in the Altas cache field");
        for (const it of items) assert.match(it, /^\d{1,2}-\d{4}$/);
        assert.match(FEB.etiqueta, /^\d{1,2}-\d{4}$/);
        assert.equal(FEB.etiqueta, "2-2026");
        assert.equal(DIC.etiqueta, "12-2024");
    });
});

/* ------------------------------------------------------------------ *
 * 2. V - Edad
 * ------------------------------------------------------------------ */

test("Edad is computed at the period end, never at 'today'", async t => {
    await t.test("a worker turning 24 on the last day of the period is 24", () => {
        // 2026-02-28 is the last day of the period; born 2002-02-28 -> 24 that very day.
        assert.equal(computeEdad(s(2002, 2, 28), FEB), 24);
        assert.equal(computeRangoEdades(computeEdad(s(2002, 2, 28), FEB)), "24 - 31");
    });

    await t.test("one day later and they are still 23 at the close", () => {
        assert.equal(computeEdad(s(2002, 3, 1), FEB), 23);
        assert.equal(computeRangoEdades(computeEdad(s(2002, 3, 1), FEB)), "18 - 23");
    });

    await t.test("the day before the birthday does not round up", () => {
        assert.equal(computeEdad(s(2002, 2, 27), FEB), 24);   // turned 24 yesterday
        assert.equal(computeEdad(s(2002, 3, 31), FEB), 23);   // birthday still a month out
    });

    await t.test("whole-year arithmetic, not /365 - leap years must not drift", () => {
        // Born 1994-03-01, period ends 2026-02-28: DATEDIF says 31 (birthday not reached).
        // (finSerial - birth)/365 = 11687/365 = 32.02 -> ROUNDDOWN 32, a bucket change.
        const born = s(1994, 3, 1);
        assert.equal(computeEdad(born, FEB), 31);
        assert.equal(Math.floor((FEB.finSerial - born) / 365), 32,
            "the /365 form no longer disagrees - the regression this test guards is gone");
        assert.equal(computeRangoEdades(computeEdad(born, FEB)), "24 - 31");
    });

    await t.test("29 February birthdays land on 28 February", () => {
        // Excel: DATEDIF(2000-02-29, 2026-02-28, "Y") = 25.
        assert.equal(computeEdad(s(2000, 2, 29), FEB), 25);
        assert.equal(completedYears(s(2000, 2, 29), s(2026, 3, 1)), 26);
    });

    await t.test("December periods do not borrow a year", () => {
        assert.equal(computeEdad(s(1990, 12, 31), DIC), 34);   // turns 34 on the last day
        assert.equal(computeEdad(s(1991, 1, 1), DIC), 33);
    });

    await t.test("edadAlCierre returns the raw number, ungated", () => {
        assert.equal(edadAlCierre(s(2010, 1, 1), FEB), 16);    // below the guard
        assert.equal(edadAlCierre(s(1930, 1, 1), FEB), 96);    // above the guard
        assert.equal(edadAlCierre(null, FEB), null);
    });
});

test("Edad guards: <18 and >80 both yield the literal 'Corregir'", async t => {
    await t.test("the lower guard, on both sides of the boundary", () => {
        assert.equal(EDAD_MIN, 18);
        assert.equal(computeEdad(s(2008, 2, 28), FEB), 18);                  // exactly 18 -> ok
        assert.equal(computeEdad(s(2008, 3, 1), FEB), LITERALS.CORREGIR);    // 17
        assert.equal(computeEdad(s(2009, 2, 28), FEB), LITERALS.CORREGIR);   // 17
        assert.equal(computeEdad(s(2010, 6, 1), FEB), LITERALS.CORREGIR);    // 15
    });

    await t.test("the upper guard, on both sides of the boundary", () => {
        assert.equal(EDAD_MAX, 80);
        assert.equal(computeEdad(s(1946, 2, 28), FEB), 80);                  // exactly 80 -> ok
        assert.equal(computeEdad(s(1945, 2, 28), FEB), LITERALS.CORREGIR);   // 81
        assert.equal(computeEdad(s(1900, 1, 2), FEB), LITERALS.CORREGIR);    // 126
    });

    await t.test("a birth date after the period end is negative, therefore Corregir", () => {
        assert.equal(computeEdad(s(2027, 5, 1), FEB), LITERALS.CORREGIR);
    });

    await t.test("'Corregir' is exactly the string Validar Edad tests for", () => {
        // template-v2's X reads +IF([Edad]="Corregir","Corregir","Ok").
        assert.equal(LITERALS.CORREGIR, "Corregir");
        assert.equal(computeEdad(s(2009, 2, 28), FEB), "Corregir");
    });
});

test("a missing or unusable birth date is 'Sin Fecha', never #VALUE! (BUG-07)", () => {
    for (const bad of [null, undefined, "", "  ", "3/5/65", NaN, {}, [], 0.5]) {
        const v = computeEdad(bad, FEB);
        assert.equal(v, LITERALS.SIN_FECHA, `computeEdad(${JSON.stringify(bad)})`);
        assert.equal(computeRangoEdades(v), LITERALS.SIN_FECHA);
    }
    assert.equal(LITERALS.SIN_FECHA, "Sin Fecha");
});

/* ------------------------------------------------------------------ *
 * 3. W - Rango Edades
 * ------------------------------------------------------------------ */

test("Rango Edades: every bucket boundary", async t => {
    await t.test("the six labels, in pivot order", () => {
        assert.deepEqual([...RANGO_LABELS],
            ["18 - 23", "24 - 31", "32 - 40", "41 - 49", "50 - 58", "59 +"]);
    });

    await t.test("min and max of every bucket, plus the value either side", () => {
        for (let i = 0; i < RANGO_EDADES.length; i++) {
            const b = RANGO_EDADES[i];
            assert.equal(computeRangoEdades(b.min), b.label, `${b.label}: min ${b.min}`);
            if (Number.isFinite(b.max)) {
                assert.equal(computeRangoEdades(b.max), b.label, `${b.label}: max ${b.max}`);
                // max+1 belongs to the NEXT bucket, with no gap.
                const next = RANGO_EDADES[i + 1];
                assert.ok(next, `${b.label} has a finite max but no successor`);
                assert.equal(next.min, b.max + 1, `gap between ${b.label} and ${next.label}`);
                assert.equal(computeRangoEdades(b.max + 1), next.label);
            }
            if (i > 0) {
                assert.equal(computeRangoEdades(b.min - 1), RANGO_EDADES[i - 1].label,
                    `${b.label}: min-1 should fall back to the previous bucket`);
            }
        }
    });

    await t.test("every age in the guarded range maps to exactly one label", () => {
        for (let age = EDAD_MIN; age <= EDAD_MAX; age++) {
            const label = computeRangoEdades(age);
            assert.ok(RANGO_LABELS.includes(label), `age ${age} produced ${JSON.stringify(label)}`);
            const matches = RANGO_EDADES.filter(b => age >= b.min && age <= b.max);
            assert.equal(matches.length, 1, `age ${age} matches ${matches.length} buckets`);
        }
    });

    await t.test("the open-ended bucket really is open-ended", () => {
        assert.equal(computeRangoEdades(59), "59 +");
        assert.equal(computeRangoEdades(80), "59 +");
        assert.equal(computeRangoEdades(120), "59 +");
    });

    await t.test("the no-date case is explicit, and never a bucket", () => {
        assert.equal(computeRangoEdades(LITERALS.SIN_FECHA), LITERALS.SIN_FECHA);
        assert.equal(computeRangoEdades(null), LITERALS.SIN_FECHA);
        assert.equal(computeRangoEdades(undefined), LITERALS.SIN_FECHA);
        assert.equal(computeRangoEdades(NaN), LITERALS.SIN_FECHA);
    });

    await t.test("'Corregir' propagates instead of hiding in '59 +' (template divergence)", () => {
        assert.equal(computeRangoEdades(LITERALS.CORREGIR), LITERALS.CORREGIR);
        // A 16-year-old: the template's unguarded W would print "59 +".
        const teen = computeEdad(s(2009, 6, 1), FEB);
        assert.equal(teen, LITERALS.CORREGIR);
        assert.equal(computeRangoEdades(teen), LITERALS.CORREGIR);
        assert.notEqual(computeRangoEdades(teen), "59 +");
    });

    await t.test("never emits undefined, NaN or an empty string", () => {
        for (const v of [null, undefined, NaN, "", "x", -5, 0, 17, 17.5, 81, Infinity, -Infinity]) {
            const out = computeRangoEdades(v);
            assert.equal(typeof out, "string");
            assert.notEqual(out, "");
            assert.notEqual(out, "undefined");
            assert.notEqual(out, "NaN");
        }
    });
});

/* ------------------------------------------------------------------ *
 * 4. AI - Altas
 * ------------------------------------------------------------------ */

test("Altas: the period edges, one day in and one day out", async t => {
    await t.test("the first day of the period is an Alta", () => {
        assert.equal(computeAltas(s(2026, 2, 1), FEB), "2-2026");
        assert.equal(computeAltas(s(2026, 2, 1), FEB), FEB.etiqueta);
    });
    await t.test("the day before the period is not", () => {
        assert.equal(computeAltas(s(2026, 1, 31), FEB), LITERALS.NO_APLICA);
    });
    await t.test("the last day of the period is an Alta", () => {
        assert.equal(computeAltas(s(2026, 2, 28), FEB), FEB.etiqueta);
    });
    await t.test("the day after the period is not", () => {
        assert.equal(computeAltas(s(2026, 3, 1), FEB), LITERALS.NO_APLICA);
    });
    await t.test("December: the year boundary is not off by one", () => {
        assert.equal(computeAltas(s(2024, 12, 1), DIC), "12-2024");
        assert.equal(computeAltas(s(2024, 12, 31), DIC), "12-2024");
        assert.equal(computeAltas(s(2024, 11, 30), DIC), LITERALS.NO_APLICA);
        assert.equal(computeAltas(s(2025, 1, 1), DIC), LITERALS.NO_APLICA);
    });
    await t.test("the same month in another year is NOT an Alta", () => {
        // The template compares MONTH() and YEAR(); a month-only comparison would pass here.
        assert.equal(computeAltas(s(2025, 2, 14), FEB), LITERALS.NO_APLICA);
        assert.equal(computeAltas(s(2027, 2, 14), FEB), LITERALS.NO_APLICA);
    });
    await t.test("no start date -> No Aplica", () => {
        assert.equal(computeAltas(null, FEB), LITERALS.NO_APLICA);
        assert.equal(computeAltas(undefined, FEB), LITERALS.NO_APLICA);
        assert.equal(computeAltas("", FEB), LITERALS.NO_APLICA);
    });
    await t.test("an unreadable start date is 'Revisar', not swallowed (BUG-08)", () => {
        assert.equal(computeAltas(null, FEB, { unusable: true }), LITERALS.REVISAR);
        assert.equal(computeAltas("30/1/26", FEB), LITERALS.REVISAR);
        assert.equal(computeAltas(NaN, FEB), LITERALS.REVISAR);
        assert.notEqual(computeAltas(null, FEB, { unusable: true }), LITERALS.NO_APLICA);
    });
});

/* ------------------------------------------------------------------ *
 * 5. AH - Bajas2
 * ------------------------------------------------------------------ */

test("Bajas2: three-way, with 'Borrar' where Altas has 'No Aplica'", async t => {
    await t.test("no cese -> No Aplica (the worker is still employed)", () => {
        assert.equal(computeBajas2(null, FEB), LITERALS.NO_APLICA);
        assert.equal(computeBajas2(undefined, FEB), LITERALS.NO_APLICA);
        assert.equal(computeBajas2("", FEB), LITERALS.NO_APLICA);
    });
    await t.test("cese inside the period -> the period label", () => {
        assert.equal(computeBajas2(s(2026, 2, 1), FEB), FEB.etiqueta);
        assert.equal(computeBajas2(s(2026, 2, 15), FEB), "2-2026");
        assert.equal(computeBajas2(s(2026, 2, 28), FEB), FEB.etiqueta);
    });
    await t.test("one day outside, on both edges -> Borrar", () => {
        assert.equal(computeBajas2(s(2026, 1, 31), FEB), LITERALS.BORRAR);
        assert.equal(computeBajas2(s(2026, 3, 1), FEB), LITERALS.BORRAR);
    });
    await t.test("the else branch is Borrar and NOT No Aplica - they are different columns", () => {
        assert.notEqual(LITERALS.BORRAR, LITERALS.NO_APLICA);
        assert.equal(computeBajas2(s(2025, 6, 1), FEB), LITERALS.BORRAR);
        assert.equal(computeAltas(s(2025, 6, 1), FEB), LITERALS.NO_APLICA);
    });
    await t.test("December year boundary", () => {
        assert.equal(computeBajas2(s(2024, 12, 31), DIC), "12-2024");
        assert.equal(computeBajas2(s(2025, 1, 1), DIC), LITERALS.BORRAR);
    });
    await t.test("an unreadable cese is 'Revisar', not 'still employed' (BUG-08)", () => {
        assert.equal(computeBajas2(null, FEB, { unusable: true }), LITERALS.REVISAR);
        assert.equal(computeBajas2("ACTIVO", FEB), LITERALS.REVISAR);
        assert.equal(computeBajas2("-", FEB), LITERALS.REVISAR);
    });
});

/* ------------------------------------------------------------------ *
 * 6. AG - BajasAntiguas, and the case trap
 * ------------------------------------------------------------------ */

test("BajasAntiguas: the 'Borrar' vs 'borrar' case trap", async t => {
    await t.test("the template's lowercase literal still matches our capitalised one", () => {
        // IF(AND([Bajas2]="borrar",[Altas]="No Aplica"),"Si","No") - Excel's = is
        // case-insensitive, JavaScript's === is not. A naive port makes every row "No".
        assert.equal(computeBajasAntiguas("Borrar", "No Aplica"), "Si");
        assert.equal(computeBajasAntiguas(LITERALS.BORRAR, LITERALS.NO_APLICA), LITERALS.SI);
        assert.notEqual(LITERALS.BORRAR, "borrar", "the trap is only real while AH emits 'Borrar'");
    });

    await t.test("every casing Excel would accept", () => {
        for (const b of ["Borrar", "borrar", "BORRAR", "BoRrAr"]) {
            for (const a of ["No Aplica", "no aplica", "NO APLICA", "No aplica"]) {
                assert.equal(computeBajasAntiguas(b, a), LITERALS.SI, `${b} / ${a}`);
            }
        }
    });

    await t.test("excelTextEquals is case-insensitive and type-safe", () => {
        assert.equal(excelTextEquals("Borrar", "borrar"), true);
        assert.equal(excelTextEquals("No Aplica", "no aplica"), true);
        assert.equal(excelTextEquals("Borrar", "Borra"), false);
        assert.equal(excelTextEquals(null, "borrar"), false);
        assert.equal(excelTextEquals(undefined, undefined), true);
        assert.equal(excelTextEquals(5, 5), true);
        assert.equal(excelTextEquals("2-2026", "2-2026"), true);
    });

    await t.test("both conditions are required", () => {
        assert.equal(computeBajasAntiguas("Borrar", "2-2026"), LITERALS.NO);   // joined this period
        assert.equal(computeBajasAntiguas("No Aplica", "No Aplica"), LITERALS.NO);
        assert.equal(computeBajasAntiguas("2-2026", "No Aplica"), LITERALS.NO); // ceased this period
        assert.equal(computeBajasAntiguas("Revisar", "No Aplica"), LITERALS.NO);
    });

    await t.test("only ever 'Si' or 'No' - six pivots filter on exactly these", () => {
        const seen = new Set();
        for (const b of [null, undefined, "", "Borrar", "borrar", "No Aplica", "Revisar", "2-2026", 5]) {
            for (const a of [null, undefined, "", "No Aplica", "no aplica", "Revisar", "2-2026"]) {
                seen.add(computeBajasAntiguas(b, a));
            }
        }
        assert.deepEqual([...seen].sort(), ["No", "Si"]);
    });
});

/* ------------------------------------------------------------------ *
 * 7. computeRow - the whole row
 * ------------------------------------------------------------------ */

test("computeRow returns exactly the five columns, keyed by tableColumn name", async t => {
    await t.test("the key set", () => {
        const out = computeRow(rec(), FEB, null);
        assert.deepEqual(Object.keys(out), [...COMPUTED_COLUMN_NAMES]);
        assert.deepEqual([...COMPUTED_COLUMN_NAMES],
            ["Edad", "Rango Edades", "BajasAntiguas", "Bajas2", "Altas"]);
    });

    await t.test("a normal active worker who joined this period", () => {
        const out = computeRow(rec({ nacimiento: s(1990, 5, 20), inicio: s(2026, 2, 10) }), FEB, null);
        assert.deepEqual(out, {
            "Edad": 35,
            "Rango Edades": "32 - 40",
            "BajasAntiguas": "No",
            "Bajas2": "No Aplica",
            "Altas": "2-2026",
        });
    });

    await t.test("a stale carry-over: ceased in an earlier period, did not rejoin", () => {
        const out = computeRow(rec({
            nacimiento: s(1975, 1, 2), inicio: s(2023, 4, 1), cese: s(2025, 9, 30),
        }), FEB, null);
        assert.equal(out["Bajas2"], "Borrar");
        assert.equal(out["Altas"], "No Aplica");
        assert.equal(out["BajasAntiguas"], "Si");   // the trap, end to end
        assert.equal(out["Edad"], 51);
        assert.equal(out["Rango Edades"], "50 - 58");
    });

    await t.test("a Baja of this period stays in the headcount", () => {
        const out = computeRow(rec({
            nacimiento: s(1988, 8, 8), inicio: s(2024, 1, 15), cese: s(2026, 2, 20),
        }), FEB, null);
        assert.equal(out["Bajas2"], "2-2026");
        assert.equal(out["BajasAntiguas"], "No");
    });

    await t.test("missing dates in every column at once", () => {
        const out = computeRow(rec(), FEB, null);
        assert.deepEqual(out, {
            "Edad": "Sin Fecha",
            "Rango Edades": "Sin Fecha",
            "BajasAntiguas": "No",
            "Bajas2": "No Aplica",
            "Altas": "No Aplica",
        });
    });

    await t.test("an entirely absent record does not throw and writes no undefined", () => {
        for (const input of [undefined, null, {}]) {
            const out = computeRow(input, FEB, null);
            for (const [k, v] of Object.entries(out)) {
                assert.notEqual(v, undefined, `${k} is undefined`);
                assert.notEqual(v, "undefined", `${k} is the string "undefined"`);
                assert.ok(typeof v !== "number" || Number.isFinite(v), `${k} is not finite`);
            }
        }
    });

    await t.test("one missing date at a time never poisons the others", () => {
        const full = { nacimiento: s(1990, 5, 20), inicio: s(2026, 2, 10), cese: s(2026, 2, 25) };
        for (const drop of ["nacimiento", "inicio", "cese"]) {
            const out = computeRow(rec({ ...full, [drop]: null }), FEB, null);
            for (const [k, v] of Object.entries(out)) {
                assert.notEqual(v, undefined, `${k} after dropping ${drop}`);
                assert.notEqual(v, "", `${k} after dropping ${drop}`);
                assert.ok(!Number.isNaN(v), `${k} is NaN after dropping ${drop}`);
            }
            if (drop === "nacimiento") {
                assert.equal(out["Edad"], "Sin Fecha");
                assert.equal(out["Altas"], "2-2026");        // unaffected
                assert.equal(out["Bajas2"], "2-2026");       // unaffected
            }
            if (drop === "inicio") assert.equal(out["Altas"], "No Aplica");
            if (drop === "cese") assert.equal(out["Bajas2"], "No Aplica");
        }
    });

    await t.test("the result is frozen - nothing downstream can mutate a pivot label", () => {
        const out = computeRow(rec(), FEB, null);
        assert.ok(Object.isFrozen(out));
    });

    await t.test("the lookups argument is accepted and ignored", () => {
        const a = computeRow(rec({ nacimiento: s(1990, 5, 20) }), FEB);
        const b = computeRow(rec({ nacimiento: s(1990, 5, 20) }), FEB, {
            zonaByDistrito: new Map([["ATE", "Si"]]), epcByContratista: new Map(), nombreComercial: new Map(),
        });
        assert.deepEqual(a, b);
    });

    await t.test("a missing or malformed period is a caller bug and throws", () => {
        assert.throws(() => computeRow(rec(), undefined), TypeError);
        assert.throws(() => computeRow(rec(), null), TypeError);
        assert.throws(() => computeRow(rec(), { etiqueta: "2-2026" }), TypeError);
        assert.throws(() => computeRow(rec(), { inicioSerial: 1, finSerial: 2 }), TypeError);
        assert.throws(() => computeEdad(s(1990, 1, 1), {}), TypeError);
    });
});

/* ------------------------------------------------------------------ *
 * 8. The unparseable-date signal
 * ------------------------------------------------------------------ */

test("unparseableDatesFromIssues threads BUG-08 through computeRow", async t => {
    await t.test("collects the date codes only, by canonical column", () => {
        const issues = new IssueList();
        issues.error({
            code: CODE.DATE_UNPARSEABLE, message: "x", columna: COL_INICIO, valor: "30/1/26",
        });
        issues.warning({
            code: CODE.DATE_IMPLAUSIBLE, message: "x", columna: COL_CESE, valor: "01/01/1899",
        });
        issues.warning({ code: CODE.DNI_LENGTH, message: "x", columna: "Nro. DNI / CE" });
        const set = unparseableDatesFromIssues(issues.items);
        assert.deepEqual([...set].sort(), [COL_CESE, COL_INICIO].sort());
        // an IssueList works too
        assert.deepEqual([...unparseableDatesFromIssues(issues)].sort(), [COL_CESE, COL_INICIO].sort());
    });

    await t.test("empty / absent input is an empty set, not a throw", () => {
        for (const input of [undefined, null, [], {}, { items: [] }]) {
            assert.equal(unparseableDatesFromIssues(input).size, 0);
        }
    });

    await t.test("with the signal, an unreadable date is visible; without it, it is not", () => {
        const r = rec();   // both dates nulled by dates.js
        const blind = computeRow(r, FEB, null);
        assert.equal(blind["Altas"], "No Aplica");
        assert.equal(blind["Bajas2"], "No Aplica");

        const seeing = computeRow(r, FEB, null, {
            unparseableDates: new Set([COL_INICIO, COL_CESE]),
        });
        assert.equal(seeing["Altas"], LITERALS.REVISAR);
        assert.equal(seeing["Bajas2"], LITERALS.REVISAR);
        assert.equal(seeing["BajasAntiguas"], "No");
    });

    await t.test("the signal accepts a Set, an array or an object map", () => {
        const r = rec();
        const expected = LITERALS.REVISAR;
        assert.equal(computeRow(r, FEB, null, { unparseableDates: [COL_INICIO] })["Altas"], expected);
        assert.equal(computeRow(r, FEB, null, { unparseableDates: new Set([COL_INICIO]) })["Altas"], expected);
        assert.equal(computeRow(r, FEB, null, { unparseableDates: { [COL_INICIO]: true } })["Altas"], expected);
        assert.equal(computeRow(r, FEB, null, { unparseableDates: { [COL_INICIO]: false } })["Altas"],
            LITERALS.NO_APLICA);
    });

    await t.test("the signal only affects the column it names", () => {
        const out = computeRow(rec({ cese: s(2026, 2, 10) }), FEB, null, {
            unparseableDates: [COL_INICIO],
        });
        assert.equal(out["Altas"], LITERALS.REVISAR);
        assert.equal(out["Bajas2"], "2-2026");
    });
});

/* ------------------------------------------------------------------ *
 * 9. Determinism - the reason this module exists
 * ------------------------------------------------------------------ */

test("determinism: the system clock cannot influence a single value", async t => {
    /** Joined during the period, with an older cese: Altas fires, so AG must stay "No". */
    const record = rec({
        nacimiento: s(1994, 3, 1),
        inicio: s(2026, 2, 14),
        cese: s(2025, 11, 30),
    });
    /** Never rejoined, ceased in an earlier period: the "Si" path - the one that evicts a
     *  worker from all six headcount pivots, and therefore the one that must not move. */
    const antigua = rec({
        nacimiento: s(1970, 7, 4),
        inicio: s(2023, 5, 10),
        cese: s(2025, 11, 30),
    });

    /** Compute a row with the process clock pinned to `iso`. */
    function underClock(iso, row = record) {
        mock.timers.enable({ apis: ["Date"], now: new Date(iso).getTime() });
        try {
            // Prove the mock really took, so a green test cannot come from a no-op mock.
            assert.equal(new Date().toISOString().slice(0, 10), iso.slice(0, 10));
            return computeRow(row, parsePeriod("2026-02"), null, {
                unparseableDates: [],
            });
        } finally {
            mock.timers.reset();
        }
    }

    await t.test("March 2026 and August 2031 produce identical output", () => {
        const a = underClock("2026-03-04T12:21:00.000Z");   // FEBRERO_2026's real refresh date
        const b = underClock("2031-08-02T23:59:59.000Z");   // five years later
        const c = underClock("1999-01-01T00:00:00.000Z");   // and before the period
        assert.deepEqual(a, b);
        assert.deepEqual(a, c);
        assert.deepEqual(a, {
            "Edad": 31,
            "Rango Edades": "24 - 31",
            "BajasAntiguas": "No",     // Altas is not "No Aplica", so AG cannot be "Si"
            "Bajas2": "Borrar",
            "Altas": "2-2026",
        });
    });

    await t.test("BajasAntiguas = 'Si' does not flip with the clock either", () => {
        // BUG-15: reopening FEBRERO_2026 later flips BajasAntiguas to "Si" for everyone
        // with a cese date, evicting them from every headcount pivot. Pin it.
        const a = underClock("2026-03-04T12:21:00.000Z", antigua);
        const b = underClock("2031-08-02T23:59:59.000Z", antigua);
        assert.deepEqual(a, b);
        assert.deepEqual(a, {
            "Edad": 55,
            "Rango Edades": "50 - 58",
            "BajasAntiguas": "Si",
            "Bajas2": "Borrar",
            "Altas": "No Aplica",
        });
    });

    await t.test("TODAY()-30 semantics are gone: the period alone decides", () => {
        // Under the old formula, a run on 2026-03-04 classified against February by
        // accident (TODAY()-30 = 2026-02-02) and a run on 2026-03-31 did not.
        const late = underClock("2026-03-31T00:00:00.000Z");
        const early = underClock("2026-03-01T00:00:00.000Z");
        assert.equal(late["Altas"], "2-2026");
        assert.deepEqual(late, early);
    });

    await t.test("the module source reads no clock at all", () => {
        const src = fs.readFileSync(path.join(__dirname, "..", "output", "computed.js"), "utf8");
        const code = src
            .replace(/\/\*[\s\S]*?\*\//g, "")     // block comments (they discuss TODAY())
            .replace(/^\s*\/\/.*$/gm, "");        // line comments
        assert.doesNotMatch(code, /Date\.now\s*\(/, "Date.now() in computed.js");
        assert.doesNotMatch(code, /new\s+Date\s*\(\s*\)/, "new Date() with no argument");
        assert.doesNotMatch(code, /\bperformance\.now\b/, "performance.now() in computed.js");
        assert.doesNotMatch(code, /TODAY\s*\(\s*\)/, "a TODAY() formula survived in computed.js");
    });

    await t.test("repeated calls are pure - same input, same output, no shared state", () => {
        const p = parsePeriod("2026-02");
        const first = computeRow(record, p, null);
        for (let i = 0; i < 50; i++) assert.deepEqual(computeRow(record, p, null), first);
        // and the record was not mutated
        assert.deepEqual(record, rec({
            nacimiento: s(1994, 3, 1), inicio: s(2026, 2, 14), cese: s(2025, 11, 30),
        }));
    });

    await t.test("the same record against a different period gives different, stable output", () => {
        const feb = computeRow(record, parsePeriod("2026-02"), null);
        const nov = computeRow(record, parsePeriod("2025-11"), null);
        assert.equal(feb["Altas"], "2-2026");
        assert.equal(nov["Altas"], "No Aplica");
        assert.equal(nov["Bajas2"], "11-2025");
        assert.equal(nov["BajasAntiguas"], "No");
        assert.equal(feb["Edad"], 31);
        assert.equal(nov["Edad"], 31);
        assert.deepEqual(nov, computeRow(record, parsePeriod("2025-11"), null));
    });
});

/* ------------------------------------------------------------------ *
 * 10. Cell-safety invariants over a wide sweep
 * ------------------------------------------------------------------ */

test("no cell can ever receive NaN, '', 'undefined' or an error", () => {
    const serials = [
        null, undefined, "", " ", "-", "ACTIVO", "04/07/1994", NaN, Infinity, -1, 0, 0.5,
        s(1900, 1, 1), s(1946, 2, 28), s(1990, 5, 20), s(2008, 2, 28), s(2009, 3, 1),
        s(2026, 1, 31), s(2026, 2, 1), s(2026, 2, 28), s(2026, 3, 1), s(2030, 1, 1),
    ];
    const allowedStrings = new Set([
        ...RANGO_LABELS, LITERALS.CORREGIR, LITERALS.SIN_FECHA, LITERALS.NO_APLICA,
        LITERALS.BORRAR, LITERALS.REVISAR, LITERALS.SI, LITERALS.NO, FEB.etiqueta,
    ]);

    let rows = 0;
    for (const nacimiento of serials) {
        for (const inicio of serials) {
            for (const cese of serials) {
                const out = computeRow(rec({ nacimiento, inicio, cese }), FEB, null);
                rows++;
                for (const [k, v] of Object.entries(out)) {
                    if (typeof v === "number") {
                        assert.ok(Number.isInteger(v) && v >= EDAD_MIN && v <= EDAD_MAX,
                            `${k} = ${v} is not an integer age in [${EDAD_MIN}, ${EDAD_MAX}]`);
                        assert.equal(k, "Edad", "only Edad may be numeric");
                        continue;
                    }
                    assert.equal(typeof v, "string", `${k} is ${typeof v}`);
                    assert.ok(allowedStrings.has(v), `${k} emitted the unknown literal ${JSON.stringify(v)}`);
                }
            }
        }
    }
    assert.equal(rows, serials.length ** 3);
});

/* ------------------------------------------------------------------ *
 * 11. Cross-check the age arithmetic against Excel's own date code
 * ------------------------------------------------------------------ */

test("completedYears agrees with Excel's serial arithmetic on a full sweep", () => {
    // Walk every day of a four-year window (two leap years) and check the age never
    // decreases, only ever steps by 1, and steps exactly on the birthday - the property
    // the /365 form violates.
    const born = s(1994, 3, 1);
    let previous = null;
    let steps = 0;
    for (let serial = s(2024, 1, 1); serial <= s(2028, 1, 1); serial++) {
        const age = completedYears(born, serial);
        assert.ok(Number.isInteger(age));
        if (previous !== null) {
            assert.ok(age === previous || age === previous + 1, `age jumped ${previous} -> ${age}`);
            if (age !== previous) {
                steps++;
                const d = XLSX.SSF.parse_date_code(serial);
                assert.equal(d.m, 3, "the age stepped on a day that is not the birthday month");
                assert.equal(d.d, 1, "the age stepped on a day that is not the birthday");
            }
        }
        previous = age;
    }
    assert.equal(steps, 4, "expected exactly four birthdays in the window");
});

test("SEVERITY/CODE imports are the real ones (guards a copy-pasted constant)", () => {
    assert.equal(SEVERITY.ERROR, "ERROR");
    assert.equal(CODE.DATE_UNPARSEABLE, "DATE_UNPARSEABLE");
    assert.equal(CODE.DATE_IMPLAUSIBLE, "DATE_IMPLAUSIBLE");
});

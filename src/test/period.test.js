"use strict";
/**
 * Tests for src/pipeline/period.js - the root of the determinism fix
 * (03-expected-output.md §6, 05-implementation-plan.md Phase 4 task 1).
 *
 * The case table in cases/period.json is generated from Date.UTC arithmetic and
 * cross-checked against XLSX.SSF.parse_date_code; this file re-runs that
 * cross-check so a wrong serial cannot pass by agreeing with itself.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const XLSX = require("xlsx");

const {
    MESES,
    PERIOD_ERROR,
    PeriodError,
    parsePeriod,
    previousMonth,
    containsSerial,
    toExcelSerial,
    daysInMonth,
    isLeapYear,
} = require("../pipeline/period.js");

const CASES = require("./cases/period.json");

/** Assert that `fn` throws a PeriodError carrying `code`. */
function assertPeriodError(fn, code, label) {
    let thrown = null;
    try {
        fn();
    } catch (err) {
        thrown = err;
    }
    assert.ok(thrown, `${label}: expected a throw, got none`);
    assert.ok(thrown instanceof PeriodError, `${label}: expected PeriodError, got ${thrown && thrown.name}`);
    assert.equal(thrown.code, code, `${label}: wrong code (message was ${JSON.stringify(thrown.message)})`);
    assert.ok(thrown.message.length > 0, `${label}: empty message`);
}

test("cases/period.json - every valid period matches the table field for field", () => {
    for (const c of CASES.valid) {
        const got = parsePeriod(c.input);
        for (const [field, want] of Object.entries(c.expected)) {
            assert.deepEqual(got[field], want, `${c.input} (${c.note}) -> ${field}`);
        }
    }
    assert.ok(CASES.valid.length >= 20, "case table shrank unexpectedly");
});

test("serials round-trip through XLSX.SSF.parse_date_code", () => {
    // The independent oracle: SheetJS's own 1900-system decoder, which already
    // encodes the phantom 1900-02-29 (03-expected-output.md §3.6).
    for (const c of CASES.valid) {
        const p = parsePeriod(c.input);

        const inicio = XLSX.SSF.parse_date_code(p.inicioSerial);
        assert.deepEqual(
            { y: inicio.y, m: inicio.m, d: inicio.d },
            { y: p.year, m: p.month, d: 1 },
            `${c.input}: inicioSerial ${p.inicioSerial} decodes wrong`);

        const fin = XLSX.SSF.parse_date_code(p.finSerial);
        assert.deepEqual(
            { y: fin.y, m: fin.m, d: fin.d },
            { y: p.year, m: p.month, d: p.diasEnMes },
            `${c.input}: finSerial ${p.finSerial} decodes wrong`);

        assert.equal(p.finSerial - p.inicioSerial, p.diasEnMes - 1,
            `${c.input}: serial span must equal the month length`);
        // The day after fin is the first of the next month - no gap, no overlap.
        // Except once in history: finSerial for 1900-02 is 59 and serial 60 is
        // Excel's phantom 29 February, asserted separately below.
        if (p.finSerial >= 61) {
            const next = XLSX.SSF.parse_date_code(p.finSerial + 1);
            assert.equal(next.d, 1, `${c.input}: finSerial+1 must be the 1st`);
        }
    }
});

test("Excel's phantom 1900-02-29 is reproduced, not corrected", () => {
    // Serial 1 = 1900-01-01, serial 60 = the day that never existed, 61 = 1900-03-01.
    // Getting this wrong shifts every date before March 1900 by one day and, worse,
    // makes a blank coerced to 0 look like plausible data instead of an error.
    assert.equal(toExcelSerial(1900, 1, 1), 1);
    assert.equal(toExcelSerial(1900, 2, 28), 59);
    assert.equal(toExcelSerial(1900, 3, 1), 61);
    assert.equal(XLSX.SSF.parse_date_code(60).d, 29, "SSF still models the phantom day");
    // 1900 is not a leap year in the real calendar, whatever Excel counts.
    assert.equal(isLeapYear(1900), false);
    assert.equal(daysInMonth(1900, 2), 28);
    assert.equal(parsePeriod("1900-02").fin, "1900-02-28");
});

test("known-good serials from the corpus", () => {
    // 45689 was read back from XLSX.SSF for 2025-02-01; 45566.3537 is the
    // refreshedDate stamped in every generated pivot cache (1 October 2024).
    assert.equal(toExcelSerial(2025, 2, 1), 45689);
    assert.equal(toExcelSerial(2024, 10, 1), 45566);
    assert.equal(parsePeriod("2024-09").finSerial + 1, 45566,
        "the stale pivot cache was refreshed the day after the 2024-09 period ended");
});

test("etiqueta is the template's own label format: <M>-<YYYY>, no zero padding", () => {
    // Verified against the pivot page filters: pivotTable7/pivotTable3 carry a
    // literal "9-2024" (BUG-17) and DICIEMBRE_2025 carries "11-2025" (BUG-16).
    assert.equal(parsePeriod("2024-09").etiqueta, "9-2024");
    assert.equal(parsePeriod("2025-11").etiqueta, "11-2025");
    assert.equal(parsePeriod("2026-02").etiqueta, "2-2026");
    assert.equal(parsePeriod("2025-12").etiqueta, "12-2025");
    for (let m = 1; m <= 12; m++) {
        assert.equal(parsePeriod(`2026-${String(m).padStart(2, "0")}`).etiqueta, `${m}-2026`);
    }
});

test("the DICIEMBRE_2025 divergence: 2025-11 is named NOVIEMBRE and labelled 11-2025", () => {
    // The archived file was refreshed 2025-12-30 and its Altas page filter reads
    // "11-2025" while its name says DICIEMBRE. One period object now produces both,
    // so the two cannot disagree again (03-expected-output.md §6.2).
    const p = parsePeriod("2025-11");
    assert.equal(p.etiqueta, "11-2025");
    assert.equal(p.mesNombre, "NOVIEMBRE");
    assert.equal(p.filename, "Reporte_Subcontratistas_NOVIEMBRE_2025.xlsx");
    assert.equal(p.filenameBase, "Reporte_Subcontratistas_NOVIEMBRE_2025");
    assert.equal(`${p.filenameBase}.json`, "Reporte_Subcontratistas_NOVIEMBRE_2025.json");
    // And the December period is a different object entirely.
    assert.notEqual(parsePeriod("2025-12").filename, p.filename);
});

test("month names come from the table, not from toLocaleString", () => {
    // getMonthAndYear() used toLocaleString('es-ES') and then compared the result to
    // "DICIEMBRE" as a year predicate; on a small-ICU build that comparison is dead
    // code. The names here are data, so no ICU build can change them.
    assert.equal(MESES.length, 12);
    assert.deepEqual(MESES.slice(0, 3), ["ENERO", "FEBRERO", "MARZO"]);
    assert.equal(MESES[11], "DICIEMBRE");
    assert.equal(parsePeriod("2026-09").mesNombre, "SEPTIEMBRE");
    for (let m = 1; m <= 12; m++) {
        const p = parsePeriod(`2026-${String(m).padStart(2, "0")}`);
        assert.equal(p.mesNombre, MESES[m - 1]);
        assert.equal(p.filename, `Reporte_Subcontratistas_${MESES[m - 1]}_2026.xlsx`);
        assert.equal(p.mesNombre, p.mesNombre.toUpperCase(), "month names are uppercase");
        assert.ok(/^[A-Z]+$/.test(p.mesNombre), "no accents in the archive filenames");
    }
});

test("leap Februaries", () => {
    assert.equal(parsePeriod("2024-02").fin, "2024-02-29");
    assert.equal(parsePeriod("2024-02").diasEnMes, 29);
    assert.equal(parsePeriod("2000-02").diasEnMes, 29, "2000 is a leap year (divisible by 400)");
    assert.equal(parsePeriod("1900-02").diasEnMes, 28, "1900 is not (divisible by 100, not 400)");
    assert.equal(parsePeriod("2025-02").diasEnMes, 28);
    assert.equal(parsePeriod("2100-02").diasEnMes, 28);
});

test("the descriptor is frozen and round-trips through its own key", () => {
    const p = parsePeriod("2026-02");
    assert.ok(Object.isFrozen(p));
    assert.throws(() => { "use strict"; p.year = 1999; }, TypeError);
    assert.deepEqual(parsePeriod(p.key), p, "parsePeriod(p.key) reproduces p exactly");
    // Two calls with the same input are indistinguishable - the determinism claim.
    assert.deepEqual(parsePeriod("2026-02"), parsePeriod(" 2026-02 "), "surrounding whitespace is trimmed");
});

test("cases/period.json - malformed and out-of-range periods throw", () => {
    for (const c of CASES.invalid) {
        assertPeriodError(() => parsePeriod(c.input), c.expectedIssue.code, `${JSON.stringify(c.input)} (${c.note})`);
    }
});

test("non-string periods throw rather than coercing", () => {
    for (const bad of [undefined, null, 202602, {}, [], new Date(2026, 1, 1), NaN, true]) {
        assertPeriodError(() => parsePeriod(bad), PERIOD_ERROR.PERIOD_MALFORMED, String(bad));
    }
});

test("cases/period.json - a future period is refused against an explicit today", () => {
    for (const c of CASES.future) {
        const label = `${c.input} vs ${c.today} (${c.note})`;
        if (c.expectedIssue) {
            assertPeriodError(() => parsePeriod(c.input, { today: c.today }), c.expectedIssue.code, label);
        } else {
            assert.equal(parsePeriod(c.input, { today: c.today }).key, c.input, label);
        }
    }
});

test("the future check accepts a Date and is skipped when today is omitted", () => {
    // Explicitly-constructed Date, never new Date() with no argument.
    const today = new Date(2026, 7, 2);  // 2 August 2026, local
    assert.equal(parsePeriod("2026-07", { today }).key, "2026-07");
    assert.equal(parsePeriod("2026-08", { today }).key, "2026-08", "the current month is allowed");
    assertPeriodError(() => parsePeriod("2026-09", { today }), PERIOD_ERROR.PERIOD_FUTURE, "next month");
    // Omitting today keeps parsePeriod pure: no clock, no refusal.
    assert.equal(parsePeriod("2099-12").key, "2099-12");
    assertPeriodError(() => parsePeriod("2026-09", { today: new Date("nope") }),
        PERIOD_ERROR.PERIOD_TODAY_INVALID, "Invalid Date");
    assertPeriodError(() => parsePeriod("2026-09", { today: 1754100000000 }),
        PERIOD_ERROR.PERIOD_TODAY_INVALID, "epoch millis are not accepted");
});

test("cases/period.json - previousMonth crosses the January boundary", () => {
    for (const c of CASES.previousMonth) {
        assert.equal(previousMonth(c.input), c.expected, `${c.input} (${c.note})`);
    }
    for (const c of CASES.previousMonthInvalid) {
        assertPeriodError(() => previousMonth(c.input), c.expectedIssue.code, `${JSON.stringify(c.input)} (${c.note})`);
    }
});

test("previousMonth takes the clock as a required argument", () => {
    assertPeriodError(() => previousMonth(), PERIOD_ERROR.PERIOD_TODAY_INVALID, "no argument");
    // The Date form, with locally-constructed dates so the assertion is TZ-independent.
    assert.equal(previousMonth(new Date(2026, 0, 1)), "2025-12");
    assert.equal(previousMonth(new Date(2026, 0, 31, 23, 59, 59)), "2025-12");
    assert.equal(previousMonth(new Date(2025, 11, 30, 18, 2)), "2025-11",
        "the DICIEMBRE_2025 run: refreshed 30 December 2025 18:02, period NOVIEMBRE");
    assert.equal(previousMonth(new Date(2026, 7, 2)), "2026-07");
    // Every month of a year, the wrap included.
    for (let m = 0; m < 12; m++) {
        const want = m === 0 ? "2025-12" : `2026-${String(m).padStart(2, "0")}`;
        assert.equal(previousMonth(new Date(2026, m, 15)), want);
    }
    // The default is a valid period, and it is never in the future.
    const today = new Date(2026, 0, 5);
    assert.equal(parsePeriod(previousMonth(today), { today }).key, "2025-12");
});

test("previousMonth is the only clock-shaped API, and it has no default", () => {
    // A regression guard on the defect itself: no call to Date.now() or to new Date()
    // with no argument may reappear in the module (05 §1 principle 3).
    const fs = require("node:fs");
    const src = fs.readFileSync(require.resolve("../pipeline/period.js"), "utf8");
    // Comments quote the defect verbatim, so strip them before grepping for it.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.equal(/new\s+Date\s*\(\s*\)/.test(code), false, "new Date() with no argument");
    assert.equal(/Date\.now\s*\(/.test(code), false, "Date.now()");
    assert.equal(/toLocaleString|toLocaleDateString|Intl\./.test(code), false, "locale-dependent month naming");
    assert.equal(/function previousMonth\(now\)/.test(code), true, "previousMonth(now) must have no default value");
});

test("containsSerial classifies Altas/Bajas without touching the clock", () => {
    const p = parsePeriod("2026-02");
    assert.equal(containsSerial(p, p.inicioSerial), true);
    assert.equal(containsSerial(p, p.finSerial), true);
    assert.equal(containsSerial(p, p.inicioSerial - 1), false, "31 January is not in February");
    assert.equal(containsSerial(p, p.finSerial + 1), false, "1 March is not in February");
    // 46235 = 2026-08-01, the future cese date sitting in FEBRERO_2026's detail block
    // (05 §8 Q6): accepted as a value, counted as a Baja only in its own period.
    assert.equal(XLSX.SSF.parse_date_code(46235).y, 2026);
    assert.equal(containsSerial(p, 46235), false);
    assert.equal(containsSerial(parsePeriod("2026-08"), 46235), true);
    // Never NaN, never a throw, for the values dates.js reports as unparseable.
    for (const bad of [null, undefined, NaN, "45689", Infinity, {}]) {
        assert.equal(containsSerial(p, bad), false, `containsSerial(${String(bad)})`);
    }
});

test("toExcelSerial agrees with SSF across a decade, day by day", () => {
    // Cheap brute force over the range the corpus actually contains: any off-by-one
    // in the leap-year or phantom-day handling shows up immediately.
    let checked = 0;
    for (let y = 2015; y <= 2030; y++) {
        for (let m = 1; m <= 12; m++) {
            for (let d = 1; d <= daysInMonth(y, m); d++) {
                const s = toExcelSerial(y, m, d);
                const back = XLSX.SSF.parse_date_code(s);
                assert.deepEqual({ y: back.y, m: back.m, d: back.d }, { y, m, d }, `serial ${s}`);
                checked++;
            }
        }
    }
    assert.equal(checked, 5844, "16 years including 4 leap days");
});

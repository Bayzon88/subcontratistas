"use strict";
/**
 * Tests for pipeline/dates.js.
 *
 * The bulk of the coverage is driven from cases/dates.json so the acceptance contract
 * (03-expected-output.md §3) is a committed data file rather than assertions buried in
 * code. Everything here is a real shape measured in src/ReporteConsolidado.xlsx or an
 * explicit line of the spec; nothing is a toy input.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const XLSX = require("xlsx");
const D = require("../pipeline/dates");
const { IssueList, CODE, SEVERITY } = require("../pipeline/issues");
const { DATE_COLUMNS } = require("../pipeline/columns");
const config = require("../config");

const CASES = JSON.parse(
    fs.readFileSync(path.join(__dirname, "cases", "dates.json"), "utf8")
).cases;

const DEFAULT_PERIOD = "2026-02-28"; // FEBRERO_2026, the last real run

/** Materialize input.raw, including the types JSON cannot express. */
function materialize(input) {
    switch (input.rawKind) {
        case "undefined": return undefined;
        case "nan": return NaN;
        case "invalidDate": return new Date(NaN);
        case "date": {
            const [y, m, d, H = 0, M = 0, S = 0] = input.raw;
            // Local constructor on purpose: SheetJS's cellDates:true builds local midnight.
            return new Date(y, m - 1, d, H, M, S);
        }
        default: return input.raw;
    }
}

/** Only the keys the case actually declares are asserted. */
function assertSubset(actual, expected, label) {
    for (const [k, v] of Object.entries(expected)) {
        assert.deepEqual(actual[k], v, `${label}: field "${k}"`);
    }
}

/* ------------------------------------------------------------------ *
 * The case table
 * ------------------------------------------------------------------ */

test("cases/dates.json - every record", async t => {
    assert.ok(CASES.length >= 60, "the case table must stay comprehensive");

    for (const c of CASES) {
        await t.test(c.name, () => {
            const issues = new IssueList();
            const opts = {
                period: c.input.period || DEFAULT_PERIOD,
                issues,
                location: { subcontratista: "ACME SAC", archivo: "acme.xlsx", hoja: "Cuadro", fila: 7, celda: "F7" },
            };
            if (c.input.date1904) opts.date1904 = true;
            if (c.input.config) opts.config = { ...config, ...c.input.config };

            const raw = materialize(c.input);
            const got = D.parseDateCell(raw, c.input.column, opts);

            assertSubset(got, c.expected, c.name);

            // Invariants that hold for every single call, no exceptions.
            assert.ok(got.serial === null || Number.isInteger(got.serial), "serial is an integer or null");
            assert.notEqual(got.serial, undefined);
            assert.ok(!Number.isNaN(got.serial), "serial is never NaN");
            assert.equal(got.ok, got.serial !== null, "ok iff a serial was produced");
            assert.ok(!(got.ok && got.empty), "ok and empty are mutually exclusive");

            // The issue list must match exactly - in code, in severity, and in count.
            assert.equal(
                issues.length, c.expectedIssue.length,
                `${c.name}: expected ${c.expectedIssue.length} issue(s), got ${JSON.stringify(issues.items.map(i => i.code))}`
            );
            c.expectedIssue.forEach((exp, i) => {
                const actual = issues.items[i];
                assert.equal(actual.code, exp.code, `${c.name}: issue ${i} code`);
                assert.equal(actual.severity, exp.severity, `${c.name}: issue ${i} severity`);
                if (exp.detalle) assertSubset(actual.detalle, exp.detalle, `${c.name}: issue ${i} detalle`);
                // Provenance must always survive so the Errores sheet can name the cell.
                assert.equal(actual.columna, c.input.column);
                assert.equal(actual.celda, "F7");
                assert.equal(actual.subcontratista, "ACME SAC");
            });
        });
    }
});

test("every rejection carries the RAW value verbatim, never a coerced one", () => {
    const issues = new IssueList();
    D.parseDateCell("09/10/205", "FECHA INICIO DE LABORES EN OBRA", { period: DEFAULT_PERIOD, issues });
    assert.equal(issues.items[0].valor, "09/10/205");

    const issues2 = new IssueList();
    D.parseDateCell(46235, "FECHA CESE/BAJA", { period: DEFAULT_PERIOD, issues: issues2 });
    assert.equal(issues2.items[0].valor, 46235);
    assert.equal(issues2.items[0].detalle.interpretada, "01/08/2026");
});

/* ------------------------------------------------------------------ *
 * serial <-> {y,m,d}
 * ------------------------------------------------------------------ */

test("serialToYMD matches XLSX.SSF.parse_date_code, including 1900-02-29", () => {
    assert.deepEqual(D.serialToYMD(1), { y: 1900, m: 1, d: 1 });
    assert.deepEqual(D.serialToYMD(59), { y: 1900, m: 2, d: 28 });
    // Excel's fictitious leap day. The naive Date.UTC(1899,11,30)+n*86400000 gives
    // 1900-03-01 here and is off by one for every serial <= 60.
    assert.deepEqual(D.serialToYMD(60), { y: 1900, m: 2, d: 29 });
    assert.deepEqual(D.serialToYMD(61), { y: 1900, m: 3, d: 1 });
    assert.deepEqual(D.serialToYMD(34519), { y: 1994, m: 7, d: 4 });
    assert.deepEqual(D.serialToYMD(D.MAX_SERIAL), { y: 9999, m: 12, d: 31 });
});

test("serialToYMD truncates the time component", () => {
    assert.deepEqual(D.serialToYMD(43139.791666666664), { y: 2018, m: 2, d: 8 });
    assert.deepEqual(D.serialToYMD(43139.833333333336), { y: 2018, m: 2, d: 8 });
    assert.deepEqual(D.serialToYMD(43139.999999), { y: 2018, m: 2, d: 8 });
});

test("serialToYMD returns null outside Excel's range, never a 1899 date", () => {
    for (const bad of [0, 0.5, -1, -34519, D.MAX_SERIAL + 1, NaN, Infinity, "34519", null, undefined]) {
        assert.equal(D.serialToYMD(bad), null, `serialToYMD(${String(bad)})`);
    }
});

test("dateToSerial is the exact inverse of parse_date_code across the 1900 system", () => {
    const failures = [];
    for (let s = 1; s <= 5000; s++) {
        const back = D.dateToSerial(D.serialToYMD(s));
        if (back !== s) failures.push([s, D.serialToYMD(s), back]);
    }
    // Sample the rest of the range, including the far end.
    for (let s = 5000; s <= D.MAX_SERIAL; s += 977) {
        const back = D.dateToSerial(D.serialToYMD(s));
        if (back !== s) failures.push([s, D.serialToYMD(s), back]);
    }
    for (const s of [25569, 34519, 32553, 23865, 43139, 46052, 45804, D.MAX_SERIAL]) {
        assert.equal(D.dateToSerial(D.serialToYMD(s)), s, `round-trip ${s}`);
    }
    assert.deepEqual(failures, [], "serial round-trip failures");
});

test("dateToSerial agrees with SSF on every serial it produces", () => {
    for (const [y, m, d, expected] of [
        [1900, 1, 1, 1],
        [1900, 2, 28, 59],
        [1900, 2, 29, 60],   // the phantom day; only reachable from serial 60
        [1900, 3, 1, 61],
        [1970, 1, 1, 25569],
        [1994, 7, 4, 34519],
        [1989, 2, 14, 32553],
        [1965, 5, 3, 23865],
        [2026, 1, 30, 46052],
        [2025, 5, 27, 45804],
        [9999, 12, 31, 2958465],
    ]) {
        assert.equal(D.dateToSerial(y, m, d), expected, `${d}/${m}/${y}`);
        assert.equal(D.dateToSerial({ y, m, d }), expected, `object form ${d}/${m}/${y}`);
        if (expected !== 60) {
            const ssf = XLSX.SSF.parse_date_code(expected);
            assert.deepEqual({ y: ssf.y, m: ssf.m, d: ssf.d }, { y, m, d });
        }
    }
});

test("dateToSerial rejects impossible components instead of rolling them over", () => {
    for (const c of [[2026, 2, 31], [2024, 2, 30], [2026, 13, 1], [2026, 0, 5], [2026, 1, 0], [1899, 12, 31]]) {
        assert.equal(D.dateToSerial(...c), null, JSON.stringify(c));
    }
    assert.equal(D.dateToSerial(1.5, 1, 1), null);
    assert.equal(D.dateToSerial(null), null);
});

test("compareYMD orders both {y,m,d} and serials", () => {
    assert.equal(D.compareYMD({ y: 2026, m: 1, d: 1 }, { y: 2026, m: 1, d: 2 }), -1);
    assert.equal(D.compareYMD({ y: 2026, m: 1, d: 2 }, { y: 2026, m: 1, d: 2 }), 0);
    assert.equal(D.compareYMD(46052, { y: 2026, m: 1, d: 1 }), 1);
    assert.equal(D.compareYMD(46052, 46052.9), 0, "serials compare by whole day");
});

test("month and year arithmetic clamps rather than rolling over", () => {
    assert.deepEqual(D.addMonthsYMD({ y: 2026, m: 1, d: 31 }, 1), { y: 2026, m: 2, d: 28 });
    assert.deepEqual(D.addMonthsYMD({ y: 2024, m: 1, d: 31 }, 1), { y: 2024, m: 2, d: 29 });
    assert.deepEqual(D.addMonthsYMD({ y: 2026, m: 12, d: 15 }, 1), { y: 2027, m: 1, d: 15 });
    assert.deepEqual(D.addMonthsYMD({ y: 2026, m: 1, d: 15 }, -1), { y: 2025, m: 12, d: 15 });
    assert.deepEqual(D.addYearsYMD({ y: 2024, m: 2, d: 29 }, -80), { y: 1944, m: 2, d: 29 }, "1944 is a leap year");
    assert.deepEqual(D.addYearsYMD({ y: 2024, m: 2, d: 29 }, -1), { y: 2023, m: 2, d: 28 }, "2023 is not");
    assert.deepEqual(D.addYearsYMD({ y: 2000, m: 2, d: 29 }, -100), { y: 1900, m: 2, d: 28 }, "1900 is not");
    assert.equal(D.isLeapYear(1900), false, "1900 is not a leap year in the civil calendar");
    assert.equal(D.isLeapYear(2000), true);
});

/* ------------------------------------------------------------------ *
 * Period context and plausibility windows
 * ------------------------------------------------------------------ */

test("resolvePeriodEnd accepts every shape a caller might hold", () => {
    const want = { y: 2026, m: 2, d: 28 };
    assert.deepEqual(D.resolvePeriodEnd("2026-02-28"), want);
    assert.deepEqual(D.resolvePeriodEnd(" 2026-02-28 "), want);
    assert.deepEqual(D.resolvePeriodEnd(46081), want);
    assert.deepEqual(D.resolvePeriodEnd(want), want);
    // period.js's own {inicio, fin, etiqueta} object, with fin as a serial or as components.
    assert.deepEqual(D.resolvePeriodEnd({ inicio: 46054, fin: 46081, etiqueta: "2-2026" }), want);
    assert.deepEqual(D.resolvePeriodEnd({ fin: want, etiqueta: "2-2026" }), want);
    assert.deepEqual(D.resolvePeriodEnd({ periodEnd: "2026-02-28" }), want);
});

test("resolvePeriodEnd throws on an unusable period - a wiring bug, not a data problem", () => {
    for (const bad of [null, undefined, "", "2026-02", "febrero", {}, { fin: "nope" }, 0, NaN]) {
        assert.throws(() => D.resolvePeriodEnd(bad), TypeError, `period ${JSON.stringify(bad)}`);
    }
});

test("plausibleRange is derived from the period, so re-running FEBRERO in AUGUST is stable", () => {
    const birth = D.plausibleRange("FECHA NACIMIENTO", "2026-02-28");
    assert.deepEqual(birth.min, { y: 2026 - config.MAX_AGE_YEARS, m: 2, d: 28 });
    assert.deepEqual(birth.max, { y: 2026 - config.MIN_AGE_YEARS, m: 2, d: 28 });

    const obra = D.plausibleRange("FECHA INICIO DE LABORES EN OBRA", "2026-02-28");
    assert.deepEqual(obra.min, { y: 2015, m: 1, d: 1 });
    assert.deepEqual(obra.max, { y: 2026, m: 3, d: 28 });
    assert.deepEqual(D.plausibleRange("FECHA CESE/BAJA", "2026-02-28"), obra);

    // A different period moves the window, and nothing else does.
    const older = D.plausibleRange("FECHA CESE/BAJA", "2025-10-31");
    assert.deepEqual(older.max, { y: 2025, m: 11, d: 30 });
});

test("period.js's descriptor is accepted verbatim - no adapter needed at the call site", t => {
    // Guarded: dates.js does not depend on period.js, and a sibling module being mid-write
    // must never turn this suite red. When it is present, the contract is asserted.
    let period;
    try {
        period = require("../pipeline/period").parsePeriod("2026-02");
    } catch {
        return t.skip("pipeline/period.js not available");
    }
    assert.deepEqual(D.resolvePeriodEnd(period), { y: 2026, m: 2, d: 28 });
    assert.deepEqual(D.resolvePeriodEnd(period.finSerial), { y: 2026, m: 2, d: 28 });
    assert.equal(
        D.parseDateCell("15/02/2026", "FECHA CESE/BAJA", { period }).serial,
        D.dateToSerial(2026, 2, 15)
    );
});

/* ------------------------------------------------------------------ *
 * Date system
 * ------------------------------------------------------------------ */

test("assertDateSystem passes the 1900 system and fails loudly on 1904", () => {
    const ok = new IssueList();
    assert.equal(D.assertDateSystem(false, { issues: ok }), true);
    assert.equal(D.assertDateSystem(undefined, { issues: ok }), true);
    assert.equal(ok.length, 0);

    const bad = new IssueList();
    assert.equal(
        D.assertDateSystem(true, { issues: bad, location: { archivo: "mac.xlsx" } }),
        false
    );
    assert.equal(bad.length, 1);
    assert.equal(bad.items[0].code, CODE.DATE_SYSTEM_1904);
    assert.equal(bad.items[0].severity, SEVERITY.FAILED);
    assert.equal(bad.items[0].archivo, "mac.xlsx");
    assert.equal(bad.hasBlockingIssues(), true, "a 1904 workbook must block the run report");
    // 1,462 days is the shift being refused; nothing must silently apply it.
    assert.equal(D.parseDateCell(34519, "FECHA NACIMIENTO", { period: DEFAULT_PERIOD, date1904: true }).serial, null);
});

/* ------------------------------------------------------------------ *
 * Behaviour that the case table states once but must hold everywhere
 * ------------------------------------------------------------------ */

test("month-first is never attempted as a fallback, in any column", () => {
    // 04/07/1994 is 4 July under the template's dd/mm/yyyy formats. If any code path ever
    // tried MM/DD/YYYY, this would come back as 7 April (serial 34431).
    // The windows are widened so the assertion is about interpretation, not plausibility.
    const wide = { ...config, MAX_AGE_YEARS: 200, EARLIEST_OBRA_DATE: "1900-01-01" };
    for (const column of DATE_COLUMNS) {
        const r = D.parseDateCell("04/07/1994", column, { period: "2026-02-28", config: wide });
        assert.equal(r.ok, true, `${column}: must parse`);
        assert.equal(r.ymd.m, 7, `${column}: month must be July`);
        assert.equal(r.serial, 34519);
        assert.notEqual(r.serial, 34431, `${column}: 34431 would be 7 April - month-first`);
    }
});

test("the eight day-first candidates are tried before ISO, and ISO cannot steal a day-first string", () => {
    assert.equal(D.TEXT_FORMATS[D.TEXT_FORMATS.length - 1], "YYYY-MM-DD");
    const r = D.parseDateCell("15-03-2020", "FECHA INICIO DE LABORES EN OBRA", { period: DEFAULT_PERIOD });
    assert.equal(r.matchedFormat, "DD-MM-YYYY");
    assert.deepEqual(r.ymd, { y: 2020, m: 3, d: 15 });
});

test("the matched format is reported, so one subcontratista's systematic misread is visible", () => {
    const issues = new IssueList();
    const seen = new Map();
    for (const raw of ["30/1/26", "27/05/25", "1/2/25", "05/06/25"]) {
        const r = D.parseDateCell(raw, "FECHA INICIO DE LABORES EN OBRA", { period: DEFAULT_PERIOD, issues });
        seen.set(raw, r.matchedFormat);
    }
    assert.deepEqual([...seen.values()], ["D/M/YY", "DD/MM/YY", "D/M/YY", "DD/MM/YY"]);
    assert.equal(issues.byCode(CODE.DATE_TWO_DIGIT_YEAR).length, 4, "every expansion is auditable");
    for (const i of issues.items) assert.equal(typeof i.detalle.formato, "string");
});

test("a call without an IssueList still works - the module is usable as a pure function", () => {
    assert.equal(D.parseDateCell("04/07/1994", "FECHA NACIMIENTO", { period: DEFAULT_PERIOD }).serial, 34519);
    assert.equal(D.parseDateCell("nope", "FECHA NACIMIENTO", { period: DEFAULT_PERIOD }).code, CODE.DATE_UNPARSEABLE);
});

test("parseDateCell is deterministic - same input and period, same answer, every time", () => {
    const inputs = ["04/07/1994", "30/1/26", 43139.791666666664, "-", "09/10/205", 46235, null];
    for (const column of DATE_COLUMNS) {
        for (const raw of inputs) {
            const a = D.parseDateCell(raw, column, { period: DEFAULT_PERIOD });
            const b = D.parseDateCell(raw, column, { period: DEFAULT_PERIOD });
            assert.deepEqual(a, b, `${column} / ${String(raw)}`);
        }
    }
});

/* ------------------------------------------------------------------ *
 * Corpus scale - the measured distribution of the last real run
 * ------------------------------------------------------------------ */

test("5,065 rows of the measured distribution: no NaN, no text, no 'undefined' anywhere", () => {
    // Proportions from 03-expected-output.md §3 and 05 Phase 2: ~4% text dates, 1,280
    // fractional serials, and the FECHA CESE/BAJA sentinel census.
    const issues = new IssueList();
    const rows = 5065;
    let accepted = 0, empty = 0, rejected = 0;

    for (let i = 0; i < rows; i++) {
        const nacimiento =
            i % 100 === 3 ? "04/07/1994" :
            i % 100 === 7 ? "14/2/1989" :
            i % 250 === 11 ? "09/10/205" :
            i % 250 === 13 ? "3/5/65" :
            25000 + (i % 12000);
        const inicio =
            i % 4 === 0 ? 43139.791666666664 :
            i % 4 === 1 ? 43139.833333333336 :
            i % 97 === 5 ? "10-11-202-6" :
            i % 97 === 7 ? "30/1/26" :
            42005 + (i % 4000);
        const cese =
            i % 5 === 0 ? "" :
            i % 5 === 1 ? "-" :
            i % 5 === 2 ? " - " :
            i % 5 === 3 ? "---" :
            i % 25 === 4 ? "ACTIVO" :
            45000 + (i % 500);

        for (const [raw, column] of [
            [nacimiento, "FECHA NACIMIENTO"],
            [inicio, "FECHA INICIO DE LABORES EN OBRA"],
            [cese, "FECHA CESE/BAJA"],
        ]) {
            const r = D.parseDateCell(raw, column, {
                period: DEFAULT_PERIOD,
                issues,
                location: { subcontratista: "SUB", archivo: "x.xlsx", fila: i + 2 },
            });
            // The whole point of Phase 2: what reaches the workbook is a number or nothing.
            assert.ok(r.serial === null || Number.isInteger(r.serial));
            assert.ok(!Number.isNaN(r.serial));
            assert.notEqual(r.serial, "");
            assert.notEqual(String(r.serial), "undefined");
            if (r.ok) accepted++; else if (r.empty) empty++; else rejected++;
        }
    }

    assert.equal(accepted + empty + rejected, rows * 3, "every cell is accounted for");
    assert.ok(rejected > 0 && empty > 0 && accepted > 0);

    // Every rejection is itemised - "~200 unparseable rows" is not a deliverable.
    const reported = issues.items.filter(i =>
        i.code === CODE.DATE_UNPARSEABLE || i.code === CODE.DATE_IMPLAUSIBLE || i.code === CODE.DATE_TWO_DIGIT_YEAR
    );
    assert.ok(reported.length >= rejected, "every rejected cell produced at least one issue");
    for (const i of reported) {
        assert.notEqual(i.valor, undefined);
        assert.equal(typeof i.fila, "number");
    }

    // Sentinels are silent-but-counted, never written as "" (BUG-09).
    assert.ok(issues.byCode(CODE.TEXT_NORMALIZED).length > 1000, "sentinel census");
    assert.ok(issues.byCode(CODE.DATE_FRACTIONAL_TRUNCATED).length > 1000, "fractional serial census");
});

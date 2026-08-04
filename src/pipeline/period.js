"use strict";
/**
 * The report period. An explicit INPUT, never an inference from the wall clock.
 *
 * This module replaces `getMonthAndYear()` (src/excelReporting.js:69-77) and its
 * duplicate (public/js/index.js:103-111), which derive the period from `new Date()`
 * and then patch the year by testing whether the *localized month name* equals
 * "DICIEMBRE" (commit 48bb315). That band-aid is wrong twice: it uses a display
 * string as a year predicate, and on a small-ICU Node build
 * `toLocaleString('es-ES',{month:'long'})` returns "December", so the test never
 * fires at all. The proof that the derivation is broken is in the archive:
 * `src/reportes/Reporte_Subcontratistas_DICIEMBRE_2025.xlsx` was refreshed
 * 2025-12-30 and its own Altas page filter reads "11-2025" - the file is named
 * December and reports November (BUG-16, BUG-40; 03-expected-output.md §6.2).
 *
 * Everything here is pure. Nothing in this file calls `new Date()` with no
 * argument; `previousMonth(now)` takes the current date as a required argument so
 * that the one place a clock is read is the CLI/server boundary, on purpose and in
 * one line. (05-implementation-plan.md §1 principle 3, Phase 4 task 1.)
 *
 * Month names are a hard-coded table, deliberately - see MESES.
 */

/**
 * Uppercase Spanish month names, index = month - 1.
 *
 * Hard-coded rather than derived from `toLocaleString('es-ES', …)` because the ICU
 * data is an environment variable in disguise: a `node --with-intl=small-icu` build
 * yields English names, which is exactly how the DICIEMBRE band-aid in
 * `getMonthAndYear()` came to silently do nothing. None of the twelve carries an
 * accent; the archive filenames (`Reporte_Subcontratistas_SEPTIEMBRE_2024.xlsx`)
 * confirm the plain spelling.
 */
const MESES = Object.freeze([
    "ENERO",
    "FEBRERO",
    "MARZO",
    "ABRIL",
    "MAYO",
    "JUNIO",
    "JULIO",
    "AGOSTO",
    "SEPTIEMBRE",
    "OCTUBRE",
    "NOVIEMBRE",
    "DICIEMBRE",
]);

/** The output filename stem. Every consumer builds its name from `filenameBase`. */
const FILENAME_PREFIX = "Reporte_Subcontratistas";

/** Strict shape. "2026-2", "26-02", "2026/02" and "2026-02-01" are all malformed. */
const PERIOD_RE = /^(\d{4})-(\d{2})$/;

/** Excel's 1900 date system has no serial before 1900-01-01, so no period does either. */
const MIN_YEAR = 1900;

/**
 * Stable error codes, so `server.js` can map a bad `--period` / form field to a 400
 * without string-matching a message. Same key===value convention as issues.js CODE.
 */
const PERIOD_ERROR = Object.freeze({
    PERIOD_MALFORMED: "PERIOD_MALFORMED",
    PERIOD_MONTH_RANGE: "PERIOD_MONTH_RANGE",
    PERIOD_YEAR_RANGE: "PERIOD_YEAR_RANGE",
    PERIOD_FUTURE: "PERIOD_FUTURE",
    PERIOD_TODAY_INVALID: "PERIOD_TODAY_INVALID",
});

/**
 * A bad period is a CALLER error, not a data issue, so it throws instead of landing
 * in the IssueList: it must stop the run before a single workbook is read, rather
 * than produce a report that is wrong in its title (03-expected-output.md §6.1,
 * 05-implementation-plan.md §8 Q5).
 */
class PeriodError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "PeriodError";
        this.code = code;
    }
}

function fail(code, message) {
    throw new PeriodError(code, message);
}

function pad2(n) {
    return String(n).padStart(2, "0");
}

function isLeapYear(year) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const MONTH_LENGTHS = Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);

function daysInMonth(year, month) {
    if (month === 2 && isLeapYear(year)) return 29;
    return MONTH_LENGTHS[month - 1];
}

/**
 * Days since 1970-01-01 for a proleptic Gregorian date - Howard Hinnant's
 * `days_from_civil`. Pure integer arithmetic: no `Date`, therefore no timezone, no
 * DST and no locale in the serial path (03-expected-output.md §3.6 warns that
 * mixing local and UTC constructions is how a date drifts by a day).
 */
function daysFromCivil(year, month, day) {
    const y = year - (month <= 2 ? 1 : 0);
    const era = Math.floor(y / 400);
    const yoe = y - era * 400;                                                  // [0, 399]
    const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
    const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;  // [0, 146096]
    return era * 146097 + doe - 719468;
}

/** 1970-01-01 as an Excel 1900-system serial is 25569; before the phantom day it is 25568. */
const EPOCH_SERIAL = 25568;

/**
 * Excel 1900-system serial for a calendar date. Serial 1 = 1900-01-01.
 *
 * Excel counts a 1900-02-29 that never existed, so every date from 1900-03-01
 * onwards is one higher than the true day count. Reproducing that off-by-one is
 * mandatory, not a bug: the workbook's own comparisons run against these numbers
 * (03-expected-output.md §3.6).
 */
function toExcelSerial(year, month, day) {
    const days = daysFromCivil(year, month, day);
    const phantom = days >= daysFromCivil(1900, 3, 1) ? 1 : 0;
    return days + EPOCH_SERIAL + phantom;
}

/** "YYYY-MM" from components. */
function formatPeriod(year, month) {
    return `${year}-${pad2(month)}`;
}

/**
 * Year/month of an explicitly-supplied "now". Accepts a Date or a "YYYY-MM" /
 * "YYYY-MM-DD" string; the string form is timezone-proof and is what tests use.
 *
 * The Date form reads LOCAL components (getFullYear/getMonth), matching
 * 03-expected-output.md §3.6's "stay in local time end to end" rule - a report
 * generated at 22:00 in Lima belongs to Lima's calendar month, not to UTC's.
 */
function resolveNow(now, code) {
    if (now instanceof Date) {
        const t = now.getTime();
        if (!Number.isFinite(t)) fail(code, "fecha actual invalida: Invalid Date");
        return { year: now.getFullYear(), month: now.getMonth() + 1 };
    }
    if (typeof now === "string") {
        const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(now.trim());
        if (!m) fail(code, `fecha actual invalida: ${JSON.stringify(now)} (se espera "YYYY-MM" o "YYYY-MM-DD")`);
        const year = Number(m[1]);
        const month = Number(m[2]);
        if (month < 1 || month > 12) fail(code, `fecha actual invalida: mes ${month} fuera de 1-12`);
        return { year, month };
    }
    return fail(code, `fecha actual invalida: se espera Date o "YYYY-MM", recibido ${typeof now}`);
}

/**
 * Parse "YYYY-MM" into the frozen period descriptor every later stage reads.
 *
 * @param {string} period  e.g. "2026-02". Surrounding whitespace is trimmed; any
 *                         other deviation from the shape is rejected.
 * @param {object} [options]
 * @param {Date|string} [options.today]  when given, a period after this month is
 *                         rejected (§8 Q5: "refuse a period in the future
 *                         outright"). The CURRENT month is allowed - it is not in
 *                         the future, merely unfinished. Omit it and no clock is
 *                         consulted at all, which is what keeps this function pure.
 * @returns {Readonly<object>}
 * @throws {PeriodError}
 */
function parsePeriod(period, options = {}) {
    if (typeof period !== "string") {
        fail(PERIOD_ERROR.PERIOD_MALFORMED,
            `periodo invalido: se espera una cadena "YYYY-MM", recibido ${period === null ? "null" : typeof period}`);
    }
    const raw = period.trim();
    const match = PERIOD_RE.exec(raw);
    if (!match) {
        fail(PERIOD_ERROR.PERIOD_MALFORMED,
            `periodo invalido: ${JSON.stringify(period)} (formato requerido "YYYY-MM")`);
    }

    const year = Number(match[1]);
    const month = Number(match[2]);

    if (month < 1 || month > 12) {
        fail(PERIOD_ERROR.PERIOD_MONTH_RANGE,
            `periodo invalido: mes ${match[2]} fuera del rango 1-12 en ${JSON.stringify(raw)}`);
    }
    if (year < MIN_YEAR) {
        fail(PERIOD_ERROR.PERIOD_YEAR_RANGE,
            `periodo invalido: anio ${year} anterior a ${MIN_YEAR} (sin serial en el sistema de fechas 1900)`);
    }

    if (options.today !== undefined && options.today !== null) {
        const now = resolveNow(options.today, PERIOD_ERROR.PERIOD_TODAY_INVALID);
        if (year > now.year || (year === now.year && month > now.month)) {
            fail(PERIOD_ERROR.PERIOD_FUTURE,
                `periodo invalido: ${formatPeriod(year, month)} es futuro respecto de ${formatPeriod(now.year, now.month)}`);
        }
    }

    const dias = daysInMonth(year, month);
    const mesNombre = MESES[month - 1];
    const filenameBase = `${FILENAME_PREFIX}_${mesNombre}_${year}`;

    return Object.freeze({
        /** The normalized input, "YYYY-MM". Round-trips: parsePeriod(p.key) === p. */
        key: formatPeriod(year, month),
        year,
        month,
        /** First and last calendar day of the month, ISO "YYYY-MM-DD". Strings, not
         *  Dates, so the descriptor is genuinely immutable and timezone-free. */
        inicio: `${year}-${pad2(month)}-01`,
        fin: `${year}-${pad2(month)}-${pad2(dias)}`,
        diasEnMes: dias,
        /** Excel 1900-system serials, for the PeriodoInicio / PeriodoFin defined names
         *  and for the JS-side Altas/Bajas comparisons of Phase 4 task 3. */
        inicioSerial: toExcelSerial(year, month, 1),
        finSerial: toExcelSerial(year, month, dias),
        /** The template's own label format: month number, NO zero padding, hyphen,
         *  year. Verified against the pivot page filters, which carry a literal
         *  "9-2024" today, and against DICIEMBRE_2025's "11-2025". Written as the
         *  PeriodoEtiqueta defined name and into the two pivot page filters. */
        etiqueta: `${month}-${year}`,
        mesNombre,
        /** Shared stem so the workbook, the metrics side-car and the run log cannot
         *  disagree about which month they describe. */
        filenameBase,
        filename: `${filenameBase}.xlsx`,
    });
}

/**
 * "YYYY-MM" for the calendar month before `now`. The CLI/server DEFAULT ONLY - the
 * operator confirms or overrides it (§8 Q5). `now` is a REQUIRED argument with no
 * default: a default would reintroduce exactly the hidden clock read this module
 * exists to delete.
 *
 * @param {Date|string} now  a Date (local components are read) or "YYYY-MM" / "YYYY-MM-DD".
 * @returns {string}
 * @throws {PeriodError}
 */
function previousMonth(now) {
    if (now === undefined || now === null) {
        fail(PERIOD_ERROR.PERIOD_TODAY_INVALID,
            "previousMonth(now) requiere la fecha actual como argumento explicito");
    }
    const { year, month } = resolveNow(now, PERIOD_ERROR.PERIOD_TODAY_INVALID);
    // The January boundary is the case getMonthAndYear() tried to patch with a month
    // NAME comparison; here it is one subtraction (BUG-16).
    return month === 1 ? formatPeriod(year - 1, 12) : formatPeriod(year, month - 1);
}

/**
 * Does an Excel date serial fall inside the period? The JS-side test behind the
 * Altas / Bajas2 literals of Phase 4 task 3, replacing
 * `MONTH(TODAY()-30)`/`YEAR(TODAY()-30)`. Non-numeric input is false, never NaN -
 * the caller records an issue for it (issues.js DATE_UNPARSEABLE).
 */
function containsSerial(period, serial) {
    if (!Number.isFinite(serial)) return false;
    return serial >= period.inicioSerial && serial <= period.finSerial;
}

module.exports = {
    MESES,
    FILENAME_PREFIX,
    MIN_YEAR,
    PERIOD_ERROR,
    PeriodError,
    parsePeriod,
    previousMonth,
    containsSerial,
    toExcelSerial,
    daysInMonth,
    isLeapYear,
    formatPeriod,
};

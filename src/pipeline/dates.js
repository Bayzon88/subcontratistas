"use strict";
/**
 * The single place a raw cell becomes an Excel date serial.
 *
 * Scope: FECHA NACIMIENTO (F), FECHA CESE/BAJA (M), FECHA INICIO DE LABORES EN OBRA (O).
 * Today the pipeline has no date handling at all (BUG-06), which produces #VALUE! in
 * Edad/Rango Edades (BUG-07), silently un-counts ~200 workers from Altas/Bajas (BUG-08)
 * and force-writes "" into a numFmtId-14 column 3,801 times (BUG-09).
 *
 * Design rules, all from 03-expected-output.md §3:
 *  - The unit of exchange is an Excel SERIAL plus its {y,m,d} components. No JS Date is
 *    ever constructed here: a Date carries a timezone, a serial does not, and every
 *    timezone-dependent conversion is a bug that only shows up at 19:00 Lima time.
 *  - Day-first, always. The template's own custom number formats are dd/mm/yyyy;@,
 *    dd.mm.yyyy;@ and d/mm/yyyy (§3.2), so "04/07/1994" is 4 July 1994. Month-first is
 *    never attempted, not even as a fallback - that is how 03/05/1965 silently becomes
 *    5 March.
 *  - Nothing throws for a data problem and nothing returns NaN. A value either becomes a
 *    serial, or becomes null with an IssueList entry carrying the raw text verbatim.
 *
 * Purity: every function here is a pure function of its arguments. No Date.now(), no
 * new Date(), no I/O. The "today" that plausibility checks against is the report period,
 * passed in - that is what makes re-running FEBRERO in AUGUST produce February's numbers.
 */

const XLSX = require("xlsx");
const dayjs = require("dayjs");
const customParseFormat = require("dayjs/plugin/customParseFormat");
dayjs.extend(customParseFormat);

const config = require("../config");
const { CODE } = require("./issues");

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** Excel 1900-system bounds: serial 1 = 1900-01-01, serial 2958465 = 9999-12-31.
 *  Serial 0 is Excel's "January 0, 1900" non-date and is what a blank coerced with
 *  Number("") looks like - it must be rejected, not turned into a 1899/1900 date. */
const MIN_SERIAL = 1;
const MAX_SERIAL = 2958465;

/**
 * Text candidates, in priority order, all parsed by dayjs in STRICT mode.
 *
 * The eight day-first shapes are 05-implementation-plan.md Phase 2 task 1. ISO is
 * appended LAST because 03-expected-output.md §3.1 accepts it as unambiguous: putting it
 * after the day-first list means only strings that fail every day-first candidate can
 * ever reach it, so "15-03-2020" still resolves as 15 March via DD-MM-YYYY.
 */
const TEXT_FORMATS = Object.freeze([
    "DD/MM/YYYY",
    "D/M/YYYY",
    "DD/MM/YY",
    "D/M/YY",
    "DD-MM-YYYY",
    "D-M-YYYY",
    "DD.MM.YYYY",
    "D.M.YYYY",
    "YYYY-MM-DD",
]);

/** Formats whose year token is two digits, so the pivot in §3.3 applies. */
const TWO_DIGIT_FORMATS = new Set(TEXT_FORMATS.filter(f => /YY/.test(f) && !/YYYY/.test(f)));

/**
 * Two-digit-year pivot: 00-60 -> 20xx, 61-99 -> 19xx (03 §3.3).
 *
 * Set explicitly rather than inherited from the library: dayjs uses the JS Date rule
 * (68 -> 2068, 69 -> 1969), date-fns slides its window against the reference date and
 * Luxon defaults to 60. All three disagree and two are wrong for these columns.
 *
 * Read from config when present so it can be promoted into the config contract later
 * without touching this file.
 */
const TWO_DIGIT_PIVOT = Number.isInteger(config.TWO_DIGIT_YEAR_PIVOT)
    ? config.TWO_DIGIT_YEAR_PIVOT
    : 60;

/**
 * Sentinels that mean "no date here", normalized to a GENUINELY EMPTY cell - null, never
 * "" (BUG-09). Measured in FECHA CESE/BAJA: "" x3801, "-" x754, " - " x154, "---" x125,
 * "ACTIVO" x58.
 *
 * Two tiers, because a dash means "absent" in any date column but only a cese column can
 * say "ACTIVO":
 *  - PUNCTUATION_SENTINEL matches any run of dashes/dots/underscores, in every column.
 *  - WORD_SENTINELS is per column and matches on the normalized (trimmed, accent-folded,
 *    upper-cased) form.
 * Extend WORD_SENTINELS by adding a string; nothing else needs to change.
 */
const PUNCTUATION_SENTINEL = /^[-‐-―._\s]+$/;

const WORD_SENTINELS = Object.freeze({
    "FECHA CESE/BAJA": Object.freeze([
        "ACTIVO",   // observed x58
        "ACTIVA",
        "NO APLICA",
        "N/A",
        "NA",
        "SIN FECHA",
        "VIGENTE",
    ]),
    "FECHA NACIMIENTO": Object.freeze(["NO APLICA", "N/A", "NA", "SIN FECHA"]),
    "FECHA INICIO DE LABORES EN OBRA": Object.freeze(["NO APLICA", "N/A", "NA", "SIN FECHA"]),
});

/**
 * Per-column policy. Data-driven off config so the owner decision in
 * 05-implementation-plan.md §8 Q1 is one boolean, not an edit in three places.
 *
 *  twoDigitYear "reject"  - a 2-digit year is unrecoverable here (a birth date feeds Edad,
 *                           Rango Edades and the Validacion pivot; 3/5/65 meaning 1965 is
 *                           indistinguishable from a typo).
 *               "expand"  - pivot at TWO_DIGIT_PIVOT, then force past-only (see below).
 *  range        which plausibility window applies (§3.5).
 *  required     drives severity only. dates.js never rejects a ROW - it nulls a cell and
 *               says why; whether that kills the row is schema.js's call. Per 03 §8.3,
 *               "unparseable required date" is an ERROR and "row accepted with a field
 *               nulled" is a WARNING.
 */
function buildPolicy(cfg) {
    const rejectBirthTwoDigit = cfg.REJECT_TWO_DIGIT_BIRTH_YEARS !== false;
    return Object.freeze({
        "FECHA NACIMIENTO": Object.freeze({
            twoDigitYear: rejectBirthTwoDigit ? "reject" : "expand",
            range: "birth",
            required: true,
        }),
        "FECHA INICIO DE LABORES EN OBRA": Object.freeze({
            twoDigitYear: "expand",
            range: "obra",
            required: true,
        }),
        "FECHA CESE/BAJA": Object.freeze({
            twoDigitYear: "expand",
            range: "obra",
            required: false,
        }),
    });
}

const DATE_POLICY = buildPolicy(config);

/* ------------------------------------------------------------------ *
 * Calendar arithmetic - pure integer maths, no Date object anywhere
 * ------------------------------------------------------------------ */

function isLeapYear(y) {
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
    if (m === 2) return isLeapYear(y) ? 29 : 28;
    return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

/** Proleptic Gregorian calendar validity. 1900-02-29 is NOT valid here on purpose - it
 *  exists only as Excel serial 60 and dateToSerial special-cases it. */
function isValidYMD(y, m, d) {
    if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
    if (m < 1 || m > 12 || d < 1) return false;
    return d <= daysInMonth(y, m);
}

/** Days since 1970-01-01 (Howard Hinnant's days_from_civil). Pure, and correct for any
 *  year - unlike Date.UTC, which maps year 94 to 1994. */
function daysFromCivil(y, m, d) {
    const yy = y - (m <= 2 ? 1 : 0);
    const era = Math.floor(yy / 400);
    const yoe = yy - era * 400;
    const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
    const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
}

/* ------------------------------------------------------------------ *
 * Serial <-> {y,m,d}
 * ------------------------------------------------------------------ */

/**
 * Excel serial -> {y,m,d}, with the time component truncated.
 *
 * Delegates to XLSX.SSF.parse_date_code, which reproduces Excel's fictitious 1900-02-29
 * at serial 60 (verified: parse_date_code(60) -> {y:1900, m:2, d:29}). The naive
 * Date.UTC(1899,11,30) + n*86400000 is off by one for every serial <= 60, which is
 * exactly the range a blank-coerced-to-zero lands in.
 *
 * @param {number} serial
 * @returns {{y:number,m:number,d:number}|null} null when out of Excel's range
 */
function serialToYMD(serial) {
    if (typeof serial !== "number" || !Number.isFinite(serial)) return null;
    const day = Math.floor(serial);
    if (day < MIN_SERIAL || day > MAX_SERIAL) return null;
    const parts = XLSX.SSF.parse_date_code(day);
    if (!parts || !parts.d) return null;
    return { y: parts.y, m: parts.m, d: parts.d };
}

/**
 * {y,m,d} -> Excel serial. The exact inverse of serialToYMD for the 1900 system,
 * including serial 60.
 *
 * Accepts either dateToSerial(y, m, d) or dateToSerial({y, m, d}).
 * @returns {number|null} null when the components are not a real date or fall outside
 *                        Excel's representable range.
 */
function dateToSerial(y, m, d) {
    if (y !== null && typeof y === "object") {
        const o = y;
        y = o.y; m = o.m; d = o.d;
    }
    if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
    // Excel's phantom leap day. Round-trips parse_date_code(60) and nothing else reaches it.
    if (y === 1900 && m === 2 && d === 29) return 60;
    if (!isValidYMD(y, m, d)) return null;
    // 25569 = days from 1970-01-01 back to the 1900 epoch. Serials <= 60 are one higher
    // than the true day count because Excel counts a 29 February 1900 that never existed.
    const naive = daysFromCivil(y, m, d) + 25569;
    const serial = naive <= 60 ? naive - 1 : naive;
    return serial >= MIN_SERIAL && serial <= MAX_SERIAL ? serial : null;
}

/** -1 / 0 / 1. Works on {y,m,d} or on serials; metrics.js compares periods with this. */
function compareYMD(a, b) {
    const sa = typeof a === "number" ? Math.floor(a) : dateToSerial(a);
    const sb = typeof b === "number" ? Math.floor(b) : dateToSerial(b);
    if (sa === null || sb === null) return null;
    return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** Add whole months, clamping the day (2026-01-31 + 1 month -> 2026-02-28). */
function addMonthsYMD(ymd, n) {
    const total = ymd.y * 12 + (ymd.m - 1) + n;
    const y = Math.floor(total / 12);
    const m = total - y * 12 + 1;
    return { y, m, d: Math.min(ymd.d, daysInMonth(y, m)) };
}

/** Add whole years, clamping 29 February onto 28 February in a non-leap target. */
function addYearsYMD(ymd, n) {
    const y = ymd.y + n;
    return { y, m: ymd.m, d: Math.min(ymd.d, daysInMonth(y, ymd.m)) };
}

/* ------------------------------------------------------------------ *
 * Period context
 * ------------------------------------------------------------------ */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Normalize whatever the caller passes as the report period into the period END as
 * {y,m,d}. Deliberately permissive about shape - period.js is a sibling module and this
 * accepts its {inicio, fin, etiqueta} object directly - but strict about content.
 *
 * Accepts: a serial, a {y,m,d}, an ISO "YYYY-MM-DD" string, or an object carrying any of
 * those under `fin`, `finSerial`, `end` or `periodEnd`.
 *
 * Throws on an unusable period: that is a wiring bug, not a data problem, and a silent
 * fallback to the wall clock is the exact defect this rework exists to remove.
 */
function resolvePeriodEnd(period) {
    const ymd = coercePeriodEnd(period);
    if (!ymd) {
        throw new TypeError(
            "dates.js: unusable period context - expected a serial, {y,m,d}, \"YYYY-MM-DD\" " +
            "or an object with fin/finSerial/end/periodEnd, got " + JSON.stringify(period)
        );
    }
    return ymd;
}

function coercePeriodEnd(p) {
    if (p === null || p === undefined) return null;
    if (typeof p === "number") return serialToYMD(p);
    if (typeof p === "string") {
        const m = ISO_DATE.exec(p.trim());
        if (!m) return null;
        const ymd = { y: +m[1], m: +m[2], d: +m[3] };
        return isValidYMD(ymd.y, ymd.m, ymd.d) ? ymd : null;
    }
    if (typeof p === "object") {
        if (isValidYMD(p.y, p.m, p.d)) return { y: p.y, m: p.m, d: p.d };
        for (const key of ["fin", "finSerial", "end", "periodEnd", "periodoFin"]) {
            if (p[key] !== undefined && p[key] !== null) {
                const nested = coercePeriodEnd(p[key]);
                if (nested) return nested;
            }
        }
    }
    return null;
}

/**
 * The plausibility window for one column (03 §3.5, 05 Phase 2 task 2). Parsing correctly
 * is not the same as being right: this is the only thing that catches a birth date of
 * 2003 on a worker hired in 1998.
 *
 * @returns {{min:{y,m,d}, max:{y,m,d}, minSerial:number, maxSerial:number}}
 */
function plausibleRange(column, period, cfg = config) {
    const end = resolvePeriodEnd(period);
    const policy = (cfg === config ? DATE_POLICY : buildPolicy(cfg))[column];
    const kind = policy ? policy.range : "obra";
    let min, max;
    if (kind === "birth") {
        // Mirrors the template's own <18 / >80 "Corregir" bounds.
        min = addYearsYMD(end, -(cfg.MAX_AGE_YEARS ?? config.MAX_AGE_YEARS));
        max = addYearsYMD(end, -(cfg.MIN_AGE_YEARS ?? config.MIN_AGE_YEARS));
    } else {
        const earliest = coercePeriodEnd(cfg.EARLIEST_OBRA_DATE ?? config.EARLIEST_OBRA_DATE);
        min = earliest || { y: 2015, m: 1, d: 1 };
        // +1 month: a start (or a scheduled cese, 05 §8 Q6) in the month after the period
        // is legitimate, and rejecting it would hide a real Alta.
        max = addMonthsYMD(end, 1);
    }
    return { min, max, minSerial: dateToSerial(min), maxSerial: dateToSerial(max) };
}

/* ------------------------------------------------------------------ *
 * Date system
 * ------------------------------------------------------------------ */

/**
 * Guard for the 1904 date system. A workbook authored on legacy Mac Excel is off by
 * exactly 1,462 days - a four-year error that looks like plausible data, which is why
 * this fails loudly instead of shifting silently.
 *
 * Call once per workbook from workbook.js with wb.Workbook?.WBProps?.date1904.
 * @returns {boolean} true when the workbook may be read.
 */
function assertDateSystem(date1904, opts = {}) {
    if (!date1904) return true;
    record(opts.issues, "failed", {
        code: CODE.DATE_SYSTEM_1904,
        message:
            "El libro usa el sistema de fechas 1904 (Mac Excel heredado): todas sus fechas " +
            "estarian desplazadas 1,462 dias. No se procesa.",
        ...(opts.location || {}),
        valor: true,
    });
    return false;
}

/* ------------------------------------------------------------------ *
 * The parser
 * ------------------------------------------------------------------ */

/** Normalized form used for sentinel matching only: trim, fold accents, collapse ws, upper. */
function normalizeSentinel(s) {
    return String(s)
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toUpperCase();
}

function record(issues, level, o) {
    if (!issues || typeof issues[level] !== "function") return null;
    return issues[level](o);
}

/** Empty / rejected / accepted result shapes, so every return site has the same keys. */
function result(over) {
    return Object.assign(
        {
            ok: false, empty: false, serial: null, ymd: null,
            matchedFormat: null, sentinel: null, code: null,
            parsedSerial: null, parsedYMD: null,
        },
        over
    );
}

/**
 * Raw cell -> Excel serial, or null with an issue.
 *
 * @param {number|string|Date|null|undefined} raw  the cell value exactly as read
 * @param {string} column                          canonical column name (columns.js)
 * @param {object} opts
 * @param {*}        opts.period      report period; anything resolvePeriodEnd accepts. Required.
 * @param {IssueList} [opts.issues]   collector; omit for a pure call
 * @param {object}   [opts.location]  {subcontratista, archivo, hoja, fila, celda}
 * @param {boolean}  [opts.date1904]  the workbook's date system; true refuses the value
 * @param {object}   [opts.config]    tunable overrides (tests)
 * @returns {{ok:boolean, empty:boolean, serial:number|null, ymd:object|null,
 *            matchedFormat:string|null, sentinel:string|null, code:string|null}}
 *
 * ok:true      -> serial and ymd are set; write the serial into the numFmtId-14 column.
 * empty:true   -> the cell is legitimately absent; write a GENUINELY EMPTY cell (BUG-09).
 * neither      -> the value was rejected; code says why and the issue carries it verbatim.
 */
function parseDateCell(raw, column, opts = {}) {
    const cfg = opts.config || config;
    const policy = (cfg === config ? DATE_POLICY : buildPolicy(cfg))[column] || {
        twoDigitYear: "expand",
        range: "obra",
        required: false,
    };
    const loc = opts.location || {};
    const issues = opts.issues;
    const rejectLevel = policy.required ? "error" : "warning";
    const base = { ...loc, columna: column, valor: raw };

    // A 1904 workbook must never reach here; if it does, refuse rather than shift by 1,462 days.
    if (opts.date1904) {
        record(issues, "failed", {
            code: CODE.DATE_SYSTEM_1904,
            message: "Valor de fecha descartado: el libro usa el sistema de fechas 1904.",
            ...base,
        });
        return result({ code: CODE.DATE_SYSTEM_1904 });
    }

    // ---- absent -------------------------------------------------------------
    if (raw === null || raw === undefined) return result({ empty: true });

    // ---- Date ---------------------------------------------------------------
    // Only reachable when the reader was configured with cellDates:true. Read with the
    // LOCAL getters: SheetJS builds local-midnight Date objects, so getUTCDate() would
    // shift the day by one for every negative-offset timezone - Lima is UTC-5.
    if (raw instanceof Date) {
        if (Number.isNaN(raw.getTime())) {
            record(issues, rejectLevel, {
                code: CODE.DATE_UNPARSEABLE,
                message: `Fecha invalida en ${column}.`,
                ...base,
                valor: String(raw),
            });
            return result({ code: CODE.DATE_UNPARSEABLE });
        }
        const ymd = { y: raw.getFullYear(), m: raw.getMonth() + 1, d: raw.getDate() };
        noteTruncation(raw.getHours(), raw.getMinutes(), raw.getSeconds(), issues, base, column);
        return finish(ymd, "date", null, column, policy, opts, cfg, issues, base, rejectLevel);
    }

    // ---- serial -------------------------------------------------------------
    if (typeof raw === "number") {
        if (!Number.isFinite(raw)) {
            record(issues, rejectLevel, {
                code: CODE.DATE_UNPARSEABLE,
                message: `Valor numerico no finito en ${column}.`,
                ...base,
                valor: String(raw),
            });
            return result({ code: CODE.DATE_UNPARSEABLE });
        }
        const ymd = serialToYMD(raw);
        if (!ymd) {
            // Includes serial 0 - Excel's "January 0, 1900", i.e. what Number("") produces.
            record(issues, rejectLevel, {
                code: CODE.DATE_UNPARSEABLE,
                message: `Serial de Excel fuera de rango en ${column} (valido: 1..${MAX_SERIAL}).`,
                ...base,
            });
            return result({ code: CODE.DATE_UNPARSEABLE });
        }
        const fraction = raw - Math.floor(raw);
        if (fraction > 0) {
            // 1,280 cells in the last run carry one: 586 at .791666... (19:00) and
            // 694 at .833333... (20:00). Truncate, but say so.
            const totalSeconds = Math.round(fraction * 86400);
            record(issues, "info", {
                code: CODE.DATE_FRACTIONAL_TRUNCATED,
                message: `Serial con hora en ${column}; se trunca al dia.`,
                ...base,
                detalle: {
                    fraccion: fraction,
                    hora: formatClock(
                        Math.floor(totalSeconds / 3600),
                        Math.floor((totalSeconds % 3600) / 60),
                        totalSeconds % 60
                    ),
                },
            });
        }
        return finish(ymd, "serial", null, column, policy, opts, cfg, issues, base, rejectLevel);
    }

    // ---- anything that is not text ------------------------------------------
    if (typeof raw !== "string") {
        record(issues, rejectLevel, {
            code: CODE.DATE_UNPARSEABLE,
            message: `Tipo de valor no admitido en ${column}: ${typeof raw}.`,
            ...base,
            valor: String(raw),
        });
        return result({ code: CODE.DATE_UNPARSEABLE });
    }

    // ---- text ---------------------------------------------------------------
    const trimmed = raw.trim();
    if (trimmed === "") return result({ empty: true });

    // Sentinels: "-", " - ", "---", "ACTIVO" all mean "no hay fecha" -> genuinely empty
    // cell, never "". Per 03 §8.3 a sentinel that fired is an INFO; a blank cell is not,
    // because nothing was normalized.
    const key = normalizeSentinel(trimmed);
    const words = WORD_SENTINELS[column] || [];
    if (PUNCTUATION_SENTINEL.test(trimmed) || words.includes(key)) {
        record(issues, "info", {
            // No dedicated sentinel code exists in issues.js and that file is a contract;
            // TEXT_NORMALIZED is the "a normalization fired" bucket. `columna` disambiguates.
            code: CODE.TEXT_NORMALIZED,
            message: `Centinela "${trimmed}" en ${column} tratado como celda vacia.`,
            ...base,
            detalle: { centinela: key, accion: "celda vacia" },
        });
        return result({ empty: true, sentinel: key });
    }

    let matched = null;
    let parsed = null;
    for (const fmt of TEXT_FORMATS) {
        const d = dayjs(trimmed, fmt, true); // strict; trimmed first, strict rejects padding
        if (d.isValid()) {
            matched = fmt;
            parsed = { y: d.year(), m: d.month() + 1, d: d.date() };
            break;
        }
    }

    if (!matched) {
        record(issues, rejectLevel, {
            code: CODE.DATE_UNPARSEABLE,
            message: `Texto no reconocido como fecha en ${column}.`,
            ...base,
            detalle: { formatosProbados: TEXT_FORMATS.slice(), numerico: /^\d+$/.test(trimmed) },
        });
        return result({ code: CODE.DATE_UNPARSEABLE });
    }

    if (TWO_DIGIT_FORMATS.has(matched)) {
        if (policy.twoDigitYear === "reject") {
            record(issues, rejectLevel, {
                code: CODE.DATE_TWO_DIGIT_YEAR,
                message:
                    `Ano de dos digitos rechazado en ${column}: no hay forma de distinguir ` +
                    `1965 de un error de tipeo, y el valor alimenta Edad y Rango Edades.`,
                ...base,
                detalle: { formato: matched },
            });
            return result({ code: CODE.DATE_TWO_DIGIT_YEAR, matchedFormat: matched });
        }
        const expanded = expandTwoDigitYear(parsed, column, policy, opts, cfg);
        if (!isValidYMD(expanded.ymd.y, expanded.ymd.m, expanded.ymd.d)) {
            // Only reachable for 29 February: 29/2/00 parses as 2000 (leap) and the
            // past-only rule can push it to 1900 (not leap).
            record(issues, rejectLevel, {
                code: CODE.DATE_UNPARSEABLE,
                message: `Ano de dos digitos expandido a una fecha inexistente en ${column}.`,
                ...base,
                detalle: { formato: matched, expandido: expanded.ymd },
            });
            return result({ code: CODE.DATE_UNPARSEABLE, matchedFormat: matched });
        }
        record(issues, "info", {
            code: CODE.DATE_TWO_DIGIT_YEAR,
            message: `Ano de dos digitos expandido a ${expanded.ymd.y} en ${column}.`,
            ...base,
            detalle: {
                formato: matched,
                pivote: TWO_DIGIT_PIVOT,
                ano: expanded.ymd.y,
                retrocedidoUnSiglo: expanded.shifted,
            },
        });
        parsed = expanded.ymd;
    }

    return finish(parsed, "text", matched, column, policy, opts, cfg, issues, base, rejectLevel);
}

/**
 * Pivot at TWO_DIGIT_PIVOT, then force the result into the past.
 *
 * The "past" reference is the column's own plausible upper bound rather than the period
 * end itself: 03 §3.5 explicitly admits a start (or a scheduled cese) up to one month
 * after the period, and measuring against the bare period end would shove a legitimate
 * next-month start back a century and reject it as implausible.
 */
function expandTwoDigitYear(ymd, column, policy, opts, cfg) {
    const yy = ymd.y % 100;
    const y = yy <= TWO_DIGIT_PIVOT ? 2000 + yy : 1900 + yy;
    const candidate = { y, m: ymd.m, d: ymd.d };
    const range = plausibleRange(column, opts.period, cfg);
    const cmp = compareYMD(candidate, range.max);
    if (cmp === 1) return { ymd: { y: y - 100, m: ymd.m, d: ymd.d }, shifted: true };
    return { ymd: candidate, shifted: false };
}

/** Shared tail: plausibility check, then build the accepted result. */
function finish(ymd, source, matchedFormat, column, policy, opts, cfg, issues, base, rejectLevel) {
    const serial = dateToSerial(ymd);
    if (serial === null) {
        record(issues, rejectLevel, {
            code: CODE.DATE_UNPARSEABLE,
            message: `Fecha fuera del rango representable por Excel en ${column}.`,
            ...base,
            detalle: { componentes: ymd, origen: source },
        });
        return result({ code: CODE.DATE_UNPARSEABLE, matchedFormat });
    }

    const range = plausibleRange(column, opts.period, cfg);
    if (serial < range.minSerial || serial > range.maxSerial) {
        // 03 §8.3: an out-of-range date is a WARNING - the row survives with the field
        // nulled - but the parsed value goes into the report so the operator can see
        // WHAT it parsed to and judge typo vs genuine outlier.
        record(issues, "warning", {
            code: CODE.DATE_IMPLAUSIBLE,
            message: `Fecha fuera del rango admisible para ${column}.`,
            ...base,
            detalle: {
                interpretada: fmtYMD(ymd),
                serial,
                minimo: fmtYMD(range.min),
                maximo: fmtYMD(range.max),
                origen: source,
                formato: matchedFormat,
            },
        });
        // parsedSerial is carried out of the rejection deliberately: 05 §8 Q6 (a cese date
        // in the future - is it a typo or a scheduled termination?) is still open, and this
        // lets the caller implement "accept, flag, count in its own period" without dates.js
        // changing. It is NOT the accepted value - ok is false and serial is null.
        return result({ code: CODE.DATE_IMPLAUSIBLE, matchedFormat, parsedSerial: serial, parsedYMD: ymd });
    }

    return result({
        ok: true,
        serial,
        ymd,
        matchedFormat: matchedFormat || source,
    });
}

function noteTruncation(H, M, S, issues, base, column) {
    if (!H && !M && !S) return;
    record(issues, "info", {
        code: CODE.DATE_FRACTIONAL_TRUNCATED,
        message: `Fecha con hora en ${column}; se trunca al dia.`,
        ...base,
        detalle: { hora: formatClock(H, M, S) },
    });
}

function formatClock(H, M, S) {
    const p = n => String(n).padStart(2, "0");
    return `${p(H)}:${p(M)}:${p(S)}`;
}

/** dd/mm/yyyy, matching the template's own display format. Report text only. */
function fmtYMD(ymd) {
    const p = (n, w) => String(n).padStart(w, "0");
    return `${p(ymd.d, 2)}/${p(ymd.m, 2)}/${p(ymd.y, 4)}`;
}

module.exports = {
    // primary
    parseDateCell,
    assertDateSystem,

    // serial helpers - output/template.js writes serials, metrics.js compares them
    serialToYMD,
    dateToSerial,
    compareYMD,
    addMonthsYMD,
    addYearsYMD,
    isValidYMD,
    daysInMonth,
    isLeapYear,

    // period / plausibility
    resolvePeriodEnd,
    plausibleRange,

    // constants, exported for tests and for the run report
    TEXT_FORMATS,
    TWO_DIGIT_FORMATS,
    TWO_DIGIT_PIVOT,
    DATE_POLICY,
    WORD_SENTINELS,
    PUNCTUATION_SENTINEL,
    MIN_SERIAL,
    MAX_SERIAL,
    fmtYMD,
};

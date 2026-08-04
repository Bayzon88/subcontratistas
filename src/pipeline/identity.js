"use strict";
/**
 * Peruvian identifiers and the canonical person key.
 *
 * Three jobs, all pure:
 *  - `normalizeRuc`  - 11 digits, emitted as TEXT, SUNAT mod-11 check digit.
 *  - `normalizeDni`  - emitted as TEXT, length validated CONDITIONALLY on document type
 *                      (DNI = 8, CE = 9-12), because a blanket 8-digit rule calls the
 *                      134 legitimate CE values errors and hides the 4 real ones.
 *  - `personKey`     - the identity key the dedupe collapses on (05 §3 Phase 3 task 7).
 *
 * Why these are text and not numbers: BUG-23. In the last run `Nro. DNI / CE` arrived
 * as a *number* in 1,356 rows and `RUC` in 3,276, so `09994533` was already `9994533`
 * before this app ever saw the cell. Everything here returns strings; nothing here
 * returns a number, ever.
 *
 * Why nothing here throws or drops: a failing check digit is a data-quality signal, not
 * grounds for removing a company's entire workforce from a compliance report
 * (05 §8 Q7). Every function returns a descriptor carrying `code` and `severity` drawn
 * from `issues.js`, and the *caller* - which is the only layer that knows the source
 * cell, file and subcontratista - turns it into the IssueList entry. That keeps this
 * module pure and keeps the provenance where it belongs.
 *
 * `valid` is a verdict, NOT an instruction. `text` is always emitted regardless.
 */

const config = require("../config");
const { INDEX_BY_CANONICAL } = require("./columns");
const { SEVERITY, CODE } = require("./issues");

/** Canonical column names this module reads off a record. columns.js owns the spelling. */
const DNI_COLUMN = "Nro. DNI / CE";
const NAME_COLUMN = "APELLIDOS Y NOMBRES";
for (const name of [DNI_COLUMN, NAME_COLUMN]) {
    // Load-time assertion: a programming error, not a data error, so throwing is correct.
    if (!INDEX_BY_CANONICAL.has(name)) {
        throw new Error(`identity.js: "${name}" is not a canonical column - columns.js changed under it`);
    }
}

/** SUNAT mod-11 weights, applied to the first 10 digits (03 §2 row 1). */
const RUC_WEIGHTS = Object.freeze([5, 4, 3, 2, 7, 6, 5, 4, 3, 2]);
const RUC_DIGITS = 11;

/** DNI is exactly 8. CE is 9 with significant leading zeros; the measured population
 *  runs 9-10, and the band is held open to 12 so a longer foreign document is reported
 *  as an INFO rather than mistaken for damage (03 §2 row 4, 05 §3 Phase 2 task 6). */
const DNI_DIGITS = 8;
const CE_MIN_DIGITS = 9;
const CE_MAX_DIGITS = 12;

/** The two accepted identity keys. `config.IDENTITY_KEY` picks the delivered one. */
const IDENTITY_MODES = Object.freeze(["name", "dni"]);

/**
 * Raw cell value -> a bare identifier string.
 *
 * Numbers become their integer decimal form with no separators and no exponent (an
 * 11-digit RUC is ~2e10, far inside the safe-integer range, so `String` is exact).
 * Whitespace is removed *everywhere*, not just at the ends: it is never significant
 * inside an identifier, and the last run carried `"20549351027    "`, `"20548820929 "`
 * and `"20602677126 "` as distinct raw values purely because of trailing spaces.
 */
function compactIdentifier(raw) {
    if (raw === null || raw === undefined) return "";
    if (typeof raw === "number") {
        // Never emit "NaN"/"Infinity" into the workbook (BUG-20 is exactly that failure).
        if (!Number.isFinite(raw)) return "";
        return String(raw);
    }
    return String(raw).replace(/\s+/g, "");
}

/**
 * The SUNAT mod-11 check digit. weights [5,4,3,2,7,6,5,4,3,2] over digits 1-10,
 * r = 11 - (sum % 11), 10 maps to 0 and 11 maps to 1, compared against digit 11.
 *
 * Verified against three known-real RUCs (04 §H: SUNAT 20131312955, Telefonica del Peru
 * 20100017491, Backus 20100113610) and against the 146 distinct non-blank trimmed RUC
 * values in the last run: 122 pass, 23 fail here, 1 never reaches here because it is not
 * 11 digits.
 *
 * @param {string} text 11 digits, already compacted
 * @returns {boolean}
 */
function rucCheckDigit(text) {
    if (typeof text !== "string" || !/^\d{11}$/.test(text)) return false;
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += RUC_WEIGHTS[i] * (text.charCodeAt(i) - 48);
    let r = 11 - (sum % 11);
    if (r === 10) r = 0;
    else if (r === 11) r = 1;
    return r === text.charCodeAt(10) - 48;
}

/**
 * Normalize one `RUC` cell.
 *
 * Note what this deliberately does NOT do: it does not left-pad short values to 11.
 * A Peruvian RUC always starts with 10, 15, 16, 17 or 20, so a leading zero cannot
 * have been lost to numeric coercion and zero-padding could only ever manufacture a
 * plausible-looking wrong answer. The one measured format failure is `71514158` - an
 * 8-digit DNI sitting in the RUC column - and it must stay reported as a FORMAT error,
 * not laundered into `00071514158` and reported as a check-digit error.
 *
 * @param {*} raw the raw cell value
 * @returns {{text: string, valid: boolean, reason: string|null, code: string|null, severity: string|null}}
 */
function normalizeRuc(raw) {
    const text = compactIdentifier(raw);
    if (text === "") {
        return descriptor("", false, "RUC is empty", CODE.REQUIRED_MISSING, SEVERITY.WARNING);
    }
    if (!/^\d+$/.test(text)) {
        return descriptor(text, false, `RUC "${text}" contains non-digit characters`,
            CODE.RUC_FORMAT, SEVERITY.WARNING);
    }
    if (text.length !== RUC_DIGITS) {
        return descriptor(text, false, `RUC "${text}" has ${text.length} digits, expected ${RUC_DIGITS}`,
            CODE.RUC_FORMAT, SEVERITY.WARNING);
    }
    if (!rucCheckDigit(text)) {
        // WARNING, never a rejection (05 §8 Q7): ~16% of distinct RUCs fail this today
        // and dropping them would delete whole subcontratistas from the report.
        return descriptor(text, false, `RUC ${text} fails the SUNAT mod-11 check digit`,
            CODE.RUC_CHECK_DIGIT, SEVERITY.WARNING);
    }
    return descriptor(text, true, null, null, null);
}

/**
 * Normalize one `Nro. DNI / CE` cell.
 *
 * Length bands, from the measured distribution over 4,342 non-empty values
 * (4 at 7 chars, 4,202 at 8, 134 at 9, 2 at 10):
 *   - exactly 8 digits  -> DNI, clean, no issue;
 *   - 9-12 digits       -> CE, accepted with an INFO. These are NOT errors; the measured
 *                          9-character population is zero-padded CE numbers such as
 *                          `001079894`, and calling them errors is what a blanket
 *                          8-digit rule gets wrong;
 *   - fewer than 8      -> zero-padded to 8 *and* flagged WARNING. All four measured
 *                          7-character values arrive from numeric cells, so the padding
 *                          restores the leading zero BUG-23 destroyed - but the padding
 *                          is an inference, so it is reported, not silently applied;
 *   - anything else     -> flagged WARNING with the raw text kept (03 §2 row 4). The
 *                          measured junk is real: `*09983472` and `"000668292` both
 *                          appear in the last run. They are damage, not a second
 *                          document type, and inventing a repair for them would hide
 *                          a source-workbook defect the operator needs to see.
 *
 * `issues.js` has one DNI code (`DNI_LENGTH`) and this module must not add to it, so
 * every shape complaint carries that code and says the specifics in `reason`.
 *
 * @param {*} raw the raw cell value
 * @returns {{text: string, valid: boolean, reason: string|null, code: string|null,
 *            severity: string|null, kind: "DNI"|"CE"|null, padded: boolean}}
 */
function normalizeDni(raw) {
    const compact = compactIdentifier(raw);
    if (compact === "") {
        return dniDescriptor("", false, "Nro. DNI / CE is empty",
            CODE.REQUIRED_MISSING, SEVERITY.WARNING, null, false);
    }
    if (!/^\d+$/.test(compact)) {
        return dniDescriptor(compact, false,
            `Nro. DNI / CE "${compact}" contains non-digit characters; kept as received`,
            CODE.DNI_LENGTH, SEVERITY.WARNING, null, false);
    }
    const n = compact.length;
    if (n === DNI_DIGITS) {
        return dniDescriptor(compact, true, null, null, null, "DNI", false);
    }
    if (n >= CE_MIN_DIGITS && n <= CE_MAX_DIGITS) {
        return dniDescriptor(compact, true,
            `Nro. DNI / CE "${compact}" has ${n} digits: accepted as a CE, not a DNI`,
            CODE.DNI_LENGTH, SEVERITY.INFO, "CE", false);
    }
    if (n < DNI_DIGITS) {
        const padded = compact.padStart(DNI_DIGITS, "0");
        return dniDescriptor(padded, false,
            `Nro. DNI / CE "${compact}" has only ${n} digits: probable leading zero lost to ` +
            `numeric coercion (BUG-23); zero-padded to "${padded}", verify against the source`,
            CODE.DNI_LENGTH, SEVERITY.WARNING, "DNI", true);
    }
    return dniDescriptor(compact, false,
        `Nro. DNI / CE "${compact}" has ${n} digits: too long for a DNI (${DNI_DIGITS}) ` +
        `or a CE (${CE_MIN_DIGITS}-${CE_MAX_DIGITS})`,
        CODE.DNI_LENGTH, SEVERITY.WARNING, null, false);
}

/**
 * The comparison form of `APELLIDOS Y NOMBRES`: NFC, CR/LF/tab to space, internal
 * whitespace runs collapsed to one space, trimmed, upper-cased.
 *
 * Accents are deliberately NOT folded, for two reasons. First, the template counts
 * people with `COUNTIF(Tabla2[APELLIDOS Y NOMBRES], ...)`, so this key must equal the
 * string that is written to column E or the JS headcount and the workbook's own
 * headcount diverge by construction. Second, `Ñ` is a distinct Spanish letter, not an
 * accented `N` - folding it merges the surnames PEÑA and PENA, which are different
 * people. NFC alone is lossless and makes the two Unicode spellings of `Ñ` one key.
 *
 * Measured effect on the last run: 4,372 distinct raw names collapse to 4,358 - the 14
 * pairs BUG-25 describes, e.g. `"MELENDEZ MARTINEZ YAMIR ALEXANDER "` with a trailing
 * space and `"FLORES  MALLQUI MAYU VICENT"` with a doubled internal space.
 *
 * @param {*} raw
 * @returns {string} "" when there is no name
 */
function normalizeNameKey(raw) {
    if (raw === null || raw === undefined) return "";
    return String(raw)
        .normalize("NFC")
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toUpperCase();
}

/**
 * The identity key, with its provenance.
 *
 * mode "name" (the `config.IDENTITY_KEY` default, 05 §8 Q3 recommendation): the
 * normalized name. It reproduces the number the client has already seen, because it is
 * the same notion of identity the template itself uses.
 *
 * mode "dni": the normalized DNI text, falling back to the name key when the DNI is
 * absent. The fallback is not optional and not cosmetic: 723 of 5,065 rows in the last
 * run had no DNI at all, and a pure DNI key would give all 723 the empty-string key and
 * collapse them into one person - a fresh instance of the exact BUG-04 arithmetic that
 * turns 643 real workers into a headcount of 1. `fallback` is returned so metrics.js can
 * count how often it fires and publish that alongside the DNI-keyed headcount.
 *
 * An empty `key` means "this record has no identity at all". Callers MUST NOT collapse
 * two records on an empty key.
 *
 * @param {object} record a canonical record (raw or already normalized - both
 *                        normalizers are idempotent)
 * @param {"name"|"dni"} [mode] defaults to config.IDENTITY_KEY
 * @returns {{key: string, mode: string, basis: "name"|"dni"|null, fallback: boolean, reason: string|null}}
 */
function personKeyDetail(record, mode) {
    const m = mode === undefined || mode === null ? config.IDENTITY_KEY : mode;
    if (!IDENTITY_MODES.includes(m)) {
        // Configuration error, not a data error - fail loudly rather than pick a default.
        throw new TypeError(`unknown identity key mode "${m}", expected one of ${IDENTITY_MODES.join(", ")}`);
    }
    const source = record || {};
    const nameKey = normalizeNameKey(source[NAME_COLUMN]);

    if (m === "name") {
        return {
            key: nameKey,
            mode: m,
            basis: nameKey === "" ? null : "name",
            fallback: false,
            reason: nameKey === "" ? "record has no APELLIDOS Y NOMBRES" : null,
        };
    }

    // A malformed DNI still identifies the row it came from, so the key uses whatever
    // text survived; only a genuinely absent one triggers the fallback.
    const dni = normalizeDni(source[DNI_COLUMN]);
    if (dni.text !== "") {
        return { key: dni.text, mode: m, basis: "dni", fallback: false, reason: null };
    }
    if (nameKey !== "") {
        return {
            key: nameKey,
            mode: m,
            basis: "name",
            fallback: true,
            reason: "no Nro. DNI / CE: fell back to the normalized APELLIDOS Y NOMBRES key",
        };
    }
    return {
        key: "",
        mode: m,
        basis: null,
        fallback: true,
        reason: "record has neither Nro. DNI / CE nor APELLIDOS Y NOMBRES",
    };
}

/**
 * The identity key alone. See `personKeyDetail` for the fallback semantics and for the
 * `fallback` flag metrics.js needs.
 *
 * @param {object} record
 * @param {"name"|"dni"} [mode] defaults to config.IDENTITY_KEY
 * @returns {string} "" when the record has no identity at all
 */
function personKey(record, mode) {
    return personKeyDetail(record, mode).key;
}

function descriptor(text, valid, reason, code, severity) {
    return { text, valid, reason, code, severity };
}

function dniDescriptor(text, valid, reason, code, severity, kind, padded) {
    return { text, valid, reason, code, severity, kind, padded };
}

module.exports = {
    RUC_WEIGHTS,
    RUC_DIGITS,
    DNI_DIGITS,
    CE_MIN_DIGITS,
    CE_MAX_DIGITS,
    IDENTITY_MODES,
    DNI_COLUMN,
    NAME_COLUMN,
    compactIdentifier,
    rucCheckDigit,
    normalizeRuc,
    normalizeDni,
    normalizeNameKey,
    personKey,
    personKeyDetail,
};

"use strict";
/**
 * Tests for src/pipeline/identity.js, driven from src/test/cases/identity.json.
 *
 * The case table is committed data (05 §3 Phase 0 task 3) and every value in it marked
 * "measured" comes verbatim from src/ReporteConsolidado.xlsx - the last real run. The
 * point of the table is that the assertions are written once here and the data grows
 * without touching this file.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const config = require("../config");
const { CODE, SEVERITY } = require("../pipeline/issues");
const {
    RUC_WEIGHTS,
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
} = require("../pipeline/identity");

const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, "cases", "identity.json"), "utf8"));

/** expectedIssue -> the {code, severity} pair the descriptor must carry. */
function expectedCodeAndSeverity(expectedIssue) {
    if (!expectedIssue) return { code: null, severity: null };
    assert.ok(CODE[expectedIssue.code], `case table names an unknown issue code: ${expectedIssue.code}`);
    assert.ok(SEVERITY[expectedIssue.severity], `case table names an unknown severity: ${expectedIssue.severity}`);
    return { code: CODE[expectedIssue.code], severity: SEVERITY[expectedIssue.severity] };
}

// ---------------------------------------------------------------------------
// RUC
// ---------------------------------------------------------------------------

test("normalizeRuc: every case in the committed table", async (t) => {
    for (const c of CASES.ruc) {
        await t.test(c.id, () => {
            const got = normalizeRuc(c.input);
            assert.equal(typeof got.text, "string", "text is always a string - RUC is emitted as TEXT");
            assert.equal(got.text, c.expected.text);
            assert.equal(got.valid, c.expected.valid);
            const { code, severity } = expectedCodeAndSeverity(c.expectedIssue);
            assert.equal(got.code, code);
            assert.equal(got.severity, severity);
            assert.equal(got.reason === null, c.expectedIssue === null,
                "a reason is present exactly when there is something to report");
        });
    }
});

test("rucCheckDigit: the SUNAT weights are the ones the plan specifies", () => {
    assert.deepEqual([...RUC_WEIGHTS], [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]);
    assert.ok(Object.isFrozen(RUC_WEIGHTS));
});

test("rucCheckDigit: the three known-real RUCs from 04 §H all pass", () => {
    // SUNAT, Telefonica del Peru, Backus.
    for (const ruc of ["20131312955", "20100017491", "20100113610"]) {
        assert.equal(rucCheckDigit(ruc), true, `${ruc} should pass`);
    }
});

test("rucCheckDigit: the three RUCs from the repo's own ReporteConsolidado.xlsx all pass", () => {
    for (const ruc of ["20604191883", "20547422407", "20101155588"]) {
        assert.equal(rucCheckDigit(ruc), true, `${ruc} should pass`);
    }
});

test("rucCheckDigit: rejects anything that is not 11 digits of string", () => {
    for (const bad of ["", "2013131295", "201313129551", "2013131295A", " 20131312955",
        20131312955, null, undefined, {}]) {
        assert.equal(rucCheckDigit(bad), false, `${String(bad)} must not pass`);
    }
});

test("rucCheckDigit: both mod-11 remainder mappings are exercised", () => {
    // r === 10 maps to check digit 0, r === 11 maps to 1. Values taken from the corpus
    // prefixes so the branches are hit with real data, not contrived digits.
    const r10 = CASES.ruc.find(c => c.id === "check-digit-remainder-maps-to-zero");
    const r11 = CASES.ruc.find(c => c.id === "check-digit-remainder-maps-to-one");
    assert.equal(r10.input.slice(-1), "0");
    assert.equal(r11.input.slice(-1), "1");
    assert.equal(rucCheckDigit(r10.input), true);
    assert.equal(rucCheckDigit(r11.input), true);
    // ...and the un-mapped raw remainders must not also validate.
    assert.equal(rucCheckDigit(r10.input.slice(0, 10) + "1"), false);
    assert.equal(rucCheckDigit(r11.input.slice(0, 10) + "0"), false);
});

test("normalizeRuc: the measured corpus splits exactly 122 pass / 23 check-digit / 1 format", () => {
    const { pass, failCheckDigit, failFormat } = CASES.rucCorpus;
    const all = [...pass, ...failCheckDigit, ...failFormat];
    assert.equal(new Set(all).size, all.length, "the committed corpus must be distinct values");
    assert.equal(all.length, 146, "146 distinct non-blank trimmed RUC values in the last run");

    let ok = 0, badCheck = 0, badFormat = 0;
    for (const v of all) {
        const r = normalizeRuc(v);
        assert.equal(r.text, v, "the RUC text is emitted unchanged");
        if (r.valid) ok++;
        else if (r.code === CODE.RUC_CHECK_DIGIT) badCheck++;
        else if (r.code === CODE.RUC_FORMAT) badFormat++;
        else assert.fail(`unexpected classification for ${v}: ${r.code}`);
    }
    assert.equal(ok, 122);
    assert.equal(badCheck, 23);
    assert.equal(badFormat, 1);
    assert.equal(pass.length, 122);
    assert.equal(failCheckDigit.length, 23);
    assert.equal(failFormat.length, 1);
    for (const v of pass) assert.equal(normalizeRuc(v).valid, true, `${v} should pass`);
    for (const v of failCheckDigit) assert.equal(normalizeRuc(v).code, CODE.RUC_CHECK_DIGIT, v);
    for (const v of failFormat) assert.equal(normalizeRuc(v).code, CODE.RUC_FORMAT, v);
});

test("normalizeRuc: a failing check digit is a WARNING, never a rejection (05 §8 Q7)", () => {
    for (const v of CASES.rucCorpus.failCheckDigit) {
        const r = normalizeRuc(v);
        assert.equal(r.severity, SEVERITY.WARNING);
        assert.equal(r.text, v, "the value survives so the subcontratista's rows survive with it");
    }
    // The whole point: nothing in this module throws for a data problem.
    assert.doesNotThrow(() => normalizeRuc("nonsense"));
    assert.doesNotThrow(() => normalizeRuc({}));
});

test("normalizeRuc: short values are NOT zero-padded to 11", () => {
    // A RUC always starts with 10/15/16/17/20, so a lost leading zero is impossible and
    // padding could only manufacture a plausible wrong answer. The measured format
    // failure is an 8-digit DNI in the RUC column and must stay a FORMAT error.
    const r = normalizeRuc(71514158);
    assert.equal(r.text, "71514158");
    assert.equal(r.code, CODE.RUC_FORMAT);
    assert.notEqual(r.text, "00071514158");
});

test("normalizeRuc: numeric and text cells of the same RUC produce the same text", () => {
    // BUG-23: the same RUC appears as the number 20604191883 in one row and the text
    // "20547422407" in another, so exact matching across the column fails today.
    assert.equal(normalizeRuc(20604191883).text, normalizeRuc("20604191883").text);
    assert.equal(normalizeRuc("20604191883 ").text, normalizeRuc(" 20604191883").text);
});

// ---------------------------------------------------------------------------
// DNI / CE
// ---------------------------------------------------------------------------

test("normalizeDni: every case in the committed table", async (t) => {
    for (const c of CASES.dni) {
        await t.test(c.id, () => {
            const got = normalizeDni(c.input);
            assert.equal(typeof got.text, "string", "text is always a string - the DNI is emitted as TEXT");
            assert.equal(got.text, c.expected.text);
            assert.equal(got.valid, c.expected.valid);
            assert.equal(got.kind, c.expected.kind);
            assert.equal(got.padded, c.expected.padded);
            const { code, severity } = expectedCodeAndSeverity(c.expectedIssue);
            assert.equal(got.code, code);
            assert.equal(got.severity, severity);
            if (c.expectedReasonMatch) {
                assert.match(got.reason, new RegExp(c.expectedReasonMatch, "i"));
            }
        });
    }
});

test("normalizeDni: 09994533 does not become 9994533 (BUG-23)", () => {
    const r = normalizeDni("09994533");
    assert.equal(r.text, "09994533");
    assert.equal(r.valid, true);
    assert.equal(r.kind, "DNI");
    assert.equal(r.code, null);
    // ...and the number the same cell becomes once Excel has coerced it is repaired,
    // loudly, back to the same 8 characters.
    const coerced = normalizeDni(9994533);
    assert.equal(coerced.text, "09994533");
    assert.equal(coerced.padded, true);
    assert.equal(coerced.severity, SEVERITY.WARNING);
    assert.match(coerced.reason, /leading zero/i);
});

test("normalizeDni: length validation is conditional on document type", () => {
    assert.equal(normalizeDni("41876311").kind, "DNI");     // 8 -> DNI, clean
    assert.equal(normalizeDni("41876311").code, null);
    assert.equal(normalizeDni("001079894").kind, "CE");     // 9 -> CE, INFO not error
    assert.equal(normalizeDni("001079894").valid, true);
    assert.equal(normalizeDni("001079894").severity, SEVERITY.INFO);
    assert.equal(normalizeDni("0006682921").kind, "CE");    // 10 -> still the CE band
    assert.equal(normalizeDni("0006682921").severity, SEVERITY.INFO);
});

test("normalizeDni: the measured length distribution classifies as the plan says", () => {
    // 4,342 non-empty values in the last run: 4 at 7 characters, 4,202 at 8, 134 at 9,
    // 2 at 10. Rebuilt synthetically at full size, plus the 723 absent values, so the
    // whole 5,065-row shape is exercised in one pass.
    const rows = [];
    for (let i = 0; i < 4; i++) rows.push(1000000 + i);                       // 7 digits, numeric cells
    for (let i = 0; i < 4202; i++) rows.push(String(10000000 + i));           // 8 characters
    for (let i = 0; i < 134; i++) rows.push("00" + String(1000000 + i));      // 9 characters, zero-padded CE
    rows.push("\"000668292", "\"000590927");                                  // the 2 measured 10-character values
    for (let i = 0; i < 723; i++) rows.push(null);                            // absent
    assert.equal(rows.length, 5065);

    const tally = { clean: 0, ce: 0, padded: 0, junk: 0, absent: 0 };
    for (const raw of rows) {
        const r = normalizeDni(raw);
        if (r.text === "") tally.absent++;
        else if (r.padded) tally.padded++;
        else if (r.kind === "CE") tally.ce++;
        else if (r.valid) tally.clean++;
        else tally.junk++;
        assert.notEqual(r.text, "NaN");
        assert.notEqual(r.text, "undefined");
    }
    assert.deepEqual(tally, { clean: 4202, ce: 134, padded: 4, junk: 2, absent: 723 });
});

test("normalizeDni: an absent DNI is REQUIRED_MISSING, not a length complaint", () => {
    for (const raw of [null, undefined, "", "   ", " "]) {
        const r = normalizeDni(raw);
        assert.equal(r.text, "");
        assert.equal(r.code, CODE.REQUIRED_MISSING);
        assert.equal(r.severity, SEVERITY.WARNING);
        assert.equal(r.kind, null);
    }
});

test("normalizeDni / normalizeRuc: never NaN, never a number, never 'undefined'", () => {
    // BUG-20 is exactly this failure mode, written into the workbook.
    for (const raw of [NaN, Infinity, -Infinity, undefined, null, {}, [], true, "  "]) {
        for (const fn of [normalizeDni, normalizeRuc]) {
            const r = fn(raw);
            assert.equal(typeof r.text, "string");
            assert.doesNotMatch(r.text, /NaN|Infinity|undefined/);
            assert.equal(r.valid, false);
            assert.ok(CODE[r.code], `every rejected value carries an issue code, got ${r.code}`);
        }
    }
});

// ---------------------------------------------------------------------------
// name key
// ---------------------------------------------------------------------------

test("normalizeNameKey: every case in the committed table", async (t) => {
    for (const c of CASES.nameKey) {
        await t.test(c.id, () => {
            assert.equal(normalizeNameKey(c.input), c.expected);
        });
    }
});

test("normalizeNameKey: the trailing-space duplicate pair collapses to one key (BUG-25)", () => {
    assert.equal(normalizeNameKey("HUARCAYA COCCHE JESUS "), normalizeNameKey("HUARCAYA COCCHE JESUS"));
});

test("normalizeNameKey: accents are folded away by NFC but never stripped", () => {
    // Ñ is a letter, not an accent: PEÑA and PENA are different surnames and must stay
    // different keys, or the dedupe merges two people.
    assert.notEqual(normalizeNameKey("PEÑA RAMIREZ JOSE"), normalizeNameKey("PENA RAMIREZ JOSE"));
    assert.notEqual(normalizeNameKey("GARCÍA LOPEZ ANA"), normalizeNameKey("GARCIA LOPEZ ANA"));
    // ...but the two Unicode spellings of the same letter are one key.
    assert.equal(normalizeNameKey("PEÑA RAMIREZ JOSE"), normalizeNameKey("PEÑA RAMIREZ JOSE"));
});

test("normalizeNameKey: idempotent", () => {
    for (const c of CASES.nameKey) {
        const once = normalizeNameKey(c.input);
        assert.equal(normalizeNameKey(once), once);
    }
});

// ---------------------------------------------------------------------------
// personKey
// ---------------------------------------------------------------------------

test("personKey: every case in the committed table", async (t) => {
    for (const c of CASES.personKey) {
        await t.test(c.id, () => {
            assert.equal(personKey(c.record, c.mode), c.expected);
            const d = personKeyDetail(c.record, c.mode);
            assert.equal(d.key, c.expected);
            assert.equal(d.mode, c.mode);
            assert.equal(d.basis, c.expectedBasis);
            assert.equal(d.fallback, c.expectedFallback);
            assert.equal(d.reason === null, d.fallback === false && d.basis !== null,
                "a reason is present exactly when the key was not taken from its own mode's field");
        });
    }
});

test("personKey: the default mode is config.IDENTITY_KEY", () => {
    assert.ok(IDENTITY_MODES.includes(config.IDENTITY_KEY));
    const record = { [NAME_COLUMN]: "HUARCAYA COCCHE JESUS ", [DNI_COLUMN]: "41876311" };
    assert.equal(personKey(record), personKey(record, config.IDENTITY_KEY));
    assert.equal(personKeyDetail(record).mode, config.IDENTITY_KEY);
});

test("personKey: an unknown mode is a configuration error and throws", () => {
    // Not a data problem - nothing in the input can reach this, only a bad IDENTITY_KEY.
    assert.throws(() => personKey({}, "ruc"), TypeError);
    assert.throws(() => personKey({}, ""), TypeError);
});

test("personKey: name mode is what the template counts, DNI mode is the alternative", () => {
    // A tiny stand-in for the run: rows 1-2 are one worker spelled two ways (the
    // measured trailing-space pathology), rows 3-4 are two genuine homonyms carrying
    // different documents, row 5 has no DNI at all.
    const rows = [
        { [NAME_COLUMN]: "HUARCAYA COCCHE JESUS ", [DNI_COLUMN]: "41876311" },
        { [NAME_COLUMN]: "HUARCAYA COCCHE JESUS", [DNI_COLUMN]: 41876311 },
        { [NAME_COLUMN]: "FLORES QUISPE JUAN CARLOS", [DNI_COLUMN]: "10607258" },
        { [NAME_COLUMN]: "FLORES QUISPE JUAN CARLOS", [DNI_COLUMN]: "45113812" },
        { [NAME_COLUMN]: "MELENDEZ MARTINEZ YAMIR ALEXANDER", [DNI_COLUMN]: null },
    ];
    const nameKeys = rows.map(r => personKey(r, "name"));
    const dniDetails = rows.map(r => personKeyDetail(r, "dni"));

    // Name mode: the two spellings of one worker collapse (which is the fix), and the
    // two homonyms stay merged (which is the known cost, BUG-25). 3 distinct keys.
    assert.equal(new Set(nameKeys).size, 3);
    // DNI mode: the homonyms separate, so 4 distinct keys - and the gap between the two
    // counts is exactly what metrics.js has to publish (05 §8 Q3).
    assert.equal(new Set(dniDetails.map(d => d.key)).size, 4);

    // The fallback is countable.
    assert.equal(dniDetails.filter(d => d.fallback).length, 1);
    assert.equal(dniDetails.find(d => d.fallback).basis, "name");
});

test("personKey: DNI mode never collapses the DNI-less rows onto one key", () => {
    // 723 of 5,065 rows had no DNI in the last run. Without the fallback they would all
    // key on "" and become one person - the BUG-04 arithmetic all over again.
    const rows = Array.from({ length: 723 }, (_, i) => ({
        [NAME_COLUMN]: `TRABAJADOR SIN DOCUMENTO ${i}`,
        [DNI_COLUMN]: null,
    }));
    const details = rows.map(r => personKeyDetail(r, "dni"));
    assert.equal(new Set(details.map(d => d.key)).size, 723);
    assert.equal(details.every(d => d.fallback && d.basis === "name"), true);
});

test("personKey: a record with no identity at all yields an empty key, flagged", () => {
    for (const mode of IDENTITY_MODES) {
        const d = personKeyDetail({ [NAME_COLUMN]: "  ", [DNI_COLUMN]: null }, mode);
        assert.equal(d.key, "");
        assert.equal(d.basis, null);
        assert.match(d.reason, /no/i);
    }
});

test("personKey: works on raw records as well as normalized ones", () => {
    // Both normalizers are idempotent, so the key is the same before and after the
    // schema layer has cleaned the record up.
    const raw = { [NAME_COLUMN]: "  MARIÑO CAJAS  JEAN   PIERO ", [DNI_COLUMN]: 41876311 };
    const normalized = { [NAME_COLUMN]: "MARIÑO CAJAS JEAN PIERO", [DNI_COLUMN]: "41876311" };
    for (const mode of IDENTITY_MODES) {
        assert.equal(personKey(raw, mode), personKey(normalized, mode));
    }
});

// ---------------------------------------------------------------------------
// purity
// ---------------------------------------------------------------------------

test("identity.js is deterministic and does not mutate its input", () => {
    const record = { [NAME_COLUMN]: "HUARCAYA COCCHE JESUS ", [DNI_COLUMN]: 9994533 };
    const before = JSON.stringify(record);
    for (let i = 0; i < 3; i++) {
        assert.deepEqual(normalizeRuc("20504039123"), normalizeRuc("20504039123"));
        assert.deepEqual(normalizeDni(9994533), normalizeDni(9994533));
        assert.equal(personKey(record, "dni"), "09994533");
    }
    assert.equal(JSON.stringify(record), before);
});

test("compactIdentifier: whitespace is never significant inside an identifier", () => {
    assert.equal(compactIdentifier("  2060 4191\t883\n"), "20604191883");
    assert.equal(compactIdentifier("  "), "");
    assert.equal(compactIdentifier(20604191883), "20604191883");
    assert.equal(compactIdentifier(null), "");
    assert.equal(compactIdentifier(undefined), "");
});

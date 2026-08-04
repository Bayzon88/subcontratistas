"use strict";
/**
 * Tests for src/pipeline/dedupe.js, driven from src/test/cases/dedupe.json.
 *
 * The case table is committed data (05 §3 Phase 0 task 3). Everything in it marked
 * "measured" comes from src/ReporteConsolidado.xlsx - the last real run - and the
 * `corpus` block holds that run's full name-key multiplicity histogram, so the
 * corpus-scale assertions run without opening the 3.7 MB workbook.
 *
 * The load-bearing assertions here are the two the old pipeline could not make:
 *   - two byte-identical workers whose source workbooks list columns in different order
 *     collapse (BUG-21: JSON.stringify serializes in key-insertion order and does not);
 *   - shuffling the input changes nothing about the output.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const config = require("../config");
const { CANONICAL } = require("../pipeline/columns");
const { CODE, SEVERITY, IssueList } = require("../pipeline/issues");
const { personKey, NAME_COLUMN, DNI_COLUMN } = require("../pipeline/identity");
const {
    SCOPES,
    DEFAULT_SCOPE,
    KEY_COLUMN_BY_MODE,
    dedupe,
    countDistinct,
    keyCensus,
    conservationCheck,
    completeness,
    isPopulated,
    sourceOf,
} = require("../pipeline/dedupe");

const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, "cases", "dedupe.json"), "utf8"));
const FIELD_MAP = CASES.fieldMap;
const CORPUS = CASES.corpus;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compact case spec -> a full canonical record. Unmentioned columns are null. */
function buildRecord(spec) {
    const record = {};
    for (const column of CANONICAL) record[column] = null;
    for (const [key, value] of Object.entries(spec)) {
        if (key === "sub" || key === "archivo" || key === "hoja" || key === "fila") continue;
        const column = FIELD_MAP[key];
        assert.ok(column, `case table uses an unmapped field "${key}"`);
        record[column] = value;
    }
    record.provenance = {
        subcontratista: spec.sub ?? null,
        archivo: spec.archivo ?? null,
        hoja: spec.hoja ?? null,
        filaOrigen: spec.fila ?? null,
        celdaAncla: null,
    };
    return record;
}

/** "SUB/archivo.xlsx:12" - the identity of a source row in the assertions. */
function sourceLabel(record) {
    const s = sourceOf(record);
    return `${s.subcontratista ?? "(sin subcontratista)"}/${s.archivo ?? "(sin archivo)"}:${s.fila ?? "?"}`;
}

function issueShape(list) {
    return list.items.map(i => ({ code: i.code, severity: i.severity }));
}

/** The identity keys of the kept records, sorted in code-unit order. */
function keptKeys(kept, mode) {
    return kept.map(r => personKey(r, mode)).sort();
}

/** Deterministic xorshift32 - a shuffle that depends on Math.random cannot be re-run. */
function makeRandom(seed) {
    let x = seed >>> 0 || 1;
    return function next() {
        x ^= x << 13; x >>>= 0;
        x ^= x >>> 17;
        x ^= x << 5; x >>>= 0;
        return x / 0x100000000;
    };
}

function shuffled(array, seed) {
    const out = array.slice();
    const rand = makeRandom(seed);
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out;
}

/** Assert one expectation block against one dedupe result. */
function assertExpectation(result, expected, mode, label) {
    assert.equal(result.kept.length, expected.kept, `${label}: kept`);
    assert.equal(result.collapsed.length, expected.collapsedGroups, `${label}: collapsed groups`);
    assert.equal(result.stats.rowsCollapsed, expected.rowsCollapsed, `${label}: rows collapsed`);
    assert.equal(result.crossSubcontratista.length, expected.cross, `${label}: cross groups`);

    if (expected.keptSources !== undefined) {
        assert.deepEqual(result.kept.map(sourceLabel), expected.keptSources, `${label}: kept sources / order`);
    }
    if (expected.keys !== undefined) {
        assert.deepEqual(keptKeys(result.kept, mode), expected.keys, `${label}: kept keys`);
    }
    if (expected.issues !== undefined) {
        assert.deepEqual(issueShape(result.issues), expected.issues, `${label}: issues`);
    }
    if (expected.withoutIdentity !== undefined) {
        assert.equal(result.stats.withoutIdentity, expected.withoutIdentity, `${label}: withoutIdentity`);
    }
    if (expected.fallbackKeys !== undefined) {
        assert.equal(result.stats.fallbackKeys, expected.fallbackKeys, `${label}: fallbackKeys`);
    }
    if (expected.conflictColumns !== undefined) {
        const columns = result.collapsed.flatMap(g => g.conflicts.map(c => c.columna));
        assert.deepEqual(columns, expected.conflictColumns, `${label}: conflicting columns`);
    }
    if (expected.fieldsLost !== undefined) {
        assert.deepEqual(result.collapsed.flatMap(g => g.fieldsLost), expected.fieldsLost, `${label}: fieldsLost`);
    }
    if (expected.subcontratistas !== undefined) {
        assert.deepEqual(result.collapsed[0].subcontratistas, expected.subcontratistas, `${label}: subcontratistas`);
    }
    if (expected.winnerFields !== undefined) {
        assert.equal(result.collapsed[0].winner.campos, expected.winnerFields, `${label}: winner completeness`);
    }
    if (expected.crossCopies !== undefined) {
        assert.equal(result.crossSubcontratista[0].copies, expected.crossCopies, `${label}: cross copies`);
    }
    if (expected.crossCollapsed !== undefined) {
        assert.equal(result.crossSubcontratista[0].collapsed, expected.crossCollapsed, `${label}: cross collapsed flag`);
    }

    // Invariants that hold for every case, asserted every time rather than case by case.
    assert.equal(result.stats.conserved, true, `${label}: rowsIn - rowsCollapsed = rowsOut`);
    assert.equal(result.stats.rowsIn - result.stats.rowsCollapsed, result.kept.length, `${label}: conservation`);
    for (const g of result.collapsed) {
        assert.equal(g.sources.length, g.copies, `${label}: every copy is itemised`);
        assert.equal(g.discarded.length, g.removed, `${label}: every discard is itemised`);
        assert.ok(g.key !== "", `${label}: an empty key must never form a group`);
    }
}

// ---------------------------------------------------------------------------
// BUG-21 - the regression the old dedupe could not catch
// ---------------------------------------------------------------------------

test("BUG-21: records whose keys are in different insertion order still collapse", async (t) => {
    for (const c of CASES.keyOrder) {
        await t.test(c.id, () => {
            const records = c.records.map(r => ({ ...r }));

            // The premise. If these two ever serialize the same, the case has rotted and
            // stopped testing what it claims to test.
            assert.notEqual(JSON.stringify(records[0]), JSON.stringify(records[1]),
                "the two records must differ as JSON strings - that is the whole defect");
            assert.deepEqual(
                Object.keys(records[0]).slice().sort(),
                Object.keys(records[1]).slice().sort(),
                "...while carrying exactly the same set of keys");

            // What the old pipeline did: new Set(rows.map(JSON.stringify)).
            const oldWay = new Set(records.map(r => JSON.stringify(r)));
            assert.equal(oldWay.size, 2, "src/excelConsolidation.js:88 keeps both copies");

            const issues = new IssueList();
            const result = dedupe(records, { mode: c.mode, issues });
            assertExpectation(result, c.expected, c.mode, c.id);
        });
    }
});

// ---------------------------------------------------------------------------
// The committed case table
// ---------------------------------------------------------------------------

test("dedupe: every case in the committed table", async (t) => {
    for (const c of CASES.cases) {
        for (const [mode, expected] of Object.entries(c.expected)) {
            await t.test(`${c.id} [${mode}]`, () => {
                const records = c.input.map(buildRecord);
                const issues = new IssueList();
                const result = dedupe(records, { mode, scope: c.scope, issues });
                assertExpectation(result, expected, mode, `${c.id} [${mode}]`);
                assert.equal(result.stats.mode, mode);
                assert.equal(result.stats.scope, c.scope || DEFAULT_SCOPE);
            });
        }
    }
});

test("homonyms: collapse under \"name\", stay apart under \"dni\"", () => {
    const c = CASES.cases.find(x => x.id === "homonyms-different-dni");
    const records = c.input.map(buildRecord);
    assert.equal(dedupe(records, { mode: "name" }).kept.length, 1);
    assert.equal(dedupe(records, { mode: "dni" }).kept.length, 2);
});

test("no DNI: the fallback keeps people apart instead of collapsing them onto \"\"", () => {
    const c = CASES.cases.find(x => x.id === "no-dni-falls-back-to-the-name");
    const records = c.input.map(buildRecord);
    for (const r of records) assert.equal(r[DNI_COLUMN], null, "the fixture must have no DNI at all");
    const result = dedupe(records, { mode: "dni" });
    assert.equal(result.kept.length, 3, "3 people, not 1 - a bare DNI key would give all four the empty key");
    assert.equal(result.stats.fallbackKeys, 4);
    assert.equal(result.stats.withoutIdentity, 0, "a name is still an identity");
});

test("a record with neither name nor DNI is never collapsed onto another", () => {
    const records = [
        buildRecord({ cargo: "OPERARIO", sub: "S", archivo: "s.xlsx", fila: 2 }),
        buildRecord({ cargo: "OPERARIO", sub: "S", archivo: "s.xlsx", fila: 3 }),
    ];
    // Identical in every field except the source row: still two workers, because we have
    // no basis to say they are one. Collapsing here is the BUG-04 arithmetic.
    for (const mode of ["name", "dni"]) {
        const result = dedupe(records, { mode });
        assert.equal(result.kept.length, 2, mode);
        assert.equal(result.stats.withoutIdentity, 2, mode);
        assert.equal(result.issues.length, 0, "and nothing is reported as a duplicate");
    }
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

/**
 * A corpus with the last run's measured shape: 4,358 distinct name keys with the
 * multiplicity histogram {1:4307, 2:46, 3:3, 4:1, 643:1}, 10 rows with no identity at
 * all, 24 duplicate keys spanning two subcontratistas, and 3 duplicate keys carrying two
 * distinct DNIs. Built deterministically so the assertions are reproducible.
 */
function buildCorpus() {
    const records = [];
    const hist = Object.entries(CORPUS.nameKeyMultiplicity)
        .map(([copies, keys]) => [Number(copies), keys])
        .sort((a, b) => a[0] - b[0]);

    let keyIndex = 0;
    let crossAssigned = 0;
    let splitDniAssigned = 0;
    let fila = 2;
    for (const [copies, keyCount] of hist) {
        for (let k = 0; k < keyCount; k++) {
            const nombre = `APELLIDO${String(keyIndex).padStart(4, "0")} NOMBRE${String(keyIndex).padStart(4, "0")}`;
            const dni = String(10000000 + keyIndex);
            // 24 two-copy keys are reported by two subcontratistas (measured: 24 keys /
            // 48 rows). 3 two-copy keys carry two distinct DNIs (measured: 3).
            const cross = copies === 2 && crossAssigned < CORPUS.keysSpanningMoreThanOneEmpresa;
            const splitDni = copies === 2 && !cross && splitDniAssigned < CORPUS.duplicateKeysWithMoreThanOneDni;
            if (cross) crossAssigned++;
            if (splitDni) splitDniAssigned++;
            for (let c = 0; c < copies; c++) {
                const sub = cross && c === 1
                    ? `SUB ${String((keyIndex + 41) % 80).padStart(3, "0")}B`
                    : `SUB ${String(keyIndex % 80).padStart(3, "0")}`;
                records.push(buildRecord({
                    nombre,
                    dni: splitDni && c === 1 ? String(90000000 + keyIndex) : dni,
                    empresa: sub,
                    sub,
                    archivo: `${sub}.xlsx`,
                    fila: fila++,
                }));
            }
            keyIndex++;
        }
    }
    for (let i = 0; i < CORPUS.rowsWithoutNameKey; i++) {
        records.push(buildRecord({ cargo: `SIN IDENTIDAD ${i}`, sub: "SUB SIN NOMBRE", archivo: "x.xlsx", fila: fila++ }));
    }
    assert.equal(keyIndex, CORPUS.distinctNameKeys, "corpus builder must reproduce the measured key count");
    assert.equal(crossAssigned, CORPUS.keysSpanningMoreThanOneEmpresa);
    assert.equal(splitDniAssigned, CORPUS.duplicateKeysWithMoreThanOneDni);
    assert.equal(records.length, CORPUS.rows, "corpus builder must reproduce the measured row count");
    return records;
}

test("determinism: shuffling the input changes nothing about the output", () => {
    const corpus = buildCorpus();
    const baseline = dedupe(corpus, { mode: "name" });
    const baselineSources = baseline.kept.map(sourceLabel);
    const baselineIssues = baseline.issues.items;

    for (const seed of [1, 7, 99, 123456, 0x5eed]) {
        const result = dedupe(shuffled(corpus, seed), { mode: "name" });
        assert.deepEqual(result.kept.map(sourceLabel), baselineSources, `seed ${seed}: kept rows and their order`);
        assert.deepEqual(result.collapsed, baseline.collapsed, `seed ${seed}: collapsed groups`);
        assert.deepEqual(result.stats, baseline.stats, `seed ${seed}: stats`);
        assert.deepEqual(result.crossSubcontratista, baseline.crossSubcontratista, `seed ${seed}: cross groups`);
        assert.deepEqual(result.issues.items, baselineIssues, `seed ${seed}: issues, in the same order`);
    }
});

test("determinism: shuffling changes nothing under \"dni\" or under scope \"subcontratista\" either", () => {
    const corpus = buildCorpus().slice(0, 900);
    for (const mode of ["name", "dni"]) {
        for (const scope of SCOPES) {
            const baseline = dedupe(corpus, { mode, scope });
            for (const seed of [3, 555]) {
                const result = dedupe(shuffled(corpus, seed), { mode, scope });
                assert.deepEqual(result.kept.map(sourceLabel), baseline.kept.map(sourceLabel), `${mode}/${scope}/${seed}`);
                assert.deepEqual(result.stats, baseline.stats, `${mode}/${scope}/${seed}`);
                assert.deepEqual(result.issues.items, baseline.issues.items, `${mode}/${scope}/${seed}`);
            }
        }
    }
});

test("determinism: ties on completeness AND on every source field still resolve on content", () => {
    // No provenance at all, equal completeness: the only thing left to sort on is the
    // field values. Without a content-total comparator this is where a shuffle leaks in.
    const records = [
        { [NAME_COLUMN]: "SIN PROCEDENCIA UNO", [DNI_COLUMN]: "10000001", EMPRESA: "ZZZ SAC" },
        { [NAME_COLUMN]: "SIN PROCEDENCIA UNO", [DNI_COLUMN]: "10000001", EMPRESA: "AAA SAC" },
        { [NAME_COLUMN]: "SIN PROCEDENCIA DOS", [DNI_COLUMN]: "10000002", EMPRESA: "MMM SAC" },
    ];
    const baseline = dedupe(records, { mode: "name" });
    assert.equal(baseline.kept.length, 2);
    assert.equal(baseline.kept[0].EMPRESA, "AAA SAC", "content order decides, and it is stable");
    for (const seed of [2, 4, 8, 16, 32]) {
        const result = dedupe(shuffled(records, seed), { mode: "name" });
        assert.deepEqual(result.kept, baseline.kept, `seed ${seed}`);
        assert.deepEqual(result.collapsed, baseline.collapsed, `seed ${seed}`);
    }
});

// ---------------------------------------------------------------------------
// Corpus scale - the last run's measured numbers
// ---------------------------------------------------------------------------

test("corpus scale: the last run's measured shape reconciles exactly", () => {
    const corpus = buildCorpus();
    const result = dedupe(corpus, { mode: "name" });

    assert.equal(result.stats.rowsIn, CORPUS.rows);
    assert.equal(result.stats.distinctKeys, CORPUS.distinctNameKeys);
    assert.equal(result.stats.withoutIdentity, CORPUS.rowsWithoutNameKey);
    assert.equal(result.stats.groups, CORPUS.duplicateNameKeys);
    assert.equal(result.stats.rowsCollapsed, CORPUS.rowsCollapsedByName);
    assert.equal(result.kept.length, CORPUS.keptByName);
    assert.equal(result.stats.crossSubcontratistaGroups, CORPUS.keysSpanningMoreThanOneEmpresa);
    assert.equal(result.stats.crossSubcontratistaRows, CORPUS.rowsInThoseKeys);
    assert.equal(result.collapsed.filter(g => g.copies > 2).length, CORPUS.keysWithMoreThanTwoCopies);

    // The 643-row header-shift block: one key, 642 rows removed, itemised rather than
    // silently folded into a headcount of 1 (BUG-04 / 03 §2.3).
    const biggest = result.collapsed.reduce((a, b) => (b.copies > a.copies ? b : a));
    assert.equal(biggest.copies, 643);
    assert.equal(biggest.removed, 642);
    assert.equal(biggest.sources.length, 643, "every one of the 643 sources is named");

    const check = conservationCheck({ read: CORPUS.rows, result });
    assert.equal(check.ok, true);
    assert.equal(check.expected, CORPUS.keptByName);
    assert.equal(check.actual, CORPUS.keptByName);
});

test("corpus scale: severity split matches who reported the duplicate", () => {
    const result = dedupe(buildCorpus(), { mode: "name" });
    const counts = result.issues.counts();
    assert.equal(counts[SEVERITY.WARNING], CORPUS.keysSpanningMoreThanOneEmpresa,
        "one WARNING per worker reported by two subcontratistas - the Dos Subcontratas population");
    assert.equal(counts[SEVERITY.INFO], CORPUS.duplicateNameKeys - CORPUS.keysSpanningMoreThanOneEmpresa);
    assert.equal(counts[SEVERITY.ERROR], 0);
    assert.equal(counts[SEVERITY.FAILED], 0, "a duplicate is never a reason to fail a run");
    assert.equal(result.issues.countsByCode()[CODE.DUPLICATE_COLLAPSED], CORPUS.duplicateNameKeys);
});

test("corpus scale: scope \"subcontratista\" keeps the cross-company copies for the pivot", () => {
    const corpus = buildCorpus();
    const all = dedupe(corpus, { mode: "name", scope: "all" });
    const perSub = dedupe(corpus, { mode: "name", scope: "subcontratista" });

    assert.equal(perSub.kept.length, all.kept.length + CORPUS.keysSpanningMoreThanOneEmpresa,
        "exactly the cross-company copies survive");
    assert.equal(perSub.stats.crossSubcontratistaGroups, CORPUS.keysSpanningMoreThanOneEmpresa,
        "and they are still reported either way");
    assert.equal(perSub.crossSubcontratista.every(g => g.collapsed === false), true);
    assert.equal(all.crossSubcontratista.every(g => g.collapsed === true), true);
    assert.equal(perSub.stats.conserved, true);
});

// ---------------------------------------------------------------------------
// countDistinct / keyCensus (05 §8 Q3)
// ---------------------------------------------------------------------------

test("countDistinct equals the number of rows dedupe would keep, in both modes", () => {
    const corpus = buildCorpus();
    for (const mode of ["name", "dni"]) {
        assert.equal(countDistinct(corpus, mode), dedupe(corpus, { mode }).kept.length, mode);
    }
    for (const c of CASES.cases) {
        const records = c.input.map(buildRecord);
        for (const mode of ["name", "dni"]) {
            // scope "subcontratista" splits a person across companies on purpose, so the
            // invariant is stated against the default scope.
            assert.equal(countDistinct(records, mode), dedupe(records, { mode }).kept.length, `${c.id} [${mode}]`);
        }
    }
});

test("countDistinct publishes the name-keyed and DNI-keyed headcounts side by side", () => {
    const corpus = buildCorpus();
    const byName = countDistinct(corpus, "name");
    const byDni = countDistinct(corpus, "dni");
    assert.equal(byName, CORPUS.keptByName);
    // In this corpus the 3 duplicate name keys carrying two distinct DNIs are 3 extra
    // people under "dni". Note the direction: on the REAL Cuadro the DNI key comes out
    // LOWER (4,342 vs 4,368) because it also catches people whose name is spelled two
    // different ways - see corpus.dniModeNote. Both effects are real and they subtract,
    // which is exactly why 05 §8 Q3 wants both numbers published side by side rather
    // than reasoned about.
    assert.equal(byDni, CORPUS.distinctNameKeys + CORPUS.duplicateKeysWithMoreThanOneDni + CORPUS.rowsWithoutNameKey);
    assert.ok(byDni !== byName, "the two keys disagree, and the run report must show by how much");
});

test("keyCensus reports the fallback population separately", () => {
    const records = [
        buildRecord({ nombre: "CON DNI", dni: "44444444", sub: "S", archivo: "s.xlsx", fila: 2 }),
        buildRecord({ nombre: "SIN DNI", sub: "S", archivo: "s.xlsx", fila: 3 }),
        buildRecord({ cargo: "SIN NADA", sub: "S", archivo: "s.xlsx", fila: 4 }),
    ];
    const census = keyCensus(records, "dni");
    assert.equal(census.total, 3);
    assert.equal(census.distinct, 3);
    assert.equal(census.withIdentity, 2);
    assert.equal(census.withoutIdentity, 1);
    assert.equal(census.fallbackKeys, 2, "no DNI at all -> fell back (identity.js), counted for metrics.js");
    assert.equal(census.duplicateKeys, 0);
    assert.equal(census.duplicateRows, 0);

    const name = keyCensus(records, "name");
    assert.equal(name.fallbackKeys, 0, "the name mode never falls back");
});

test("keyCensus.duplicateRows equals what dedupe would collapse", () => {
    const corpus = buildCorpus();
    for (const mode of ["name", "dni"]) {
        assert.equal(keyCensus(corpus, mode).duplicateRows, dedupe(corpus, { mode }).stats.rowsCollapsed, mode);
        assert.equal(keyCensus(corpus, mode).duplicateKeys, dedupe(corpus, { mode }).stats.groups, mode);
    }
});

// ---------------------------------------------------------------------------
// Conservation (05 §3 Phase 3 task 8)
// ---------------------------------------------------------------------------

test("conservationCheck: every case in the committed table", async (t) => {
    for (const c of CASES.conservation) {
        await t.test(c.id, () => {
            const input = { ...c.input };
            if (input.collapsed === "NaN") input.collapsed = NaN;
            const got = conservationCheck(input);
            assert.equal(got.ok, c.expected.ok, "ok");
            assert.equal(got.expected, c.expected.expected, "expected");
            assert.equal(got.actual, c.expected.actual, "actual");
            if (c.expected.difference !== undefined) assert.equal(got.detail.difference, c.expected.difference);
            if (c.expected.workbooks !== undefined) assert.equal(got.detail.workbooks, c.expected.workbooks);
            if (c.expected.read !== undefined) assert.equal(got.detail.read, c.expected.read);
            if (c.expected.motivoMatch !== undefined) {
                assert.match(got.detail.motivo, new RegExp(c.expected.motivoMatch));
            }
            if (c.expected.ok) assert.equal(got.detail.motivo, null, "a passing check says nothing");
            // Never NaN, in any field, ever.
            for (const [k, v] of Object.entries({ expected: got.expected, actual: got.actual, difference: got.detail.difference })) {
                assert.ok(v === null || Number.isFinite(v), `${k} must be a finite number or null, got ${v}`);
            }
        });
    }
});

test("conservationCheck: accepts dedupe's own output verbatim", () => {
    const corpus = buildCorpus();
    const result = dedupe(corpus, { mode: "name" });

    // Three spellings of the same assertion, all of which run.js may reasonably use.
    const a = conservationCheck({ read: corpus.length, result });
    const b = conservationCheck({ read: corpus.length, collapsed: result.collapsed, written: result.kept });
    const c = conservationCheck({ read: corpus.length, collapsed: result.stats.rowsCollapsed, written: result.kept.length });
    for (const check of [a, b, c]) {
        assert.equal(check.ok, true);
        assert.equal(check.expected, result.kept.length);
    }
});

test("conservationCheck: per-workbook detail survives for the run report", () => {
    const check = conservationCheck({
        read: [
            { subcontratista: "SUB B", archivo: "b.xlsx", filas: 3 },
            { subcontratista: "SUB A", archivo: "a.xlsx", filas: 4 },
        ],
        collapsed: 1,
        written: 6,
    });
    assert.equal(check.ok, true);
    assert.deepEqual(check.detail.perWorkbook, [
        { subcontratista: "SUB B", archivo: "b.xlsx", filas: 3 },
        { subcontratista: "SUB A", archivo: "a.xlsx", filas: 4 },
    ], "reported in the order given - this module does not reorder the caller's workbooks");
});

test("conservationCheck: never throws, whatever it is handed", () => {
    for (const input of [undefined, null, {}, { read: "x" }, { read: [{}] }, { read: [null] },
        { read: 5, collapsed: [{}], written: 5 }, { read: 5, collapsed: 1, written: {} }]) {
        const got = conservationCheck(input);
        assert.equal(got.ok, false);
        assert.equal(got.expected, null);
        assert.equal(got.actual, null);
        assert.ok(typeof got.detail.motivo === "string" && got.detail.motivo.length > 0);
    }
});

// ---------------------------------------------------------------------------
// The itemised list (03 §8.2)
// ---------------------------------------------------------------------------

test("every collapse names the person, the key and every contributing source", () => {
    const records = [
        buildRecord({ nombre: "GUZMAN ARRIETA EDER MIGUEL", dni: "76478853", empresa: "CLIMAXI INGENIEROS EIRL", sub: "CLIMAXI INGENIEROS EIRL", archivo: "climaxi.xlsx", hoja: "Cuadro", fila: 17 }),
        buildRecord({ nombre: "GUZMAN ARRIETA EDER MIGUEL", dni: "76478853", empresa: "OBRAS SUBTERRANEAS SA", sub: "OBRAS SUBTERRANEAS SA", archivo: "osub.xlsx", hoja: "Cuadro", fila: 204 }),
    ];
    const issues = new IssueList();
    const result = dedupe(records, { mode: "name", issues });

    assert.equal(issues.length, 1);
    const i = issues.items[0];
    assert.equal(i.code, CODE.DUPLICATE_COLLAPSED);
    assert.equal(i.severity, SEVERITY.WARNING);
    assert.equal(i.columna, KEY_COLUMN_BY_MODE.name);
    assert.equal(i.valor, "GUZMAN ARRIETA EDER MIGUEL");
    assert.equal(i.subcontratista, "CLIMAXI INGENIEROS EIRL", "provenance is the winner's");
    assert.equal(i.archivo, "climaxi.xlsx");
    assert.equal(i.hoja, "Cuadro");
    assert.equal(i.fila, 17);
    assert.match(i.message, /GUZMAN ARRIETA EDER MIGUEL/);
    assert.match(i.message, /CLIMAXI INGENIEROS EIRL\/climaxi\.xlsx:17/);
    assert.match(i.message, /OBRAS SUBTERRANEAS SA\/osub\.xlsx:204/, "the discarded source is named too");

    assert.equal(i.detalle.cruzado, true);
    assert.deepEqual(i.detalle.subcontratistas, ["CLIMAXI INGENIEROS EIRL", "OBRAS SUBTERRANEAS SA"]);
    assert.deepEqual(i.detalle.fuentes.map(s => `${s.subcontratista}:${s.fila}`),
        ["CLIMAXI INGENIEROS EIRL:17", "OBRAS SUBTERRANEAS SA:204"]);
    assert.deepEqual(i.detalle.conflictos, [{ columna: "EMPRESA", valores: ["CLIMAXI INGENIEROS EIRL", "OBRAS SUBTERRANEAS SA"], truncado: 0 }]);
    assert.equal(result.crossSubcontratista[0].key, "GUZMAN ARRIETA EDER MIGUEL");
});

test("a huge group is fully itemised in detalle but abbreviated in the message", () => {
    const records = [];
    for (let i = 0; i < 40; i++) {
        records.push(buildRecord({ nombre: 20101155588, sub: "SUB DESPLAZADA", archivo: "shift.xlsx", fila: 2 + i }));
    }
    const result = dedupe(records, { mode: "name" });
    const i = result.issues.items[0];
    assert.equal(result.collapsed[0].sources.length, 40, "detalle carries every source");
    assert.match(i.message, /\(\+34 mas\)/, "the Errores cell stays readable");
    assert.equal(i.detalle.fuentes.length, 40);
});

test("issues are optional: dedupe still works when no IssueList is passed", () => {
    const records = [
        buildRecord({ nombre: "SOLO UNO", dni: "12121212", sub: "S", archivo: "s.xlsx", fila: 2 }),
        buildRecord({ nombre: "SOLO UNO", dni: "12121212", sub: "S", archivo: "s.xlsx", fila: 3 }),
    ];
    const result = dedupe(records);
    assert.equal(result.kept.length, 1);
    assert.equal(result.issues.length, 1, "a fresh list is created rather than throwing");
    assert.equal(result.stats.mode, config.IDENTITY_KEY);
});

// ---------------------------------------------------------------------------
// Purity and contract
// ---------------------------------------------------------------------------

test("dedupe does not mutate the input array or any record, and returns the same objects", () => {
    const records = CASES.cases
        .flatMap(c => c.input)
        .map(buildRecord);
    const before = JSON.stringify(records);
    const order = records.slice();

    const result = dedupe(records, { mode: "name" });

    assert.equal(JSON.stringify(records), before, "no record was mutated");
    assert.deepEqual(records, order, "the caller's array order is untouched");
    for (const kept of result.kept) {
        assert.ok(records.includes(kept), "kept holds the caller's own objects, not copies");
    }
});

test("mode and scope are validated: a bad one is a configuration error, not a data error", () => {
    const records = [buildRecord({ nombre: "X", sub: "S", archivo: "s.xlsx", fila: 2 })];
    assert.throws(() => dedupe(records, { mode: "ruc" }), TypeError);
    assert.throws(() => dedupe(records, { scope: "global" }), TypeError);
    assert.throws(() => countDistinct(records, "apellido"), TypeError);
    assert.throws(() => keyCensus(records, "apellido"), TypeError);
    // ...but a data problem never throws.
    assert.doesNotThrow(() => dedupe([null, undefined, 3, "x", {}], { mode: "name" }));
    assert.doesNotThrow(() => dedupe(null, { mode: "name" }));
    assert.doesNotThrow(() => dedupe(undefined));
});

test("dedupe defaults to config.IDENTITY_KEY and scope \"all\"", () => {
    const result = dedupe([], {});
    assert.equal(result.stats.mode, config.IDENTITY_KEY);
    assert.equal(result.stats.scope, DEFAULT_SCOPE);
    assert.equal(DEFAULT_SCOPE, "all");
    assert.deepEqual(SCOPES, ["all", "subcontratista"]);
});

test("completeness counts populated canonical fields only", () => {
    const empty = buildRecord({});
    assert.equal(completeness(empty), 0, "provenance is not a canonical column");
    assert.equal(completeness(buildRecord({ nombre: "A", hpt: 0 })), 2, "HPT = 0 hours is a value, not a gap");
    assert.equal(completeness(buildRecord({ nombre: "   " })), 0, "whitespace is not a value");
    assert.equal(completeness(buildRecord({ nombre: "A", nacimiento: NaN })), 1, "NaN is never data (BUG-20)");
    assert.equal(completeness(null), 0);
    assert.equal(isPopulated(0), true);
    assert.equal(isPopulated(""), false);
    assert.equal(isPopulated(NaN), false);
    assert.equal(isPopulated(Infinity), false);
    assert.equal(isPopulated(null), false);
    assert.equal(isPopulated(undefined), false);
});

test("sourceOf reads workbook.js provenance, 03 §2 provenance and bare fields alike", () => {
    assert.deepEqual(sourceOf({ provenance: { subcontratista: "S", archivo: "a.xlsx", hoja: "Cuadro", filaOrigen: 9, celdaAncla: "A1" } }),
        { subcontratista: "S", archivo: "a.xlsx", hoja: "Cuadro", fila: 9, celda: "A1" });
    assert.deepEqual(sourceOf({ provenance: { carpetaSubcontratista: "S", archivo: "a.xlsx", hoja: "Cuadro", filaOrigen: 9, celdaOrigen: "F9" } }),
        { subcontratista: "S", archivo: "a.xlsx", hoja: "Cuadro", fila: 9, celda: "F9" });
    assert.deepEqual(sourceOf({ subcontratista: "S", archivo: "a.xlsx", fila: 9 }),
        { subcontratista: "S", archivo: "a.xlsx", hoja: null, fila: 9, celda: null });
    assert.deepEqual(sourceOf(null),
        { subcontratista: null, archivo: null, hoja: null, fila: null, celda: null });
});

test("stats never carry a NaN and always reconcile", () => {
    const result = dedupe(buildCorpus(), { mode: "dni" });
    for (const [k, v] of Object.entries(result.stats)) {
        if (typeof v === "number") assert.ok(Number.isFinite(v), `stats.${k} is ${v}`);
    }
    assert.equal(result.stats.rowsIn - result.stats.rowsCollapsed, result.stats.rowsOut);
    assert.equal(result.stats.rowsOut, result.kept.length);
    assert.equal(result.stats.distinctKeys + result.stats.withoutIdentity, result.kept.length);
});

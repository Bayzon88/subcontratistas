"use strict";
/**
 * output/ooxml.js against the REAL template.
 *
 * This is the Phase-0 structural assertion helper of 05-implementation-plan.md §4.2
 * applied to the one module that can destroy the deliverable. The six pivot sheets
 * are what the client reads; there is no library that can rebuild them if the patch
 * corrupts a part. So the tests here are mostly identity tests: after the patch,
 * every pivot part and the pivot cache RECORDS must be SHA-1 identical to the
 * template's, and the file must still open in both readers.
 *
 * Every measured number below was read off src/template.xlsx:
 *   Tabla2 ref A1:AI8824 (the 8,823-row ceiling, BUG-11)
 *   <calcPr calcId="191029"/> with no fullCalcOnLoad
 *   rId15 -> calcChain.xml, plus the calcChain content-type override
 *   cacheField "Altas" is index 34, "Bajas2" is index 33
 *   pivotTable3 / pivotTable7 pageField fld=34 item=14 -> shared item 1 -> "9-2024"
 *   pivotTable2 pageField fld=33 item=1  -> shared item 2 -> "Borrar"  (BUG: AC 19)
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const JSZip = require("jszip");
const XlsxPopulate = require("xlsx-populate");
const XLSX = require("xlsx");

const config = require("../config");
const { parsePeriod } = require("../pipeline/period");
const {
    patchWorkbook,
    OoxmlError,
    OOXML_ERROR,
    PART,
    PERIOD_NAMES,
    TABLE_NAME,
} = require("../output/ooxml");

const TEMPLATE = config.TEMPLATE_LEGACY;

/** The nine sheets of 03-expected-output.md §7.1. This inventory must not change. */
const SHEETS = [
    "Reporte Social - RRHH", "CJ Y EPC", "Hoja1", "Cuadro", "Contratistas",
    "Tabla", "Sheet1", "Dos Subcontratas por Mes", "Validacion",
];

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ooxml-test-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let copies = 0;
/** A private copy of the template. The template itself is never written to. */
function templateCopy(label) {
    const dst = path.join(TMP, `${label}-${copies++}.xlsx`);
    fs.copyFileSync(TEMPLATE, dst);
    return dst;
}

function sha1(buf) {
    return crypto.createHash("sha1").update(buf).digest("hex");
}

async function open(file) {
    return JSZip.loadAsync(fs.readFileSync(file));
}

async function part(zip, name) {
    const entry = zip.file(name);
    return entry ? entry.async("string") : null;
}

async function partSha(zip, name) {
    const entry = zip.file(name);
    return entry ? sha1(await entry.async("nodebuffer")) : null;
}

function refsOf(tableXml) {
    return (tableXml.match(/ref="[^"]*"/g) || []).map((s) => s.slice(5, -1));
}

/** One patched workbook shared by the read-only assertions, so the 3.7 MB template
 *  round-trip is paid once rather than per assertion. */
const PERIOD = parsePeriod("2026-02");
const ROWS = 5070;
const patched = (async () => {
    const file = templateCopy("main");
    const result = await patchWorkbook(file, { rowCount: ROWS, period: "2026-02" });
    return { file, result, zip: await open(file), template: await open(TEMPLATE) };
})();

/* ------------------------------------------------- 1. Tabla2 is resized (BUG-11) */

test("the template really does carry the frozen 8,823-row ceiling", async () => {
    const tpl = (await patched).template;
    assert.deepEqual(refsOf(await part(tpl, PART.TABLE)),
        ["A1:AI8824", "A1:AI8824", "A2:AI8824", "C1:C8824"]);
});

test("all four Tabla2 refs move together to 1 + rowCount", async () => {
    const { result, zip } = await patched;
    assert.equal(result.lastRow, ROWS + 1);
    assert.deepEqual(result.table, {
        table: "A1:AI5071",
        autoFilter: "A1:AI5071",
        sortState: "A2:AI5071",
        sortCondition: "C1:C5071",
    });
    // Read back off disk, not off the return value.
    assert.deepEqual(refsOf(await part(zip, PART.TABLE)),
        ["A1:AI5071", "A1:AI5071", "A2:AI5071", "C1:C5071"]);
});

test("sortState keeps row 2 and sortCondition keeps column C", async () => {
    // The naive fix - one global replace of the ref VALUE - would rewrite A2:AI8824
    // as A1:AI5071 and sort the header row into the data.
    const xml = await part((await patched).zip, PART.TABLE);
    assert.match(xml, /<table [^>]*ref="A1:AI5071"/);
    assert.match(xml, /<autoFilter ref="A1:AI5071"/);
    assert.match(xml, /<sortState ref="A2:AI5071"/);
    assert.match(xml, /<sortCondition ref="C1:C5071"\/>/);
    assert.equal(xml.includes("8824"), false);
});

test("the table name is still Tabla2, and the cache still binds to it by name", async () => {
    const { zip } = await patched;
    const table = await part(zip, PART.TABLE);
    assert.match(table, new RegExp(`name="${TABLE_NAME}"`));
    const cache = await part(zip, PART.PIVOT_CACHE_DEF);
    assert.match(cache, new RegExp(`<worksheetSource name="${TABLE_NAME}"/>`));
});

test("the 35 tableColumn definitions are untouched by the resize", async () => {
    const { zip, template } = await patched;
    const before = (await part(template, PART.TABLE)).match(/<tableColumn [^>]*>/g);
    const after = (await part(zip, PART.TABLE)).match(/<tableColumn [^>]*>/g);
    assert.equal(before.length, 35);
    assert.deepEqual(after, before);
});

test("n > 8823 is handled by construction - the ceiling is gone (AC 16)", async () => {
    const file = templateCopy("tall");
    const result = await patchWorkbook(file, { rowCount: 9000, period: "2026-02" });
    assert.equal(result.table.table, "A1:AI9001");
    assert.deepEqual(refsOf(await part(await open(file), PART.TABLE)),
        ["A1:AI9001", "A1:AI9001", "A2:AI9001", "C1:C9001"]);
});

/* ------------------------------------------- 2 + 3. the two load-time attributes */

test("refreshOnLoad=\"1\" lands on <pivotCacheDefinition> (BUG-14, AC 21)", async () => {
    const { zip, template } = await patched;
    assert.equal(/refreshOnLoad/.test((await part(template, PART.PIVOT_CACHE_DEF)).slice(0, 800)), false);
    const xml = await part(zip, PART.PIVOT_CACHE_DEF);
    const root = /<pivotCacheDefinition\b[^>]*>/.exec(xml)[0];
    assert.match(root, /refreshOnLoad="1"/);
});

test("recordCount and refreshedDate are deliberately NOT touched", async () => {
    // recordCount must equal the number of <r> in pivotCacheRecords1.xml, which this
    // module does not rebuild; refreshedDate would need a clock. refreshOnLoad makes
    // Excel rewrite both on open.
    const { zip, template } = await patched;
    const a = /<pivotCacheDefinition\b[^>]*>/.exec(await part(template, PART.PIVOT_CACHE_DEF))[0];
    const b = /<pivotCacheDefinition\b[^>]*>/.exec(await part(zip, PART.PIVOT_CACHE_DEF))[0];
    assert.equal(/recordCount="(\d+)"/.exec(a)[1], /recordCount="(\d+)"/.exec(b)[1]);
    assert.equal(/refreshedDate="([^"]+)"/.exec(a)[1], /refreshedDate="([^"]+)"/.exec(b)[1]);
});

test("fullCalcOnLoad=\"1\" lands on <calcPr> (AC 21)", async () => {
    const { zip, template } = await patched;
    assert.equal(/<calcPr[^>]*\/>/.exec(await part(template, PART.WORKBOOK))[0],
        '<calcPr calcId="191029"/>');
    const calcPr = /<calcPr[^>]*\/>/.exec(await part(zip, PART.WORKBOOK))[0];
    assert.match(calcPr, /fullCalcOnLoad="1"/);
    assert.match(calcPr, /calcId="191029"/);   // the original attribute survives
});

/* --------------------------------------------------- 4. the dangling calcChain */

test("the calcChain relationship, override and part all go (AC 21)", async () => {
    const { zip, template, result } = await patched;
    // the template really does carry all three
    assert.match(await part(template, PART.WORKBOOK_RELS), /calcChain/);
    assert.match(await part(template, PART.CONTENT_TYPES), /calcChain/);
    assert.notEqual(template.file(PART.CALC_CHAIN), null);

    assert.equal(/calcChain/.test(await part(zip, PART.WORKBOOK_RELS)), false);
    assert.equal(/calcChain/.test(await part(zip, PART.CONTENT_TYPES)), false);
    assert.equal(zip.file(PART.CALC_CHAIN), null);
    assert.equal(result.calcChain.relationshipId, "rId15");
    assert.equal(result.calcChain.overrideRemoved, true);
    assert.equal(result.calcChain.partRemoved, true);
});

test("the rId is looked up by relationship Type, never assumed", async () => {
    // Renumber calcChain to an rId nobody would guess and confirm it is still found.
    const file = templateCopy("renumbered");
    const zip = await open(file);
    const rels = (await part(zip, PART.WORKBOOK_RELS)).replace('Id="rId15"', 'Id="rId977"');
    zip.file(PART.WORKBOOK_RELS, rels, { date: zip.file(PART.WORKBOOK_RELS).date });
    fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));

    const result = await patchWorkbook(file, { rowCount: 10, period: "2026-02" });
    assert.equal(result.calcChain.relationshipId, "rId977");
    assert.equal(/calcChain/.test(await part(await open(file), PART.WORKBOOK_RELS)), false);
});

test("every remaining relationship still points at a part that exists", async () => {
    const { zip } = await patched;
    const rels = await part(zip, PART.WORKBOOK_RELS);
    for (const m of rels.matchAll(/Target="([^"]+)"/g)) {
        const target = m[1];
        if (/^https?:/.test(target)) continue;
        const full = path.posix.normalize(path.posix.join("xl", target));
        assert.notEqual(zip.file(full), null, `relacion colgante: ${target}`);
    }
});

test("every content-type Override still points at a part that exists", async () => {
    const { zip } = await patched;
    const ct = await part(zip, PART.CONTENT_TYPES);
    for (const m of ct.matchAll(/<Override PartName="([^"]+)"/g)) {
        assert.notEqual(zip.file(m[1].replace(/^\//, "")), null, `override colgante: ${m[1]}`);
    }
});

/* ---------------------------------------------------------- 5. the report period */

test("the period is stored as three defined names (AC 22)", async () => {
    const { zip } = await patched;
    const xml = await part(zip, PART.WORKBOOK);
    const block = /<definedNames>[\s\S]*?<\/definedNames>/.exec(xml)[0];
    assert.match(block, new RegExp(
        `<definedName name="${PERIOD_NAMES.INICIO}">${PERIOD.inicioSerial}</definedName>`));
    assert.match(block, new RegExp(
        `<definedName name="${PERIOD_NAMES.FIN}">${PERIOD.finSerial}</definedName>`));
    assert.match(block, new RegExp(
        `<definedName name="${PERIOD_NAMES.ETIQUETA}">&quot;${PERIOD.etiqueta}&quot;</definedName>`));
    // the template's own _FilterDatabase name survives untouched
    assert.match(block, /_xlnm\._FilterDatabase/);
});

test("the defined names are workbook-scoped, so Cuadro formulas can see them", async () => {
    const xml = await part((await patched).zip, PART.WORKBOOK);
    for (const name of Object.values(PERIOD_NAMES)) {
        const tag = new RegExp(`<definedName name="${name}"[^>]*>`).exec(xml)[0];
        assert.equal(/localSheetId/.test(tag), false, `${name} no debe ser local a una hoja`);
    }
});

test("the period is stamped into docProps/custom.xml (AC 22)", async () => {
    const { zip, result } = await patched;
    const xml = await part(zip, PART.CUSTOM_PROPS);
    assert.match(xml, new RegExp(
        `name="${PERIOD_NAMES.INICIO}"><vt:lpwstr>${PERIOD.inicio}</vt:lpwstr>`));
    assert.match(xml, new RegExp(
        `name="${PERIOD_NAMES.FIN}"><vt:lpwstr>${PERIOD.fin}</vt:lpwstr>`));
    assert.match(xml, new RegExp(
        `name="${PERIOD_NAMES.ETIQUETA}"><vt:lpwstr>${PERIOD.etiqueta}</vt:lpwstr>`));
    // the template's own two properties survive, and pids stay unique
    assert.match(xml, /SV_QUERY_LIST_/);
    const pids = [...xml.matchAll(/\spid="(\d+)"/g)].map((m) => Number(m[1]));
    assert.deepEqual(pids, [...new Set(pids)]);
    assert.deepEqual(result.customProperties, {
        PeriodoInicio: PERIOD.inicio,
        PeriodoFin: PERIOD.fin,
        PeriodoEtiqueta: PERIOD.etiqueta,
    });
});

test("docProps/custom.xml is created, wired and declared when it is absent", async () => {
    const file = templateCopy("nocustom");
    const zip = await open(file);
    zip.remove(PART.CUSTOM_PROPS);
    const ct = (await part(zip, PART.CONTENT_TYPES))
        .replace(/<Override PartName="\/docProps\/custom\.xml"[^>]*\/>/, "");
    const rels = (await part(zip, PART.ROOT_RELS))
        .replace(/<Relationship [^>]*custom-properties[^>]*\/>/, "");
    zip.file(PART.CONTENT_TYPES, ct, { date: zip.file(PART.CONTENT_TYPES).date });
    zip.file(PART.ROOT_RELS, rels, { date: zip.file(PART.ROOT_RELS).date });
    fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));

    const result = await patchWorkbook(file, { rowCount: 10, period: "2026-02" });
    assert.equal(result.createdCustomProps, true);

    const out = await open(file);
    const xml = await part(out, PART.CUSTOM_PROPS);
    assert.match(xml, /name="PeriodoEtiqueta"><vt:lpwstr>2-2026<\/vt:lpwstr>/);
    // pids start at 2 when the part is new, and the part is reachable from the package
    assert.deepEqual([...xml.matchAll(/\spid="(\d+)"/g)].map((m) => m[1]), ["2", "3", "4"]);
    assert.match(await part(out, PART.CONTENT_TYPES), /PartName="\/docProps\/custom\.xml"/);
    assert.match(await part(out, PART.ROOT_RELS), /custom-properties/);
    // and it still opens
    assert.deepEqual(XLSX.readFile(file, { bookSheets: true }).SheetNames, SHEETS);
});

test("the filename stem and the stored period cannot disagree", async () => {
    // AC 22: DICIEMBRE_2025 is named December and reports November. Whatever the
    // caller names the file, the content records the period it was patched with.
    const { result } = await patched;
    assert.equal(result.definedNames[PERIOD_NAMES.ETIQUETA], PERIOD.etiqueta);
    assert.equal(PERIOD.filename, "Reporte_Subcontratistas_FEBRERO_2026.xlsx");
});

test("a parsePeriod descriptor is accepted as well as a YYYY-MM string", async () => {
    const file = templateCopy("descriptor");
    const result = await patchWorkbook(file, { rowCount: 12, period: parsePeriod("2025-11") });
    assert.equal(result.definedNames.PeriodoEtiqueta, "11-2025");
    assert.equal(result.customProperties.PeriodoInicio, "2025-11-01");
});

/* ------------------------------------------------- 6. the pivot page filters */

test("the template really is filtered on \"9-2024\" and on \"Borrar\"", async () => {
    const tpl = (await patched).template;
    const cache = await part(tpl, PART.PIVOT_CACHE_DEF);
    assert.match(cache, /<cacheField name="Altas"[^>]*><sharedItems[^>]*><s v="No Aplica"\/><s v="9-2024"\/>/);
    assert.match(cache, /<cacheField name="Bajas2"[^>]*><sharedItems[^>]*><s v="No Aplica"\/><s v="9-2024"\/><s v="Borrar"\/>/);
    assert.match(await part(tpl, "xl/pivotTables/pivotTable3.xml"), /<pageField fld="34" item="14"/);
    assert.match(await part(tpl, "xl/pivotTables/pivotTable7.xml"), /<pageField fld="34" item="14"/);
    assert.match(await part(tpl, "xl/pivotTables/pivotTable2.xml"), /<pageField fld="33" item="1"/);
});

test("the period label replaces \"9-2024\" in both cache fields", async () => {
    const cache = await part((await patched).zip, PART.PIVOT_CACHE_DEF);
    assert.equal(cache.includes('<s v="9-2024"/>'), false);
    assert.match(cache, /<cacheField name="Altas"[^>]*><sharedItems[^>]*><s v="No Aplica"\/><s v="2-2026"\/>/);
    assert.match(cache, /<cacheField name="Bajas2"[^>]*><sharedItems[^>]*><s v="No Aplica"\/><s v="2-2026"\/><s v="Borrar"\/>/);
});

test("the shared-item COUNT and every other index are unchanged", async () => {
    // Rewriting the one live period item rather than appending is what keeps every
    // pivot item index - in all 13 pivots - valid.
    const { zip, template } = await patched;
    const counts = async (z) => {
        const xml = await part(z, PART.PIVOT_CACHE_DEF);
        return [...xml.matchAll(/<sharedItems[^>]*count="(\d+)"/g)].map((m) => m[1]);
    };
    assert.deepEqual(await counts(zip), await counts(template));
});

test("Detalle Cesados stops filtering on \"Borrar\" (AC 19)", async () => {
    const { zip, result } = await patched;
    const xml = await part(zip, "xl/pivotTables/pivotTable2.xml");
    // item 14 -> <item x="1"/> -> shared item 1, which now carries the period label.
    assert.match(xml, /<pageField fld="33" item="14" hier="-1"\/>/);
    const bajas = result.pivotFilters.find((f) => f.part.endsWith("pivotTable2.xml"));
    assert.deepEqual(
        { cacheField: bajas.cacheField, fld: bajas.fld, previousItem: bajas.previousItem, item: bajas.item, value: bajas.value },
        { cacheField: "Bajas2", fld: 33, previousItem: 1, item: 14, value: "2-2026" });
    // "Borrar" itself is still a valid item - only the SELECTION moved.
    assert.match(await part(zip, PART.PIVOT_CACHE_DEF), /<s v="Borrar"\/>/);
});

test("the Altas pivots needed no index change, so their parts do not move", async () => {
    const { result } = await patched;
    const altas = result.pivotFilters.filter((f) => f.cacheField === "Altas");
    assert.equal(altas.length, 2);
    for (const f of altas) {
        assert.equal(f.fld, 34);
        assert.equal(f.previousItem, 14);
        assert.equal(f.item, 14);
    }
});

test("exactly three page filters are repointed, and nothing warns", async () => {
    const { result } = await patched;
    assert.deepEqual(result.pivotFilters.map((f) => f.part).sort(), [
        "xl/pivotTables/pivotTable2.xml",
        "xl/pivotTables/pivotTable3.xml",
        "xl/pivotTables/pivotTable7.xml",
    ]);
    assert.deepEqual(result.warnings, []);
});

test("patchPivotFilters:false leaves the cache strings and all 13 pivots alone", async () => {
    const file = templateCopy("nofilters");
    const result = await patchWorkbook(file, {
        rowCount: 100, period: "2026-02", patchPivotFilters: false,
    });
    assert.deepEqual(result.pivotFilters, []);
    const zip = await open(file);
    const template = (await patched).template;
    assert.match(await part(zip, PART.PIVOT_CACHE_DEF), /<s v="9-2024"\/>/);
    for (const name of result.pivotParts) {
        assert.equal(await partSha(zip, name), await partSha(template, name), name);
    }
});

/* --------------------------------------------- the identity gate (05 §6 risk 1) */

test("12 of the 13 pivot parts are SHA-1 identical to the template's", async () => {
    const { zip, template, result } = await patched;
    assert.equal(result.pivotParts.length, 13);
    const moved = [];
    for (const name of result.pivotParts) {
        assert.notEqual(zip.file(name), null, `falta ${name}`);
        if (await partSha(zip, name) !== await partSha(template, name)) moved.push(name);
    }
    // Only the Detalle Cesados block changes, and only by its pageField item index.
    assert.deepEqual(moved, ["xl/pivotTables/pivotTable2.xml"]);
});

test("pivotTable2 differs from the template by exactly one attribute value", async () => {
    const { zip, template } = await patched;
    const a = await part(template, "xl/pivotTables/pivotTable2.xml");
    const b = await part(zip, "xl/pivotTables/pivotTable2.xml");
    assert.equal(a.replace('<pageField fld="33" item="1" hier="-1"/>',
        '<pageField fld="33" item="14" hier="-1"/>'), b);
});

test("the pivot cache RECORDS and the theme are byte-identical", async () => {
    const { zip, template } = await patched;
    for (const name of [PART.PIVOT_CACHE_RECORDS, "xl/theme/theme1.xml",
        "xl/pivotCache/_rels/pivotCacheDefinition1.xml.rels"]) {
        assert.equal(await partSha(zip, name), await partSha(template, name), name);
    }
});

test("only seven parts change at all, and calcChain is the only one removed", async () => {
    const { zip, template } = await patched;
    const before = Object.keys(template.files);
    const after = Object.keys(zip.files);
    assert.deepEqual(before.filter((n) => !after.includes(n)), [PART.CALC_CHAIN]);
    assert.deepEqual(after.filter((n) => !before.includes(n)), []);

    const changed = [];
    for (const name of after) {
        if (await partSha(zip, name) !== await partSha(template, name)) changed.push(name);
    }
    assert.deepEqual(changed.sort(), [
        "[Content_Types].xml",
        "docProps/custom.xml",
        "xl/_rels/workbook.xml.rels",
        "xl/pivotCache/pivotCacheDefinition1.xml",
        "xl/pivotTables/pivotTable2.xml",
        "xl/tables/table1.xml",
        "xl/workbook.xml",
    ]);
});

/* ---------------------------------------------------------------- readability */

test("the result still opens with xlsx-populate, all nine sheets", async () => {
    const wb = await XlsxPopulate.fromFileAsync((await patched).file);
    assert.deepEqual(wb.sheets().map((s) => s.name()), SHEETS);
});

test("the result still opens with SheetJS, all nine sheets", async () => {
    const wb = XLSX.readFile((await patched).file);
    assert.deepEqual(wb.SheetNames, SHEETS);
});

/* ---------------------------------------------------------------- determinism */

test("patching twice yields the same bytes as patching once", async () => {
    const once = templateCopy("once");
    const twice = templateCopy("twice");
    await patchWorkbook(once, { rowCount: ROWS, period: "2026-02" });
    await patchWorkbook(twice, { rowCount: ROWS, period: "2026-02" });
    await patchWorkbook(twice, { rowCount: ROWS, period: "2026-02" });
    assert.deepEqual(sha1(fs.readFileSync(twice)), sha1(fs.readFileSync(once)));
});

test("two runs of the same period on the same input are byte-identical", async () => {
    const a = templateCopy("run-a");
    const b = templateCopy("run-b");
    await patchWorkbook(a, { rowCount: 42, period: "2026-02" });
    await patchWorkbook(b, { rowCount: 42, period: "2026-02" });
    assert.equal(sha1(fs.readFileSync(a)), sha1(fs.readFileSync(b)));
});

test("no zip entry timestamp is taken from the clock", async () => {
    // A fresh JSZip entry defaults to `new Date()`, which would make the output bytes
    // depend on the minute the run happened (05 §1 principle 3).
    const { zip, template } = await patched;
    for (const name of Object.keys(zip.files)) {
        assert.equal(zip.files[name].date.getTime(), template.files[name].date.getTime(), name);
    }
});

test("nothing is left behind on the temp path", async () => {
    const leftovers = fs.readdirSync(TMP).filter((f) => f.includes(".tmp"));
    assert.deepEqual(leftovers, []);
});

/* --------------------------------------------------------------- caller errors */

test("a rowCount that is not a positive integer is a hard error", async () => {
    for (const bad of [0, -1, 1.5, "5070", null, undefined, NaN]) {
        await assert.rejects(
            () => patchWorkbook(templateCopy("bad"), { rowCount: bad, period: "2026-02" }),
            (e) => e instanceof OoxmlError && e.code === OOXML_ERROR.BAD_ROW_COUNT,
            `rowCount=${String(bad)}`);
    }
});

test("a rowCount past Excel's own limit is a hard error", async () => {
    await assert.rejects(
        () => patchWorkbook(templateCopy("huge"), { rowCount: 1048576, period: "2026-02" }),
        (e) => e instanceof OoxmlError && e.code === OOXML_ERROR.BAD_ROW_COUNT);
});

test("a missing or malformed period is a hard error", async () => {
    await assert.rejects(
        () => patchWorkbook(templateCopy("noperiod"), { rowCount: 10 }),
        (e) => e instanceof OoxmlError && e.code === OOXML_ERROR.BAD_PERIOD);
    await assert.rejects(
        () => patchWorkbook(templateCopy("halfperiod"), { rowCount: 10, period: { etiqueta: "2-2026" } }),
        (e) => e instanceof OoxmlError && e.code === OOXML_ERROR.BAD_PERIOD);
    // a malformed string is period.js's error, raised before a byte is written
    await assert.rejects(
        () => patchWorkbook(templateCopy("badstring"), { rowCount: 10, period: "2026-2" }),
        (e) => e.name === "PeriodError");
});

test("a file that is not a zip fails without touching it", async () => {
    const file = path.join(TMP, "not-a-zip.xlsx");
    fs.writeFileSync(file, "esto no es un xlsx");
    await assert.rejects(
        () => patchWorkbook(file, { rowCount: 10, period: "2026-02" }),
        (e) => e instanceof OoxmlError && e.code === OOXML_ERROR.NOT_A_ZIP);
    assert.equal(fs.readFileSync(file, "utf8"), "esto no es un xlsx");
});

test("a zip with no table part fails loudly rather than silently skipping", async () => {
    const file = templateCopy("notable");
    const zip = await open(file);
    zip.remove(PART.TABLE);
    fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    await assert.rejects(
        () => patchWorkbook(file, { rowCount: 10, period: "2026-02" }),
        (e) => e instanceof OoxmlError && e.code === OOXML_ERROR.MISSING_PART);
});

test("a half-resized table is impossible: a missing ref element throws", async () => {
    const file = templateCopy("nosort");
    const zip = await open(file);
    const xml = (await part(zip, PART.TABLE)).replace(/<sortState[\s\S]*?<\/sortState>/, "");
    zip.file(PART.TABLE, xml, { date: zip.file(PART.TABLE).date });
    fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    await assert.rejects(
        () => patchWorkbook(file, { rowCount: 10, period: "2026-02" }),
        (e) => e instanceof OoxmlError && e.code === OOXML_ERROR.TABLE_SHAPE);
});

test("a failed patch leaves the original file intact", async () => {
    const file = templateCopy("intact");
    const before = sha1(fs.readFileSync(file));
    await assert.rejects(() => patchWorkbook(file, { rowCount: 0, period: "2026-02" }));
    assert.equal(sha1(fs.readFileSync(file)), before);
    assert.deepEqual(fs.readdirSync(TMP).filter((f) => f.includes(".tmp")), []);
});

/* ----------------------------------------------- degraded, never corrupt (task 6) */

test("an unrecognizable period slot warns and skips instead of guessing", async () => {
    // Blank out the live "9-2024" item in the Altas cache field. There is then no
    // period-shaped item to reuse, and the module must decline rather than invent an
    // index - a wrong index repoints the filter at an unrelated column.
    const file = templateCopy("noslot");
    const zip = await open(file);
    let cache = await part(zip, PART.PIVOT_CACHE_DEF);
    const at = cache.indexOf('<cacheField name="Altas"');
    cache = cache.slice(0, at) + cache.slice(at).replace('<s v="9-2024"/>', '<s v="Nada"/>');
    zip.file(PART.PIVOT_CACHE_DEF, cache, { date: zip.file(PART.PIVOT_CACHE_DEF).date });
    fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));

    const result = await patchWorkbook(file, { rowCount: 10, period: "2026-02" });
    assert.deepEqual(result.warnings.map((w) => w.code), ["PIVOT_PERIOD_SLOT_AMBIGUOUS"]);
    // Bajas2 was still patched; the table resize and both attributes still happened.
    assert.deepEqual(result.pivotFilters.map((f) => f.cacheField), ["Bajas2"]);
    assert.equal(result.table.table, "A1:AI11");
    const out = await open(file);
    assert.match(/<pivotCacheDefinition\b[^>]*>/.exec(await part(out, PART.PIVOT_CACHE_DEF))[0],
        /refreshOnLoad="1"/);
    assert.match(await part(out, PART.WORKBOOK), /fullCalcOnLoad="1"/);
});

test("a period label already present in the cache is reused, not duplicated", async () => {
    // "12-2024" is already a (retained, unused) shared item in both fields. Patching
    // for that period must move the INDEX and leave every string alone - a duplicated
    // value inside one cacheField is what Excel "repairs".
    const file = templateCopy("existing");
    const result = await patchWorkbook(file, { rowCount: 10, period: "2024-12" });
    const cache = await part(await open(file), PART.PIVOT_CACHE_DEF);
    assert.match(cache, /<s v="9-2024"\/>/);                        // untouched
    const altas = cache.slice(cache.indexOf('<cacheField name="Altas"'));
    const field = altas.slice(0, altas.indexOf("</cacheField>"));
    assert.equal((field.match(/v="12-2024"/g) || []).length, 1);    // still exactly one
    for (const f of result.pivotFilters) assert.equal(f.rewroteSharedItem, null);
    assert.equal(result.pivotFilters.length, 3);
});

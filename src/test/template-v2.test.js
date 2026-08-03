"use strict";
/**
 * src/template-v2.xlsx - the deterministic template of 05-implementation-plan.md Phase 4.
 *
 * These are the permanent assertions behind the most delicate change in the rework
 * (05 §6 risk row 5). They run against the COMMITTED artifact, not against a freshly
 * built one, so a hand-edit of template-v2.xlsx that bypasses tools/build-template-v2.js
 * fails here - and the first test proves the committed bytes are exactly what the script
 * produces from src/template.xlsx.
 *
 * Everything is asserted on the raw OOXML. The point of the whole exercise is that the
 * parts no library models - xl/pivotTables/*, xl/pivotCache/*, xl/tables/* - survive
 * untouched, and only a byte-level check can show that.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const JSZip = require("jszip");
const XLSX = require("xlsx");
const XlsxPopulate = require("xlsx-populate");

const config = require("../config");
const { readLookups, clearLookupCache } = require("../pipeline/lookups");
const {
    build,
    COMPUTED_COLUMNS,
    RAW_COLUMNS,
    PERIOD_NAMES,
    JUNK_STRINGS,
    REPAIRED_FORMULAS,
    TABLE_LAST_ROW,
} = require("../../tools/build-template-v2");

const LEGACY = config.TEMPLATE_LEGACY;      // src/template.xlsx
const V2 = config.TEMPLATE;                 // src/template-v2.xlsx

/** Cuadro is xl/worksheets/sheet4.xml, Hoja1 is sheet3.xml (workbook.xml.rels order). */
const CUADRO_PART = "xl/worksheets/sheet4.xml";
const HOJA1_PART = "xl/worksheets/sheet3.xml";

/* ------------------------------------------------------------------- fixtures */

let cache = null;
async function parts() {
    if (cache) return cache;
    const legacy = await JSZip.loadAsync(fs.readFileSync(LEGACY));
    const v2 = await JSZip.loadAsync(fs.readFileSync(V2));
    cache = {
        legacy,
        v2,
        v2Names: new Set(Object.keys(v2.files).filter(n => !v2.files[n].dir)),
        table: await v2.file("xl/tables/table1.xml").async("string"),
        legacyTable: await legacy.file("xl/tables/table1.xml").async("string"),
        cuadro: await v2.file(CUADRO_PART).async("string"),
        hoja1: await v2.file(HOJA1_PART).async("string"),
        workbook: await v2.file("xl/workbook.xml").async("string"),
        rels: await v2.file("xl/_rels/workbook.xml.rels").async("string"),
        types: await v2.file("[Content_Types].xml").async("string"),
        shared: await v2.file("xl/sharedStrings.xml").async("string"),
    };
    return cache;
}

function sha1(buf) {
    return crypto.createHash("sha1").update(buf).digest("hex");
}

function unescapeXml(s) {
    return String(s)
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
}

/** One <tableColumn> element by id, self-closing or paired. */
function tableColumn(xml, id) {
    const re = new RegExp(`<tableColumn id="${id}"[^>]*?/>|<tableColumn id="${id}"[^>]*?>[\\s\\S]*?</tableColumn>`);
    const m = re.exec(xml);
    assert.ok(m, `no <tableColumn id="${id}">`);
    return m[0];
}

function calculatedFormula(xml, id) {
    const m = /<calculatedColumnFormula[^>]*>([\s\S]*?)<\/calculatedColumnFormula>/.exec(tableColumn(xml, id));
    return m ? unescapeXml(m[1]) : null;
}

/**
 * The <c> elements of one row of a worksheet part, keyed by column letter.
 *
 * The reference is matched anywhere in the attribute list, not just first: xlsx-populate
 * re-emits attributes in its own order (`<c cm="1" r="AD2" s="64">`), and this helper is
 * also pointed at the writer's output.
 */
function rowCells(sheetXml, rowNumber) {
    const m = new RegExp(`<row r="${rowNumber}"[^>]*>([\\s\\S]*?)</row>`).exec(sheetXml);
    assert.ok(m, `no <row r="${rowNumber}">`);
    const out = new Map();
    for (const cell of m[1].match(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g) || []) {
        const ref = /\br="([A-Z]+)\d+"/.exec(cell);
        assert.ok(ref, `cell without a reference: ${cell.slice(0, 80)}`);
        out.set(ref[1], cell);
    }
    return out;
}

/* ------------------------------------------------- the artifact is the script's */

test("template-v2.xlsx is exactly what tools/build-template-v2.js produces", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmplv2-"));
    try {
        const first = path.join(dir, "first.xlsx");
        const second = path.join(dir, "second.xlsx");
        await build(LEGACY, first);
        await build(LEGACY, second);

        // Reproducible: no wall clock, pinned zip timestamps, fixed compression level.
        assert.equal(sha1(fs.readFileSync(first)), sha1(fs.readFileSync(second)),
            "two runs of the build script disagree");
        // And the committed artifact is that output, so nobody hand-edited it.
        assert.equal(sha1(fs.readFileSync(V2)), sha1(fs.readFileSync(first)),
            "src/template-v2.xlsx is stale - re-run node tools/build-template-v2.js");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/* -------------------------------------------------- 05 §6 risk row 1: the pivots */

test("all 13 pivot tables and every pivot cache part are SHA-1 identical to template.xlsx", async () => {
    const { legacy, v2 } = await parts();

    const preserved = Object.keys(legacy.files)
        .filter(n => !legacy.files[n].dir)
        .filter(n => n.startsWith("xl/pivotTables/") || n.startsWith("xl/pivotCache/"))
        .sort();

    // 13 pivotTable parts + their 13 rels + 2 cache parts + 1 cache rels.
    assert.equal(preserved.filter(n => /pivotTables\/pivotTable\d+\.xml$/.test(n)).length, 13);
    assert.equal(preserved.length, 29);

    for (const name of preserved) {
        const after = v2.file(name);
        assert.ok(after, `${name} is missing from template-v2.xlsx`);
        assert.equal(
            sha1(await after.async("nodebuffer")),
            sha1(await legacy.file(name).async("nodebuffer")),
            `${name} is not byte-identical`
        );
    }

    // The theme is the other part xlsx-populate never models; keep it in the guard.
    assert.equal(
        sha1(await v2.file("xl/theme/theme1.xml").async("nodebuffer")),
        sha1(await legacy.file("xl/theme/theme1.xml").async("nodebuffer"))
    );
});

test("the pivot cache still binds to the table name, so resizing Tabla2 carries the pivots", async () => {
    const { v2 } = await parts();
    const def = await v2.file("xl/pivotCache/pivotCacheDefinition1.xml").async("string");
    assert.match(def, /<worksheetSource name="Tabla2"\/>/);
});

/* ------------------------------------------------ Option D: the five JS literals */

test("the five Option-D columns lost their calculatedColumnFormula, the other twelve kept theirs", async () => {
    const { table, legacyTable } = await parts();

    const literals = COMPUTED_COLUMNS.filter(c => c.literal).map(c => c.name);
    assert.deepEqual(literals, ["Edad", "Rango Edades", "BajasAntiguas", "Bajas2", "Altas"]);
    assert.equal(COMPUTED_COLUMNS.filter(c => !c.literal).length, 12);

    for (const c of COMPUTED_COLUMNS) {
        const el = tableColumn(table, c.id);
        // id and name must be byte-identical to the legacy file: the pivot cache's field
        // mapping is positional over <tableColumns> and keyed by these names.
        const legacyEl = tableColumn(legacyTable, c.id);
        const openTag = x => /^<tableColumn[^>]*?\/?>/.exec(x)[0].replace(/\/>$/, ">");
        assert.equal(openTag(el), openTag(legacyEl), `${c.name}: the <tableColumn> attributes changed`);

        if (c.literal) {
            assert.equal(calculatedFormula(table, c.id), null,
                `${c.name} still carries a calculatedColumnFormula - Excel will re-fill TODAY()-30`);
        } else {
            assert.ok(calculatedFormula(table, c.id), `${c.name} lost its calculatedColumnFormula`);
        }
    }

    // Every column still declared, and still 35 of them.
    assert.match(table, /<tableColumns count="35">/);
    assert.equal((table.match(/<tableColumn /g) || []).length, 35);
});

test("the five Option-D columns carry no <f> in Cuadro, and the twelve survivors carry exactly one", async () => {
    const { cuadro, table } = await parts();
    const cells = rowCells(cuadro, TABLE_LAST_ROW);

    for (const c of COMPUTED_COLUMNS) {
        const cell = cells.get(c.col);
        assert.ok(cell, `${c.col}${TABLE_LAST_ROW} is missing from the specimen row`);
        if (c.literal) {
            assert.ok(!cell.includes("<f"), `${c.col}${TABLE_LAST_ROW} (${c.name}) still holds a formula`);
        } else {
            assert.equal((cell.match(/<f[ >]/g) || []).length, 1, `${c.col}${TABLE_LAST_ROW} (${c.name})`);
            // The per-cell formula is generated FROM table1.xml, so the two cannot drift.
            const body = unescapeXml(/<f[^>]*>([\s\S]*?)<\/f>/.exec(cell)[1]);
            assert.equal(body, calculatedFormula(table, c.id), `${c.name}: cell and table formulas disagree`);
        }
    }

    // Trabajdores Unicos Zona Influencia is a genuine array formula; t="array" must live.
    assert.match(cells.get("AD"), /<f t="array" ref="AD2">/);
    assert.equal((cuadro.match(/<f[ >]/g) || []).length, 12);
    // No TODAY() anywhere in the sheet or the table definition - that is the whole point.
    assert.ok(!cuadro.includes("TODAY("), "TODAY() survives in Cuadro");
    assert.ok(!table.includes("TODAY("), "TODAY() survives in table1.xml");
    // The AP helper's 5,070 shared formulas and the 8,823 array formulas are gone with it.
    assert.ok(!cuadro.includes('t="shared"'));
});

/* --------------------------------------------- BUG-26: the validation columns */

test("Validar Edad and ValidarDNI carry the bodies recovered from Formato Reporte subcontratas.xlsx", async () => {
    const { table, legacyTable, cuadro } = await parts();

    const genero = calculatedFormula(table, 18);
    const edad = calculatedFormula(table, 22);
    const dni = calculatedFormula(table, 19);

    assert.equal(edad, REPAIRED_FORMULAS[22]);
    assert.equal(dni, REPAIRED_FORMULAS[19]);
    assert.equal(edad, '+IF(Tabla2[[#This Row],[Edad]]="Corregir","Corregir","Ok")');
    assert.equal(dni, '+IF(Tabla2[[#This Row],[Nro. DNI / CE]]="","Corregir",IF(LEN(Tabla2[[#This Row],[Nro. DNI / CE]])>=8,"OK","Corregir"))');

    // Validar Genero was the only correct one and must be untouched.
    assert.equal(genero, calculatedFormula(legacyTable, 18));
    assert.notEqual(edad, genero);
    assert.notEqual(dni, genero);

    // In the legacy template all three were byte-identical - that is BUG-26.
    assert.equal(calculatedFormula(legacyTable, 22), calculatedFormula(legacyTable, 18));
    assert.equal(calculatedFormula(legacyTable, 19), calculatedFormula(legacyTable, 18));

    // The specimen row agrees.
    const cells = rowCells(cuadro, TABLE_LAST_ROW);
    assert.equal(unescapeXml(/<f[^>]*>([\s\S]*?)<\/f>/.exec(cells.get("X"))[1]), REPAIRED_FORMULAS[22]);
    assert.equal(unescapeXml(/<f[^>]*>([\s\S]*?)<\/f>/.exec(cells.get("AA"))[1]), REPAIRED_FORMULAS[19]);
});

/* ------------------------------------------------------- the table geometry */

test("all four Tabla2 refs moved together to a table with no ghost rows", async () => {
    const { table, cuadro } = await parts();
    const n = TABLE_LAST_ROW;

    assert.match(table, new RegExp(`name="Tabla2" displayName="Tabla2" ref="A1:AI${n}"`));
    assert.match(table, new RegExp(`<autoFilter ref="A1:AI${n}"`));
    assert.match(table, new RegExp(`<sortState ref="A2:AI${n}"`));
    assert.match(table, new RegExp(`<sortCondition ref="C1:C${n}"/>`));
    assert.ok(!table.includes("8824"), "an 8824 ref survived in table1.xml");

    // The sheet matches the table: header row + one specimen data row and nothing else.
    const rows = cuadro.match(/<row\b[^>]*\/>|<row\b[^>]*>[\s\S]*?<\/row>/g) || [];
    assert.equal(rows.length, 2);
    assert.match(cuadro, new RegExp(`<dimension ref="A1:AI${n}"/>`));
    // Still one tablePart, still pointing at table1.xml through rId4.
    assert.match(cuadro, /<tableParts count="1"><tablePart r:id="rId4"\/><\/tableParts>/);
});

test("the specimen row carries the raw columns as empty, styled cells", async () => {
    const { cuadro, legacy } = await parts();
    const cells = rowCells(cuadro, TABLE_LAST_ROW);

    for (const col of RAW_COLUMNS) {
        const cell = cells.get(col);
        assert.ok(cell, `${col}${TABLE_LAST_ROW} is missing`);
        assert.ok(!cell.includes("<v>"), `${col}${TABLE_LAST_ROW} still holds a value`);
        assert.ok(!cell.includes("<f"), `${col}${TABLE_LAST_ROW} holds a formula`);
    }
    // F, M and O keep the built-in short-date style the pipeline writes serials against.
    for (const col of ["F", "M", "O"]) {
        assert.match(cells.get(col), /\ss="4"/, `${col}${TABLE_LAST_ROW} lost the date style`);
    }
    const styles = await legacy.file("xl/styles.xml").async("string");
    const xf = (styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)[1].match(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g) || [])[4];
    assert.match(xf, /numFmtId="14"/, "cell style 4 is no longer the short date format");
});

test("the manual date-repair helpers, AJ1 and the stale filter database are gone", async () => {
    const { cuadro, workbook } = await parts();

    for (const row of [1, 2]) {
        for (const col of ["AJ", "AK", "AL", "AM", "AN", "AO", "AP"]) {
            assert.ok(!rowCells(cuadro, row).has(col), `${col}${row} survives`);
        }
    }
    assert.ok(!cuadro.includes("LEFT(Tabla2"), "the LEFT() date helper survives");
    assert.ok(!cuadro.includes("MID(Tabla2"), "the MID() date helper survives");
    assert.ok(!cuadro.includes("RIGHT(Tabla2"), "the RIGHT() date helper survives");
    assert.ok(!cuadro.includes("DATE(AO"), "the DATE() date helper survives");

    assert.ok(!workbook.includes("_FilterDatabase"), "the stale _xlnm._FilterDatabase survives");
    assert.ok(!workbook.includes("$AK$14:$AP$8612"));
});

/* --------------------------------------------------------- BUG-28: the junk */

test("no template junk string survives outside the untouchable pivot cache", async () => {
    const { v2 } = await parts();
    const named = ["asfasf", "fafsasf", "GUARDIA RIOS ELLIOT JOULE", "LOPEZ PICON JEAN CARLOS"];

    for (const name of Object.keys(v2.files)) {
        if (v2.files[name].dir) continue;
        if (!name.endsWith(".xml") && !name.endsWith(".rels")) continue;
        // xl/pivotCache/* stays byte-identical by design (05 §6 risk row 1). It holds
        // 14,034 shared items cached by the 2024-10-01 refresh, two of which are these
        // worker names; refreshOnLoad replaces that cache the first time Excel opens the
        // file. Rewriting it here would trade a hygiene defect for a corruption risk.
        if (name.startsWith("xl/pivotCache/")) continue;
        const text = await v2.file(name).async("string");
        for (const junk of named) {
            assert.ok(!text.includes(junk), `${junk} survives in ${name}`);
        }
    }

    // "as" and "asf" are too short to grep for; assert they are gone as shared strings.
    const shared = await v2.file("xl/sharedStrings.xml").async("string");
    const texts = new Set((shared.match(/<si>[\s\S]*?<\/si>|<si\/>/g) || []).map(si =>
        (si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [])
            .map(t => unescapeXml(t.replace(/^<t[^>]*>/, "").replace(/<\/t>$/, "")))
            .join("")
    ));
    for (const junk of JUNK_STRINGS) {
        assert.ok(!texts.has(junk.text), `${junk.text} survives in the shared string table`);
    }
});

/* ---------------------------------------------------- BUG-29: the Hoja1 table */

test("the Hoja1 lookup table needs no normalization any more", async () => {
    clearLookupCache();
    const before = readLookups(LEGACY).raw;
    const after = readLookups(V2).raw;

    // What the defect looked like, so the fix is measured rather than asserted.
    assert.equal(before.zona.defects.keysNormalized, 15);
    assert.equal(before.zona.defects.paddedKeys.length, 14);
    assert.equal(before.zona.defects.internalWhitespaceKeys.length, 1);
    assert.equal(before.zona.defects.strandedKeys.length, 2);
    assert.equal(before.zona.defects.paddedValues.length, 2);

    // And what it looks like now.
    assert.equal(after.zona.defects.keysNormalized, 0, "Hoja1 keys still need trimming");
    assert.equal(after.zona.defects.paddedKeys.length, 0);
    assert.equal(after.zona.defects.internalWhitespaceKeys.length, 0);
    assert.equal(after.zona.defects.strandedKeys.length, 0);
    assert.equal(after.zona.defects.paddedValues.length, 0);
    assert.equal(after.zona.defects.collisions.length, 0, "trimming must not merge two different values");
    assert.equal(after.epc.defects.keysNormalized, 0);

    // Nothing was lost: same slots, same populated rows, same distinct normalized keys.
    assert.equal(after.zona.populated, before.zona.populated);
    assert.equal(after.zona.distinctKeys, before.zona.distinctKeys);

    // The two districts that always resolved to "No" now resolve.
    const zona = readLookups(V2).zonaByDistrito;
    assert.equal(zona.get("CARMEN DE LA LEGUA -REYNOSO"), "CALLAO");
    assert.equal(zona.get("LA PERLA CALLAO"), "CALLAO");

    // "SAN LUIS " no longer leaks its trailing space into every pivot label.
    assert.deepEqual(zona.values().filter(v => typeof v === "string" && v !== v.trim()), []);
    assert.ok(zona.values().includes("SAN LUIS"));
});

/* ------------------------------------------------- the stored report period */

test("Hoja1 carries the three period defined names as placeholders", async () => {
    const { workbook, hoja1 } = await parts();

    const names = [...workbook.matchAll(/<definedName name="([^"]+)"[^>]*>([^<]*)<\/definedName>/g)]
        .map(m => [m[1], m[2]]);
    assert.deepEqual(names, [
        ["PeriodoEtiqueta", "Hoja1!$P$4"],
        ["PeriodoFin", "Hoja1!$P$3"],
        ["PeriodoInicio", "Hoja1!$P$2"],
    ]);

    // The target cells exist and are empty - output/template.js fills them per run.
    for (const p of PERIOD_NAMES) {
        const cells = rowCells(hoja1, p.row);
        assert.ok(cells.has("P"), `Hoja1!P${p.row} is missing`);
        assert.ok(!cells.get("P").includes("<v>"), `Hoja1!P${p.row} is not a placeholder`);
        assert.ok(cells.has("O"), `Hoja1!O${p.row} label is missing`);
        if (p.dateStyle) assert.match(cells.get("P"), /\ss="4"/, `Hoja1!P${p.row} needs the date style`);
    }
    assert.match(hoja1, /<dimension ref="A2:P61"\/>/);

    // The lookup tables the business owns are still where the formulas point.
    const { table } = await parts();
    assert.ok(table.includes("Hoja1!$A$2:$B$61"));
    assert.ok(table.includes("Hoja1!$L$5:$M$9"));
});

/* ------------------------------------------------------- package integrity */

test("[Content_Types].xml and workbook.xml.rels reference no absent part", async () => {
    const { v2Names, types, rels } = await parts();

    for (const m of types.matchAll(/<Override PartName="\/([^"]+)"/g)) {
        assert.ok(v2Names.has(m[1]), `[Content_Types].xml declares absent part ${m[1]}`);
    }
    for (const m of rels.matchAll(/Target="([^"]+)"/g)) {
        if (/^https?:/.test(m[1])) continue;
        const resolved = path.posix.normalize(path.posix.join("xl", m[1]));
        assert.ok(v2Names.has(resolved), `workbook.xml.rels targets absent part ${resolved}`);
    }
    // Every worksheet's rels too, since Cuadro's rId4 is the table part.
    for (const name of v2Names) {
        if (!name.startsWith("xl/worksheets/_rels/")) continue;
        const xml = await (await parts()).v2.file(name).async("string");
        for (const m of xml.matchAll(/Target="([^"]+)"/g)) {
            const resolved = path.posix.normalize(path.posix.join("xl/worksheets", m[1]));
            assert.ok(v2Names.has(resolved), `${name} targets absent part ${resolved}`);
        }
    }
});

test("calcChain is gone and the workbook recalculates on open", async () => {
    const { v2Names, types, rels, workbook } = await parts();

    // xl/calcChain.xml indexed cells in the 8,822 deleted rows. AC 21 wants it gone with
    // its relationship and its content-type override, not orphaned behind either.
    assert.ok(!v2Names.has("xl/calcChain.xml"));
    assert.ok(!types.includes("calcChain"));
    assert.ok(!rels.includes("calcChain"));
    assert.match(workbook, /<calcPr calcId="191029" fullCalcOnLoad="1"\/>/);
});

test("the nine sheets and their visibility are unchanged", async () => {
    const { workbook } = await parts();
    const sheets = [...workbook.matchAll(/<sheet [^>]*\/>/g)]
        .map(m => [
            /\bname="([^"]+)"/.exec(m[0])[1],
            (/\bstate="(\w+)"/.exec(m[0]) || [, "visible"])[1],
        ]);
    assert.deepEqual(sheets, [
        ["Reporte Social - RRHH", "visible"],
        ["CJ Y EPC", "visible"],
        ["Hoja1", "hidden"],
        ["Cuadro", "visible"],
        ["Contratistas", "visible"],
        ["Tabla", "visible"],
        ["Sheet1", "hidden"],
        ["Dos Subcontratas por Mes", "visible"],
        ["Validacion", "hidden"],
    ]);
});

/* ----------------------------------------------------------- the two readers */

test("template-v2.xlsx opens with SheetJS", () => {
    const wb = XLSX.readFile(V2);
    assert.equal(wb.SheetNames.length, 9);
    assert.equal(wb.Sheets.Cuadro["!ref"], `A1:AI${TABLE_LAST_ROW}`);
    assert.equal(wb.Sheets.Cuadro.A1.v, "RUC");
    assert.equal(wb.Sheets.Cuadro.AI1.v, "Altas");
    assert.equal(wb.Sheets.Cuadro.V2, undefined, "the Edad specimen cell should be empty");
});

test("template-v2.xlsx round-trips through xlsx-populate without touching the pivots", async () => {
    const wb = await XlsxPopulate.fromFileAsync(V2);
    assert.deepEqual(wb.sheets().map(s => s.name()).slice(0, 2), ["Reporte Social - RRHH", "CJ Y EPC"]);
    assert.equal(wb.sheet("Cuadro").cell("A1").value(), "RUC");
    assert.equal(wb.sheet("Hoja1").cell("O2").value(), "PeriodoInicio");

    const bytes = await wb.outputAsync();
    const { legacy } = await parts();
    const after = await JSZip.loadAsync(bytes);

    for (const name of Object.keys(legacy.files)) {
        if (legacy.files[name].dir) continue;
        if (!name.startsWith("xl/pivotTables/") && !name.startsWith("xl/pivotCache/") && name !== "xl/tables/table1.xml") continue;
        assert.ok(after.file(name), `the writer dropped ${name}`);
        if (name === "xl/tables/table1.xml") continue;
        assert.equal(
            sha1(await after.file(name).async("nodebuffer")),
            sha1(await legacy.file(name).async("nodebuffer")),
            `the writer altered ${name}`
        );
    }

    // And the writer does not resurrect a formula in the five literal columns.
    const cuadro = await after.file(CUADRO_PART).async("string");
    for (const c of COMPUTED_COLUMNS.filter(x => x.literal)) {
        const cell = rowCells(cuadro, TABLE_LAST_ROW).get(c.col);
        assert.ok(!cell || !cell.includes("<f"), `${c.col}2 (${c.name}) regained a formula on write`);
    }
    assert.ok(!after.file("xl/calcChain.xml"), "the writer reintroduced calcChain.xml");
});

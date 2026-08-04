"use strict";
/**
 * Tests for the structural assertion helper (05-implementation-plan.md Phase 0 task 4).
 *
 * THE POINT OF THIS FILE: a check that cannot fail is not a check. Every one of the ten
 * checks is run against a good workbook AND against a copy corrupted in exactly the way
 * that check exists to catch, and each corruption is asserted to trip ITS OWN check AND
 * NOTHING ELSE. A corruption that trips two checks means one of them is over-reaching;
 * a corruption that trips none means the check is decorative.
 *
 * The good workbook is src/template-v2.xlsx run through output/ooxml.js's patchWorkbook
 * - i.e. the state a delivered report is supposed to be in - with the Cuadro specimen
 * row populated so the value-level checks (e), (f) and (g) have something to look at.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const JSZip = require("jszip");

const {
    assertStructure, failures, summarize, formatResults,
    CHECKS, CHECK_IDS, STATUS, StructuralError, STRUCTURAL_ERROR,
    OPTION_D_COLUMNS, FORMULA_COLUMNS, PERIOD_NAMES, TABLE_NAME,
    colLetter, colIndex, periodFromFilename,
} = require("./structural");

const config = require("../config");
const { patchWorkbook } = require("../output/ooxml");
const { parsePeriod } = require("../pipeline/period");

const TEMPLATE = config.TEMPLATE;                 // src/template-v2.xlsx
const PERIOD = "2026-02";
const REPORT_NAME = parsePeriod(PERIOD).filename; // Reporte_Subcontratistas_FEBRERO_2026.xlsx

const SHEET_CUADRO = "xl/worksheets/sheet4.xml";
const PART_TABLE = "xl/tables/table1.xml";
const PART_SST = "xl/sharedStrings.xml";
const PART_WORKBOOK = "xl/workbook.xml";
const PART_WB_RELS = "xl/_rels/workbook.xml.rels";
const PART_CT = "[Content_Types].xml";
const PART_CACHE_DEF = "xl/pivotCache/pivotCacheDefinition1.xml";

let tmpDir = null;
let baselineBuffer = null;   // the good report, as bytes

/* ------------------------------------------------------------------ *
 * XML surgery for the fixtures. Kept independent of structural.js's own
 * helpers so a bug in those cannot make a corruption silently a no-op:
 * every mutation asserts that it actually changed the part.
 * ------------------------------------------------------------------ */

function replaceOnce(xml, needle, replacement, what) {
    const at = xml.indexOf(needle);
    assert.ok(at >= 0, `la corrupcion "${what}" no encontro ${JSON.stringify(needle)}`);
    const out = xml.slice(0, at) + replacement + xml.slice(at + needle.length);
    assert.notEqual(out, xml, `la corrupcion "${what}" no cambio nada`);
    return out;
}

/** Replace the whole `<c r="REF" …/>` or `<c r="REF" …>…</c>` element. */
function setCell(xml, ref, replacement) {
    const open = new RegExp(`<c r="${ref}"(\\s[^>]*?)?(/>|>)`);
    const m = open.exec(xml);
    assert.ok(m, `no existe la celda ${ref}`);
    let end = m.index + m[0].length;
    if (m[2] === ">") {
        const close = xml.indexOf("</c>", end);
        assert.ok(close >= 0, `celda ${ref} sin cierre`);
        end = close + 4;
    }
    return xml.slice(0, m.index) + replacement + xml.slice(end);
}

/** Append `<si>` entries, returning their indexes. */
function addSharedStrings(xml, texts) {
    const existing = (xml.match(/<si[\s>]/g) || []).length;
    const block = texts.map((t) => `<si><t xml:space="preserve">${t}</t></si>`).join("");
    let out = xml.replace("</sst>", `${block}</sst>`);
    assert.notEqual(out, xml, "no se pudo ampliar sharedStrings");
    out = out.replace(/(<sst\b[^>]*?)\scount="(\d+)"/, (w, head, n) => `${head} count="${Number(n) + texts.length}"`);
    out = out.replace(/(<sst\b[^>]*?)\suniqueCount="(\d+)"/, (w, head, n) => `${head} uniqueCount="${Number(n) + texts.length}"`);
    return { xml: out, indexes: texts.map((_, i) => existing + i) };
}

/** Move all four Tabla2 refs to `lastRow` together, the way ooxml.js does. */
function resizeTable(xml, lastRow) {
    let out = xml;
    out = out.replace(/(<table\b[^>]*?)\sref="A1:AI\d+"/, `$1 ref="A1:AI${lastRow}"`);
    out = out.replace(/(<autoFilter\b[^>]*?)\sref="A1:AI\d+"/, `$1 ref="A1:AI${lastRow}"`);
    out = out.replace(/(<sortState\b[^>]*?)\sref="A2:AI\d+"/, `$1 ref="A2:AI${lastRow}"`);
    out = out.replace(/(<sortCondition\b[^>]*?)\sref="C1:C\d+"/, `$1 ref="C1:C${lastRow}"`);
    assert.ok(out.includes(`ref="A1:AI${lastRow}"`), "resizeTable no aplico");
    return out;
}

/** Clone Cuadro's row 2 as row `n`, optionally dropping every formula. */
function cloneRow2(sheetXml, n, { keepFormulas = true } = {}) {
    const start = sheetXml.indexOf('<row r="2"');
    assert.ok(start >= 0, "no existe la fila 2");
    const end = sheetXml.indexOf("</row>", start) + "</row>".length;
    let rowXml = sheetXml.slice(start, end);
    rowXml = rowXml.replace(/ r="(\d+)"/, ` r="${n}"`);                 // the <row r>
    rowXml = rowXml.replace(/ r="([A-Z]+)2"/g, ` r="$1${n}"`);          // every <c r>
    rowXml = rowXml.replace(/ ref="AD2"/g, ` ref="AD${n}"`);            // the array formula
    if (!keepFormulas) rowXml = rowXml.replace(/<f\b[^>]*>[\s\S]*?<\/f>|<f\b[^>]*\/>/g, "");
    return sheetXml.slice(0, end) + rowXml + sheetXml.slice(end);
}

/* ------------------------------------------------------------------ *
 * Fixture plumbing
 * ------------------------------------------------------------------ */

async function loadZip(buffer) {
    return JSZip.loadAsync(buffer);
}

/**
 * Write a workbook derived from the baseline into its own directory, so every fixture
 * keeps the report filename that check (j) reads the period out of.
 */
async function makeFixture(name, mutate, { filename = REPORT_NAME } = {}) {
    const dir = path.join(tmpDir, name);
    await fsp.mkdir(dir, { recursive: true });
    const zip = await loadZip(baselineBuffer);
    if (mutate) await mutate(zip);
    const buf = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
    const file = path.join(dir, filename);
    await fsp.writeFile(file, buf);
    return file;
}

/** Edit one text part in place. */
async function edit(zip, part, fn) {
    const before = await zip.file(part).async("string");
    const after = await fn(before);
    assert.notEqual(after, before, `la edicion de ${part} no cambio nada`);
    zip.file(part, after);
}

const DEFAULTS = { templatePath: TEMPLATE, expectedRows: 1, period: PERIOD };

async function run(file, options = {}) {
    return assertStructure(file, { ...DEFAULTS, ...options });
}

function statusOf(results, id) {
    const found = results.find((r) => r.check === id);
    assert.ok(found, `no hay resultado para la verificacion ${id}`);
    return found;
}

/** The heart of the file: this corruption trips exactly these checks and no others. */
function assertFailsExactly(results, expected) {
    const failed = failures(results).map((r) => r.check).sort();
    assert.deepEqual(failed, [...expected].sort(),
        `esperado que fallara ${JSON.stringify(expected)}\n${formatResults(results)}`);
}

/* ------------------------------------------------------------------ *
 * Setup: the good report
 * ------------------------------------------------------------------ */

before(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "structural-"));

    // 1. template-v2 -> patchWorkbook: the state a delivered report must be in.
    const patched = path.join(tmpDir, "base", REPORT_NAME);
    await fsp.mkdir(path.dirname(patched), { recursive: true });
    await fsp.copyFile(TEMPLATE, patched);
    await patchWorkbook(patched, { rowCount: 1, period: PERIOD });

    // 2. Populate the Cuadro specimen row with one plausible worker, so (e), (f) and (g)
    //    have real data to pass on. Synthetic values only - no real identity.
    const zip = await loadZip(await fsp.readFile(patched));
    const sstXml = await zip.file(PART_SST).async("string");
    const added = addSharedStrings(sstXml, [
        "20100000001",                    // RUC
        "SUBCONTRATA DE PRUEBA SAC",      // EMPRESA
        "CONTRATISTA DE PRUEBA SAC",      // CONTRATISTA PRNCIPAL
        "09994533",                       // Nro. DNI / CE (leading zero, AC 13)
        "TRABAJADOR DE PRUEBA",           // APELLIDOS Y NOMBRES
        "masculino",                      // GENERO
        "24 - 31",                        // Rango Edades (Option D literal)
        "No",                             // BajasAntiguas
        "No Aplica",                      // Bajas2
        "2-2026",                         // Altas == period.etiqueta
    ]);
    zip.file(PART_SST, added.xml);
    const [RUC, EMPRESA, CONTRATISTA, DNI, NOMBRE, GENERO, RANGO, BAJAS_ANT, BAJAS2, ALTAS] = added.indexes;

    let sheet = await zip.file(SHEET_CUADRO).async("string");
    const s = (ref, style, idx) => { sheet = setCell(sheet, ref, `<c r="${ref}" s="${style}" t="s"><v>${idx}</v></c>`); };
    const n = (ref, style, value) => { sheet = setCell(sheet, ref, `<c r="${ref}" s="${style}"><v>${value}</v></c>`); };
    s("A2", 1, RUC);
    s("B2", 2, EMPRESA);
    s("C2", 2, CONTRATISTA);
    s("D2", 2, DNI);
    s("E2", 2, NOMBRE);
    n("F2", 4, 32874);        // 1990-01-15, style 4 -> numFmtId 14
    s("L2", 7, GENERO);
    n("O2", 4, 45658);        // 2025-01-01
    n("V2", 24, 36);          // Edad, a JS-computed literal
    s("W2", 25, RANGO);
    s("AG2", 64, BAJAS_ANT);
    sheet = setCell(sheet, "AH2", `<c r="AH2" t="s"><v>${BAJAS2}</v></c>`);
    sheet = setCell(sheet, "AI2", `<c r="AI2" t="s"><v>${ALTAS}</v></c>`);
    zip.file(SHEET_CUADRO, sheet);

    baselineBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
});

after(async () => {
    if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * The check table itself
 * ------------------------------------------------------------------ */

describe("la tabla de verificaciones", () => {
    test("cubre exactamente a..j, sin ids repetidos, con fase asignada", () => {
        assert.deepEqual(CHECK_IDS, ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]);
        assert.equal(new Set(CHECK_IDS).size, CHECK_IDS.length);
        for (const c of CHECKS) {
            assert.ok(c.title && c.title.length > 0, `${c.id} sin titulo`);
            assert.ok(c.phase && c.phase.length > 0, `${c.id} sin fase que la reclame`);
            assert.ok(Object.isFrozen(c));
        }
    });

    test("las 17 columnas calculadas estan repartidas 5 literales / 12 formulas, sin solaparse", () => {
        assert.equal(OPTION_D_COLUMNS.length, 5);
        assert.equal(FORMULA_COLUMNS.length, 12);
        const letters = [...OPTION_D_COLUMNS, ...FORMULA_COLUMNS].map((c) => c.letter);
        assert.equal(new Set(letters).size, 17);
        const ids = [...OPTION_D_COLUMNS, ...FORMULA_COLUMNS].map((c) => c.id);
        assert.equal(new Set(ids).size, 17);
        // S..AI, i.e. index0 18..34, each exactly once.
        const indexes = [...OPTION_D_COLUMNS, ...FORMULA_COLUMNS].map((c) => c.index0).sort((a, b) => a - b);
        assert.deepEqual(indexes, Array.from({ length: 17 }, (_, i) => i + 18));
        // The five literal ones are exactly the clock-dependent columns of 05 §5.
        assert.deepEqual(OPTION_D_COLUMNS.map((c) => c.name),
            ["Edad", "Rango Edades", "BajasAntiguas", "Bajas2", "Altas"]);
    });

    test("colLetter/colIndex son inversas en el rango de la tabla", () => {
        for (let i = 0; i < 35; i++) assert.equal(colIndex(colLetter(i)), i);
        assert.equal(colLetter(0), "A");
        assert.equal(colLetter(21), "V");
        assert.equal(colLetter(34), "AI");
    });

    test("no depende del reloj: sin new Date(), Date.now() ni TODAY()", () => {
        // Comments are stripped first - they name TODAY()-30 on purpose, as the thing
        // check (h) exists to keep out of the workbook.
        const code = fs.readFileSync(path.join(__dirname, "structural.js"), "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/^\s*\/\/.*$/gm, "");
        assert.equal(/new Date\s*\(/.test(code), false);
        assert.equal(/Date\.now\s*\(/.test(code), false);
        assert.equal(/TODAY\s*\(/.test(code), false);
    });
});

/* ------------------------------------------------------------------ *
 * The good workbooks
 * ------------------------------------------------------------------ */

describe("el reporte correcto", () => {
    test("pasa las diez verificaciones", async () => {
        const file = await makeFixture("bueno", null);
        const results = await run(file);
        assert.deepEqual(summarize(results), { pass: 10, fail: 0, pending: 0 }, formatResults(results));
        for (const r of results) assert.equal(r.status, STATUS.PASS);
    });

    test("devuelve una fila por verificacion, en orden, congelada", async () => {
        const file = await makeFixture("bueno-forma", null);
        const results = await run(file);
        assert.equal(results.length, CHECKS.length);
        assert.deepEqual(results.map((r) => r.check), CHECK_IDS);
        assert.ok(Object.isFrozen(results));
        for (const r of results) {
            assert.ok(Object.isFrozen(r));
            assert.deepEqual(Object.keys(r).sort(), ["check", "detail", "phase", "status", "title"]);
            assert.equal(typeof r.detail, "string");
            assert.ok(r.detail.length > 0, `${r.check} sin detalle`);
        }
    });

    test("es determinista: dos corridas dan el mismo resultado", async () => {
        const file = await makeFixture("bueno-determinista", null);
        const a = await run(file);
        const b = await run(file);
        assert.deepEqual(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(a)));
    });

    test("sin expectedRows, (a) compara el ref contra la hoja", async () => {
        const file = await makeFixture("bueno-sin-filas", null);
        const results = await run(file, { expectedRows: undefined });
        assert.equal(statusOf(results, "a").status, STATUS.PASS);
        assert.match(statusOf(results, "a").detail, /sin expectedRows/);
    });

    test("la plantilla desnuda solo falla (d): refreshOnLoad es el parche por corrida", async () => {
        const results = await assertStructure(TEMPLATE, { templatePath: TEMPLATE, expectedRows: 1 });
        assertFailsExactly(results, ["d"]);
        assert.match(statusOf(results, "d").detail, /refreshOnLoad/);
    });

    test("los nombres definidos tambien se resuelven en forma de referencia a celda", async () => {
        // template-v2 ships PeriodoInicio -> Hoja1!$P$2; output/template.js writes the
        // values into those cells instead of into the names. Both forms must verify.
        const file = await makeFixture("periodo-por-referencia", async (zip) => {
            await edit(zip, PART_WORKBOOK, (xml) => xml.replace(
                /<definedNames>[\s\S]*?<\/definedNames>/,
                '<definedNames>' +
                `<definedName name="${PERIOD_NAMES.ETIQUETA}">Hoja1!$P$4</definedName>` +
                `<definedName name="${PERIOD_NAMES.FIN}">Hoja1!$P$3</definedName>` +
                `<definedName name="${PERIOD_NAMES.INICIO}">Hoja1!$P$2</definedName>` +
                '</definedNames>'));
            await edit(zip, "xl/worksheets/sheet3.xml", (xml) => {
                let out = setCell(xml, "P2", '<c r="P2" s="4"><v>46054</v></c>');
                out = setCell(out, "P3", '<c r="P3" s="4"><v>46081</v></c>');
                out = setCell(out, "P4", '<c r="P4" t="inlineStr"><is><t>2-2026</t></is></c>');
                return out;
            });
        });
        const results = await run(file);
        assertFailsExactly(results, []);
        assert.match(statusOf(results, "j").detail, /PeriodoInicio=46054/);
    });
});

/* ------------------------------------------------------------------ *
 * (a) the table ref
 * ------------------------------------------------------------------ */

describe("(a) Tabla2 ref == filas reales", () => {
    test("cae si el ref de <table> se adelanta a la hoja", async () => {
        const file = await makeFixture("a-ref-adelantado", async (zip) => {
            await edit(zip, PART_TABLE, (xml) =>
                xml.replace(/(<table\b[^>]*?)\sref="A1:AI2"/, '$1 ref="A1:AI3"'));
        });
        const results = await run(file);
        assertFailsExactly(results, ["a"]);
        assert.match(statusOf(results, "a").detail, /autoFilter/);
    });

    test("cae si sortCondition no acompaña al resto", async () => {
        const file = await makeFixture("a-sortcondition", async (zip) => {
            await edit(zip, PART_TABLE, (xml) =>
                replaceOnce(xml, '<sortCondition ref="C1:C2"/>', '<sortCondition ref="C1:C9"/>', "sortCondition"));
        });
        const results = await run(file);
        assertFailsExactly(results, ["a"]);
        assert.match(statusOf(results, "a").detail, /sortCondition/);
    });

    test("cae si expectedRows no coincide con el ref", async () => {
        const file = await makeFixture("a-expected", null);
        const results = await run(file, { expectedRows: 5 });
        assertFailsExactly(results, ["a"]);
        assert.match(statusOf(results, "a").detail, /se esperaban 5/);
    });

    test("cae si hay datos fuera de la tabla (BUG-11: filas invisibles a los pivots)", async () => {
        const file = await makeFixture("a-fuera-de-tabla", async (zip) => {
            await edit(zip, SHEET_CUADRO, (xml) => cloneRow2(xml, 3));
        });
        const results = await run(file);
        assertFailsExactly(results, ["a"]);
        assert.match(statusOf(results, "a").detail, /fuera de la tabla/);
    });
});

/* ------------------------------------------------------------------ *
 * (b) pivot identity
 * ------------------------------------------------------------------ */

describe("(b) partes pivot identicas a la plantilla", () => {
    test("cae si se altera una pivotTable", async () => {
        const file = await makeFixture("b-pivot-alterada", async (zip) => {
            await edit(zip, "xl/pivotTables/pivotTable5.xml", (xml) =>
                xml.replace(/(<pivotTableDefinition\b[^>]*?)\sname="[^"]*"/, '$1 name="ALTERADA"'));
        });
        const results = await run(file);
        assertFailsExactly(results, ["b"]);
        assert.match(statusOf(results, "b").detail, /pivotTable5\.xml difiere/);
    });

    test("cae si falta una parte pivot", async () => {
        const file = await makeFixture("b-pivot-ausente", async (zip) => {
            zip.remove("xl/pivotTables/pivotTable9.xml");
        });
        const results = await run(file);
        // The part is also referenced by [Content_Types] and by a sheet rel, so (c)
        // fires too - correctly: removing a part IS a dangling reference.
        assertFailsExactly(results, ["b", "c"]);
        assert.match(statusOf(results, "b").detail, /falta xl\/pivotTables\/pivotTable9\.xml/);
    });

    test("cae si la cache deja de apuntar a Tabla2", async () => {
        const file = await makeFixture("b-cache-desligada", async (zip) => {
            await edit(zip, PART_CACHE_DEF, (xml) =>
                replaceOnce(xml, `<worksheetSource name="${TABLE_NAME}"/>`,
                    '<worksheetSource name="Tabla3"/>', "worksheetSource"));
        });
        const results = await run(file);
        assertFailsExactly(results, ["b"]);
        assert.match(statusOf(results, "b").detail, /worksheetSource/);
    });

    test("cae si se altera pivotCacheRecords1.xml, que nadie debe tocar", async () => {
        const file = await makeFixture("b-records", async (zip) => {
            await edit(zip, "xl/pivotCache/pivotCacheRecords1.xml", (xml) =>
                xml.replace(/(<pivotCacheRecords\b[^>]*?)\scount="\d+"/, '$1 count="7"'));
        });
        const results = await run(file);
        assertFailsExactly(results, ["b"]);
    });

    test("NO cae por el parche sancionado de ooxml.js (refreshOnLoad + filtro de periodo)", async () => {
        // The baseline already went through patchWorkbook: pivotCacheDefinition1.xml and
        // pivotTable2.xml differ from the template's bytes, on purpose.
        const file = await makeFixture("b-parche-sancionado", null);
        const results = await run(file);
        assert.equal(statusOf(results, "b").status, STATUS.PASS);
        assert.match(statusOf(results, "b").detail, /2 salvo el parche sancionado/);
    });

    test("una etiqueta de periodo distinta sigue pasando; otro cambio en la cache no", async () => {
        const otro = await makeFixture("b-otro-periodo", async (zip) => {
            await edit(zip, PART_CACHE_DEF, (xml) => xml.replace(/<s v="2-2026"\/>/g, '<s v="11-2025"/>'));
        });
        assert.equal(statusOf(await run(otro), "b").status, STATUS.PASS);

        const roto = await makeFixture("b-item-borrado", async (zip) => {
            // Removing a shared item changes the COUNT, which is what invalidates every
            // pivot's item table - and is exactly what must not be normalised away.
            await edit(zip, PART_CACHE_DEF, (xml) => xml.replace('<s v="Borrar"/>', ""));
        });
        assert.equal(statusOf(await run(roto), "b").status, STATUS.FAIL);
    });
});

/* ------------------------------------------------------------------ *
 * (c) dangling parts
 * ------------------------------------------------------------------ */

describe("(c) sin partes ni relaciones colgantes", () => {
    test("cae con una relacion colgante (el calcChain de BUG-...)", async () => {
        const file = await makeFixture("c-rel-colgante", async (zip) => {
            await edit(zip, PART_WB_RELS, (xml) => xml.replace("</Relationships>",
                '<Relationship Id="rId999" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain"' +
                ' Target="calcChain.xml"/></Relationships>'));
        });
        const results = await run(file);
        assertFailsExactly(results, ["c"]);
        assert.match(statusOf(results, "c").detail, /rId999 -> xl\/calcChain\.xml, ausente/);
    });

    test("cae con un Override colgante en [Content_Types].xml", async () => {
        const file = await makeFixture("c-override-colgante", async (zip) => {
            await edit(zip, PART_CT, (xml) => xml.replace("</Types>",
                '<Override PartName="/xl/calcChain.xml"' +
                ' ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>'));
        });
        const results = await run(file);
        assertFailsExactly(results, ["c"]);
        assert.match(statusOf(results, "c").detail, /declara xl\/calcChain\.xml, ausente/);
    });

    test("cae con una parte presente que nadie declara", async () => {
        const file = await makeFixture("c-sin-content-type", async (zip) => {
            zip.file("xl/inventado.qqq", "x");
        });
        const results = await run(file);
        assertFailsExactly(results, ["c"]);
        assert.match(statusOf(results, "c").detail, /inventado\.qqq no tiene content type/);
    });
});

/* ------------------------------------------------------------------ *
 * (d) the recalculation flags
 * ------------------------------------------------------------------ */

describe("(d) fullCalcOnLoad + refreshOnLoad", () => {
    test("cae sin fullCalcOnLoad", async () => {
        const file = await makeFixture("d-sin-fullcalc", async (zip) => {
            await edit(zip, PART_WORKBOOK, (xml) => xml.replace(' fullCalcOnLoad="1"', ""));
        });
        const results = await run(file);
        assertFailsExactly(results, ["d"]);
        assert.match(statusOf(results, "d").detail, /fullCalcOnLoad=null/);
    });

    test("cae sin refreshOnLoad, y (b) no se contagia", async () => {
        const file = await makeFixture("d-sin-refresh", async (zip) => {
            await edit(zip, PART_CACHE_DEF, (xml) => xml.replace(' refreshOnLoad="1"', ""));
        });
        const results = await run(file);
        assertFailsExactly(results, ["d"]);
        assert.equal(statusOf(results, "b").status, STATUS.PASS);
    });
});

/* ------------------------------------------------------------------ *
 * (e) empty-string rows
 * ------------------------------------------------------------------ */

describe('(e) cero celdas "" dentro de Tabla2', () => {
    test("cae con una fila fantasma de cadenas vacias (03 §7.2)", async () => {
        const file = await makeFixture("e-fila-fantasma", async (zip) => {
            const sstXml = await zip.file(PART_SST).async("string");
            const added = addSharedStrings(sstXml, [""]);
            zip.file(PART_SST, added.xml);
            const vacio = added.indexes[0];
            await edit(zip, SHEET_CUADRO, (xml) => {
                // A faithful ghost row: the writer's .value("") in A:R, formulas intact.
                let out = cloneRow2(xml, 3);
                for (const ref of ["A3", "B3", "C3", "D3", "E3"]) {
                    out = setCell(out, ref, `<c r="${ref}" s="2" t="s"><v>${vacio}</v></c>`);
                }
                for (const ref of ["F3", "O3"]) out = setCell(out, ref, `<c r="${ref}" s="4"/>`);
                out = setCell(out, "L3", '<c r="L3" s="7"/>');
                return out;
            });
            await edit(zip, PART_TABLE, (xml) => resizeTable(xml, 3));
        });
        const results = await run(file, { expectedRows: 2 });
        assertFailsExactly(results, ["e"]);
        assert.match(statusOf(results, "e").detail, /5 celdas ""/);
    });

    test("cae con una fila con datos pero sin CONTRATISTA PRNCIPAL (el COUNTIF de 03 §7.2)", async () => {
        const file = await makeFixture("e-sin-contratista", async (zip) => {
            await edit(zip, SHEET_CUADRO, (xml) => setCell(xml, "C2", '<c r="C2" s="2"/>'));
        });
        const results = await run(file);
        assertFailsExactly(results, ["e"]);
        assert.match(statusOf(results, "e").detail, /CONTRATISTA PRNCIPAL/);
    });

    test("cae con una fila con datos pero sin APELLIDOS Y NOMBRES", async () => {
        const file = await makeFixture("e-sin-nombre", async (zip) => {
            await edit(zip, SHEET_CUADRO, (xml) => setCell(xml, "E2", '<c r="E2" s="2"/>'));
        });
        const results = await run(file);
        assertFailsExactly(results, ["e"]);
    });

    test('una celda sin valor NO es una celda "": la fila especimen de la plantilla pasa', async () => {
        // template-v2's row 2 has <c r="A2" s="1"/> in all of A:R - no value at all.
        const results = await assertStructure(TEMPLATE, { templatePath: TEMPLATE, expectedRows: 1 });
        assert.equal(statusOf(results, "e").status, STATUS.PASS);
    });
});

/* ------------------------------------------------------------------ *
 * (f) #VALUE!, NaN, "undefined"
 * ------------------------------------------------------------------ */

describe('(f) cero #VALUE!, NaN y "undefined" en Cuadro', () => {
    test("cae con un #VALUE! (los 36 trabajadores de FEBRERO_2026)", async () => {
        const file = await makeFixture("f-value", async (zip) => {
            await edit(zip, SHEET_CUADRO, (xml) =>
                setCell(xml, "W2", '<c r="W2" s="25" t="e"><v>#VALUE!</v></c>'));
        });
        const results = await run(file);
        assertFailsExactly(results, ["f"]);
        assert.match(statusOf(results, "f").detail, /#VALUE! x1/);
    });

    test('cae con la cadena literal "undefined" (BUG del genero de OCTUBRE_2025)', async () => {
        const file = await makeFixture("f-undefined", async (zip) => {
            const sstXml = await zip.file(PART_SST).async("string");
            const added = addSharedStrings(sstXml, ["undefined"]);
            zip.file(PART_SST, added.xml);
            await edit(zip, SHEET_CUADRO, (xml) =>
                setCell(xml, "Y2", `<c r="Y2" s="9" t="s"><v>${added.indexes[0]}</v></c>`));
        });
        const results = await run(file);
        assertFailsExactly(results, ["f"]);
        assert.match(statusOf(results, "f").detail, /"undefined"/);
    });

    test("cae con un NaN en una celda numerica", async () => {
        const file = await makeFixture("f-nan", async (zip) => {
            await edit(zip, SHEET_CUADRO, (xml) =>
                setCell(xml, "AB2", '<c r="AB2" s="9"><v>NaN</v></c>'));
        });
        const results = await run(file);
        assertFailsExactly(results, ["f"]);
        assert.match(statusOf(results, "f").detail, /1 celdas NaN en AB2/);
        // The corruption also drops AB2's <f>. With a single data row that is "no <f>
        // anywhere in the column", which (i) reports as a note and does not fail on -
        // Excel refills it from calculatedColumnFormula. The MIXED state is the one
        // that fails, and it needs two rows: see "cae con una columna mixta".
        assert.equal(statusOf(results, "i").status, STATUS.PASS);
        assert.match(statusOf(results, "i").detail, /sin <f> por celda en AB/);
    });
});

/* ------------------------------------------------------------------ *
 * (g) date columns
 * ------------------------------------------------------------------ */

describe("(g) F, M y O son seriales", () => {
    test("cae con una fecha de texto (las 4.894 de FECHA CESE/BAJA)", async () => {
        const file = await makeFixture("g-fecha-texto", async (zip) => {
            const sstXml = await zip.file(PART_SST).async("string");
            const added = addSharedStrings(sstXml, ["04/07/1994"]);
            zip.file(PART_SST, added.xml);
            await edit(zip, SHEET_CUADRO, (xml) =>
                setCell(xml, "F2", `<c r="F2" s="4" t="s"><v>${added.indexes[0]}</v></c>`));
        });
        const results = await run(file);
        assertFailsExactly(results, ["g"]);
        assert.match(statusOf(results, "g").detail, /04\/07\/1994/);
    });

    test('cae con un centinela de texto en FECHA CESE/BAJA ("-", "ACTIVO")', async () => {
        const file = await makeFixture("g-centinela", async (zip) => {
            const sstXml = await zip.file(PART_SST).async("string");
            const added = addSharedStrings(sstXml, ["ACTIVO"]);
            zip.file(PART_SST, added.xml);
            await edit(zip, SHEET_CUADRO, (xml) =>
                setCell(xml, "M2", `<c r="M2" s="4" t="s"><v>${added.indexes[0]}</v></c>`));
        });
        const results = await run(file);
        assertFailsExactly(results, ["g"]);
    });

    test("cae con un serial sin formato de fecha (AC 9: numFmtId 14)", async () => {
        const file = await makeFixture("g-sin-formato", async (zip) => {
            await edit(zip, SHEET_CUADRO, (xml) =>
                setCell(xml, "O2", '<c r="O2"><v>45658</v></c>'));   // sin s= -> General
        });
        const results = await run(file);
        assertFailsExactly(results, ["g"]);
        assert.match(statusOf(results, "g").detail, /sin formato de fecha/);
    });

    test("una celda de fecha vacia no es una violacion (03 §3.7)", async () => {
        const file = await makeFixture("g-vacia", async (zip) => {
            await edit(zip, SHEET_CUADRO, (xml) => setCell(xml, "F2", '<c r="F2" s="4"/>'));
        });
        const results = await run(file);
        assertFailsExactly(results, []);
    });
});

/* ------------------------------------------------------------------ *
 * (h) Option D
 * ------------------------------------------------------------------ */

describe("(h) las 5 columnas Opcion D sin formula", () => {
    for (const col of [{ name: "Edad", id: 25 }, { name: "Altas", id: 29 }]) {
        test(`cae si revive <calculatedColumnFormula> en ${col.name}`, async () => {
            const file = await makeFixture(`h-ccf-${col.id}`, async (zip) => {
                await edit(zip, PART_TABLE, (xml) => {
                    const re = new RegExp(`(<tableColumn id="${col.id}"[^>]*?)/>`);
                    assert.ok(re.test(xml), `no se encontro tableColumn id=${col.id} autocerrada`);
                    return xml.replace(re,
                        '$1><calculatedColumnFormula>IFERROR(DATEDIF(Tabla2[[#This Row],[FECHA NACIMIENTO]],' +
                        'TODAY(),"Y"),"Sin Fecha")</calculatedColumnFormula></tableColumn>');
                });
            });
            const results = await run(file);
            assertFailsExactly(results, ["h"]);
            assert.match(statusOf(results, "h").detail, new RegExp(`${col.name} conserva`));
        });
    }

    test("cae si revive un <f> por celda en V (Edad)", async () => {
        const file = await makeFixture("h-f-por-celda", async (zip) => {
            await edit(zip, SHEET_CUADRO, (xml) => setCell(xml, "V2",
                '<c r="V2" s="24"><f>DATEDIF(Tabla2[[#This Row],[FECHA NACIMIENTO]],TODAY(),"Y")</f><v>36</v></c>'));
        });
        const results = await run(file);
        assertFailsExactly(results, ["h"]);
        assert.match(statusOf(results, "h").detail, /Edad tiene <f> en 1 celdas/);
    });

    test("cae si una columna Opcion D cambia de posicion o de id", async () => {
        const file = await makeFixture("h-id-cambiado", async (zip) => {
            await edit(zip, PART_TABLE, (xml) =>
                replaceOnce(xml, '<tableColumn id="25"', '<tableColumn id="99"', "id de Edad"));
        });
        const results = await run(file);
        assertFailsExactly(results, ["h"]);
        assert.match(statusOf(results, "h").detail, /id=99/);
    });
});

/* ------------------------------------------------------------------ *
 * (i) the twelve that stay formulas
 * ------------------------------------------------------------------ */

describe("(i) las 12 restantes conservan su formula", () => {
    test("cae si se borra la formula de Zona de Influencia", async () => {
        const file = await makeFixture("i-formula-borrada", async (zip) => {
            await edit(zip, PART_TABLE, (xml) => {
                const re = /(<tableColumn id="21"[^>]*?>)<calculatedColumnFormula>[\s\S]*?<\/calculatedColumnFormula>/;
                assert.ok(re.test(xml), "no se encontro la formula de Zona de Influencia");
                return xml.replace(re, "$1");
            });
        });
        const results = await run(file);
        assertFailsExactly(results, ["i"]);
        assert.match(statusOf(results, "i").detail, /Zona de Influencia tiene 0/);
    });

    test("cae con una columna mixta: unas filas con <f> y otras sin", async () => {
        const file = await makeFixture("i-columna-mixta", async (zip) => {
            await edit(zip, SHEET_CUADRO, (xml) => cloneRow2(xml, 3, { keepFormulas: false }));
            await edit(zip, PART_TABLE, (xml) => resizeTable(xml, 3));
        });
        const results = await run(file, { expectedRows: 2 });
        assertFailsExactly(results, ["i"]);
        assert.match(statusOf(results, "i").detail, /columna mixta/);
    });

    test("cae si una columna de formula cambia de nombre (los pivots se atan al nombre)", async () => {
        const file = await makeFixture("i-nombre-cambiado", async (zip) => {
            await edit(zip, PART_TABLE, (xml) =>
                replaceOnce(xml, 'name="Trabajadores Unicos"', 'name="Trabajadores Únicos"', "nombre de AC"));
        });
        const results = await run(file);
        assertFailsExactly(results, ["i"]);
        assert.match(statusOf(results, "i").detail, /falta la columna Trabajadores Unicos/);
    });
});

/* ------------------------------------------------------------------ *
 * (j) the report period
 * ------------------------------------------------------------------ */

describe("(j) nombres Periodo* == periodo del archivo", () => {
    test("cae si falta un nombre definido", async () => {
        const file = await makeFixture("j-falta-nombre", async (zip) => {
            await edit(zip, PART_WORKBOOK, (xml) =>
                xml.replace(/<definedName name="PeriodoFin">[\s\S]*?<\/definedName>/, ""));
        });
        const results = await run(file);
        assertFailsExactly(results, ["j"]);
        assert.match(statusOf(results, "j").detail, /falta el nombre definido PeriodoFin/);
    });

    test("cae si la etiqueta no corresponde al periodo", async () => {
        const file = await makeFixture("j-etiqueta-mala", async (zip) => {
            await edit(zip, PART_WORKBOOK, (xml) =>
                replaceOnce(xml, "&quot;2-2026&quot;", "&quot;9-2024&quot;", "etiqueta"));
        });
        const results = await run(file);
        assertFailsExactly(results, ["j"]);
        assert.match(statusOf(results, "j").detail, /9-2024/);
    });

    test("cae si el serial no corresponde al periodo", async () => {
        const file = await makeFixture("j-serial-malo", async (zip) => {
            await edit(zip, PART_WORKBOOK, (xml) =>
                replaceOnce(xml, ">46054<", ">46023<", "PeriodoInicio"));
        });
        const results = await run(file);
        assertFailsExactly(results, ["j"]);
    });

    test("cae si el nombre del archivo dice otro mes (AC 22, el caso DICIEMBRE_2025)", async () => {
        const file = await makeFixture("j-archivo-otro-mes", null,
            { filename: "Reporte_Subcontratistas_MARZO_2026.xlsx" });
        const results = await run(file);
        assertFailsExactly(results, ["j"]);
        assert.match(statusOf(results, "j").detail, /el archivo dice 2026-03/);
    });

    test("cae si docProps/custom.xml no lleva el periodo", async () => {
        const file = await makeFixture("j-sin-custom", async (zip) => {
            await edit(zip, "docProps/custom.xml", (xml) =>
                xml.replace(/<property[^>]*name="Periodo[^"]*"[^>]*>[\s\S]*?<\/property>/g, ""));
        });
        const results = await run(file);
        assertFailsExactly(results, ["j"]);
        assert.match(statusOf(results, "j").detail, /custom\.xml no declara/);
    });

    test("sin periodo de referencia solo verifica la existencia", async () => {
        const file = await makeFixture("j-sin-referencia", null, { filename: "salida.xlsx" });
        const results = await assertStructure(file, { templatePath: TEMPLATE, expectedRows: 1 });
        assertFailsExactly(results, []);
        assert.match(statusOf(results, "j").detail, /sin periodo de referencia/);
    });

    test("periodFromFilename lee los 12 meses y rechaza lo demas", () => {
        assert.equal(periodFromFilename("Reporte_Subcontratistas_FEBRERO_2026.xlsx").key, "2026-02");
        assert.equal(periodFromFilename("/x/y/Reporte_Subcontratistas_DICIEMBRE_2025.xlsx").key, "2025-12");
        assert.equal(periodFromFilename("Reporte_Subcontratistas_SETIEMBRE_2025.xlsx"), null);
        assert.equal(periodFromFilename("template-v2.xlsx"), null);
        assert.equal(periodFromFilename("Reporte_Subcontratistas_FEBRERO_2026.json"), null);
    });
});

/* ------------------------------------------------------------------ *
 * pending: the burn-down list
 * ------------------------------------------------------------------ */

describe("pendientes", () => {
    test("una falla reclamada por una fase posterior se reporta pending, no fail", async () => {
        const results = await assertStructure(TEMPLATE,
            { templatePath: TEMPLATE, expectedRows: 1, pending: ["d"] });
        assert.equal(statusOf(results, "d").status, STATUS.PENDING);
        assert.match(statusOf(results, "d").detail, /reclamado por Fase 3 tarea 4/);
        assert.deepEqual(failures(results), []);
        assert.deepEqual(summarize(results), { pass: 9, fail: 0, pending: 1 });
    });

    test("una verificacion pendiente que ya pasa se reporta pass", async () => {
        const file = await makeFixture("pending-que-pasa", null);
        const results = await run(file, { pending: ["d", "e"] });
        assert.equal(statusOf(results, "d").status, STATUS.PASS);
        assert.equal(statusOf(results, "e").status, STATUS.PASS);
    });

    test("la verificacion pendiente nunca se borra de la tabla", async () => {
        const results = await assertStructure(TEMPLATE,
            { templatePath: TEMPLATE, expectedRows: 1, pending: CHECK_IDS });
        assert.deepEqual(results.map((r) => r.check), CHECK_IDS);
    });
});

/* ------------------------------------------------------------------ *
 * Caller errors and rendering
 * ------------------------------------------------------------------ */

describe("errores de invocacion", () => {
    test("archivo ausente", async () => {
        await assert.rejects(() => assertStructure(path.join(tmpDir, "no-existe.xlsx"), { templatePath: TEMPLATE }),
            (err) => err instanceof StructuralError && err.code === STRUCTURAL_ERROR.NOT_FOUND);
    });

    test("archivo que no es un zip", async () => {
        const file = path.join(tmpDir, "basura.xlsx");
        await fsp.writeFile(file, "esto no es un xlsx");
        await assert.rejects(() => assertStructure(file, { templatePath: TEMPLATE }),
            (err) => err instanceof StructuralError && err.code === STRUCTURAL_ERROR.NOT_A_ZIP);
    });

    test("plantilla ausente", async () => {
        const file = await makeFixture("plantilla-ausente", null);
        await assert.rejects(() => assertStructure(file, { templatePath: path.join(tmpDir, "no.xlsx") }),
            (err) => err instanceof StructuralError && err.code === STRUCTURAL_ERROR.NOT_FOUND);
    });

    test("opciones invalidas", async () => {
        const file = await makeFixture("opciones", null);
        await assert.rejects(() => assertStructure("", {}),
            (err) => err instanceof StructuralError && err.code === STRUCTURAL_ERROR.BAD_OPTION);
        await assert.rejects(() => assertStructure(file, { templatePath: TEMPLATE, expectedRows: -1 }),
            (err) => err instanceof StructuralError && err.code === STRUCTURAL_ERROR.BAD_OPTION);
        await assert.rejects(() => assertStructure(file, { templatePath: TEMPLATE, expectedRows: 1.5 }),
            (err) => err instanceof StructuralError && err.code === STRUCTURAL_ERROR.BAD_OPTION);
        await assert.rejects(() => assertStructure(file, { templatePath: TEMPLATE, pending: ["z"] }),
            (err) => err instanceof StructuralError && err.code === STRUCTURAL_ERROR.BAD_OPTION);
    });

    test("una hoja Cuadro ausente no mata la corrida: las demas filas siguen informando", async () => {
        const file = await makeFixture("sin-cuadro", async (zip) => {
            await edit(zip, PART_WORKBOOK, (xml) =>
                xml.replace('<sheet name="Cuadro"', '<sheet name="Otra Cosa"'));
        });
        const results = await run(file);
        assert.equal(results.length, 10);
        assert.equal(statusOf(results, "a").status, STATUS.FAIL);
        assert.match(statusOf(results, "a").detail, /no existe en xl\/workbook\.xml/);
        assert.equal(statusOf(results, "b").status, STATUS.PASS);   // the pivots are untouched
    });
});

describe("presentacion", () => {
    test("formatResults imprime una linea por verificacion mas el resumen", async () => {
        const file = await makeFixture("formato", null);
        const results = await run(file);
        const text = formatResults(results, { title: "prueba" });
        const lines = text.split("\n");
        assert.equal(lines[0], "prueba");
        for (const c of CHECKS) {
            assert.ok(lines.some((l) => l.startsWith(`  ${c.id}  `) && l.includes(c.title)),
                `falta la fila ${c.id}`);
        }
        assert.match(lines[lines.length - 1], /10 ok, 0 fallan, 0 pendientes de 10/);
    });
});

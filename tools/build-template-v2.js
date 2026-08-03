"use strict";
/**
 * Build src/template-v2.xlsx from src/template.xlsx.
 *
 * This is the deterministic template of 05-implementation-plan.md Phase 4 (tasks 3-7)
 * and 03-expected-output.md §5-§7. It is a SCRIPT and not a manual Excel edit so the
 * transformation is reviewable, re-runnable and diffable; the output is committed.
 *
 * WHY STRING SUBSTITUTION AND NOT AN XML LIBRARY
 * ----------------------------------------------
 * 05 §6 risk row 1: a mangled pivot part is an unusable compliance report that looks
 * fine until the client opens it. So no part is ever parsed-and-reserialized. Every
 * edit below is a targeted substitution whose match count is asserted, and the 13
 * pivotTable parts plus both pivotCache parts are verified SHA-1 identical to the
 * source at the end of the run. The pivot cache binds to the TABLE NAME
 * (<worksheetSource name="Tabla2"/>), so resizing Tabla2 is enough - the pivots follow.
 *
 * WHAT IT CHANGES (each numbered item maps to the brief and to Phase 4)
 * --------------------------------------------------------------------
 *  1. xl/tables/table1.xml: delete <calculatedColumnFormula> from the five Option-D
 *     columns (V Edad, W Rango Edades, AG BajasAntiguas, AH Bajas2, AI Altas). Their
 *     values become JS literals written per run against the explicit report period.
 *     Leaving the element in place is not cosmetic: Excel treats those cells as an
 *     inconsistent calculated column and re-fills the formula on the next table edit,
 *     sort or refresh, silently restoring TODAY()-30 (05 §5, 03 §5).
 *  2. Repair the two copy-paste-broken validation columns, X "Validar Edad" and
 *     AA "ValidarDNI", which are byte-identical copies of Z "Validar Genero" today.
 *     The correct bodies are recovered verbatim from the previous generation of the
 *     same workbook, src/Formato Reporte subcontratas.xlsx (BUG-26 / 03 §5.1).
 *  3. Clean Cuadro: drop the junk in rows 2-3 (BUG-28), the AK/AM/AO/AP manual
 *     date-repair helpers, the "a" in AJ1 and the stale _xlnm._FilterDatabase.
 *  4. Trim the Hoja1 lookup keys that can never match through Excel's TRIM(), and the
 *     "SAN LUIS " value that propagates into every pivot as a non-canonical label
 *     (BUG-29). pipeline/lookups.js measures this; its count must fall to zero here.
 *  5. Shrink Tabla2 to A1:AI2 - all four refs move together - and truncate the sheet
 *     to match, so the shipped template carries no ghost rows and no structured
 *     reference lives outside the table. output/ooxml.js grows it per run.
 *  6. Add the period defined names PeriodoInicio / PeriodoFin / PeriodoEtiqueta on the
 *     already-hidden Hoja1 (03 §6.1). output/template.js fills them per run.
 *
 * Plus one consequence of item 5: xl/calcChain.xml is dropped (it indexes cells in the
 * 8,822 deleted rows, and a calcChain pointing at absent cells is a repair prompt
 * waiting to happen), together with its relationship and its content-type override -
 * which is also 03 AC 21. fullCalcOnLoad="1" goes on <calcPr> in the same breath,
 * because without a calc chain the workbook must full-calc on open.
 *
 * DETERMINISM. Nothing here reads the wall clock. Zip entry timestamps are pinned to
 * the DOS epoch so two runs of this script produce byte-identical files.
 *
 *   node tools/build-template-v2.js [inputPath] [outputPath]
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const JSZip = require("jszip");

const SRC = path.join(__dirname, "..", "src");
const DEFAULT_IN = path.join(SRC, "template.xlsx");
const DEFAULT_OUT = path.join(SRC, "template-v2.xlsx");

/** The table keeps one data row. output/ooxml.js rewrites this to 1 + n per run. */
const TABLE_LAST_ROW = 2;

/** Zip entry timestamp. Explicit argument - config forbids a bare new Date(). */
const FIXED_DATE = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));

/* ------------------------------------------------------------------ column map */

/**
 * The 17 computed columns of Tabla2, S..AI, in sheet order, with the tableColumn id
 * they carry in xl/tables/table1.xml. `literal: true` is Option D: the column loses
 * its calculated-column formula and is written as a value by the pipeline.
 *
 * ids verified against src/template.xlsx before use - assertColumnIdentity() below
 * re-checks name and id on every run so an id drift fails the build instead of
 * silently deleting the wrong column's formula.
 */
const COMPUTED_COLUMNS = Object.freeze([
    { col: "S", id: 27, name: "EPC/CJV", literal: false },
    { col: "T", id: 26, name: "Tipo de Empresa", literal: false },
    { col: "U", id: 20, name: "Contratistas", literal: false },
    { col: "V", id: 25, name: "Edad", literal: true },
    { col: "W", id: 23, name: "Rango Edades", literal: true },
    { col: "X", id: 22, name: "Validar Edad", literal: false },
    { col: "Y", id: 21, name: "Zona de Influencia", literal: false },
    { col: "Z", id: 18, name: "Validar Genero", literal: false },
    { col: "AA", id: 19, name: "ValidarDNI", literal: false },
    { col: "AB", id: 24, name: "Trabajador", literal: false },
    { col: "AC", id: 30, name: "Trabajadores Unicos", literal: false },
    { col: "AD", id: 31, name: "Trabajdores Unicos Zona Influencia", literal: false },
    { col: "AE", id: 32, name: "Altas Zona de Influencia", literal: false },
    { col: "AF", id: 33, name: "Bajas Zona Influencia", literal: false },
    { col: "AG", id: 34, name: "BajasAntiguas", literal: true },
    { col: "AH", id: 28, name: "Bajas2", literal: true },
    { col: "AI", id: 29, name: "Altas", literal: true },
]);

/** The 18 raw columns, A..R. Written by output/template.js from the canonical records. */
const RAW_COLUMNS = Object.freeze([
    "A", "B", "C", "D", "E", "F", "G", "H", "I",
    "J", "K", "L", "M", "N", "O", "P", "Q", "R",
]);

/** Leftover manual date-repair helpers on Cuadro (03 §5.2). They go, with AJ1's "a". */
const HELPER_COLUMNS = Object.freeze(["AJ", "AK", "AL", "AM", "AN", "AO", "AP"]);

/**
 * The recovered bodies of the two broken validation columns, unescaped.
 *
 * Source: src/Formato Reporte subcontratas.xlsx -> xl/tables/table1.xml, tableColumn
 * id=22 and id=19. Verbatim, including the leading "+" and the mixed-case "Ok"/"OK"
 * literals - 03 §5.1 uses exactly that casing difference as the evidence these ran in
 * production. Do not "tidy" them.
 */
const REPAIRED_FORMULAS = Object.freeze({
    22: '+IF(Tabla2[[#This Row],[Edad]]="Corregir","Corregir","Ok")',
    19: '+IF(Tabla2[[#This Row],[Nro. DNI / CE]]="","Corregir",IF(LEN(Tabla2[[#This Row],[Nro. DNI / CE]])>=8,"OK","Corregir"))',
});

/**
 * Cuadro junk to erase from the shared string table, by measured index.
 *
 * All eight are referenced by Cuadro!A2:E3 and by nothing else in the workbook
 * (verified by scanning every t="s" reference in all nine sheets). Rows 2 and 3 are
 * deleted below, so these entries become unreferenced - but the strings would still be
 * physically present in xl/sharedStrings.xml, and 03 AC 20 wants them gone. The <si>
 * elements are BLANKED IN PLACE rather than removed: deleting one would renumber every
 * later index and rewrite the meaning of thousands of cells.
 *
 * `scan: true` marks the strings distinctive enough to be searched as raw substrings
 * across every part. "as" and "asf" are not - they occur inside ordinary XML - so those
 * two are only asserted as exact <si> texts.
 */
const JUNK_STRINGS = Object.freeze([
    { index: 3328, text: "asfasf", scan: true },
    { index: 3329, text: "asf", scan: false },
    { index: 3330, text: "as", scan: false },
    { index: 3331, text: "fafsasf", scan: true },
    { index: 433, text: "71244274", scan: true },
    { index: 434, text: "GUARDIA RIOS ELLIOT JOULE", scan: true },
    { index: 439, text: "73932936", scan: true },
    { index: 440, text: "LOPEZ PICON JEAN CARLOS", scan: true },
]);

/** Labels written next to the period placeholders on Hoja1, appended to the sst. */
const PERIOD_NAMES = Object.freeze([
    { name: "PeriodoInicio", row: 2, cell: "$P$2", dateStyle: true },
    { name: "PeriodoFin", row: 3, cell: "$P$3", dateStyle: true },
    { name: "PeriodoEtiqueta", row: 4, cell: "$P$4", dateStyle: false },
]);

/* ---------------------------------------------------------------- xml helpers */

function xmlEscape(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function xmlUnescape(s) {
    return String(s)
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
}

/**
 * Every substitution in this file goes through here. A silent no-op edit on an OOXML
 * part is exactly the failure mode that ships a broken workbook, so a wrong match
 * count is a hard error and the build stops.
 */
function replaceExactly(xml, needle, replacement, expected, label) {
    const parts = xml.split(needle);
    const found = parts.length - 1;
    if (found !== expected) {
        throw new Error(`${label}: expected ${expected} occurrence(s) of ${JSON.stringify(needle.slice(0, 120))}, found ${found}`);
    }
    return parts.join(replacement);
}

function replaceRegexExactly(xml, re, replacement, expected, label) {
    let found = 0;
    const out = xml.replace(re, (...args) => {
        found++;
        return typeof replacement === "function" ? replacement(...args) : replacement;
    });
    if (found !== expected) {
        throw new Error(`${label}: expected ${expected} match(es), found ${found}`);
    }
    return out;
}

/** Excel's TRIM: collapse internal whitespace runs to one space, then strip the ends. */
function excelTrim(value) {
    return String(value).replace(/\s+/g, " ").trim();
}

function sha1(buf) {
    return crypto.createHash("sha1").update(buf).digest("hex");
}

/* ------------------------------------------------------- 1. xl/tables/table1.xml */

/** Pull one <tableColumn> element (self-closing or paired) out of table1.xml by id. */
function tableColumnById(xml, id) {
    const re = new RegExp(`<tableColumn id="${id}"[^>]*?/>|<tableColumn id="${id}"[^>]*?>[\\s\\S]*?</tableColumn>`);
    const m = re.exec(xml);
    if (!m) throw new Error(`table1.xml: no <tableColumn id="${id}">`);
    return m[0];
}

function tableColumnName(element) {
    const m = /\sname="([^"]*)"/.exec(element);
    if (!m) throw new Error(`table1.xml: <tableColumn> without a name: ${element.slice(0, 80)}`);
    return xmlUnescape(m[1]);
}

/** Fail the build if the ids in COMPUTED_COLUMNS ever stop matching the real file. */
function assertColumnIdentity(tableXml) {
    for (const c of COMPUTED_COLUMNS) {
        const el = tableColumnById(tableXml, c.id);
        const name = tableColumnName(el);
        if (name !== c.name) {
            throw new Error(`table1.xml: id=${c.id} is named ${JSON.stringify(name)}, expected ${JSON.stringify(c.name)}`);
        }
        if (!el.includes("<calculatedColumnFormula")) {
            throw new Error(`table1.xml: id=${c.id} (${name}) carries no <calculatedColumnFormula>`);
        }
    }
}

/** The calculated-column formula of one column, unescaped, plus its array flag. */
function calculatedFormula(tableXml, id) {
    const el = tableColumnById(tableXml, id);
    const m = /<calculatedColumnFormula([^>]*)>([\s\S]*?)<\/calculatedColumnFormula>/.exec(el);
    if (!m) throw new Error(`table1.xml: id=${id} has no <calculatedColumnFormula>`);
    return { array: m[1].includes('array="1"'), escaped: m[2], body: xmlUnescape(m[2]) };
}

function transformTable(xml) {
    assertColumnIdentity(xml);
    let out = xml;

    // 1a. Repair Validar Edad (id 22) and ValidarDNI (id 19) BEFORE anything else, so
    //     the specimen row below can be generated from the repaired bodies.
    for (const [id, body] of Object.entries(REPAIRED_FORMULAS)) {
        const el = tableColumnById(out, id);
        const repaired = el.replace(
            /<calculatedColumnFormula([^>]*)>[\s\S]*?<\/calculatedColumnFormula>/,
            `<calculatedColumnFormula$1>${xmlEscape(body)}</calculatedColumnFormula>`
        );
        out = replaceExactly(out, el, repaired, 1, `table1.xml repair id=${id}`);
    }

    // 1b. Option D: delete the calculated-column formula of the five clock-dependent
    //     columns. The open tag - id, name, uid, dataDxfId, dataCellStyle - is kept
    //     byte-identical and merely self-closed, so the pivot cache field mapping,
    //     which is positional over <tableColumns>, is untouched.
    for (const c of COMPUTED_COLUMNS.filter(x => x.literal)) {
        const el = tableColumnById(out, c.id);
        const openTag = /^<tableColumn[^>]*>/.exec(el)[0];
        const selfClosed = `${openTag.slice(0, -1)}/>`;
        out = replaceExactly(out, el, selfClosed, 1, `table1.xml drop formula id=${c.id} (${c.name})`);
    }

    // 1c. Resize. The four refs move together or Excel rebuilds the table on open.
    const n = TABLE_LAST_ROW;
    out = replaceExactly(out, ' ref="A1:AI8824" totalsRowShown="0"', ` ref="A1:AI${n}" totalsRowShown="0"`, 1, "table1.xml table ref");
    out = replaceExactly(out, '<autoFilter ref="A1:AI8824"', `<autoFilter ref="A1:AI${n}"`, 1, "table1.xml autoFilter ref");
    out = replaceExactly(out, '<sortState ref="A2:AI8824"', `<sortState ref="A2:AI${n}"`, 1, "table1.xml sortState ref");
    out = replaceExactly(out, '<sortCondition ref="C1:C8824"/>', `<sortCondition ref="C1:C${n}"/>`, 1, "table1.xml sortCondition ref");

    return out;
}

/* ------------------------------------------- 2. xl/worksheets/sheet4.xml (Cuadro) */

/** Split a <row> into its <c> children. <c> cannot nest and formula text is escaped. */
function cellsOf(rowXml) {
    return rowXml.match(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g) || [];
}

function cellColumn(cellXml) {
    return /<c r="([A-Z]+)\d+"/.exec(cellXml)[1];
}

/** The cell's attributes minus r, and minus t (no value survives, so no type either). */
function cellStyleAttrs(cellXml) {
    const attrs = /^<c\b([^>]*?)\/?>/.exec(cellXml)[1];
    return attrs
        .replace(/\s+r="[^"]*"/, "")
        .replace(/\s+t="[^"]*"/, "")
        .replace(/\s+$/, "");
}

/**
 * Rebuild Cuadro's sheetData as exactly two rows: the header row and one specimen data
 * row. Everything else in the sheet - 8,822 rows of styled-but-empty cells, 12 rows of
 * leftover real workers, 5,070 shared formulas in the AP helper column and 8,823 array
 * formulas in AD - goes.
 *
 * The specimen row is what output/template.js clones per record: it carries the per-
 * column style index verbatim (F, M and O keep s="4" -> numFmtId 14, the built-in short
 * date), the twelve surviving formulas REGENERATED FROM table1.xml so the two can never
 * disagree, and nothing at all in the five Option-D columns.
 */
function transformCuadro(xml, tableXml) {
    const start = xml.indexOf("<sheetData>");
    const end = xml.indexOf("</sheetData>");
    if (start < 0 || end < 0) throw new Error("sheet4.xml: no <sheetData>");
    const body = xml.slice(start + "<sheetData>".length, end);

    const rows = body.match(/<row\b[^>]*\/>|<row\b[^>]*>[\s\S]*?<\/row>/g) || [];
    if (rows.length !== 8824) throw new Error(`sheet4.xml: expected 8824 rows, found ${rows.length}`);

    // -- header row: drop AJ1 ("a"), keep every other cell byte-identical.
    let header = rows[0];
    const headerCells = cellsOf(header).filter(c => !HELPER_COLUMNS.includes(cellColumn(c)));
    if (headerCells.length !== 35) {
        throw new Error(`sheet4.xml: header row keeps ${headerCells.length} cells, expected 35`);
    }
    const headerOpen = /^<row\b[^>]*>/.exec(header)[0].replace(/spans="[^"]*"/, 'spans="1:35"');
    header = `${headerOpen}${headerCells.join("")}</row>`;

    // -- specimen row: styles from the original row 2, formulas from table1.xml.
    const styleByColumn = new Map();
    for (const cell of cellsOf(rows[1])) styleByColumn.set(cellColumn(cell), cellStyleAttrs(cell));

    const specimenCells = [];
    for (const col of RAW_COLUMNS) {
        specimenCells.push(`<c r="${col}2"${styleByColumn.get(col) || ""}/>`);
    }
    for (const c of COMPUTED_COLUMNS) {
        const attrs = styleByColumn.get(c.col) || "";
        if (c.literal) {
            // No <f>, no <v>: the pipeline writes a literal here (Option D).
            specimenCells.push(`<c r="${c.col}2"${attrs}/>`);
            continue;
        }
        const f = calculatedFormula(tableXml, c.id);
        // Trabajdores Unicos Zona Influencia is a genuine array formula; t="array" and
        // ref must survive or Excel drops it to a scalar SUMPRODUCT (05 §6 risk row 5).
        const fTag = f.array
            ? `<f t="array" ref="${c.col}2">${f.escaped}</f>`
            : `<f>${f.escaped}</f>`;
        specimenCells.push(`<c r="${c.col}2"${attrs}>${fTag}</c>`);
    }
    const specimenOpen = /^<row\b[^>]*>/.exec(rows[1])[0].replace(/spans="[^"]*"/, 'spans="1:35"');
    const specimen = `${specimenOpen}${specimenCells.join("")}</row>`;

    let out = xml.slice(0, start) + `<sheetData>${header}${specimen}</sheetData>` + xml.slice(end + "</sheetData>".length);

    // The sheet no longer extends past AI2; leaving AU8824 makes Excel reserve the old
    // rectangle and reintroduces the ghost-row footprint this task removes.
    out = replaceExactly(out, '<dimension ref="A1:AU8824"/>', `<dimension ref="A1:AI${TABLE_LAST_ROW}"/>`, 1, "sheet4.xml dimension");
    // The saved view pointed at rows 12/13 of the deleted block.
    out = replaceExactly(out, '<pane ySplit="1" topLeftCell="A12"', '<pane ySplit="1" topLeftCell="A2"', 1, "sheet4.xml pane");
    out = replaceExactly(out, 'activeCell="C13" sqref="C13"', 'activeCell="A2" sqref="A2"', 1, "sheet4.xml selection");

    return out;
}

/* ------------------------------------------------------ 3. xl/sharedStrings.xml */

/** Byte spans of every <si> in the shared string table, in index order. */
function sharedItemSpans(xml) {
    const spans = [];
    const re = /<si>[\s\S]*?<\/si>|<si\/>/g;
    let m;
    while ((m = re.exec(xml)) !== null) spans.push({ start: m.index, end: m.index + m[0].length, xml: m[0] });
    return spans;
}

function sharedItemText(siXml) {
    return xmlUnescape((siXml.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [])
        .map(t => t.replace(/^<t[^>]*>/, "").replace(/<\/t>$/, ""))
        .join(""));
}

function siElement(text) {
    const preserve = text !== text.trim() ? ' xml:space="preserve"' : "";
    return `<si><t${preserve}>${xmlEscape(text)}</t></si>`;
}

/**
 * Which shared-string indices the Hoja1 lookup tables use as keys or values.
 *
 * Driven off the sheet rather than a hard-coded index list, so the repair is described
 * by the table's own geometry (pipeline/lookups.js TABLES: A2:B61 and L5:M9) and cannot
 * silently target the wrong entry if the workbook is re-saved.
 */
function lookupStringIndices(hoja1Xml) {
    const wanted = [];
    for (let r = 2; r <= 61; r++) wanted.push(`A${r}`, `B${r}`);
    for (let r = 5; r <= 9; r++) wanted.push(`L${r}`, `M${r}`);
    const set = new Set(wanted);

    const indices = new Set();
    const re = /<c r="([A-Z]+\d+)"([^>]*)>\s*<v>(\d+)<\/v>\s*<\/c>/g;
    let m;
    while ((m = re.exec(hoja1Xml)) !== null) {
        if (!set.has(m[1])) continue;
        if (!/\bt="s"/.test(m[2])) continue;      // numeric cells (Hoja1!A28 = 166) are not keys
        indices.add(Number(m[3]));
    }
    return indices;
}

function transformSharedStrings(xml, hoja1Xml, report) {
    const spans = sharedItemSpans(xml);
    const edits = new Map();                       // index -> replacement <si>

    // 3a. BUG-29: keys and values the live template's TRIM() can never reach.
    for (const index of lookupStringIndices(hoja1Xml)) {
        const text = sharedItemText(spans[index].xml);
        const fixed = excelTrim(text);
        if (fixed === text) continue;
        edits.set(index, siElement(fixed));
        report.lookupTrimmed.push({ index, from: text, to: fixed });
    }

    // 3b. Cuadro row 2/3 junk, blanked in place (see JUNK_STRINGS).
    for (const junk of JUNK_STRINGS) {
        const text = sharedItemText(spans[junk.index].xml);
        if (text !== junk.text) {
            throw new Error(`sharedStrings: index ${junk.index} is ${JSON.stringify(text)}, expected ${JSON.stringify(junk.text)}`);
        }
        edits.set(junk.index, "<si><t/></si>");
        report.junkBlanked.push({ index: junk.index, text });
    }

    // Apply back-to-front so earlier offsets stay valid.
    let out = xml;
    for (const index of [...edits.keys()].sort((a, b) => b - a)) {
        const span = spans[index];
        out = out.slice(0, span.start) + edits.get(index) + out.slice(span.end);
    }

    // 3c. Append the three period labels. Appending never renumbers an existing index.
    const firstNewIndex = spans.length;
    const appended = PERIOD_NAMES.map(p => siElement(p.name)).join("");
    out = replaceExactly(out, "</sst>", `${appended}</sst>`, 1, "sharedStrings append");
    out = replaceRegexExactly(out, /uniqueCount="(\d+)"/, (_, n) => `uniqueCount="${Number(n) + PERIOD_NAMES.length}"`, 1, "sharedStrings uniqueCount");

    report.periodLabelIndices = PERIOD_NAMES.map((p, i) => ({ name: p.name, index: firstNewIndex + i }));
    return out;
}

/* --------------------------------------------- 4. xl/worksheets/sheet3.xml (Hoja1) */

/**
 * Put the period placeholders on the hidden Hoja1, next to the lookup tables the
 * business already maintains there (03 §6.1). Label in O, value in P, on rows 2..4 -
 * three rows that already exist, so no <row> has to be invented and cell order inside
 * each row stays ascending.
 *
 * The value cells ship EMPTY. They are placeholders; output/template.js writes the real
 * serials and the "<M>-<YYYY>" label per run. P2/P3 carry s="4" (numFmtId 14, the same
 * built-in short date the Cuadro date columns use) so a written serial renders as a date.
 */
function transformHoja1(xml, periodLabelIndices) {
    let out = replaceExactly(xml, '<dimension ref="A2:M61"/>', '<dimension ref="A2:P61"/>', 1, "sheet3.xml dimension");

    for (let i = 0; i < PERIOD_NAMES.length; i++) {
        const p = PERIOD_NAMES[i];
        const labelIndex = periodLabelIndices[i].index;
        const re = new RegExp(`(<row r="${p.row}"[^>]*>)([\\s\\S]*?)(</row>)`);
        const m = re.exec(out);
        if (!m) throw new Error(`sheet3.xml: no <row r="${p.row}">`);
        const open = m[1].replace(/spans="[^"]*"/, 'spans="1:16"');
        const valueCell = p.dateStyle ? `<c r="P${p.row}" s="4"/>` : `<c r="P${p.row}"/>`;
        const added = `<c r="O${p.row}" s="1" t="s"><v>${labelIndex}</v></c>${valueCell}`;
        out = replaceExactly(out, m[0], `${open}${m[2]}${added}${m[3]}`, 1, `sheet3.xml row ${p.row}`);
    }
    return out;
}

/* ------------------------------------------------------------- 5. xl/workbook.xml */

function transformWorkbook(xml) {
    // The stale filter database points at the AK:AP helper block that no longer exists.
    // Replacing the whole <definedNames> block in one substitution keeps the element
    // ordering Excel expects (definedNames sits between <sheets> and <calcPr>).
    const oldNames = '<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="3" hidden="1">Cuadro!$AK$14:$AP$8612</definedName></definedNames>';
    // Excel writes defined names sorted by name; keep that order.
    const newNames = "<definedNames>"
        + [...PERIOD_NAMES]
            .sort((a, b) => (a.name < b.name ? -1 : 1))
            .map(p => `<definedName name="${p.name}">Hoja1!${p.cell}</definedName>`)
            .join("")
        + "</definedNames>";
    let out = replaceExactly(xml, oldNames, newNames, 1, "workbook.xml definedNames");

    // xl/calcChain.xml is dropped below, so the workbook must recalculate on open.
    // 03 AC 21 requires this on the generated report too; output/ooxml.js is idempotent.
    out = replaceExactly(out, '<calcPr calcId="191029"/>', '<calcPr calcId="191029" fullCalcOnLoad="1"/>', 1, "workbook.xml calcPr");
    return out;
}

/* ---------------------------------------------------------------------- driver */

async function build(inputPath, outputPath) {
    const source = await JSZip.loadAsync(fs.readFileSync(inputPath));
    const report = { lookupTrimmed: [], junkBlanked: [], periodLabelIndices: [] };

    const read = async name => {
        const file = source.file(name);
        if (!file) throw new Error(`${inputPath}: missing part ${name}`);
        return file.async("string");
    };

    const tableXml = transformTable(await read("xl/tables/table1.xml"));
    const cuadroXml = transformCuadro(await read("xl/worksheets/sheet4.xml"), tableXml);
    const hoja1Raw = await read("xl/worksheets/sheet3.xml");
    const sharedXml = transformSharedStrings(await read("xl/sharedStrings.xml"), hoja1Raw, report);
    const hoja1Xml = transformHoja1(hoja1Raw, report.periodLabelIndices);
    const workbookXml = transformWorkbook(await read("xl/workbook.xml"));

    // calcChain indexes cells in the deleted rows. Drop the part, its relationship and
    // its content-type override together - a declared-but-absent part is a repair prompt.
    const relsXml = replaceExactly(
        await read("xl/_rels/workbook.xml.rels"),
        '<Relationship Id="rId15" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/>',
        "", 1, "workbook.xml.rels calcChain"
    );
    const typesXml = replaceExactly(
        await read("[Content_Types].xml"),
        '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/>',
        "", 1, "[Content_Types].xml calcChain"
    );

    const out = new JSZip();
    const names = Object.keys(source.files);
    const replacements = new Map([
        ["xl/tables/table1.xml", tableXml],
        ["xl/worksheets/sheet4.xml", cuadroXml],
        ["xl/worksheets/sheet3.xml", hoja1Xml],
        ["xl/sharedStrings.xml", sharedXml],
        ["xl/workbook.xml", workbookXml],
        ["xl/_rels/workbook.xml.rels", relsXml],
        ["[Content_Types].xml", typesXml],
    ]);

    for (const name of names) {
        const entry = source.files[name];
        if (entry.dir) continue;
        if (name === "xl/calcChain.xml") continue;
        const content = replacements.has(name)
            ? Buffer.from(replacements.get(name), "utf8")
            : await entry.async("nodebuffer");
        out.file(name, content, { date: FIXED_DATE, createFolders: false });
    }

    const bytes = await out.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
        platform: "UNIX",
    });
    fs.writeFileSync(outputPath, bytes);

    await verify(inputPath, outputPath, report);
    return report;
}

/* -------------------------------------------------------------------- verify */

/** Parts that must come through byte-for-byte. 05 §6 risk row 1 is measured here. */
function preservedParts(zip) {
    return Object.keys(zip.files)
        .filter(n => n.startsWith("xl/pivotTables/") || n.startsWith("xl/pivotCache/") || n === "xl/theme/theme1.xml")
        .sort();
}

async function verify(inputPath, outputPath, report) {
    const before = await JSZip.loadAsync(fs.readFileSync(inputPath));
    const after = await JSZip.loadAsync(fs.readFileSync(outputPath));

    const partsBefore = preservedParts(before);
    const partsAfter = preservedParts(after);
    if (partsBefore.join("|") !== partsAfter.join("|")) {
        throw new Error("verify: the preserved part inventory changed");
    }
    for (const name of partsBefore) {
        const a = sha1(await before.file(name).async("nodebuffer"));
        const b = sha1(await after.file(name).async("nodebuffer"));
        if (a !== b) throw new Error(`verify: ${name} is not SHA-1 identical (${a} != ${b})`);
    }
    report.preservedParts = partsBefore.length;

    const tableXml = await after.file("xl/tables/table1.xml").async("string");
    for (const c of COMPUTED_COLUMNS) {
        const el = tableColumnById(tableXml, c.id);
        const has = el.includes("<calculatedColumnFormula");
        if (c.literal && has) throw new Error(`verify: ${c.name} still carries a calculatedColumnFormula`);
        if (!c.literal && !has) throw new Error(`verify: ${c.name} lost its calculatedColumnFormula`);
        if (tableColumnName(el) !== c.name) throw new Error(`verify: id=${c.id} name drifted`);
    }

    const names = new Set(Object.keys(after.files));
    const types = await after.file("[Content_Types].xml").async("string");
    for (const m of types.matchAll(/<Override PartName="\/([^"]+)"/g)) {
        if (!names.has(m[1])) throw new Error(`verify: [Content_Types].xml declares absent part ${m[1]}`);
    }
    const rels = await after.file("xl/_rels/workbook.xml.rels").async("string");
    for (const m of rels.matchAll(/Target="([^"]+)"/g)) {
        if (/^https?:/.test(m[1])) continue;
        const resolved = path.posix.normalize(path.posix.join("xl", m[1]));
        if (!names.has(resolved)) throw new Error(`verify: workbook.xml.rels targets absent part ${resolved}`);
    }

    // Junk strings must not survive. The pivot cache is exempt and stays byte-identical:
    // it holds 14,034 shared items cached by a 2024-10-01 refresh, including the same two
    // worker names, and rewriting it is exactly the corruption risk this build avoids.
    // refreshOnLoad (output/ooxml.js) replaces that cache the first time the file opens.
    const shared = await after.file("xl/sharedStrings.xml").async("string");
    const sharedTexts = new Set(sharedItemSpans(shared).map(s => sharedItemText(s.xml)));
    for (const junk of JUNK_STRINGS) {
        if (sharedTexts.has(junk.text)) throw new Error(`verify: ${junk.text} survives in the shared string table`);
    }
    for (const name of Object.keys(after.files)) {
        if (after.files[name].dir) continue;
        if (name.startsWith("xl/pivotCache/")) continue;
        if (!name.endsWith(".xml") && !name.endsWith(".rels")) continue;
        const text = await after.file(name).async("string");
        for (const junk of JUNK_STRINGS) {
            if (junk.scan && text.includes(junk.text)) throw new Error(`verify: ${junk.text} survives in ${name}`);
        }
    }
}

/* ------------------------------------------------------------------------ main */

if (require.main === module) {
    const inputPath = process.argv[2] || DEFAULT_IN;
    const outputPath = process.argv[3] || DEFAULT_OUT;
    build(inputPath, outputPath).then(report => {
        const size = fs.statSync(outputPath).size;
        process.stdout.write(
            `${path.relative(process.cwd(), outputPath)} written (${(size / 1048576).toFixed(2)} MB)\n` +
            `  claves de Hoja1 recortadas: ${report.lookupTrimmed.length}\n` +
            report.lookupTrimmed.map(t => `    ${JSON.stringify(t.from)} -> ${JSON.stringify(t.to)}\n`).join("") +
            `  cadenas basura borradas:    ${report.junkBlanked.length}\n` +
            `  partes preservadas SHA-1:   ${report.preservedParts}\n`
        );
    }).catch(err => {
        process.stderr.write(`build-template-v2 failed: ${err.stack}\n`);
        process.exitCode = 1;
    });
}

module.exports = { build, COMPUTED_COLUMNS, RAW_COLUMNS, PERIOD_NAMES, JUNK_STRINGS, REPAIRED_FORMULAS, TABLE_LAST_ROW };

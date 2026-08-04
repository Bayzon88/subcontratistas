"use strict";
/**
 * The post-write OOXML patcher.
 *
 * `xlsx-populate` writes the workbook, then this module reaches into the finished
 * .xlsx and fixes the six things xlsx-populate cannot know about, because it never
 * models those parts at all: the Excel Table's extent, the pivot cache's refresh
 * flag, the workbook's calculation flag, a dangling relationship, the report period,
 * and two pivot page filters frozen on "9-2024".
 *
 * THE ONE RULE: targeted string substitution, never parse-and-reserialize.
 *
 * That rule is the whole reason Option D works (05-implementation-plan.md §5). The
 * six pivot sheets ARE the deliverable, there is no library in the JS ecosystem that
 * can write a pivot table, and the only reason the current app does not destroy them
 * is that xlsx-populate keeps the archive as a live JSZip and rewrites only the parts
 * it models. Round-tripping `xl/pivotTables/*` or `xl/pivotCache/*` through any XML
 * DOM would reorder attributes, normalize self-closing tags and drop the `mc:Ignorable`
 * namespaces - i.e. produce a file that is byte-different everywhere and, in the worst
 * case, silently unreadable by Excel. So: every edit here is a `String.replace` over a
 * located substring, and the result is asserted by SHA-1 in src/test/ooxml.test.js.
 * (05-implementation-plan.md §6, risk row 1 - "Never parse-and-reserialize".)
 *
 * What is patched, and why:
 *
 *  1. `xl/tables/table1.xml` - the FOUR refs of Tabla2 (BUG-11). The template freezes
 *     them at row 8824. Anything past that is written to the sheet but falls OUTSIDE
 *     the table: no calculated columns, invisible to the shared pivot cache, silently
 *     excluded from every total. Resizing removes the 8,823-row ceiling by construction.
 *  2. `xl/pivotCache/pivotCacheDefinition1.xml` - `refreshOnLoad="1"` (BUG-14). Absent
 *     today, which is why five of the fourteen archived reports still display
 *     September-2024 figures.
 *  3. `xl/workbook.xml` - `fullCalcOnLoad="1"` on `<calcPr>`. REQUIRED under Option D,
 *     not cosmetic: xlsx-populate strips the cached `<v>` from every formula cell and
 *     does not emit `calcChain.xml`, so without it the twelve columns that stay
 *     formulas can open empty while feeding a FRESHLY REFRESHED pivot cache - an
 *     inconsistency that is strictly worse than today's uniform staleness because it
 *     is invisible.
 *  4. The dangling `calcChain` relationship + content-type override. They point at a
 *     part xlsx-populate does not emit; a dangling relationship is a "needs repair"
 *     prompt waiting to happen (03-expected-output.md §7.4).
 *  5. The report period, as three defined names and three custom document properties,
 *     so the workbook records the month it is for and the filename cannot disagree
 *     with the content (03-expected-output.md AC 22; DICIEMBRE_2025 is the proof they
 *     currently can - refreshed 2025-12-30, its own Altas page filter reads "11-2025").
 *  6. The pivot page filters on `Altas` and `Bajas2` (Phase 4 task 5, AC 19).
 *
 * DETERMINISM. Nothing here reads a clock. The period is an argument; the temp file
 * name uses the pid (which never reaches the output bytes); every entry keeps its
 * original zip timestamp and compression method, so patching the same input twice
 * produces byte-identical output. That is asserted, not assumed.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const JSZip = require("jszip");

const { parsePeriod } = require("../pipeline/period");

/** Part paths. Fixed by the template; asserted rather than discovered. */
const PART = Object.freeze({
    CONTENT_TYPES: "[Content_Types].xml",
    ROOT_RELS: "_rels/.rels",
    WORKBOOK: "xl/workbook.xml",
    WORKBOOK_RELS: "xl/_rels/workbook.xml.rels",
    TABLE: "xl/tables/table1.xml",
    PIVOT_CACHE_DEF: "xl/pivotCache/pivotCacheDefinition1.xml",
    PIVOT_CACHE_RECORDS: "xl/pivotCache/pivotCacheRecords1.xml",
    CALC_CHAIN: "xl/calcChain.xml",
    CUSTOM_PROPS: "docProps/custom.xml",
});

/** The Excel Table the whole dependency chain hangs off. */
const TABLE_NAME = "Tabla2";

/**
 * The two cache fields that carry a period label. Both hold `PeriodoEtiqueta` for
 * rows inside the period and a sentinel otherwise; `Altas` is filtered by
 * pivotTable3 / pivotTable7 and `Bajas2` by pivotTable2 (the `Detalle Cesados Zona
 * de Influencia` block). Named, not indexed - the index is derived from the cache's
 * own `<cacheField>` order so a template edit cannot silently repoint a filter at
 * the wrong column.
 */
const PERIOD_CACHE_FIELDS = Object.freeze(["Altas", "Bajas2"]);

/** The template's own label shape: month number, NO zero padding, hyphen, year. */
const PERIOD_LABEL_RE = /^\d{1,2}-\d{4}$/;

/** Excel's hard sheet limit. Past this the file is not repairable, it is impossible. */
const EXCEL_MAX_ROWS = 1048576;

const CALC_CHAIN_REL_TYPE =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain";
const CUSTOM_PROPS_REL_TYPE =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties";
const CUSTOM_PROPS_CONTENT_TYPE =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.custom-properties+xml";

/** The one fmtid Office uses for user-defined document properties. */
const CUSTOM_PROPS_FMTID = "{D5CDD505-2E9C-101B-9397-08002B2CF9AE}";

/** The three names written into `<definedNames>` and into docProps/custom.xml. */
const PERIOD_NAMES = Object.freeze({
    INICIO: "PeriodoInicio",
    FIN: "PeriodoFin",
    ETIQUETA: "PeriodoEtiqueta",
});

/**
 * A STRUCTURAL failure - the template is not the shape this module was written
 * against. It throws, deliberately, unlike every data-level problem in the pipeline:
 * a table that was not resized produces a report whose extra rows are invisible to
 * every pivot, and that failure is undetectable downstream. Better a dead run than a
 * plausible-looking wrong report (05 §6 risk row 1).
 */
class OoxmlError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "OoxmlError";
        this.code = code;
    }
}

const OOXML_ERROR = Object.freeze({
    MISSING_PART: "MISSING_PART",
    BAD_ROW_COUNT: "BAD_ROW_COUNT",
    BAD_PERIOD: "BAD_PERIOD",
    TABLE_SHAPE: "TABLE_SHAPE",
    WORKBOOK_SHAPE: "WORKBOOK_SHAPE",
    CACHE_SHAPE: "CACHE_SHAPE",
    NOT_A_ZIP: "NOT_A_ZIP",
});

function fail(code, message) {
    throw new OoxmlError(code, message);
}

/* ------------------------------------------------------------------ *
 * Minimal XML string surgery
 * ------------------------------------------------------------------ */

/**
 * Attribute soup inside an open tag, quote-aware so a `>` inside an attribute value
 * cannot terminate the match early. Used everywhere instead of `[^>]*`.
 */
const ATTRS = "(?:[^>\"']|\"[^\"]*\"|'[^']*')*";

function xmlEscape(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function xmlUnescape(value) {
    return String(value)
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
}

/**
 * Locate the FIRST open tag named `tag`. `\b` keeps `<table` from matching
 * `<tableColumn` and `<sortState` from matching `<sortCondition`.
 * @returns {{start:number,end:number,text:string,attrs:string,selfClosing:boolean}|null}
 */
function findOpenTag(xml, tag, from = 0) {
    const re = new RegExp(`<${tag}\\b(${ATTRS}?)(/?)>`);
    const slice = xml.slice(from);
    const m = re.exec(slice);
    if (!m) return null;
    return {
        start: from + m.index,
        end: from + m.index + m[0].length,
        text: m[0],
        attrs: m[1],
        selfClosing: m[2] === "/",
    };
}

/** Read one attribute out of an open-tag string. `null` when absent. */
function getAttr(tagText, name) {
    const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tagText);
    return m ? m[1] : null;
}

/**
 * Set (or add) one attribute on an open-tag string, returning the new tag text.
 * Adding appends just before the tag's `>` / `/>`, which keeps every other attribute
 * byte-identical and in its original order - the point of not reserializing.
 */
function setAttr(tagText, name, value) {
    const escaped = xmlEscape(value);
    const re = new RegExp(`(\\s${name}=")[^"]*(")`);
    if (re.test(tagText)) return tagText.replace(re, `$1${escaped}$2`);
    const selfClosing = /\/>$/.test(tagText);
    const head = tagText.slice(0, tagText.length - (selfClosing ? 2 : 1));
    return `${head} ${name}="${escaped}"${selfClosing ? "/>" : ">"}`;
}

/** Splice `replacement` into `xml` over [start, end). */
function splice(xml, start, end, replacement) {
    return xml.slice(0, start) + replacement + xml.slice(end);
}

/**
 * Remove every `<tag …>` element whose open tag satisfies `predicate`, handling the
 * self-closing and the paired form.
 *
 * Written as an element walk rather than one regex on purpose: a regex of the shape
 * `<definedName …>[\s\S]*?</definedName>` silently eats everything up to the NEXT
 * element's close when the match is self-closing, which would delete unrelated
 * defined names. Removal has to know where the element actually ends.
 */
function removeElementsWhere(xml, tag, predicate) {
    const closeTag = `</${tag}>`;
    let out = "";
    let i = 0;
    const removed = [];
    for (;;) {
        const open = findOpenTag(xml, tag, i);
        if (!open) { out += xml.slice(i); break; }
        let end;
        if (open.selfClosing) {
            end = open.end;
        } else {
            const close = xml.indexOf(closeTag, open.end);
            if (close < 0) { out += xml.slice(i); break; }  // malformed - leave it alone
            end = close + closeTag.length;
        }
        if (predicate(open.text)) {
            out += xml.slice(i, open.start);
            removed.push(xml.slice(open.start, end));
        } else {
            out += xml.slice(i, end);
        }
        i = end;
    }
    return { xml: out, removed };
}

/** Every open tag named `tag`, in document order. */
function collectOpenTags(xml, tag) {
    const tags = [];
    let i = 0;
    for (;;) {
        const open = findOpenTag(xml, tag, i);
        if (!open) break;
        tags.push(open);
        i = open.end;
    }
    return tags;
}

/* ------------------------------------------------------------------ *
 * 1. Tabla2 - the four refs (BUG-11)
 * ------------------------------------------------------------------ */

/**
 * `A1:AI8824` -> `A1:AI<lastRow>`. The START cell is preserved verbatim, which is the
 * whole point: `<sortState>` starts at row 2 (it excludes the header) and
 * `<sortCondition>` is a single column `C1:C…`. A naive global replace of one ref
 * VALUE would rewrite `A2:AI8824` as `A1:AI8824` and quietly re-sort the header row
 * into the data.
 */
function retargetRef(ref, lastRow, where) {
    const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref);
    if (!m) {
        fail(OOXML_ERROR.TABLE_SHAPE,
            `${PART.TABLE}: ${where} ref="${ref}" no tiene la forma <col><fila>:<col><fila>`);
    }
    const startRow = Number(m[2]);
    if (startRow > lastRow) {
        fail(OOXML_ERROR.TABLE_SHAPE,
            `${PART.TABLE}: ${where} ref="${ref}" empieza en la fila ${startRow}, ` +
            `posterior a la ultima fila calculada ${lastRow}`);
    }
    return `${m[1]}${m[2]}:${m[3]}${lastRow}`;
}

/**
 * Rewrite the four refs of Tabla2 together. Each is located by its OWN element, so
 * the three distinct shapes stay distinct.
 *
 * The pivot cache binds to the TABLE NAME (`<worksheetSource name="Tabla2"/>`), not
 * to a range, so resizing here is enough - all 13 pivots follow automatically and no
 * pivot part is touched. That is the mechanic Option D rests on.
 */
function resizeTable(xml, lastRow) {
    const table = findOpenTag(xml, "table");
    if (!table) fail(OOXML_ERROR.TABLE_SHAPE, `${PART.TABLE}: falta el elemento <table>`);

    const name = getAttr(table.text, "name");
    if (name !== TABLE_NAME) {
        fail(OOXML_ERROR.TABLE_SHAPE,
            `${PART.TABLE}: se esperaba name="${TABLE_NAME}", encontrado ${JSON.stringify(name)}`);
    }

    const applied = {};
    let out = xml;

    // Each ref is reached through its OWN element, so `<table>` can never hit
    // `<tableColumn>` and `<sortState>` can never hit `<sortCondition>`.
    for (const tag of ["table", "autoFilter", "sortState", "sortCondition"]) {
        const found = findOpenTag(out, tag);
        if (!found) {
            fail(OOXML_ERROR.TABLE_SHAPE, `${PART.TABLE}: falta el elemento <${tag}>`);
        }
        // Exactly one of each is expected; a second occurrence would mean the template
        // grew a structure this function does not understand, and a half-resized table
        // is the invisible failure this module exists to prevent.
        if (findOpenTag(out, tag, found.end)) {
            fail(OOXML_ERROR.TABLE_SHAPE,
                `${PART.TABLE}: se encontro mas de un <${tag}>; el patch asume exactamente uno`);
        }
        const ref = getAttr(found.text, "ref");
        if (!ref) fail(OOXML_ERROR.TABLE_SHAPE, `${PART.TABLE}: <${tag}> sin atributo ref`);
        applied[tag] = retargetRef(ref, lastRow, `<${tag}>`);
        out = splice(out, found.start, found.end, setAttr(found.text, "ref", applied[tag]));
    }

    return { xml: out, refs: applied };
}

/* ------------------------------------------------------------------ *
 * 2. refreshOnLoad on the pivot cache (BUG-14)
 * ------------------------------------------------------------------ */

function setRefreshOnLoad(xml) {
    const root = findOpenTag(xml, "pivotCacheDefinition");
    if (!root) {
        fail(OOXML_ERROR.CACHE_SHAPE,
            `${PART.PIVOT_CACHE_DEF}: falta el elemento <pivotCacheDefinition>`);
    }
    // recordCount is deliberately NOT updated. It must equal the number of <r> in
    // pivotCacheRecords1.xml, and those records are not rebuilt here; a mismatch is a
    // repair prompt. refreshOnLoad discards the records on open and rebuilds both.
    // refreshedBy/refreshedDate are likewise left alone - rewriting them would need a
    // clock, and Excel overwrites them the moment it honours refreshOnLoad.
    return splice(xml, root.start, root.end, setAttr(root.text, "refreshOnLoad", "1"));
}

/* ------------------------------------------------------------------ *
 * 3 + 5. workbook.xml - fullCalcOnLoad and the period defined names
 * ------------------------------------------------------------------ */

/**
 * Elements that may legally follow `<definedNames>` in CT_Workbook's sequence. Used
 * only when the workbook has no `<definedNames>` at all and one must be inserted in
 * a schema-valid position.
 */
const AFTER_DEFINED_NAMES = [
    "calcPr", "oleSize", "customWorkbookViews", "pivotCaches", "smartTagPr",
    "smartTagTypes", "webPublishing", "fileRecoveryPr", "webPublishObjects", "extLst",
];

function periodDefinedNamesXml(period) {
    // PeriodoInicio / PeriodoFin are real 1900-system date serials, per
    // 03-expected-output.md §6.1 ("Both real date serials"), so a formula can compare
    // a FECHA cell against them directly. PeriodoEtiqueta is a quoted string constant.
    //
    // WORKBOOK-scoped, not local to Hoja1: a sheet-local name is only visible on its
    // own sheet, and §6.4's fallback formulas reference PeriodoInicio from `Cuadro`.
    // "on Hoja1" in the plan means "stored alongside the lookup tables the business
    // owns", not "scoped to Hoja1".
    return (
        `<definedName name="${PERIOD_NAMES.INICIO}">${period.inicioSerial}</definedName>` +
        `<definedName name="${PERIOD_NAMES.FIN}">${period.finSerial}</definedName>` +
        `<definedName name="${PERIOD_NAMES.ETIQUETA}">&quot;${xmlEscape(period.etiqueta)}&quot;</definedName>`
    );
}

/** Drop any previously-written Periodo* name, so a second patch is a no-op. */
function stripPeriodDefinedNames(xml) {
    const names = new Set(Object.values(PERIOD_NAMES));
    return removeElementsWhere(xml, "definedName", (tag) => names.has(getAttr(tag, "name"))).xml;
}

function patchWorkbookXml(xml, period) {
    let out = stripPeriodDefinedNames(xml);
    const block = periodDefinedNamesXml(period);

    const open = findOpenTag(out, "definedNames");
    if (open && !open.selfClosing) {
        const close = out.indexOf("</definedNames>", open.end);
        if (close < 0) {
            fail(OOXML_ERROR.WORKBOOK_SHAPE,
                `${PART.WORKBOOK}: <definedNames> sin cierre`);
        }
        out = splice(out, close, close, block);
    } else if (open && open.selfClosing) {
        out = splice(out, open.start, open.end, `<definedNames>${block}</definedNames>`);
    } else {
        // No <definedNames> at all: insert one in the first schema-valid slot.
        let at = -1;
        for (const tag of AFTER_DEFINED_NAMES) {
            const found = findOpenTag(out, tag);
            if (found) { at = found.start; break; }
        }
        if (at < 0) at = out.lastIndexOf("</workbook>");
        if (at < 0) {
            fail(OOXML_ERROR.WORKBOOK_SHAPE,
                `${PART.WORKBOOK}: no se encontro donde insertar <definedNames>`);
        }
        out = splice(out, at, at, `<definedNames>${block}</definedNames>`);
    }

    // fullCalcOnLoad. Located AFTER the defined names are in place so the anchor
    // search is not disturbed by the insertion offsets.
    const calcPr = findOpenTag(out, "calcPr");
    if (calcPr) {
        out = splice(out, calcPr.start, calcPr.end,
            setAttr(calcPr.text, "fullCalcOnLoad", "1"));
    } else {
        // CT_Workbook puts <calcPr> immediately after <definedNames>.
        const close = out.indexOf("</definedNames>");
        const at = close >= 0 ? close + "</definedNames>".length : out.lastIndexOf("</workbook>");
        if (at < 0) {
            fail(OOXML_ERROR.WORKBOOK_SHAPE,
                `${PART.WORKBOOK}: no se encontro donde insertar <calcPr>`);
        }
        out = splice(out, at, at, `<calcPr fullCalcOnLoad="1"/>`);
    }

    return out;
}

/* ------------------------------------------------------------------ *
 * 4. The dangling calcChain references
 * ------------------------------------------------------------------ */

/**
 * Remove the calcChain relationship from `xl/_rels/workbook.xml.rels`, located by
 * its relationship TYPE. Never by assuming rId15: the rId is an arbitrary token that
 * Excel renumbers whenever the workbook is edited, and matching on it would silently
 * stop working - and silently leave the dangling reference - the first time it moved.
 *
 * @returns {{xml:string, removedId:string|null}}
 */
function stripCalcChainRelationship(xml) {
    let removedId = null;
    const result = removeElementsWhere(xml, "Relationship", (tag) => {
        if (getAttr(tag, "Type") !== CALC_CHAIN_REL_TYPE) return false;
        removedId = getAttr(tag, "Id");
        return true;
    });
    return { xml: result.xml, removedId };
}

/** Remove one `<Override PartName="…"/>` from [Content_Types].xml. */
function stripContentTypeOverride(xml, partName) {
    const result = removeElementsWhere(xml, "Override",
        (tag) => getAttr(tag, "PartName") === partName);
    return { xml: result.xml, removed: result.removed.length > 0 };
}

/* ------------------------------------------------------------------ *
 * 5b. docProps/custom.xml
 * ------------------------------------------------------------------ */

const EMPTY_CUSTOM_PROPS =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
    `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" ` +
    `xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"></Properties>`;

function patchCustomProps(xml, period) {
    const names = new Set(Object.values(PERIOD_NAMES));
    // Idempotence: drop ours first, then renumber from what is left, so the pids we
    // write are a pure function of the OTHER properties in the part.
    let out = removeElementsWhere(xml, "property", (tag) => names.has(getAttr(tag, "name"))).xml;

    let maxPid = 1; // pid 0 and 1 are reserved by the spec; user properties start at 2.
    for (const tag of collectOpenTags(out, "property")) {
        const pid = Number(getAttr(tag.text, "pid"));
        if (Number.isFinite(pid) && pid > maxPid) maxPid = pid;
    }

    const values = [
        [PERIOD_NAMES.INICIO, period.inicio],
        [PERIOD_NAMES.FIN, period.fin],
        [PERIOD_NAMES.ETIQUETA, period.etiqueta],
    ];
    // ISO strings rather than vt:filetime: a filetime carries a timezone, and this
    // module is not allowed to have one (05 §1 principle 3).
    const block = values
        .map(([name, value], i) =>
            `<property fmtid="${CUSTOM_PROPS_FMTID}" pid="${maxPid + 1 + i}" ` +
            `name="${xmlEscape(name)}"><vt:lpwstr>${xmlEscape(value)}</vt:lpwstr></property>`)
        .join("");

    const close = out.lastIndexOf("</Properties>");
    if (close < 0) {
        fail(OOXML_ERROR.WORKBOOK_SHAPE, `${PART.CUSTOM_PROPS}: falta </Properties>`);
    }
    out = splice(out, close, close, block);
    return { xml: out, properties: Object.fromEntries(values) };
}

const CUSTOM_PROPS_RE_ESCAPED = CUSTOM_PROPS_REL_TYPE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Add the custom-properties Override / Relationship when the part had to be created. */
function ensureCustomPropsWired(contentTypes, rootRels) {
    let ct = contentTypes;
    if (!ct.includes(`PartName="/${PART.CUSTOM_PROPS}"`)) {
        const close = ct.lastIndexOf("</Types>");
        ct = splice(ct, close, close,
            `<Override PartName="/${PART.CUSTOM_PROPS}" ContentType="${CUSTOM_PROPS_CONTENT_TYPE}"/>`);
    }
    let rels = rootRels;
    if (!new RegExp(`Type="${CUSTOM_PROPS_RE_ESCAPED}"`).test(rels)) {
        let maxId = 0;
        for (const m of rels.matchAll(/\sId="rId(\d+)"/g)) {
            const n = Number(m[1]);
            if (n > maxId) maxId = n;
        }
        const close = rels.lastIndexOf("</Relationships>");
        rels = splice(rels, close, close,
            `<Relationship Id="rId${maxId + 1}" Type="${CUSTOM_PROPS_REL_TYPE}" ` +
            `Target="docProps/custom.xml"/>`);
    }
    return { contentTypes: ct, rootRels: rels };
}

/* ------------------------------------------------------------------ *
 * 6. The pivot page filters (Phase 4 task 5, AC 19)
 * ------------------------------------------------------------------ */

/**
 * A pivot page filter is TWO levels of indirection deep, which is exactly why the
 * plan warns not to guess:
 *
 *   <pageField fld="34" item="14"/>          in xl/pivotTables/pivotTableN.xml
 *      -> pivotFields[34]/items[14] = <item x="1"/>
 *      -> cacheFields[34]/sharedItems[1]  = <s v="9-2024"/>   in the cache definition
 *
 * So "9-2024" is not a string sitting in the pivot part; it is a string in the shared
 * cache reached through an index in the pivot part. Repointing means one of two
 * things, and this module decides which by looking:
 *
 *   a) the run's PeriodoEtiqueta ALREADY exists among the cache's shared items ->
 *      change the INDEX in <pageField item="…">, touch no string;
 *   b) it does not -> rewrite the ONE live period-shaped shared item ("9-2024") to
 *      the run's etiqueta, and point <pageField> at whichever items entry references
 *      it. Rewriting rather than appending keeps the shared-item count and every
 *      other index stable, which is what makes this safe.
 *
 * Never both, and never a blind append: a duplicated shared-item value inside one
 * cacheField is precisely the inconsistency Excel "repairs".
 *
 * `xl/pivotCache/pivotCacheRecords1.xml` is left byte-identical on purpose, even though
 * its `<x v="1"/>` entries now resolve to the new label instead of "9-2024". Those
 * records still describe the template's September-2024 population and are discarded
 * wholesale by the refresh; rewriting them would mean regenerating the cache, which is
 * the one thing 05 §6 risk row 1 forbids. `recordCount` is left alone for the same
 * reason - it must agree with the records part, and it does.
 *
 * The rewritten string is only a seed. `refreshOnLoad="1"` makes Excel rebuild the
 * cache from Tabla2 on open; a page selection survives a refresh when its VALUE still
 * exists in the new data, and under Option D it does, because the JS-computed Altas /
 * Bajas2 literals are exactly PeriodoEtiqueta. That is the whole mechanism: today the
 * selection is "9-2024", the refreshed data has no such value, and the filter resolves
 * to nothing - which is why pivotTable2's Total column is all zeros and it listed 55
 * rows against a summary of 79.
 */

/** Locate `<cacheField name="X" …>…</cacheField>`, exactly (the closing quote in the
 *  needle keeps "Altas" from matching "Altas Zona de Influencia"). */
function findCacheField(xml, name) {
    const needle = `<cacheField name="${xmlEscape(name)}"`;
    const start = xml.indexOf(needle);
    if (start < 0) return null;
    const open = findOpenTag(xml, "cacheField", start);
    if (!open || open.start !== start) return null;
    if (open.selfClosing) return { start, end: open.end, bodyStart: open.end, bodyEnd: open.end };
    const close = xml.indexOf("</cacheField>", open.end);
    if (close < 0) return null;
    return { start, end: close + "</cacheField>".length, bodyStart: open.end, bodyEnd: close };
}

/** Ordinal position of a cacheField, which IS the `fld` index used by every pivot. */
function cacheFieldIndex(xml, name) {
    const tags = collectOpenTags(xml, "cacheField");
    return tags.findIndex((t) => xmlUnescape(getAttr(t.text, "name") || "") === name);
}

/**
 * Enumerate a cacheField's `<sharedItems>` children IN ORDER. The index a pivot item
 * refers to counts every child - `<s>`, `<m>`, `<n>`, `<b>`, `<d>`, `<e>` - not just
 * the string ones, so a missing-value `<m u="1"/>` occupies a slot.
 */
function parseSharedItems(cacheXml, field) {
    const open = findOpenTag(cacheXml, "sharedItems", field.bodyStart);
    if (!open || open.start >= field.bodyEnd) return null;
    if (open.selfClosing) return { items: [], bodyStart: open.end, bodyEnd: open.end };
    const close = cacheXml.indexOf("</sharedItems>", open.end);
    if (close < 0 || close > field.bodyEnd) return null;

    const body = cacheXml.slice(open.end, close);
    const items = [];
    const re = new RegExp(`<(s|m|n|b|d|e)\\b(${ATTRS}?)/>`, "g");
    let consumed = 0;
    for (const m of body.matchAll(re)) {
        if (m.index !== consumed) {
            // Something other than a self-closing item (an <s> with a <tables> child,
            // for instance). Bail rather than mis-index every item after it.
            return null;
        }
        consumed = m.index + m[0].length;
        const raw = getAttr(m[0], "v");
        items.push({
            tag: m[1],
            value: raw === null ? null : xmlUnescape(raw),
            unused: getAttr(m[0], "u") === "1",
            start: open.end + m.index,
            end: open.end + m.index + m[0].length,
            text: m[0],
        });
    }
    if (consumed !== body.length) return null;
    return { items, bodyStart: open.end, bodyEnd: close };
}

/** Split `<pivotFields>` into its `<pivotField>` elements, in order. */
function parsePivotFields(pivotXml) {
    const open = findOpenTag(pivotXml, "pivotFields");
    if (!open || open.selfClosing) return null;
    const close = pivotXml.indexOf("</pivotFields>", open.end);
    if (close < 0) return null;

    const fields = [];
    let i = open.end;
    while (i < close) {
        const tag = findOpenTag(pivotXml, "pivotField", i);
        if (!tag || tag.start >= close) break;
        if (tag.selfClosing) {
            fields.push({ start: tag.start, end: tag.end, bodyStart: tag.end, bodyEnd: tag.end });
            i = tag.end;
        } else {
            const end = pivotXml.indexOf("</pivotField>", tag.end);
            if (end < 0 || end > close) return null;
            fields.push({
                start: tag.start,
                end: end + "</pivotField>".length,
                bodyStart: tag.end,
                bodyEnd: end,
            });
            i = end + "</pivotField>".length;
        }
    }
    return fields;
}

/**
 * Index of the `<item x="k"/>` entry inside one pivotField's `<items>`. Items with a
 * `t` attribute (`t="default"`, the grand total) are never a page selection.
 */
function pivotItemIndexFor(pivotXml, field, sharedIndex) {
    const open = findOpenTag(pivotXml, "items", field.bodyStart);
    if (!open || open.start >= field.bodyEnd || open.selfClosing) return -1;
    const close = pivotXml.indexOf("</items>", open.end);
    if (close < 0 || close > field.bodyEnd) return -1;

    const body = pivotXml.slice(open.end, close);
    let i = 0;
    for (const m of body.matchAll(new RegExp(`<item\\b(${ATTRS}?)/>`, "g"))) {
        const tag = m[0];
        if (getAttr(tag, "t") === null && Number(getAttr(tag, "x")) === sharedIndex) return i;
        i++;
    }
    return -1;
}

/** Does this pivot carry a page filter on cache field `fld`? */
function hasPageFieldOn(pivotXml, fld) {
    return collectOpenTags(pivotXml, "pageField")
        .some((t) => Number(getAttr(t.text, "fld")) === fld);
}

/** Rewrite `<pageField fld="F" …>`'s `item` attribute. */
function setPageFieldItem(pivotXml, fld, itemIndex) {
    let out = pivotXml;
    let changed = false;
    let previous = null;
    // Walked back-to-front so an earlier edit cannot shift a later tag's offsets.
    const tags = collectOpenTags(out, "pageField").reverse();
    for (const t of tags) {
        if (Number(getAttr(t.text, "fld")) !== fld) continue;
        previous = getAttr(t.text, "item");
        changed = true;
        out = splice(out, t.start, t.end, setAttr(t.text, "item", String(itemIndex)));
    }
    return { xml: out, changed, previous };
}

/* ------------------------------------------------------------------ *
 * zip plumbing
 * ------------------------------------------------------------------ */

/**
 * The compression METHOD an entry arrived with. JSZip reuses the already-compressed
 * bytes verbatim when the requested method matches the stored one, so preserving it
 * per entry means every part this module does not touch comes out of the archive
 * byte-identical - which is what makes the SHA-1 assertions on the 13 pivot parts a
 * real check rather than a tautology.
 */
function entryCompression(entry) {
    const magic = entry && entry._data && entry._data.compression && entry._data.compression.magic;
    return magic === "\x00\x00" ? "STORE" : "DEFLATE";
}

/**
 * A timestamp for a part that has to be CREATED. Borrowed from an entry the archive
 * already had, so it stays inside the DOS date range and, more importantly, never
 * comes from the wall clock (05 §1 principle 3).
 */
function archiveDate(zip) {
    for (const name of Object.keys(zip.files)) {
        const entry = zip.files[name];
        if (!entry.dir && entry.date) return entry.date;
    }
    return new Date(Date.UTC(1980, 0, 1));
}

async function readPart(zip, name, { required = true } = {}) {
    const entry = zip.file(name);
    if (!entry) {
        if (required) fail(OOXML_ERROR.MISSING_PART, `falta la parte ${name} en el archivo`);
        return null;
    }
    return entry.async("string");
}

/**
 * Replace one part, preserving everything about the zip entry except its bytes.
 * `date` above all: JSZip stamps `new Date()` on a fresh entry, which would make the
 * output depend on the wall clock and break both determinism and idempotence.
 */
function writePart(zip, name, content) {
    const entry = zip.file(name);
    zip.file(name, content, {
        binary: false,
        date: entry ? entry.date : archiveDate(zip),
        compression: entry ? entryCompression(entry) : "DEFLATE",
        comment: entry ? entry.comment : null,
        unixPermissions: entry ? entry.unixPermissions : null,
        dosPermissions: entry ? entry.dosPermissions : null,
        createFolders: false,
    });
}

/* ------------------------------------------------------------------ *
 * the entry point
 * ------------------------------------------------------------------ */

function resolvePeriod(period) {
    if (typeof period === "string") return parsePeriod(period);
    if (period && typeof period === "object") {
        const missing = ["inicio", "fin", "inicioSerial", "finSerial", "etiqueta"]
            .filter((k) => period[k] === undefined || period[k] === null);
        if (missing.length) {
            fail(OOXML_ERROR.BAD_PERIOD,
                `periodo invalido: faltan los campos ${missing.join(", ")} ` +
                `(se espera el descriptor de parsePeriod o la cadena "YYYY-MM")`);
        }
        return period;
    }
    return fail(OOXML_ERROR.BAD_PERIOD,
        `periodo invalido: se espera "YYYY-MM" o el descriptor de parsePeriod, ` +
        `recibido ${period === null ? "null" : typeof period}`);
}

/**
 * Patch a written .xlsx in place.
 *
 * @param {string} filePath  the workbook xlsx-populate just wrote.
 * @param {object} options
 * @param {number} options.rowCount   accepted worker rows in `Cuadro` (data rows, so
 *                                    the table's last row is 1 + rowCount).
 * @param {string|object} options.period  "YYYY-MM" or a parsePeriod descriptor.
 * @param {boolean} [options.patchPivotFilters=true]  repoint the Altas / Bajas2 page
 *                                    filters. Off is the escape hatch if a future
 *                                    template makes the two-level remap unsafe.
 * @param {boolean} [options.dropCalcChain=true]
 * @returns {Promise<object>} a report of every patch applied or skipped. Skips land
 *                            in `warnings` rather than throwing: a page filter that
 *                            could not be repointed is a degraded report, not a
 *                            corrupt one, and the operator must be told either way.
 */
async function patchWorkbook(filePath, options = {}) {
    const { rowCount, patchPivotFilters = true, dropCalcChain = true } = options;
    const period = resolvePeriod(options.period);

    if (!Number.isInteger(rowCount) || rowCount < 1) {
        // A run with zero accepted workers must stop upstream, loudly. Resizing Tabla2
        // to a header-only A1:AI1 is not a table Excel accepts, and clamping to one row
        // would manufacture exactly the ghost row 03 §7.2 exists to delete.
        fail(OOXML_ERROR.BAD_ROW_COUNT,
            `rowCount invalido: se espera un entero >= 1, recibido ${JSON.stringify(rowCount)}`);
    }
    const lastRow = rowCount + 1;   // + the header row
    if (lastRow > EXCEL_MAX_ROWS) {
        fail(OOXML_ERROR.BAD_ROW_COUNT,
            `rowCount ${rowCount} excede el maximo de filas de Excel (${EXCEL_MAX_ROWS - 1})`);
    }

    const original = await fsp.readFile(filePath);
    let zip;
    try {
        zip = await JSZip.loadAsync(original);
    } catch (e) {
        fail(OOXML_ERROR.NOT_A_ZIP, `${filePath} no es un .xlsx legible: ${e.message}`);
    }

    const warnings = [];
    const warn = (code, message) => warnings.push({ code, message });

    /* -- 1. Tabla2 ------------------------------------------------------ */
    const tableXml = await readPart(zip, PART.TABLE);
    const resized = resizeTable(tableXml, lastRow);
    writePart(zip, PART.TABLE, resized.xml);

    /* -- 2 + 6. the pivot cache ---------------------------------------- */
    let cacheXml = await readPart(zip, PART.PIVOT_CACHE_DEF);
    cacheXml = setRefreshOnLoad(cacheXml);

    const pivotParts = Object.keys(zip.files)
        .filter((n) => /^xl\/pivotTables\/pivotTable\d+\.xml$/.test(n))
        .sort();

    const filters = [];
    if (patchPivotFilters) {
        const caches = Object.keys(zip.files)
            .filter((n) => /^xl\/pivotCache\/pivotCacheDefinition\d+\.xml$/.test(n));
        if (caches.length !== 1) {
            // Every pivot's `fld` indexes into ITS OWN cache. With more than one cache
            // this module cannot tell which is which, and guessing repoints a filter at
            // an unrelated column.
            warn("PIVOT_MULTIPLE_CACHES",
                `se encontraron ${caches.length} definiciones de pivotCache; ` +
                `los filtros de periodo no se repuntaron`);
        } else {
            const pivotXmls = new Map();
            for (const part of pivotParts) pivotXmls.set(part, await readPart(zip, part));

            for (const fieldName of PERIOD_CACHE_FIELDS) {
                const result = repointPeriodFilter(cacheXml, pivotXmls, fieldName, period, warn);
                cacheXml = result.cacheXml;
                filters.push(...result.applied);
            }
            for (const [part, xml] of pivotXmls) {
                // Written unconditionally, even when unchanged: an untouched string
                // recompresses to the same bytes, so idempotence does not depend on
                // remembering which parts were edited.
                writePart(zip, part, xml);
            }
        }
    }
    writePart(zip, PART.PIVOT_CACHE_DEF, cacheXml);

    /* -- 3 + 5. workbook.xml ------------------------------------------- */
    const workbookXml = await readPart(zip, PART.WORKBOOK);
    writePart(zip, PART.WORKBOOK, patchWorkbookXml(workbookXml, period));

    /* -- 4. the dangling calcChain ------------------------------------- */
    let contentTypes = await readPart(zip, PART.CONTENT_TYPES);
    const calcChain = { partRemoved: false, relationshipId: null, overrideRemoved: false };
    if (dropCalcChain) {
        const rels = await readPart(zip, PART.WORKBOOK_RELS);
        const stripped = stripCalcChainRelationship(rels);
        calcChain.relationshipId = stripped.removedId;
        writePart(zip, PART.WORKBOOK_RELS, stripped.xml);

        const ct = stripContentTypeOverride(contentTypes, `/${PART.CALC_CHAIN}`);
        contentTypes = ct.xml;
        calcChain.overrideRemoved = ct.removed;

        // The part itself, when it is there. FEBRERO_2026 still carries one (it was
        // opened and saved in Excel); MAYO_2026 does not. Dropping all three together
        // is the only state that is consistent in both cases, and fullCalcOnLoad makes
        // the chain redundant anyway - Excel rebuilds it on the first recalculation.
        if (zip.file(PART.CALC_CHAIN)) {
            zip.remove(PART.CALC_CHAIN);
            calcChain.partRemoved = true;
        }
    }

    /* -- 5b. docProps/custom.xml --------------------------------------- */
    let customXml = await readPart(zip, PART.CUSTOM_PROPS, { required: false });
    let createdCustomProps = false;
    if (customXml === null) {
        customXml = EMPTY_CUSTOM_PROPS;
        createdCustomProps = true;
    }
    const custom = patchCustomProps(customXml, period);
    writePart(zip, PART.CUSTOM_PROPS, custom.xml);

    if (createdCustomProps) {
        const rootRels = await readPart(zip, PART.ROOT_RELS);
        const wired = ensureCustomPropsWired(contentTypes, rootRels);
        contentTypes = wired.contentTypes;
        writePart(zip, PART.ROOT_RELS, wired.rootRels);
    }
    writePart(zip, PART.CONTENT_TYPES, contentTypes);

    /* -- re-zip, atomically -------------------------------------------- */
    // Per-entry compression, so an entry that arrived STORE-d does not silently become
    // DEFLATE-d and every untouched entry takes JSZip's already-compressed fast path.
    for (const name of Object.keys(zip.files)) {
        const entry = zip.files[name];
        if (entry.dir || entry.options.compression) continue;   // writePart already set it
        entry.options.compression = entryCompression(entry);
    }

    const buffer = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
        platform: "DOS",
        streamFiles: false,
    });

    // Temp-then-rename: a crash mid-write must never leave a truncated report where
    // the operator will find it. The pid keeps two processes from colliding and never
    // reaches the output bytes, so determinism is untouched.
    const tmpPath = `${filePath}.${process.pid}.ooxml.tmp`;
    try {
        await fsp.writeFile(tmpPath, buffer);
        await fsp.rename(tmpPath, filePath);
    } catch (e) {
        try { fs.unlinkSync(tmpPath); } catch { /* the rename may already have consumed it */ }
        throw e;
    }

    return Object.freeze({
        file: filePath,
        bytes: buffer.length,
        rowCount,
        lastRow,
        table: resized.refs,
        refreshOnLoad: true,
        fullCalcOnLoad: true,
        calcChain,
        definedNames: {
            [PERIOD_NAMES.INICIO]: period.inicioSerial,
            [PERIOD_NAMES.FIN]: period.finSerial,
            [PERIOD_NAMES.ETIQUETA]: period.etiqueta,
        },
        customProperties: custom.properties,
        createdCustomProps,
        pivotFilters: filters,
        pivotParts,
        warnings,
    });
}

/**
 * Repoint every page filter bound to one period-bearing cache field. Mutates nothing:
 * returns the new cache XML and writes the new pivot XML back into `pivotXmls`.
 */
function repointPeriodFilter(cacheXml, pivotXmls, fieldName, period, warn) {
    const applied = [];
    const fld = cacheFieldIndex(cacheXml, fieldName);
    if (fld < 0) {
        warn("PIVOT_FIELD_NOT_FOUND",
            `el cacheField ${JSON.stringify(fieldName)} no existe; su filtro de periodo no se repunto`);
        return { cacheXml, applied };
    }

    const field = findCacheField(cacheXml, fieldName);
    const shared = field ? parseSharedItems(cacheXml, field) : null;
    if (!shared) {
        warn("PIVOT_SHARED_ITEMS_UNPARSED",
            `no se pudieron leer los sharedItems de ${JSON.stringify(fieldName)}; ` +
            `su filtro de periodo no se repunto`);
        return { cacheXml, applied };
    }

    let out = cacheXml;
    let targetIndex = shared.items.findIndex(
        (it) => it.tag === "s" && it.value === period.etiqueta);
    let rewrote = null;

    if (targetIndex < 0) {
        // The one live period-shaped item is the slot to reuse: "9-2024" in the
        // template. The u="1" entries are items Excel retained from older refreshes and
        // rewriting one of those would leave the live label pointing nowhere.
        const candidates = shared.items
            .map((it, i) => ({ it, i }))
            .filter(({ it }) => it.tag === "s" && !it.unused && PERIOD_LABEL_RE.test(it.value || ""));
        if (candidates.length !== 1) {
            warn("PIVOT_PERIOD_SLOT_AMBIGUOUS",
                `${fieldName}: se esperaba exactamente un item de periodo activo en la cache, ` +
                `se encontraron ${candidates.length}; su filtro no se repunto`);
            return { cacheXml, applied };
        }
        const { it, i } = candidates[0];
        targetIndex = i;
        rewrote = { from: it.value, to: period.etiqueta, sharedIndex: i };
        out = splice(out, it.start, it.end, setAttr(it.text, "v", period.etiqueta));
    }

    for (const [part, xml] of pivotXmls) {
        if (!hasPageFieldOn(xml, fld)) continue;

        const fields = parsePivotFields(xml);
        if (!fields || !fields[fld]) {
            warn("PIVOT_FIELDS_UNPARSED",
                `${part}: no se pudo leer <pivotFields>[${fld}] (${fieldName}); filtro sin repuntar`);
            continue;
        }
        const itemIndex = pivotItemIndexFor(xml, fields[fld], targetIndex);
        if (itemIndex < 0) {
            warn("PIVOT_ITEM_NOT_FOUND",
                `${part}: ningun <item x="${targetIndex}"> en el campo ${fieldName}; filtro sin repuntar`);
            continue;
        }
        const res = setPageFieldItem(xml, fld, itemIndex);
        if (!res.changed) continue;
        pivotXmls.set(part, res.xml);
        applied.push({
            part,
            cacheField: fieldName,
            fld,
            sharedIndex: targetIndex,
            previousItem: res.previous === null ? null : Number(res.previous),
            item: itemIndex,
            value: period.etiqueta,
            rewroteSharedItem: rewrote,
        });
    }

    // Report the shared-item rewrite once even when no pivot referenced it.
    if (rewrote && applied.length === 0) {
        warn("PIVOT_SHARED_ITEM_ORPHANED",
            `${fieldName}: se reescribio el item compartido ${JSON.stringify(rewrote.from)} ` +
            `a ${JSON.stringify(rewrote.to)} pero ninguna tabla dinamica lo filtra`);
    }

    return { cacheXml: out, applied };
}

module.exports = {
    patchWorkbook,
    OoxmlError,
    OOXML_ERROR,
    PART,
    PERIOD_NAMES,
    PERIOD_CACHE_FIELDS,
    TABLE_NAME,
    EXCEL_MAX_ROWS,
};

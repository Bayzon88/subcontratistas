"use strict";
/**
 * structural.js - the structural assertion helper (05-implementation-plan.md Phase 0
 * task 4). Every later phase is verified through this file, and the check table below
 * IS the burn-down list of the output defects.
 *
 * `assertStructure()` unzips a generated report with jszip and returns ONE LIST of
 * `{check, title, status, detail, phase}` rows, so the whole thing reads as one table
 * in the test output. It never throws for a failed check - a failure is a row with
 * `status: "fail"`, exactly like the pipeline never throws for a data problem. It DOES
 * throw for a caller wiring error (file missing, not a zip, bad option), because a
 * check that silently examined the wrong file is worse than no check.
 *
 * THE CHECKS. The "status today" column is what was true BEFORE this rework; a check
 * whose fix a later phase owns is never deleted, it is marked `pending` and the owning
 * phase is named in the row.
 *
 *   (a) xl/tables/table1.xml `ref` matches the real row count       passed; must keep passing
 *   (b) the 13 pivotTable parts and every pivotCache part are
 *       present and SHA-1-identical TO THE TEMPLATE'S               passed; must keep passing
 *   (c) [Content_Types].xml and the .rels reference no absent part  failed (dangling calcChain); Fase 3.4
 *   (d) fullCalcOnLoad="1" + refreshOnLoad="1"                      failed by design; Fase 3.4
 *   (e) zero empty-string cells inside Tabla2                       failed (3,757 in MAYO_2026); Fase 3.1
 *   (f) zero #VALUE!, zero NaN, zero "undefined" in Cuadro          failed (36 + 10); Fase 2
 *   (g) every populated cell in F, M and O is a date serial         failed (103/4,894/100 text); Fase 2.1
 *   (h) the five Option-D columns carry NO formula, anywhere        Fase 4 tarea 3
 *   (i) the other twelve DO still carry theirs                      Fase 4 tarea 3
 *   (j) the Periodo* defined names match the period in the filename  Fase 3.4 (03 AC 22)
 *
 * WHY (h) EXISTS. V/W/AG/AH/AI are Excel Table *calculated columns*. Writing literals
 * into them without deleting `<calculatedColumnFormula>` leaves Excel free to re-fill
 * the column on the next edit or refresh, which silently restores the TODAY()-30
 * behaviour Phase 4 exists to remove (05 §5, last paragraph). A surviving per-cell
 * `<f>` does the same thing on the next recalculation. Both are checked.
 *
 * THE CONSTANT TABLES BELOW ARE DELIBERATELY NOT IMPORTED from src/output/computed.js
 * or tools/build-template-v2.js. They are measured from src/template.xlsx and restated
 * here so that a wrong constant in the module under test cannot validate itself.
 *
 * CLI:
 *   node src/test/structural.js <report.xlsx> [--template src/template-v2.xlsx]
 *                              [--rows N] [--period YYYY-MM] [--pending c,d]
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const JSZip = require("jszip");

const config = require("../config");
const { CANONICAL } = require("../pipeline/columns");
const { parsePeriod, MESES, FILENAME_PREFIX } = require("../pipeline/period");

/* ------------------------------------------------------------------ *
 * Constants measured from the template
 * ------------------------------------------------------------------ */

/** The Excel Table the whole dependency chain hangs off: 18 raw + 17 computed = 35 columns. */
const TABLE_NAME = "Tabla2";
const TABLE_COLUMNS = 35;
const RAW_COLUMNS = 18;
const LAST_COLUMN_LETTER = "AI";

/** The parts whose bytes the writer must never disturb (05 §5: "all 29 pivot parts are
 *  SHA-1 IDENTICAL"). 13 pivotTables + 13 rels + 2 pivotCache + 1 pivotCache rels. */
const PIVOT_TABLE_COUNT = 13;
const PIVOT_PART_RE = /^xl\/(pivotTables|pivotCache)\//;
const PIVOT_TABLE_RE = /^xl\/pivotTables\/pivotTable\d+\.xml$/;
const PIVOT_CACHE_DEF_RE = /^xl\/pivotCache\/pivotCacheDefinition\d+\.xml$/;

/**
 * The FIVE Option-D columns: JS-computed literal values, no formula anywhere.
 * `id` is the `<tableColumn id>` in xl/tables/table1.xml - NOT the ordinal position,
 * which is why it is stated explicitly (the ids are shuffled: V is id 25, W is id 23).
 */
const OPTION_D_COLUMNS = Object.freeze([
    Object.freeze({ letter: "V", index0: 21, id: 25, name: "Edad" }),
    Object.freeze({ letter: "W", index0: 22, id: 23, name: "Rango Edades" }),
    Object.freeze({ letter: "AG", index0: 32, id: 34, name: "BajasAntiguas" }),
    Object.freeze({ letter: "AH", index0: 33, id: 28, name: "Bajas2" }),
    Object.freeze({ letter: "AI", index0: 34, id: 29, name: "Altas" }),
]);

/** The TWELVE that stay Excel formulas - VLOOKUP/COUNTIF/SUMPRODUCT over data that
 *  does not change after the file is written, so the business keeps owning Hoja1. */
const FORMULA_COLUMNS = Object.freeze([
    Object.freeze({ letter: "S", index0: 18, id: 27, name: "EPC/CJV" }),
    Object.freeze({ letter: "T", index0: 19, id: 26, name: "Tipo de Empresa" }),
    Object.freeze({ letter: "U", index0: 20, id: 20, name: "Contratistas" }),
    Object.freeze({ letter: "X", index0: 23, id: 22, name: "Validar Edad" }),
    Object.freeze({ letter: "Y", index0: 24, id: 21, name: "Zona de Influencia" }),
    Object.freeze({ letter: "Z", index0: 25, id: 18, name: "Validar Genero" }),
    Object.freeze({ letter: "AA", index0: 26, id: 19, name: "ValidarDNI" }),
    Object.freeze({ letter: "AB", index0: 27, id: 24, name: "Trabajador" }),
    Object.freeze({ letter: "AC", index0: 28, id: 30, name: "Trabajadores Unicos" }),
    // sic - the typo is the template's own column name and pivots bind to it.
    Object.freeze({ letter: "AD", index0: 29, id: 31, name: "Trabajdores Unicos Zona Influencia" }),
    Object.freeze({ letter: "AE", index0: 30, id: 32, name: "Altas Zona de Influencia" }),
    Object.freeze({ letter: "AF", index0: 31, id: 33, name: "Bajas Zona Influencia" }),
]);

/** F, M and O - the three date columns, derived from CANONICAL so a column reorder in
 *  columns.js cannot leave this check pointing at the wrong letters. */
const DATE_COLUMN_INDEXES = Object.freeze([
    CANONICAL.indexOf("FECHA NACIMIENTO"),
    CANONICAL.indexOf("FECHA CESE/BAJA"),
    CANONICAL.indexOf("FECHA INICIO DE LABORES EN OBRA"),
]);

/** The two columns the plan's COUNTIF(Tabla2[...],"") formulation names (03 §7.2). */
const COL_CONTRATISTA = CANONICAL.indexOf("CONTRATISTA PRNCIPAL");
const COL_APELLIDOS = CANONICAL.indexOf("APELLIDOS Y NOMBRES");

/** Built-in date/time number formats, plus the ranges Excel reserves for locale
 *  variants. numFmtId 14 is what the template's style 4 resolves to. */
const DATE_NUMFMT_IDS = new Set([
    14, 15, 16, 17, 22,
    27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
    45, 46, 47,
    50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

/** The three defined names, and the docProps/custom.xml property names. */
const PERIOD_NAMES = Object.freeze({
    INICIO: "PeriodoInicio",
    FIN: "PeriodoFin",
    ETIQUETA: "PeriodoEtiqueta",
});

/** How many offending addresses a detail line carries before it says "y N mas". */
const MAX_SAMPLES = 6;

const STATUS = Object.freeze({ PASS: "pass", FAIL: "fail", PENDING: "pending" });

/**
 * The check table. `phase` names the owner of the fix - the phase a `pending` row is
 * claimed by. Order is the order the rows come back in, so the table always reads the
 * same way.
 */
const CHECKS = Object.freeze([
    Object.freeze({ id: "a", title: "Tabla2 ref == filas reales", phase: "Fase 0 (ya pasaba)" }),
    Object.freeze({ id: "b", title: "partes pivot SHA-1 identicas a la plantilla", phase: "Fase 0 (ya pasaba)" }),
    Object.freeze({ id: "c", title: "sin partes ni relaciones colgantes", phase: "Fase 3 tarea 4" }),
    Object.freeze({ id: "d", title: "fullCalcOnLoad + refreshOnLoad", phase: "Fase 3 tarea 4" }),
    Object.freeze({ id: "e", title: 'cero celdas "" dentro de Tabla2', phase: "Fase 3 tarea 1" }),
    Object.freeze({ id: "f", title: 'cero #VALUE!, NaN y "undefined" en Cuadro', phase: "Fase 2" }),
    Object.freeze({ id: "g", title: "columnas de fecha F, M, O son seriales", phase: "Fase 2 tarea 1" }),
    Object.freeze({ id: "h", title: "las 5 columnas Opcion D sin formula", phase: "Fase 4 tarea 3" }),
    Object.freeze({ id: "i", title: "las 12 restantes conservan su formula", phase: "Fase 4 tarea 3" }),
    Object.freeze({ id: "j", title: "nombres Periodo* == periodo del archivo", phase: "Fase 3 tarea 4" }),
]);

const CHECK_IDS = Object.freeze(CHECKS.map((c) => c.id));

/**
 * A caller wiring error - the file is not there, is not a zip, or an option is
 * nonsense. Distinct from a failed check, which is data about the workbook.
 */
class StructuralError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "StructuralError";
        this.code = code;
    }
}

const STRUCTURAL_ERROR = Object.freeze({
    NOT_FOUND: "NOT_FOUND",
    NOT_A_ZIP: "NOT_A_ZIP",
    BAD_OPTION: "BAD_OPTION",
});

/* ------------------------------------------------------------------ *
 * Tiny XML / address helpers
 *
 * Deliberately string surgery rather than a parser: this runs on every test, the
 * Cuadro sheet of a real month is megabytes of XML, and no part is ever rewritten
 * here - only read.
 * ------------------------------------------------------------------ */

/** 0 -> "A", 25 -> "Z", 26 -> "AA", 34 -> "AI". */
function colLetter(index0) {
    let s = "";
    let n = index0 + 1;
    while (n > 0) {
        s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

/** "AI" -> 34. Returns -1 for anything that is not a column reference. */
function colIndex(letters) {
    if (!/^[A-Z]+$/.test(letters)) return -1;
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
}

const ADDR_RE = /^([A-Z]+)(\d+)$/;

function parseAddress(ref) {
    const m = ADDR_RE.exec(ref || "");
    if (!m) return null;
    return { col: colIndex(m[1]), row: Number(m[2]) };
}

/** "A1:AI2" -> {first:{col,row}, last:{col,row}}. */
function parseRange(ref) {
    if (typeof ref !== "string") return null;
    const parts = ref.split(":");
    const first = parseAddress(parts[0]);
    const last = parts.length === 2 ? parseAddress(parts[1]) : first;
    if (!first || !last) return null;
    return { first, last };
}

/** Read one attribute out of an open tag's attribute text. Values are always quoted
 *  with `"` in every part Excel writes.
 *
 *  The pattern is memoised because scanCells calls this four times per cell and a
 *  5,000-worker month is 175,000 cells; a non-global RegExp is stateless, so sharing
 *  one is safe. */
const ATTR_RE = new Map();

function attr(text, name) {
    let re = ATTR_RE.get(name);
    if (!re) {
        re = new RegExp(`\\s${name}="([^"]*)"`);
        ATTR_RE.set(name, re);
    }
    const m = re.exec(text);
    return m ? m[1] : null;
}

const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function unescapeXml(s) {
    if (s.indexOf("&") < 0) return s;
    return s.replace(/&(#x?[0-9a-fA-F]+|lt|gt|amp|quot|apos);/g, (whole, body) => {
        if (body[0] === "#") {
            const code = body[1] === "x" || body[1] === "X"
                ? parseInt(body.slice(2), 16)
                : parseInt(body.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
        }
        return ENTITIES[body] !== undefined ? ENTITIES[body] : whole;
    });
}

/**
 * Find the first `<tag ...>` open tag at or after `from`, returning its full text,
 * bounds and whether it is self-closing. Quote-aware, so a `>` inside an attribute
 * value cannot end the tag early.
 */
function findOpenTag(xml, tag, from = 0) {
    const needle = `<${tag}`;
    let i = xml.indexOf(needle, from);
    while (i >= 0) {
        const after = xml[i + needle.length];
        if (after === undefined || after === ">" || after === "/" || /\s/.test(after)) {
            let j = i + needle.length;
            let quote = null;
            for (; j < xml.length; j++) {
                const ch = xml[j];
                if (quote) { if (ch === quote) quote = null; continue; }
                if (ch === '"' || ch === "'") { quote = ch; continue; }
                if (ch === ">") break;
            }
            if (j >= xml.length) return null;
            const text = xml.slice(i, j + 1);
            return { start: i, end: j + 1, text, selfClosing: text.endsWith("/>") };
        }
        i = xml.indexOf(needle, i + 1);
    }
    return null;
}

/** Every `<tag ...>` open tag in document order. */
function collectOpenTags(xml, tag) {
    const out = [];
    let i = 0;
    for (;;) {
        const t = findOpenTag(xml, tag, i);
        if (!t) break;
        out.push(t);
        i = t.end;
    }
    return out;
}

/** The full element (open tag + body + close tag) for the open tag at `open`. */
function elementText(xml, open, tag) {
    if (open.selfClosing) return open.text;
    const close = xml.indexOf(`</${tag}>`, open.end);
    if (close < 0) return xml.slice(open.start);
    return xml.slice(open.start, close + tag.length + 3);
}

/* ------------------------------------------------------------------ *
 * Sheet scanning
 * ------------------------------------------------------------------ */

const HAS_FORMULA_RE = /<f[\s>/]/;
const V_RE = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>|<v\s*\/>/;
const T_TEXT_RE = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g;

/**
 * Walk every `<c>` element of a worksheet part, calling `visit` with a reusable
 * descriptor. Reusable on purpose: a 5,000-row month is 175,000 cells and allocating
 * an object per cell is the difference between 200 ms and several seconds.
 *
 * The regex cannot match `<cols>`, `<col .../>`, `<conditionalFormatting>` etc.
 * because the character after `<c` must be whitespace, `/` or `>`.
 */
function scanCells(xml, visit) {
    const re = /<c(\s[^>]*?)?(\/>|>)/g;
    const cell = { ref: null, row: 0, col: -1, t: null, s: null, hasFormula: false, v: null, inline: null };
    let m;
    while ((m = re.exec(xml)) !== null) {
        const attrs = m[1] || "";
        let body = "";
        if (m[2] === ">") {
            const close = xml.indexOf("</c>", re.lastIndex);
            if (close < 0) break;
            body = xml.slice(re.lastIndex, close);
            re.lastIndex = close + 4;
        }
        const ref = attr(attrs, "r");
        const addr = parseAddress(ref);
        cell.ref = ref;
        cell.row = addr ? addr.row : 0;
        cell.col = addr ? addr.col : -1;
        cell.t = attr(attrs, "t");
        cell.s = attr(attrs, "s");
        cell.hasFormula = body.length > 0 && HAS_FORMULA_RE.test(body);
        cell.v = null;
        cell.inline = null;
        if (body.length > 0) {
            const vm = V_RE.exec(body);
            if (vm) cell.v = vm[1] === undefined ? "" : vm[1];
            if (cell.t === "inlineStr") {
                let parts = "";
                T_TEXT_RE.lastIndex = 0;
                let tm;
                while ((tm = T_TEXT_RE.exec(body)) !== null) parts += tm[1] === undefined ? "" : tm[1];
                cell.inline = parts;
            }
        }
        visit(cell);
    }
}

/** Parse xl/sharedStrings.xml into a plain array of resolved strings. */
function parseSharedStrings(xml) {
    const out = [];
    if (!xml) return out;
    const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si\s*\/>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
        const body = m[1];
        if (body === undefined) { out.push(""); continue; }
        let text = "";
        T_TEXT_RE.lastIndex = 0;
        let tm;
        while ((tm = T_TEXT_RE.exec(body)) !== null) text += tm[1] === undefined ? "" : tm[1];
        out.push(unescapeXml(text));
    }
    return out;
}

/**
 * The resolved TEXT of a cell, or null when the cell carries no value at all.
 * A cell with no `<v>` and no inline text is genuinely empty - which is NOT the same
 * thing as a cell holding "", and telling the two apart is the entire point of
 * check (e).
 */
function cellText(cell, sst) {
    if (cell.t === "inlineStr") return cell.inline === null ? null : unescapeXml(cell.inline);
    if (cell.v === null) return null;
    if (cell.t === "s") {
        const idx = Number(cell.v);
        if (!Number.isInteger(idx) || idx < 0 || idx >= sst.length) return null;
        return sst[idx];
    }
    return unescapeXml(cell.v);
}

/* ------------------------------------------------------------------ *
 * The workbook under inspection
 * ------------------------------------------------------------------ */

/** Lazily-decompressed view over one .xlsx. */
class Book {
    constructor(zip, file) {
        this.zip = zip;
        this.file = file;
        this._text = new Map();
        this._sst = null;
    }

    names() {
        return Object.keys(this.zip.files).filter((n) => !this.zip.files[n].dir);
    }

    has(name) {
        const f = this.zip.file(name);
        return !!f && !f.dir;
    }

    async text(name) {
        if (this._text.has(name)) return this._text.get(name);
        const f = this.zip.file(name);
        const value = f && !f.dir ? await f.async("string") : null;
        this._text.set(name, value);
        return value;
    }

    async bytes(name) {
        const f = this.zip.file(name);
        return f && !f.dir ? f.async("nodebuffer") : null;
    }

    async sharedStrings() {
        if (this._sst === null) {
            this._sst = parseSharedStrings(await this.text("xl/sharedStrings.xml"));
        }
        return this._sst;
    }
}

async function openBook(file) {
    let buf;
    try {
        buf = await fsp.readFile(file);
    } catch (err) {
        throw new StructuralError(STRUCTURAL_ERROR.NOT_FOUND, `no se pudo leer ${file}: ${err.message}`);
    }
    let zip;
    try {
        zip = await JSZip.loadAsync(buf);
    } catch (err) {
        throw new StructuralError(STRUCTURAL_ERROR.NOT_A_ZIP, `${file} no es un .xlsx valido: ${err.message}`);
    }
    return new Book(zip, file);
}

/** Fold accents and case so "CUADRO ", "cuadro" and "Cuadro" are the same sheet. */
function foldName(s) {
    return String(s)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toUpperCase();
}

/** Resolve a relationship Target against the directory of the part that owns the .rels. */
function resolveRelTarget(relsPart, target) {
    if (target.startsWith("/")) return target.slice(1);
    const relsDir = path.posix.dirname(relsPart);            // "xl/_rels"
    const ownerDir = path.posix.dirname(relsDir) === "." ? "" : path.posix.dirname(relsDir);
    const joined = ownerDir ? path.posix.join(ownerDir, target) : target;
    return path.posix.normalize(joined);
}

/**
 * Locate the Cuadro worksheet part and the table part bound to it, following
 * workbook.xml -> workbook.xml.rels -> sheetN.xml -> sheetN.xml.rels -> table1.xml.
 * Nothing is hard-coded to sheet4.xml: the template's sheet order is not a contract.
 */
async function locate(book, sheetName) {
    const out = {
        sheetPart: null, tablePart: null, sheetRid: null,
        workbookXml: await book.text("xl/workbook.xml"),
        problems: [],
    };
    if (!out.workbookXml) {
        out.problems.push("falta xl/workbook.xml");
        return out;
    }
    const wanted = foldName(sheetName);
    for (const tag of collectOpenTags(out.workbookXml, "sheet")) {
        const name = unescapeXml(attr(tag.text, "name") || "");
        if (foldName(name) === wanted) {
            out.sheetRid = attr(tag.text, "r:id") || attr(tag.text, "id");
            break;
        }
    }
    if (!out.sheetRid) {
        out.problems.push(`la hoja ${JSON.stringify(sheetName)} no existe en xl/workbook.xml`);
        return out;
    }
    const rels = await book.text("xl/_rels/workbook.xml.rels");
    if (!rels) {
        out.problems.push("falta xl/_rels/workbook.xml.rels");
        return out;
    }
    for (const tag of collectOpenTags(rels, "Relationship")) {
        if (attr(tag.text, "Id") === out.sheetRid) {
            out.sheetPart = resolveRelTarget("xl/_rels/workbook.xml.rels", attr(tag.text, "Target") || "");
            break;
        }
    }
    if (!out.sheetPart || !book.has(out.sheetPart)) {
        out.problems.push(`la relacion ${out.sheetRid} no resuelve a una parte presente`);
        return out;
    }

    // The table: sheetN.xml.rels -> the /table relationship whose part is named Tabla2.
    const sheetRelsPart = path.posix.join(
        path.posix.dirname(out.sheetPart), "_rels", `${path.posix.basename(out.sheetPart)}.rels`);
    const sheetRels = await book.text(sheetRelsPart);
    const candidates = [];
    if (sheetRels) {
        for (const tag of collectOpenTags(sheetRels, "Relationship")) {
            const type = attr(tag.text, "Type") || "";
            if (!type.endsWith("/table")) continue;
            candidates.push(resolveRelTarget(sheetRelsPart, attr(tag.text, "Target") || ""));
        }
    }
    for (const cand of candidates) {
        const xml = await book.text(cand);
        if (xml && attr((findOpenTag(xml, "table") || { text: "" }).text, "name") === TABLE_NAME) {
            out.tablePart = cand;
            break;
        }
    }
    if (!out.tablePart) {
        if (candidates.length > 0) {
            out.problems.push(`ninguna tabla de ${sheetName} se llama ${TABLE_NAME} (${candidates.join(", ")})`);
        } else {
            out.problems.push(`${sheetName} no tiene ninguna relacion de tipo /table`);
        }
    }
    return out;
}

/* ------------------------------------------------------------------ *
 * Number formats (check g)
 * ------------------------------------------------------------------ */

/** styleIndex -> numFmtId, plus the custom format codes, out of xl/styles.xml. */
function parseNumberFormats(stylesXml) {
    const xfs = [];
    const custom = new Map();
    if (!stylesXml) return { xfs, custom };
    for (const tag of collectOpenTags(stylesXml, "numFmt")) {
        const id = Number(attr(tag.text, "numFmtId"));
        if (Number.isInteger(id)) custom.set(id, unescapeXml(attr(tag.text, "formatCode") || ""));
    }
    const open = findOpenTag(stylesXml, "cellXfs");
    if (open && !open.selfClosing) {
        const close = stylesXml.indexOf("</cellXfs>", open.end);
        const block = stylesXml.slice(open.end, close < 0 ? stylesXml.length : close);
        for (const tag of collectOpenTags(block, "xf")) {
            const id = Number(attr(tag.text, "numFmtId"));
            xfs.push(Number.isFinite(id) ? id : 0);
        }
    }
    return { xfs, custom };
}

/** Does this style index render as a date? Errs permissive - a custom code that
 *  mentions a year or a day counts, because the point is to catch General. */
function isDateStyle(styleIndex, formats) {
    const idx = styleIndex === null || styleIndex === undefined ? 0 : Number(styleIndex);
    const numFmtId = Number.isInteger(idx) && idx >= 0 && idx < formats.xfs.length ? formats.xfs[idx] : 0;
    if (DATE_NUMFMT_IDS.has(numFmtId)) return true;
    const code = formats.custom.get(numFmtId);
    if (!code) return false;
    return /[yYdD]/.test(code.replace(/\[[^\]]*\]/g, "").replace(/"[^"]*"/g, ""));
}

/* ------------------------------------------------------------------ *
 * The template's pivot fingerprint (check b)
 * ------------------------------------------------------------------ */

const templateFingerprintCache = new Map();

function sha1(buf) {
    return crypto.createHash("sha1").update(buf).digest("hex");
}

/**
 * The two sanctioned edits to the pivot layer, and the ONLY two. Both sides are
 * normalized the same way, so a difference is masked only when it is exactly one of:
 *
 *  1. `refreshOnLoad="1"` on `<pivotCacheDefinition>` - required by check (d) and by
 *     AC 21; it necessarily changes that part's bytes, which is why a blanket "SHA-1
 *     identical" would be a check the output layer can never pass.
 *  2. the period label written into the two page-filter cache fields, and the
 *     `<pageField item>` index that selects it (03 §7.3 / §6.4). Only a value of the
 *     shape "<M>-<YYYY>" is neutralised, and the item COUNT is untouched, so a change
 *     that invalidates any pivot's item table still fails.
 *
 * Everything else - every other pivotTable, every rel, pivotCacheRecords1.xml, the
 * cache's field list, its shared-item counts - is compared byte for byte.
 */
function normalizePivotPart(name, text) {
    let out = text;
    if (PIVOT_CACHE_DEF_RE.test(name)) {
        const open = findOpenTag(out, "pivotCacheDefinition");
        if (open) {
            const stripped = open.text.replace(/\srefreshOnLoad="[^"]*"/, "");
            out = out.slice(0, open.start) + stripped + out.slice(open.end);
        }
        out = out.replace(/<s v="\d{1,2}-\d{4}"\/>/g, '<s v="@PERIODO"/>');
    }
    if (PIVOT_TABLE_RE.test(name)) {
        out = out.replace(/(<pageField\b[^>]*?)\sitem="\d+"/g, "$1");
    }
    return out;
}

function isTextPart(name) {
    return name.endsWith(".xml") || name.endsWith(".rels");
}

/** SHA-1 of every pivot part of the template, cached by path+size+mtime so this does
 *  not re-hash 1.6 MB on every single test. Identity only - no clock decision. */
async function templateFingerprint(templatePath) {
    let stat;
    try {
        stat = await fsp.stat(templatePath);
    } catch (err) {
        throw new StructuralError(STRUCTURAL_ERROR.NOT_FOUND,
            `no se pudo leer la plantilla ${templatePath}: ${err.message}`);
    }
    const key = `${path.resolve(templatePath)}|${stat.size}|${stat.mtimeMs}`;
    const cached = templateFingerprintCache.get(key);
    if (cached) return cached;

    const book = await openBook(templatePath);
    const parts = new Map();
    for (const name of book.names().filter((n) => PIVOT_PART_RE.test(n)).sort()) {
        const raw = await book.bytes(name);
        const entry = { raw: sha1(raw) };
        if (isTextPart(name)) {
            entry.normalized = sha1(Buffer.from(normalizePivotPart(name, raw.toString("utf8")), "utf8"));
        }
        parts.set(name, entry);
    }
    const fp = { path: templatePath, parts };
    templateFingerprintCache.set(key, fp);
    return fp;
}

/* ------------------------------------------------------------------ *
 * Result rows
 * ------------------------------------------------------------------ */

function row(id, status, detail) {
    const meta = CHECKS.find((c) => c.id === id);
    return Object.freeze({
        check: id,
        title: meta.title,
        status,
        detail: String(detail),
        phase: meta.phase,
    });
}

/** Collapse a list of offenders into "A5, B7, C9 y 41 mas". */
function sample(list, max = MAX_SAMPLES) {
    if (list.length === 0) return "";
    const head = list.slice(0, max).join(", ");
    return list.length > max ? `${head} y ${list.length - max} mas` : head;
}

/* ------------------------------------------------------------------ *
 * The checks
 * ------------------------------------------------------------------ */

/** (a) the four refs of table1.xml move together and describe the real row count. */
async function checkTableRef(ctx) {
    const { book, tablePart, sheetStats, expectedRows } = ctx;
    if (!tablePart) return row("a", STATUS.FAIL, ctx.locateProblems || "no se encontro la tabla");
    const xml = await book.text(tablePart);
    const open = findOpenTag(xml, "table");
    const refs = {
        table: attr(open.text, "ref"),
        autoFilter: attr((findOpenTag(xml, "autoFilter") || { text: "" }).text, "ref"),
        sortState: attr((findOpenTag(xml, "sortState") || { text: "" }).text, "ref"),
        sortCondition: attr((findOpenTag(xml, "sortCondition") || { text: "" }).text, "ref"),
    };
    const range = parseRange(refs.table);
    const problems = [];
    if (!range) {
        return row("a", STATUS.FAIL, `${tablePart}: ref ilegible ${JSON.stringify(refs.table)}`);
    }
    const lastRow = range.last.row;
    const dataRows = lastRow - 1;

    if (range.first.col !== 0 || range.first.row !== 1) problems.push(`la tabla no empieza en A1 (${refs.table})`);
    if (colLetter(range.last.col) !== LAST_COLUMN_LETTER) {
        problems.push(`la ultima columna es ${colLetter(range.last.col)}, se esperaba ${LAST_COLUMN_LETTER}`);
    }
    // All four refs must move together, or the rows past the shortest one are invisible
    // to the autofilter / sort and, through them, to Excel's own idea of the table.
    if (refs.autoFilter !== refs.table) problems.push(`autoFilter ${refs.autoFilter} != table ${refs.table}`);
    const wantSort = `A2:${LAST_COLUMN_LETTER}${lastRow}`;
    if (refs.sortState !== wantSort) problems.push(`sortState ${refs.sortState} != ${wantSort}`);
    const wantCond = `C1:C${lastRow}`;
    if (refs.sortCondition !== wantCond) problems.push(`sortCondition ${refs.sortCondition} != ${wantCond}`);

    const cols = collectOpenTags(xml, "tableColumn").length;
    if (cols !== TABLE_COLUMNS) problems.push(`${cols} tableColumns, se esperaban ${TABLE_COLUMNS}`);

    // The sheet must agree with the ref. A populated row past lastRow is BUG-11: it is
    // written to the sheet, gets no computed column and is invisible to every pivot.
    if (sheetStats.maxRow > lastRow) {
        problems.push(`hay datos en la fila ${sheetStats.maxRow}, fuera de la tabla (ultima ${lastRow})`);
    } else if (sheetStats.maxRow < lastRow && sheetStats.maxRow >= 1) {
        problems.push(`la tabla llega a la fila ${lastRow} pero la ultima fila con celdas es ${sheetStats.maxRow}`);
    }
    if (typeof expectedRows === "number" && dataRows !== expectedRows) {
        problems.push(`${dataRows} filas de datos, se esperaban ${expectedRows}`);
    }

    const detail = `ref ${refs.table} -> ${dataRows} filas de datos` +
        (typeof expectedRows === "number" ? ` (esperadas ${expectedRows})` : " (sin expectedRows: contra la hoja)") +
        (problems.length ? `; ${problems.join("; ")}` : "; los 4 refs concuerdan");
    return row("a", problems.length ? STATUS.FAIL : STATUS.PASS, detail);
}

/** (b) the pivot layer is byte-identical to the template's, modulo the two sanctioned patches. */
async function checkPivotIdentity(ctx) {
    const { book, templatePath } = ctx;
    const fp = await templateFingerprint(templatePath);
    const problems = [];
    let identical = 0;
    let sanctioned = 0;

    const templateTables = [...fp.parts.keys()].filter((n) => PIVOT_TABLE_RE.test(n));
    if (templateTables.length !== PIVOT_TABLE_COUNT) {
        problems.push(`la plantilla tiene ${templateTables.length} pivotTables, se esperaban ${PIVOT_TABLE_COUNT}`);
    }

    for (const [name, expected] of fp.parts) {
        const raw = await book.bytes(name);
        if (!raw) { problems.push(`falta ${name}`); continue; }
        if (sha1(raw) === expected.raw) { identical += 1; continue; }
        if (expected.normalized !== undefined) {
            const norm = sha1(Buffer.from(normalizePivotPart(name, raw.toString("utf8")), "utf8"));
            if (norm === expected.normalized) { sanctioned += 1; continue; }
        }
        problems.push(`${name} difiere de la plantilla`);
    }

    const extra = book.names().filter((n) => PIVOT_PART_RE.test(n) && !fp.parts.has(n));
    for (const name of extra) problems.push(`parte pivot inesperada ${name}`);

    const reportTables = book.names().filter((n) => PIVOT_TABLE_RE.test(n));
    if (reportTables.length !== PIVOT_TABLE_COUNT) {
        problems.push(`${reportTables.length} pivotTables en el reporte, se esperaban ${PIVOT_TABLE_COUNT}`);
    }

    // The cache binds to the TABLE NAME, which is what makes resizing enough (05 §5).
    for (const name of [...fp.parts.keys()].filter((n) => PIVOT_CACHE_DEF_RE.test(n))) {
        const xml = await book.text(name);
        if (xml && !xml.includes(`<worksheetSource name="${TABLE_NAME}"/>`)) {
            problems.push(`${name} ya no apunta a <worksheetSource name="${TABLE_NAME}"/>`);
        }
    }

    const detail = `${identical + sanctioned}/${fp.parts.size} partes pivot verificadas contra ` +
        `${path.basename(fp.path)} (${identical} identicas byte a byte, ${sanctioned} salvo el parche sancionado)` +
        (problems.length ? `; ${sample(problems)}` : "");
    return row("b", problems.length ? STATUS.FAIL : STATUS.PASS, detail);
}

/** (c) no content-type override and no relationship points at an absent part. */
async function checkDanglingParts(ctx) {
    const { book } = ctx;
    const present = new Set(book.names());
    const problems = [];

    const ct = await book.text("[Content_Types].xml");
    let overrides = 0;
    const defaults = new Set();
    if (!ct) {
        problems.push("falta [Content_Types].xml");
    } else {
        for (const tag of collectOpenTags(ct, "Default")) {
            const ext = (attr(tag.text, "Extension") || "").toLowerCase();
            if (ext) defaults.add(ext);
        }
        for (const tag of collectOpenTags(ct, "Override")) {
            const part = (attr(tag.text, "PartName") || "").replace(/^\//, "");
            overrides += 1;
            if (part && !present.has(part)) problems.push(`[Content_Types].xml declara ${part}, ausente`);
        }
    }

    // The reverse direction: a part with no declared content type is the same repair
    // prompt seen from the other side.
    for (const name of present) {
        if (name === "[Content_Types].xml") continue;
        // Not path.extname: it returns "" for a dotfile, and "_rels/.rels" IS covered
        // by the Default for the "rels" extension.
        const base = path.posix.basename(name);
        const dot = base.lastIndexOf(".");
        const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
        if (defaults.has(ext)) continue;
        if (ct && ct.includes(`PartName="/${name}"`)) continue;
        problems.push(`${name} no tiene content type`);
    }

    let rels = 0;
    for (const name of [...present].filter((n) => n.endsWith(".rels")).sort()) {
        const xml = await book.text(name);
        if (!xml) continue;
        for (const tag of collectOpenTags(xml, "Relationship")) {
            if ((attr(tag.text, "TargetMode") || "") === "External") continue;
            const target = attr(tag.text, "Target") || "";
            if (!target || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) continue;
            rels += 1;
            const resolved = resolveRelTarget(name, target);
            if (!present.has(resolved)) {
                problems.push(`${name}#${attr(tag.text, "Id")} -> ${resolved}, ausente`);
            }
        }
    }

    const detail = `${overrides} overrides y ${rels} relaciones resueltas contra ${present.size} partes` +
        (problems.length ? `; ${sample(problems)}` : "; ninguna colgante");
    return row("c", problems.length ? STATUS.FAIL : STATUS.PASS, detail);
}

/** (d) the two attributes that make a delivered file show current numbers (AC 21). */
async function checkRecalcFlags(ctx) {
    const { book } = ctx;
    const problems = [];

    const wb = await book.text("xl/workbook.xml");
    let calcPr = null;
    if (!wb) {
        problems.push("falta xl/workbook.xml");
    } else {
        const open = findOpenTag(wb, "calcPr");
        if (!open) problems.push("xl/workbook.xml no tiene <calcPr>");
        else {
            calcPr = attr(open.text, "fullCalcOnLoad");
            if (calcPr !== "1") problems.push(`<calcPr fullCalcOnLoad=${JSON.stringify(calcPr)}> (se esperaba "1")`);
        }
    }

    const caches = book.names().filter((n) => PIVOT_CACHE_DEF_RE.test(n)).sort();
    if (caches.length === 0) problems.push("no hay pivotCacheDefinition");
    let refresh = null;
    for (const name of caches) {
        const xml = await book.text(name);
        const open = xml ? findOpenTag(xml, "pivotCacheDefinition") : null;
        refresh = open ? attr(open.text, "refreshOnLoad") : null;
        if (refresh !== "1") problems.push(`${name} refreshOnLoad=${JSON.stringify(refresh)} (se esperaba "1")`);
    }

    const detail = `fullCalcOnLoad=${JSON.stringify(calcPr)}, refreshOnLoad=${JSON.stringify(refresh)}` +
        (problems.length ? `; ${problems.join("; ")}` : "");
    return row("d", problems.length ? STATUS.FAIL : STATUS.PASS, detail);
}

/** (e) zero empty-string cells inside Tabla2 (03 §7.2 - the 3,757 ghost rows). */
function checkEmptyStrings(ctx) {
    const { sheetStats } = ctx;
    const problems = [];
    if (sheetStats.emptyStringCells.length > 0) {
        problems.push(`${sheetStats.emptyStringCells.length} celdas "" en ${sample(sheetStats.emptyStringCells)}`);
    }
    if (sheetStats.rowsMissingIdentity.length > 0) {
        problems.push(`${sheetStats.rowsMissingIdentity.length} filas con datos pero sin ` +
            `CONTRATISTA PRNCIPAL / APELLIDOS Y NOMBRES: filas ${sample(sheetStats.rowsMissingIdentity)}`);
    }
    const detail = `${sheetStats.dataRowsWithContent} filas con contenido en A:R dentro de ` +
        `A2:${LAST_COLUMN_LETTER}${sheetStats.tableLastRow}` +
        (problems.length ? `; ${problems.join("; ")}` : '; ninguna celda ""');
    return row("e", problems.length ? STATUS.FAIL : STATUS.PASS, detail);
}

/** (f) zero #VALUE!, zero NaN, zero "undefined" anywhere in Cuadro (AC 11, 12, 17). */
function checkPoisonValues(ctx) {
    const { sheetStats } = ctx;
    const problems = [];
    if (sheetStats.errorCells.length > 0) {
        const byCode = new Map();
        for (const e of sheetStats.errorCells) byCode.set(e.code, (byCode.get(e.code) || 0) + 1);
        const summary = [...byCode].map(([c, n]) => `${c} x${n}`).join(", ");
        problems.push(`${sheetStats.errorCells.length} celdas de error (${summary}) en ` +
            `${sample(sheetStats.errorCells.map((e) => e.ref))}`);
    }
    if (sheetStats.nanCells.length > 0) {
        problems.push(`${sheetStats.nanCells.length} celdas NaN en ${sample(sheetStats.nanCells)}`);
    }
    if (sheetStats.undefinedCells.length > 0) {
        problems.push(`${sheetStats.undefinedCells.length} celdas con "undefined" en ${sample(sheetStats.undefinedCells)}`);
    }
    const detail = `${sheetStats.cells} celdas revisadas en toda la hoja` +
        (problems.length ? `; ${problems.join("; ")}` : "; sin #VALUE!, sin NaN, sin \"undefined\"");
    return row("f", problems.length ? STATUS.FAIL : STATUS.PASS, detail);
}

/** (g) every populated cell of F, M and O is a numeric serial with a date format (AC 9). */
function checkDateColumns(ctx) {
    const { sheetStats } = ctx;
    const problems = [];
    const letters = DATE_COLUMN_INDEXES.map(colLetter).join(", ");
    if (sheetStats.nonNumericDates.length > 0) {
        problems.push(`${sheetStats.nonNumericDates.length} celdas de fecha no numericas en ` +
            `${sample(sheetStats.nonNumericDates.map((d) => `${d.ref}=${JSON.stringify(d.text)}`))}`);
    }
    if (sheetStats.nonDateFormat.length > 0) {
        problems.push(`${sheetStats.nonDateFormat.length} seriales sin formato de fecha en ` +
            `${sample(sheetStats.nonDateFormat)}`);
    }
    const detail = `${sheetStats.dateCellsPopulated} celdas pobladas en ${letters}` +
        (problems.length ? `; ${problems.join("; ")}` : "; todas seriales con numFmt de fecha");
    return row("g", problems.length ? STATUS.FAIL : STATUS.PASS, detail);
}

/** Shared by (h) and (i): read the `<tableColumn>` elements by name. */
async function readTableColumns(ctx) {
    const xml = await ctx.book.text(ctx.tablePart);
    const map = new Map();
    if (!xml) return map;
    const tags = collectOpenTags(xml, "tableColumn");
    tags.forEach((tag, ordinal) => {
        const name = unescapeXml(attr(tag.text, "name") || "");
        const element = elementText(xml, tag, "tableColumn");
        map.set(name, {
            ordinal,
            id: Number(attr(tag.text, "id")),
            formula: /<calculatedColumnFormula[\s>]/.test(element)
                ? (/<calculatedColumnFormula(?:\s[^>]*)?>([\s\S]*?)<\/calculatedColumnFormula>/.exec(element) || [, ""])[1]
                : null,
            formulaCount: (element.match(/<calculatedColumnFormula[\s>]/g) || []).length,
        });
    });
    return map;
}

/**
 * (h) the five Option-D columns carry no formula in EITHER place.
 *
 * Both halves matter and neither implies the other: a surviving
 * `<calculatedColumnFormula>` makes Excel re-fill the whole column on the next edit,
 * and a surviving per-cell `<f>` recomputes that one row on the next recalculation.
 * Either restores TODAY()-30 and the report silently starts mutating again.
 */
async function checkOptionDLiterals(ctx) {
    if (!ctx.tablePart) return row("h", STATUS.FAIL, ctx.locateProblems || "no se encontro la tabla");
    const cols = await readTableColumns(ctx);
    const problems = [];
    for (const col of OPTION_D_COLUMNS) {
        const found = cols.get(col.name);
        if (!found) { problems.push(`falta la columna ${col.name} en la tabla`); continue; }
        if (found.ordinal !== col.index0) {
            problems.push(`${col.name} esta en ${colLetter(found.ordinal)}, se esperaba ${col.letter}`);
        }
        if (found.id !== col.id) problems.push(`${col.name} tiene id=${found.id}, se esperaba ${col.id}`);
        if (found.formulaCount > 0) {
            problems.push(`${col.name} conserva <calculatedColumnFormula> (Excel la volveria a rellenar)`);
        }
        const sheetFormulas = ctx.sheetStats.formulasByColumn.get(col.index0) || 0;
        if (sheetFormulas > 0) {
            problems.push(`${col.name} tiene <f> en ${sheetFormulas} celdas de la hoja`);
        }
    }
    const detail = `${OPTION_D_COLUMNS.map((c) => `${c.letter} ${c.name}`).join(", ")}` +
        (problems.length ? `; ${problems.join("; ")}` : "; sin calculatedColumnFormula y sin <f>");
    return row("h", problems.length ? STATUS.FAIL : STATUS.PASS, detail);
}

/**
 * (i) the other twelve DO still carry their formulas - the guard against (h)
 * over-deleting. The authority is table1.xml, which must hold exactly one
 * `<calculatedColumnFormula>` per column. The sheet is checked for a MIXED state -
 * some data rows with `<f>` and some without - because that, not absence, is the
 * pathology: a column half literal and half formula reads as consistent in Excel and
 * is not.
 */
async function checkFormulasSurvive(ctx) {
    if (!ctx.tablePart) return row("i", STATUS.FAIL, ctx.locateProblems || "no se encontro la tabla");
    const cols = await readTableColumns(ctx);
    const problems = [];
    const notes = [];
    const dataRows = ctx.sheetStats.dataRowsPresent;
    for (const col of FORMULA_COLUMNS) {
        const found = cols.get(col.name);
        if (!found) { problems.push(`falta la columna ${col.name} en la tabla`); continue; }
        if (found.ordinal !== col.index0) {
            problems.push(`${col.name} esta en ${colLetter(found.ordinal)}, se esperaba ${col.letter}`);
        }
        if (found.id !== col.id) problems.push(`${col.name} tiene id=${found.id}, se esperaba ${col.id}`);
        if (found.formulaCount !== 1) {
            problems.push(`${col.name} tiene ${found.formulaCount} <calculatedColumnFormula>, se esperaba 1`);
        } else if (!found.formula || found.formula.trim() === "") {
            problems.push(`${col.name} tiene <calculatedColumnFormula> vacia`);
        }
        const withF = ctx.sheetStats.formulasByColumn.get(col.index0) || 0;
        if (dataRows > 0 && withF > 0 && withF < dataRows) {
            problems.push(`${col.name} tiene <f> en ${withF} de ${dataRows} filas (columna mixta)`);
        } else if (dataRows > 0 && withF === 0) {
            notes.push(col.letter);
        }
    }
    let detail = `${FORMULA_COLUMNS.length} columnas con calculatedColumnFormula sobre ${dataRows} filas`;
    if (notes.length) {
        detail += `; sin <f> por celda en ${notes.join(",")} (Excel las rellena por fullCalcOnLoad)`;
    }
    if (problems.length) detail += `; ${problems.join("; ")}`;
    return row("i", problems.length ? STATUS.FAIL : STATUS.PASS, detail);
}

/* -------- (j) the report period ---------------------------------- */

const FILENAME_RE = new RegExp(`^${FILENAME_PREFIX}_([^_]+)_(\\d{4})\\.xlsx$`, "i");

/** The period a filename encodes, or null. AC 22: the filename and the content must agree. */
function periodFromFilename(file) {
    const m = FILENAME_RE.exec(path.basename(file));
    if (!m) return null;
    const idx = MESES.findIndex((mes) => foldName(mes) === foldName(m[1]));
    if (idx < 0) return null;
    return parsePeriod(`${m[2]}-${String(idx + 1).padStart(2, "0")}`);
}

/** Resolve one `<definedName>` body: a literal, or a reference followed into its cell. */
async function resolveDefinedName(book, body) {
    const text = unescapeXml(body).trim();
    if (text === "") return { kind: "vacio", value: null };
    if (/^"[\s\S]*"$/.test(text)) return { kind: "literal", value: text.slice(1, -1) };
    if (/^-?\d+(\.\d+)?$/.test(text)) return { kind: "literal", value: Number(text) };

    // A reference: Hoja1!$P$2, or 'Mi Hoja'!$P$2.
    const m = /^(?:'([^']+)'|([^'!]+))!\$?([A-Z]+)\$?(\d+)$/.exec(text);
    if (!m) return { kind: "desconocido", value: text };
    const sheetName = m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2];
    const address = `${m[3]}${m[4]}`;
    const loc = await locate(book, sheetName);
    if (!loc.sheetPart) return { kind: "referencia", value: null, ref: text, problem: loc.problems.join("; ") };
    const xml = await book.text(loc.sheetPart);
    const sst = await book.sharedStrings();
    let value = null;
    let found = false;
    scanCells(xml, (cell) => {
        if (found || cell.ref !== address) return;
        found = true;
        const t = cellText(cell, sst);
        if (t === null) { value = null; return; }
        value = cell.t === "s" || cell.t === "str" || cell.t === "inlineStr" ? t : Number(t);
    });
    return { kind: "referencia", value, ref: text };
}

function periodValueMatches(resolved, expectedSerial, expectedIso) {
    if (resolved === null || resolved === undefined) return false;
    if (typeof resolved === "number") return resolved === expectedSerial;
    const s = String(resolved).trim();
    return s === String(expectedSerial) || s === expectedIso;
}

async function checkPeriod(ctx) {
    const { book } = ctx;
    const problems = [];
    const wb = await book.text("xl/workbook.xml");
    if (!wb) return row("j", STATUS.FAIL, "falta xl/workbook.xml");

    const declared = new Map();
    for (const tag of collectOpenTags(wb, "definedName")) {
        const name = attr(tag.text, "name");
        if (!name || !Object.values(PERIOD_NAMES).includes(name)) continue;
        const element = elementText(wb, tag, "definedName");
        const body = tag.selfClosing ? "" : element.slice(tag.text.length, element.length - "</definedName>".length);
        declared.set(name, body);
    }
    for (const name of Object.values(PERIOD_NAMES)) {
        if (!declared.has(name)) problems.push(`falta el nombre definido ${name}`);
    }

    // The reference period: the caller's, the filename's, or none. When both exist they
    // must agree - "the filename and the content cannot disagree" (03 §6.1, AC 22).
    const fromName = periodFromFilename(book.file);
    let period = ctx.period || null;
    if (period && fromName && period.key !== fromName.key) {
        problems.push(`el archivo dice ${fromName.key} y el periodo pedido es ${period.key}`);
    }
    if (!period) period = fromName;

    const shown = [];
    for (const [label, name] of [["inicio", PERIOD_NAMES.INICIO], ["fin", PERIOD_NAMES.FIN], ["etiqueta", PERIOD_NAMES.ETIQUETA]]) {
        if (!declared.has(name)) continue;
        const resolved = await resolveDefinedName(book, declared.get(name));
        shown.push(`${name}=${JSON.stringify(resolved.value)}`);
        if (!period) continue;
        if (resolved.kind === "desconocido") {
            problems.push(`${name} no es ni literal ni referencia: ${JSON.stringify(resolved.value)}`);
            continue;
        }
        if (resolved.value === null) {
            problems.push(`${name} no tiene valor${resolved.ref ? ` (${resolved.ref} vacia)` : ""}`);
            continue;
        }
        const ok = label === "etiqueta"
            ? String(resolved.value) === period.etiqueta
            : periodValueMatches(resolved.value,
                label === "inicio" ? period.inicioSerial : period.finSerial,
                label === "inicio" ? period.inicio : period.fin);
        if (!ok) {
            problems.push(`${name}=${JSON.stringify(resolved.value)} no corresponde a ${period.key}`);
        }
    }

    // docProps/custom.xml, the second half of AC 22.
    if (period) {
        const custom = await book.text("docProps/custom.xml");
        const want = {
            [PERIOD_NAMES.INICIO]: [period.inicio, String(period.inicioSerial)],
            [PERIOD_NAMES.FIN]: [period.fin, String(period.finSerial)],
            [PERIOD_NAMES.ETIQUETA]: [period.etiqueta],
        };
        if (!custom) {
            problems.push("falta docProps/custom.xml");
        } else {
            for (const tag of collectOpenTags(custom, "property")) {
                const name = attr(tag.text, "name");
                if (!want[name]) continue;
                const element = elementText(custom, tag, "property");
                const value = unescapeXml((/<vt:lpwstr>([\s\S]*?)<\/vt:lpwstr>/.exec(element) || [, ""])[1]).trim();
                if (!want[name].includes(value)) {
                    problems.push(`docProps/custom.xml ${name}=${JSON.stringify(value)} no corresponde a ${period.key}`);
                }
                delete want[name];
            }
            for (const missing of Object.keys(want)) {
                problems.push(`docProps/custom.xml no declara ${missing}`);
            }
        }
    }

    const detail = (period
        ? `periodo de referencia ${period.key} (${ctx.period ? "opcion" : "nombre de archivo"}); `
        : "sin periodo de referencia (ni opcion ni nombre de archivo): solo se verifica la existencia; ") +
        (shown.length ? shown.join(", ") : "ningun nombre definido") +
        (problems.length ? `; ${problems.join("; ")}` : "");
    return row("j", problems.length ? STATUS.FAIL : STATUS.PASS, detail);
}

/* ------------------------------------------------------------------ *
 * One pass over the Cuadro sheet feeds (a), (e), (f), (g), (h) and (i)
 * ------------------------------------------------------------------ */

async function scanSheet(book, sheetPart, tableLastRow, formats) {
    const sst = await book.sharedStrings();
    const xml = sheetPart ? await book.text(sheetPart) : null;
    const stats = {
        cells: 0,
        maxRow: 0,
        tableLastRow,
        cellsWithoutAddress: 0,
        emptyStringCells: [],
        errorCells: [],
        nanCells: [],
        undefinedCells: [],
        nonNumericDates: [],
        nonDateFormat: [],
        dateCellsPopulated: 0,
        formulasByColumn: new Map(),
        dataRowsPresent: 0,
        dataRowsWithContent: 0,
        rowsMissingIdentity: [],
    };
    if (!xml) return stats;

    const dateCols = new Set(DATE_COLUMN_INDEXES);
    const rowsSeen = new Set();
    // Per-row identity tracking for the COUNTIF(Tabla2[...],"") arm of check (e).
    const rowHasContent = new Map();
    const rowIdentity = new Map();

    scanCells(xml, (cell) => {
        stats.cells += 1;
        if (cell.col < 0) { stats.cellsWithoutAddress += 1; return; }
        if (cell.row > stats.maxRow) stats.maxRow = cell.row;

        const inTable = cell.row >= 2 && cell.row <= tableLastRow && cell.col < TABLE_COLUMNS;
        if (inTable) rowsSeen.add(cell.row);

        if (cell.hasFormula) {
            stats.formulasByColumn.set(cell.col, (stats.formulasByColumn.get(cell.col) || 0) + 1);
        }

        const text = cellText(cell, sst);

        // (f) - anywhere in Cuadro, not only inside the table.
        if (cell.t === "e") {
            stats.errorCells.push({ ref: cell.ref, code: text === null ? "?" : text });
        }
        if (text !== null && text !== "") {
            if (text.includes("undefined")) stats.undefinedCells.push(cell.ref);
            if (text.includes("NaN")) stats.nanCells.push(cell.ref);
            else if ((cell.t === null || cell.t === "n") && !Number.isFinite(Number(text))) {
                stats.nanCells.push(cell.ref);
            }
        }

        if (!inTable) return;

        // (e) - a cell that HOLDS "" is a ghost row; a cell with no value at all is not.
        if (text === "") stats.emptyStringCells.push(cell.ref);

        if (cell.col < RAW_COLUMNS && text !== null && text.trim() !== "") {
            rowHasContent.set(cell.row, true);
            if (cell.col === COL_CONTRATISTA || cell.col === COL_APELLIDOS) {
                const seen = rowIdentity.get(cell.row) || new Set();
                seen.add(cell.col);
                rowIdentity.set(cell.row, seen);
            }
        }

        // (g)
        if (dateCols.has(cell.col)) {
            const populated = text !== null && text !== "";
            if (populated) {
                stats.dateCellsPopulated += 1;
                const numeric = (cell.t === null || cell.t === "n") && Number.isFinite(Number(text));
                if (!numeric) stats.nonNumericDates.push({ ref: cell.ref, text });
                else if (!isDateStyle(cell.s, formats)) stats.nonDateFormat.push(cell.ref);
            }
        }
    });

    stats.dataRowsPresent = rowsSeen.size;
    stats.dataRowsWithContent = rowHasContent.size;
    for (const rowNumber of [...rowHasContent.keys()].sort((a, b) => a - b)) {
        const seen = rowIdentity.get(rowNumber);
        if (!seen || seen.size < 2) stats.rowsMissingIdentity.push(rowNumber);
    }
    return stats;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Run every structural check against a generated report.
 *
 * @param {string} xlsxPath           the workbook to inspect
 * @param {object} [options]
 * @param {string} [options.templatePath]  the reference for check (b). NEVER a past
 *                                         report - the template is the reference.
 * @param {number} [options.expectedRows]  accepted worker count; omitted, check (a)
 *                                         compares the ref against the sheet only
 * @param {string|object} [options.period] "YYYY-MM" or a parsePeriod() descriptor
 * @param {string[]} [options.pending]     check ids whose fix a later phase owns; a
 *                                         failure there is reported `pending`, never
 *                                         deleted
 * @param {string} [options.sheetName]     defaults to config.SHEET_NAME ("Cuadro")
 * @returns {Promise<Array<{check,title,status,detail,phase}>>}
 */
async function assertStructure(xlsxPath, options = {}) {
    if (typeof xlsxPath !== "string" || xlsxPath.trim() === "") {
        throw new StructuralError(STRUCTURAL_ERROR.BAD_OPTION, "assertStructure: falta la ruta del .xlsx");
    }
    const templatePath = options.templatePath || config.TEMPLATE;
    const sheetName = options.sheetName || config.SHEET_NAME;

    let expectedRows;
    if (options.expectedRows !== undefined && options.expectedRows !== null) {
        if (!Number.isInteger(options.expectedRows) || options.expectedRows < 0) {
            throw new StructuralError(STRUCTURAL_ERROR.BAD_OPTION,
                `expectedRows debe ser un entero >= 0, recibido ${JSON.stringify(options.expectedRows)}`);
        }
        expectedRows = options.expectedRows;
    }

    let period = null;
    if (options.period !== undefined && options.period !== null) {
        period = typeof options.period === "string" ? parsePeriod(options.period) : options.period;
        if (!period || typeof period.etiqueta !== "string" || !Number.isFinite(period.inicioSerial)) {
            throw new StructuralError(STRUCTURAL_ERROR.BAD_OPTION,
                "period debe ser \"YYYY-MM\" o un descriptor de parsePeriod()");
        }
    }

    const pending = new Set(options.pending || []);
    for (const id of pending) {
        if (!CHECK_IDS.includes(id)) {
            throw new StructuralError(STRUCTURAL_ERROR.BAD_OPTION,
                `pending: ${JSON.stringify(id)} no es un id de verificacion (${CHECK_IDS.join(",")})`);
        }
    }

    const book = await openBook(xlsxPath);
    const loc = await locate(book, sheetName);
    const formats = parseNumberFormats(await book.text("xl/styles.xml"));

    // The table's own last row bounds the scan. With no readable table there is nothing
    // to bound it with, so the scan covers the whole sheet and (a) reports the reason.
    let tableLastRow = Number.MAX_SAFE_INTEGER;
    if (loc.tablePart) {
        const tableXml = await book.text(loc.tablePart);
        const range = parseRange(attr((findOpenTag(tableXml, "table") || { text: "" }).text, "ref"));
        if (range) tableLastRow = range.last.row;
    }
    const sheetStats = await scanSheet(book, loc.sheetPart, tableLastRow, formats);

    const ctx = {
        book,
        templatePath,
        tablePart: loc.tablePart,
        sheetPart: loc.sheetPart,
        locateProblems: loc.problems.join("; "),
        expectedRows,
        period,
        sheetStats,
        formats,
    };

    const runners = {
        a: () => checkTableRef(ctx),
        b: () => checkPivotIdentity(ctx),
        c: () => checkDanglingParts(ctx),
        d: () => checkRecalcFlags(ctx),
        e: () => checkEmptyStrings(ctx),
        f: () => checkPoisonValues(ctx),
        g: () => checkDateColumns(ctx),
        h: () => checkOptionDLiterals(ctx),
        i: () => checkFormulasSurvive(ctx),
        j: () => checkPeriod(ctx),
    };

    const results = [];
    for (const meta of CHECKS) {
        let result;
        try {
            result = await runners[meta.id]();
        } catch (err) {
            if (err instanceof StructuralError) throw err;
            // A check that blew up is a failed check, not a dead test run: the other
            // nine still carry information.
            result = row(meta.id, STATUS.FAIL, `error al verificar: ${err && err.message ? err.message : err}`);
        }
        if (result.status === STATUS.FAIL && pending.has(meta.id)) {
            result = row(meta.id, STATUS.PENDING, `reclamado por ${meta.phase}: ${result.detail}`);
        }
        results.push(result);
    }
    return Object.freeze(results);
}

/** The rows that failed. `pending` is deliberately not a failure. */
function failures(results) {
    return results.filter((r) => r.status === STATUS.FAIL);
}

/** `{pass, fail, pending}` counts. */
function summarize(results) {
    const out = { pass: 0, fail: 0, pending: 0 };
    for (const r of results) out[r.status] += 1;
    return out;
}

const STATUS_LABEL = { pass: "OK  ", fail: "FALLA", pending: "PEND" };

/** Render the whole run as one table, one line per check. */
function formatResults(results, options = {}) {
    const header = options.title ? [options.title, ""] : [];
    const width = Math.max(...results.map((r) => r.title.length));
    const lines = results.map((r) =>
        `  ${r.check}  ${STATUS_LABEL[r.status].padEnd(5)}  ${r.title.padEnd(width)}  ${r.detail}`);
    const s = summarize(results);
    return [...header, ...lines, "",
        `  ${s.pass} ok, ${s.fail} fallan, ${s.pending} pendientes de ${results.length}`].join("\n");
}

module.exports = {
    assertStructure,
    failures,
    summarize,
    formatResults,
    CHECKS,
    CHECK_IDS,
    STATUS,
    StructuralError,
    STRUCTURAL_ERROR,
    OPTION_D_COLUMNS,
    FORMULA_COLUMNS,
    PERIOD_NAMES,
    TABLE_NAME,
    // exported for the test's corruption helpers and for anyone auditing the checks
    colLetter,
    colIndex,
    normalizePivotPart,
    periodFromFilename,
};

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function parseArgv(argv) {
    const out = { file: null, template: undefined, rows: undefined, period: undefined, pending: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--template") out.template = argv[++i];
        else if (a === "--rows") out.rows = Number(argv[++i]);
        else if (a === "--period") out.period = argv[++i];
        else if (a === "--pending") out.pending = String(argv[++i] || "").split(",").filter(Boolean);
        else if (a.startsWith("--")) throw new StructuralError(STRUCTURAL_ERROR.BAD_OPTION, `opcion desconocida ${a}`);
        else if (!out.file) out.file = a;
        else throw new StructuralError(STRUCTURAL_ERROR.BAD_OPTION, `argumento inesperado ${a}`);
    }
    return out;
}

async function main(argv) {
    const args = parseArgv(argv);
    if (!args.file) {
        process.stderr.write(
            "uso: node src/test/structural.js <report.xlsx> [--template src/template-v2.xlsx]\n" +
            "                                [--rows N] [--period YYYY-MM] [--pending c,d]\n");
        return 2;
    }
    const results = await assertStructure(args.file, {
        templatePath: args.template,
        expectedRows: Number.isFinite(args.rows) ? args.rows : undefined,
        period: args.period,
        pending: args.pending,
    });
    process.stdout.write(`${formatResults(results, { title: path.basename(args.file) })}\n`);
    return failures(results).length > 0 ? 1 : 0;
}

// Guarded twice: `require.main === module` alone is true inside a node:test child
// process, and this file lives in src/test/ where the runner would otherwise execute it.
if (require.main === module && !process.env.NODE_TEST_CONTEXT) {
    main(process.argv.slice(2))
        .then((code) => { process.exitCode = code; })
        .catch((err) => {
            process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
            process.exitCode = 2;
        });
}

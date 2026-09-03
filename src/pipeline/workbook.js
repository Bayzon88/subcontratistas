"use strict";
/**
 * The reader. One .xlsx in, raw rows keyed by canonical column name out.
 *
 * Three things happen here and nowhere else (05-implementation-plan.md Phase 1
 * tasks 1-6, 8, 10; 03-expected-output.md §1.2-§1.4):
 *
 *   1. The `Cuadro` sheet is located by NORMALIZED name, not by
 *      `SheetNames.indexOf("Cuadro")`. That indexOf returns -1 on no match,
 *      `SheetNames[-1]` is undefined, `Sheets[undefined]` is undefined,
 *      `sheet_to_json` throws, and the catch logs to a console that
 *      `console.clear()` has already wiped - an entire subcontratista's workforce
 *      disappears and the report still looks complete (BUG-01).
 *   2. The header row is located by anchoring on a cell whose normalized value is
 *      exactly `RUC`. The anchor fixes the ROW ONLY; the left and right edges are
 *      measured separately by walking the header row outward. Anchoring the left
 *      edge on RUC would discard any canonical column placed to its left, which is
 *      exactly what "column order may vary" permits, and the >=8-of-18 threshold
 *      cannot see it because 17 of 18 would still resolve (BUG-03).
 *   3. Every header, every missing column and every numeric-name row becomes an
 *      IssueList entry. Nothing is dropped silently and nothing throws for a data
 *      problem.
 *
 * NO COERCION HAPPENS HERE. Values are the raw SheetJS `.v` (numbers stay numbers,
 * date serials stay serials); typing is schema.js's job.
 *
 * Row shape: the 18 canonical keys, always all present (null when the column is
 * absent or the cell is empty - `defval: null`, BUG-05), plus a `provenance` key
 * carrying {subcontratista, archivo, hoja, filaOrigen, celdaAncla}. That replaces
 * the `errorEnArchivo` field excelConsolidation.js stamps at :140 and its own
 * cleanup loop deletes at :64-69, destroying the traceability it existed for
 * (BUG-22).
 */
const path = require("path");
const XLSX = require("xlsx");
const config = require("../config");
const { CANONICAL, normalizeHeader, resolveHeader } = require("./columns");
const { CODE, IssueList } = require("./issues");

/** A name that is numeric, or 8-11 digits after trimming, is a shifted row. §2.3 */
const NUMERIC_NAME_RE = /^\d{8,11}$/;
const NAME_COLUMN = "APELLIDOS Y NOMBRES";

/** Raw value of one cell, or null. `.v` only - `.w` is formatted text and would
 *  re-introduce locale-dependent dates. */
function cellValue(ws, r, c) {
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    if (!cell || cell.v === undefined || cell.v === null) return null;
    return cell.v;
}

function addr(r, c) {
    return XLSX.utils.encode_cell({ r, c });
}

/** A header cell counts as empty when it normalizes to "" - covers null, "", "   "
 *  and a stray "\n". */
function isBlankHeader(value) {
    return normalizeHeader(value) === "";
}

/**
 * Select the sheet whose name matches config.SHEET_NAME case-, accent- and
 * whitespace-insensitively. "Cuadro", " cuadro ", "CUADRO" and "CUADRO " all match;
 * "Cuadro 2026" does not (equality, not prefix - a near-miss must fail loudly rather
 * than bind to the wrong table).
 *
 * @returns {{name: string, exact: boolean}|null}
 */
function matchSheetName(sheetNames, wanted = config.SHEET_NAME) {
    const target = normalizeHeader(wanted);
    for (const name of sheetNames || []) {
        if (normalizeHeader(name) === target) return { name, exact: name === wanted };
    }
    return null;
}

/**
 * Walk the header row outward from the anchor, stopping after HEADER_EDGE_GAP
 * consecutive empty header cells in each direction. The edge is the last NON-empty
 * cell seen, so the gap cells themselves are not part of the span.
 */
function resolveSpan(ws, row, anchorCol, range) {
    let left = anchorCol;
    let gap = 0;
    for (let c = anchorCol - 1; c >= range.s.c; c--) {
        if (isBlankHeader(cellValue(ws, row, c))) {
            if (++gap >= config.HEADER_EDGE_GAP) break;
        } else {
            gap = 0;
            left = c;
        }
    }
    let right = anchorCol;
    gap = 0;
    for (let c = anchorCol + 1; c <= range.e.c; c++) {
        if (isBlankHeader(cellValue(ws, row, c))) {
            if (++gap >= config.HEADER_EDGE_GAP) break;
        } else {
            gap = 0;
            right = c;
        }
    }
    return { left, right };
}

/** Resolve every header cell across the span. Blank cells inside the span are holes,
 *  not headers, and are ignored. */
function collectHeaders(ws, row, left, right) {
    const out = [];
    for (let c = left; c <= right; c++) {
        const raw = cellValue(ws, row, c);
        if (isBlankHeader(raw)) continue;
        const { canonical, via, normalized } = resolveHeader(raw);
        out.push({ col: c, celda: addr(row, c), raw, normalized, canonical, via });
    }
    return out;
}

function distinctCanonicalCount(headers) {
    const seen = new Set();
    for (const h of headers) if (h.canonical) seen.add(h.canonical);
    return seen.size;
}

/**
 * Find the header row. Scans row-major over the first ANCHOR_MAX_ROWS x
 * ANCHOR_MAX_COLS of the used range for a cell normalizing to exactly "RUC", then
 * accepts it only if at least ANCHOR_MIN_HEADERS of the 18 canonical columns also
 * resolve on that row within the resolved span. The gate is what stops a title cell
 * or an instructions block that happens to say "RUC" from winning (§1.2 step 6).
 *
 * @returns {{anchor: object|null, candidates: number, samples: Array}}
 */
function findAnchor(ws, range) {
    const lastRow = Math.min(range.e.r, range.s.r + config.ANCHOR_MAX_ROWS - 1);
    const lastCol = Math.min(range.e.c, range.s.c + config.ANCHOR_MAX_COLS - 1);
    const samples = [];
    let candidates = 0;

    for (let r = range.s.r; r <= lastRow; r++) {
        for (let c = range.s.c; c <= lastCol; c++) {
            const value = cellValue(ws, r, c);
            if (value === null) continue;
            if (samples.length < 10 && String(value).trim() !== "") {
                samples.push({ celda: addr(r, c), valor: value });
            }
            if (normalizeHeader(value) !== "RUC") continue;
            candidates++;
            const { left, right } = resolveSpan(ws, r, c, range);
            const headers = collectHeaders(ws, r, left, right);
            if (distinctCanonicalCount(headers) >= config.ANCHOR_MIN_HEADERS) {
                return {
                    anchor: { row: r, col: c, celda: addr(r, c), left, right, headers },
                    candidates,
                    samples,
                };
            }
        }
    }
    return { anchor: null, candidates, samples };
}

/**
 * Last row that carries any value across the header span. Stops after DATA_END_GAP
 * consecutive fully-empty rows so a decorative block far below the table does not
 * drag the read range down, and trailing blank rows are discarded rather than
 * counted (§1.2 step 5).
 */
function findLastDataRow(ws, range, anchor) {
    let last = anchor.row;
    let gap = 0;
    for (let r = anchor.row + 1; r <= range.e.r; r++) {
        let empty = true;
        for (let c = anchor.left; c <= anchor.right; c++) {
            const v = cellValue(ws, r, c);
            if (v !== null && String(v).trim() !== "") { empty = false; break; }
        }
        if (empty) {
            if (++gap >= config.DATA_END_GAP) break;
        } else {
            gap = 0;
            last = r;
        }
    }
    return last;
}

/** True when the value is a shifted-row artefact rather than a person's name. */
function isNumericName(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === "number") return true;
    if (typeof value === "boolean") return false;
    return NUMERIC_NAME_RE.test(String(value).trim());
}

/** The empty result, so every caller gets the same shape whether or not the file read. */
function failedResult(provenance) {
    return {
        ok: false,
        rows: [],
        provenance,
        headerMap: {},
        anchor: null,
        missingColumns: CANONICAL.slice(),
        unrecognizedHeaders: [],
        stats: { rowsFound: 0, rowsRejected: 0, rowsReturned: 0, blankRows: 0 },
    };
}

/**
 * Read one subcontratista workbook.
 *
 * @param {string} filePath absolute path to the .xlsx
 * @param {object} o
 * @param {string} o.subcontratista source folder name - the subcontratista's identity
 * @param {string} [o.archivo] name to call the file in issues and provenance. Defaults to
 *        the basename of `filePath`, which is right for a real run because zip.js extracted
 *        the file under its own name. /review reads an upload whose temp file is named by
 *        express-fileupload, so it passes the name the operator actually chose - otherwise
 *        every message would name "tmp-1-1788408375827".
 * @param {import('./issues').IssueList} o.issues collector; never throws, always appends
 * @returns {{ok: boolean, rows: Array<object>, provenance: object, headerMap: object,
 *            anchor: object|null, missingColumns: string[],
 *            unrecognizedHeaders: Array<object>, stats: object}}
 */
function readWorkbook(filePath, { subcontratista, archivo: nombreMostrado, issues = new IssueList() } = {}) {
    const archivo = nombreMostrado || path.basename(filePath);
    const base = { subcontratista: subcontratista ?? null, archivo, hoja: null, celdaAncla: null, date1904: false };

    // The tuned read of Phase 1 task 10: `sheets` skips parsing every other sheet,
    // `cellFormula`/`cellStyles` skip work nothing downstream reads - measured 415ms
    // -> 341ms on the 2.4 MB / 4,808-row workbook in src/.
    //
    // `sheets` takes the REAL name, so the loose match has to be resolved first -
    // but SheetJS populates wb.SheetNames with EVERY sheet even when the filter
    // matches none of them (verified against src/Formato Reporte subcontratas.xlsx),
    // so the speculative pass on the canonical name doubles as the name listing. The
    // common case (a sheet named exactly "Cuadro") is one read; only a loosely-named
    // sheet pays for a second.
    const READ_OPTS = { cellFormula: false, cellStyles: false };
    let wb;
    try {
        wb = XLSX.readFile(filePath, { ...READ_OPTS, sheets: [config.SHEET_NAME] });
    } catch (err) {
        issues.failed({
            code: CODE.WORKBOOK_UNREADABLE,
            message: `no se pudo abrir el archivo "${archivo}" del subcontratista "${subcontratista}": ${err.message}`,
            subcontratista, archivo, detalle: { error: err.message },
        });
        return failedResult(base);
    }

    const names = wb.SheetNames || [];
    const match = matchSheetName(names);
    if (!match) {
        // BUG-01. Naming the sheets actually present is the difference between the
        // operator fixing the file and the workforce silently disappearing.
        issues.failed({
            code: CODE.SHEET_NOT_FOUND,
            message: `el archivo "${archivo}" del subcontratista "${subcontratista}" no tiene una hoja "${config.SHEET_NAME}"; hojas presentes: ${names.map(n => `"${n}"`).join(", ") || "(ninguna)"}`,
            subcontratista, archivo,
            detalle: { hojasPresentes: names, hojaBuscada: config.SHEET_NAME },
        });
        return failedResult(base);
    }
    base.hoja = match.name;

    if (!match.exact) {
        issues.info({
            code: CODE.SHEET_MATCHED_LOOSELY,
            message: `hoja "${match.name}" aceptada como "${config.SHEET_NAME}" tras normalizar mayusculas, acentos y espacios`,
            subcontratista, archivo, hoja: match.name,
            detalle: { nombreReal: match.name, nombreCanonico: config.SHEET_NAME },
        });
        try {
            wb = XLSX.readFile(filePath, { ...READ_OPTS, sheets: [match.name] });
        } catch (err) {
            issues.failed({
                code: CODE.WORKBOOK_UNREADABLE,
                message: `no se pudo leer la hoja "${match.name}" de "${archivo}" (${subcontratista}): ${err.message}`,
                subcontratista, archivo, hoja: match.name, detalle: { error: err.message },
            });
            return failedResult(base);
        }
    }

    // Read the date system rather than assuming it. A workbook authored on legacy
    // Mac Excel is off by exactly 1,462 days, which looks like plausible data. The
    // flag is returned so the caller can fail loudly instead of shifting silently.
    base.date1904 = Boolean(wb.Workbook && wb.Workbook.WBProps && wb.Workbook.WBProps.date1904);
    if (base.date1904) {
        issues.warning({
            code: CODE.DATE_SYSTEM_1904,
            message: `el archivo "${archivo}" (${subcontratista}) usa el sistema de fechas 1904; toda fecha esta desplazada 1462 dias`,
            subcontratista, archivo, hoja: match.name, detalle: { date1904: true },
        });
    }

    const ws = wb.Sheets[match.name];
    if (!ws || !ws["!ref"]) {
        issues.failed({
            code: CODE.ANCHOR_NOT_FOUND,
            message: `la hoja "${match.name}" de "${archivo}" (${subcontratista}) esta vacia`,
            subcontratista, archivo, hoja: match.name, detalle: { primerasCeldas: [] },
        });
        return failedResult(base);
    }

    const range = XLSX.utils.decode_range(ws["!ref"]);
    const { anchor, candidates, samples } = findAnchor(ws, range);
    if (!anchor) {
        // Never fall back to A1: a wrong table read as if it were right is the exact
        // failure this module exists to remove.
        issues.failed({
            code: CODE.ANCHOR_NOT_FOUND,
            message: candidates > 0
                ? `no se encontro una fila de encabezados valida en "${archivo}" (${subcontratista}): ${candidates} celda(s) "RUC" halladas, ninguna con al menos ${config.ANCHOR_MIN_HEADERS} de las 18 columnas canonicas en su fila`
                : `no se encontro ninguna celda "RUC" en las primeras ${config.ANCHOR_MAX_ROWS} filas x ${config.ANCHOR_MAX_COLS} columnas de "${match.name}" en "${archivo}" (${subcontratista})`,
            subcontratista, archivo, hoja: match.name,
            detalle: {
                candidatosRUC: candidates,
                minimoEncabezados: config.ANCHOR_MIN_HEADERS,
                primerasCeldas: samples,
            },
        });
        return failedResult(base);
    }

    base.celdaAncla = anchor.celda;

    issues.info({
        code: CODE.ANCHOR_FOUND,
        message: `ancla "RUC" en ${anchor.celda} de "${match.name}" (${archivo}); encabezados leidos de ${addr(anchor.row, anchor.left)} a ${addr(anchor.row, anchor.right)}`,
        subcontratista, archivo, hoja: match.name,
        fila: anchor.row + 1, celda: anchor.celda,
        detalle: {
            filaEncabezado: anchor.row + 1,
            rangoEncabezados: `${addr(anchor.row, anchor.left)}:${addr(anchor.row, anchor.right)}`,
            encabezadosResueltos: distinctCanonicalCount(anchor.headers),
        },
    });

    // ---- header resolution -------------------------------------------------
    // Two passes: claim, then decide. A canonical column claimed twice is only fatal
    // when the choice between the claimants would be ARBITRARY. An exact canonical
    // spelling beats an alias hit, deterministically and regardless of column order,
    // because the alternative rejects a real, common file: the format the client
    // itself hands out (src/Formato Reporte subcontratas.xlsx) carries the template's
    // computed columns to the right of the 18 input ones, and its computed column
    // "Trabajador" (AA1) is an alias of APELLIDOS Y NOMBRES - which already sits, in
    // its exact canonical spelling, at E1. Failing that workbook would be a far worse
    // outcome than the ambiguity §1.4 rule 3 exists to catch.
    const claims = new Map();
    const unrecognizedHeaders = [];

    for (const h of anchor.headers) {
        if (!h.canonical) {
            unrecognizedHeaders.push({ celda: h.celda, raw: h.raw, normalized: h.normalized });
            continue;
        }
        if (!claims.has(h.canonical)) claims.set(h.canonical, []);
        claims.get(h.canonical).push(h);
    }

    const winners = new Map();      // canonical -> header
    const demoted = new Map();      // losing header -> winning header
    const duplicates = [];          // genuinely ambiguous claims: fatal

    for (const [canonical, hs] of claims) {
        const exact = hs.filter(h => h.via === "canonical");
        const pool = exact.length ? exact : hs;
        if (pool.length > 1) {
            duplicates.push({ canonical, celdas: pool.map(h => h.celda) });
            continue;
        }
        winners.set(canonical, pool[0]);
        for (const h of hs) if (h !== pool[0]) demoted.set(h, pool[0]);
    }

    // Emit in column order so the run report reads left to right.
    const headerMap = {};
    const recoveredLeft = [];
    for (const h of anchor.headers) {
        if (!h.canonical) {
            issues.info({
                code: CODE.HEADER_UNRECOGNIZED,
                message: `encabezado "${h.raw}" no reconocido en ${h.celda} de "${archivo}" (${subcontratista}) - ignorado`,
                subcontratista, archivo, hoja: match.name,
                fila: anchor.row + 1, celda: h.celda, valor: h.raw,
                detalle: { normalizado: h.normalized },
            });
            continue;
        }
        const winner = demoted.get(h);
        if (winner) {
            issues.warning({
                code: CODE.HEADER_DUPLICATE,
                message: `encabezado "${h.raw}" en ${h.celda} de "${archivo}" (${subcontratista}) es un alias de "${h.canonical}", que ya esta en ${winner.celda} con su nombre exacto - se ignora ${h.celda}`,
                subcontratista, archivo, hoja: match.name,
                fila: anchor.row + 1, celda: h.celda, columna: h.canonical, valor: h.raw,
                detalle: { ganadora: winner.celda, ignorada: h.celda, resueltoPor: "nombre exacto" },
            });
            continue;
        }
        if (winners.get(h.canonical) !== h) continue;   // fatal duplicate, reported below
        headerMap[h.canonical] = { col: h.col, celda: h.celda, raw: h.raw, via: h.via };
        if (h.via === "alias") {
            issues.info({
                code: CODE.HEADER_ALIAS_ACCEPTED,
                message: `accepted alias "${h.raw}" as "${h.canonical}" en ${h.celda} de "${archivo}" (${subcontratista})`,
                subcontratista, archivo, hoja: match.name,
                fila: anchor.row + 1, celda: h.celda, columna: h.canonical, valor: h.raw,
                detalle: { alias: h.normalized },
            });
        }
        if (h.col < anchor.col) recoveredLeft.push(h.canonical);
    }

    if (anchor.left < anchor.col) {
        // §1.2 step 4: the span is measured, not inherited from the anchor. Making
        // the recovery visible is what keeps an unexpected span from being merely
        // tolerated.
        const n = anchor.col - anchor.left;
        issues.info({
            code: CODE.LEFT_EDGE_EXTENDED,
            message: `left edge resolved at ${addr(anchor.row, anchor.left)}, ${n} column(s) left of the RUC anchor at ${anchor.celda}: ${recoveredLeft.join(", ") || "(sin columnas canonicas)"}`,
            subcontratista, archivo, hoja: match.name,
            fila: anchor.row + 1, celda: addr(anchor.row, anchor.left),
            detalle: { columnasRecuperadas: recoveredLeft, columnasAdicionales: n },
        });
    }

    if (duplicates.length) {
        // BUG-05: sheet_to_json would suffix the second one `_1` and the old cleanup
        // loop would delete it, so one of the two columns wins with no message.
        for (const d of duplicates) {
            issues.failed({
                code: CODE.HEADER_DUPLICATE,
                message: `columna "${d.canonical}" duplicada en "${archivo}" (${subcontratista}): ${d.celdas.join(" y ")}`,
                subcontratista, archivo, hoja: match.name,
                fila: anchor.row + 1, celda: d.celdas[d.celdas.length - 1], columna: d.canonical,
                detalle: { celdas: d.celdas },
            });
        }
        return failedResult(base);
    }

    if (Object.keys(headerMap).length < config.ANCHOR_MIN_HEADERS) {
        // Unreachable via findAnchor (which gates on the same threshold) unless every
        // duplicate was stripped; kept as a belt-and-braces guard for §1.4 rule 5.
        issues.failed({
            code: CODE.ANCHOR_NOT_FOUND,
            message: `solo ${Object.keys(headerMap).length} de las 18 columnas canonicas se resolvieron en "${archivo}" (${subcontratista}); minimo ${config.ANCHOR_MIN_HEADERS}`,
            subcontratista, archivo, hoja: match.name, fila: anchor.row + 1,
            detalle: { resueltas: Object.keys(headerMap) },
        });
        return failedResult(base);
    }

    // ---- data --------------------------------------------------------------
    const lastRow = findLastDataRow(ws, range, anchor);
    if (lastRow <= anchor.row) {
        // §1.4 rule 4. issues.js has no dedicated "file has no rows" code, so ROW_EMPTY
        // carries it at FAILED severity - the workbook, not a row, is what is rejected.
        issues.failed({
            code: CODE.ROW_EMPTY,
            message: `no hay filas de datos bajo el ancla ${anchor.celda} en "${archivo}" (${subcontratista})`,
            subcontratista, archivo, hoja: match.name, celda: anchor.celda,
            detalle: { filaEncabezado: anchor.row + 1 },
        });
        return failedResult(base);
    }

    const readRange = XLSX.utils.encode_range({
        s: { r: anchor.row, c: anchor.left },
        e: { r: lastRow, c: anchor.right },
    });
    // defval:null so a missing cell is an explicit null instead of an absent key -
    // the absent key is what made the old JSON.stringify dedupe key-order-dependent
    // (BUG-05). header:1 rather than object mode so SheetJS never gets the chance to
    // suffix a repeated header, and so columns are addressed by position.
    const matrix = XLSX.utils.sheet_to_json(ws, {
        header: 1,
        range: readRange,
        defval: null,
        raw: true,
        blankrows: true,
    });

    const rows = [];
    let rowsFound = 0;
    let rowsRejected = 0;
    let blankRows = 0;

    for (let i = 1; i < matrix.length; i++) {
        const line = matrix[i] || [];
        const sheetRow = anchor.row + i;          // 0-based
        const filaOrigen = sheetRow + 1;          // 1-based, as the operator sees it

        const nonEmpty = line.some(v => v !== null && v !== undefined && String(v).trim() !== "");
        if (!nonEmpty) {
            blankRows++;
            issues.info({
                code: CODE.ROW_EMPTY,
                message: `fila ${filaOrigen} vacia en "${archivo}" (${subcontratista}) - omitida`,
                subcontratista, archivo, hoja: match.name, fila: filaOrigen,
            });
            continue;
        }
        rowsFound++;

        const record = {};
        for (const canonical of CANONICAL) {
            const h = headerMap[canonical];
            record[canonical] = h ? (line[h.col - anchor.left] ?? null) : null;
        }

        // §2.3, second header-shift defence. A shifted sheet can resolve 17 of 18
        // headers perfectly while every VALUE is off by one column: 643 rows of the
        // last real run (12.7%) were all "named" 20101155588, and because the template
        // keys identity on the name they counted as ONE person between them.
        const nameHeader = headerMap[NAME_COLUMN];
        const nameValue = record[NAME_COLUMN];
        if (nameHeader && isNumericName(nameValue)) {
            rowsRejected++;
            issues.error({
                code: CODE.ROW_NUMERIC_NAME,
                message: `fila ${filaOrigen} rechazada en "${archivo}" (${subcontratista}): "${NAME_COLUMN}" es numerico ("${nameValue}") - la hoja probablemente tiene las columnas desplazadas`,
                subcontratista, archivo, hoja: match.name,
                fila: filaOrigen,
                celda: addr(sheetRow, nameHeader.col),
                columna: NAME_COLUMN,
                valor: nameValue,
            });
            continue;
        }

        record.provenance = {
            subcontratista: subcontratista ?? null,
            archivo,
            hoja: match.name,
            filaOrigen,
            celdaAncla: anchor.celda,
        };
        rows.push(record);
    }

    // ---- missing canonical columns, with the affected row count ------------
    const missingColumns = CANONICAL.filter(name => !headerMap[name]);
    for (const name of missingColumns) {
        // A FORMAT-VERSION SIGNAL, not a row problem. HPT is the live case: the older
        // input format (src/Formato Reporte subcontratas.xlsx) stops at TIPO DE
        // CONTRATO LABORAL, and HPT is the "# Horas" measure on CJ Y EPC - 985,872
        // hours in FEBRERO_2026 - so a whole-file miss silently subtracts that
        // company's hours from a compliance figure (BUG-55).
        issues.warning({
            code: CODE.COLUMN_MISSING,
            message: `columna "${name}" ausente en "${archivo}" (${subcontratista}) - nula en ${rows.length} fila(s)`,
            subcontratista, archivo, hoja: match.name, columna: name,
            detalle: { filasAfectadas: rows.length, senalDeVersion: true },
        });
    }

    return {
        ok: true,
        rows,
        provenance: base,
        headerMap,
        anchor: {
            celda: anchor.celda,
            fila: anchor.row + 1,
            columna: anchor.col,
            filaIndex: anchor.row,
            left: anchor.left,
            right: anchor.right,
            rangoEncabezados: `${addr(anchor.row, anchor.left)}:${addr(anchor.row, anchor.right)}`,
            rangoDatos: readRange,
        },
        missingColumns,
        unrecognizedHeaders,
        stats: { rowsFound, rowsRejected, rowsReturned: rows.length, blankRows },
    };
}

module.exports = {
    readWorkbook,
    matchSheetName,
    isNumericName,
    NUMERIC_NAME_RE,
};

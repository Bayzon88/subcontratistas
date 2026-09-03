"use strict";
/**
 * Single-workbook review. One subcontratista's .xlsx in, a report of what is wrong with
 * it out - and nothing written anywhere.
 *
 * This is the first half of `run.js` and none of the second. The flow there is
 *
 *     zip -> walk -> readWorkbook -> parseRow -> dedupe -> consolidated -> metrics
 *                                                       -> template -> runReport
 *
 * and everything from `consolidated` rightwards is what produces a deliverable. A review
 * answers "would this file survive the pipeline?", so it stops at `dedupe` and reports the
 * IssueList that the run would have collected. Three consequences worth stating, because
 * they are the reason this module exists rather than a flag on runPipeline():
 *
 * 1. NO SINGLE FLIGHT. run.js refuses a concurrent run because the template round-trip
 *    peaks near 944 MB RSS (config.ALLOW_CONCURRENT_RUNS). A review never opens the
 *    template, so it costs one workbook's worth of memory and must NOT take that lock -
 *    otherwise reviewing a file would block the monthly consolidation, and vice versa.
 *
 * 2. NOTHING IS WRITTEN. No run dir, no output dir, no report, no run.json. The caller
 *    owns the uploaded temp file and deletes it; this module only reads.
 *
 * 3. THE PERIOD IS STILL AN ARGUMENT. Date plausibility is checked against the period, so
 *    a review needs one for its answers to mean anything. No clock is read here, for the
 *    same reason run.js reads none: the answer must depend on the input alone.
 *
 * The issue codes, severities and messages are the pipeline's own - a review reports
 * exactly what the run would report, because it runs the same code.
 */

const path = require("node:path");

const { IssueList, SEVERITY, SEVERITY_ORDER } = require("./issues");
const { parsePeriod } = require("./period");
const { readWorkbook } = require("./workbook");
const { createRowParser } = require("./schema");
const { dedupe, conservationCheck, KEY_COLUMN_BY_MODE } = require("./dedupe");
const config = require("../config");

/**
 * In a real run the subcontratista's identity is the folder name inside the zip
 * (zip.js walkInput). A review receives a bare file with no folder around it, so the
 * filename stem stands in. It is only a label: it appears in issue messages and is the
 * dedupe scope's subcontratista, which for a single workbook groups everything together
 * either way.
 */
function subcontratistaFromFilename(name) {
    const base = path.basename(String(name || ""), path.extname(String(name || "")));
    const trimmed = base.trim();
    return trimmed === "" ? "(sin nombre)" : trimmed;
}

/** Severity ranking, so the report can lead with the worst thing in the file. */
function worstSeverity(issues) {
    let worst = null;
    for (const item of issues.items) {
        if (worst === null || SEVERITY_ORDER.indexOf(item.severity) > SEVERITY_ORDER.indexOf(worst)) {
            worst = item.severity;
        }
    }
    return worst;
}

/* ------------------------------------------------------------------ *
 * Donde mirar en el Excel
 *
 * Every issue already carries `fila`, `celda` and `columna` - the pipeline records them
 * so the Errores sheet can point at a cell. What it does not carry is a sentence an
 * operator can act on without knowing the pipeline's vocabulary, and a duplicate carries
 * only the winning row, addressed at the anchor cell (A1) rather than at the column the
 * duplication is in. Both are fixed here, in the review, rather than in the pipeline:
 * run.js writes these same issues into a spreadsheet whose wording the client already
 * reads, and a review is free to say it differently.
 * ------------------------------------------------------------------ */

/** "E1" -> "E". The header cell already carries the column letters, so a data cell is
 *  those letters plus the row - no index-to-letter arithmetic, and no way to disagree
 *  with the addressing the rest of the pipeline uses. */
function letrasDe(celdaEncabezado) {
    const m = /^([A-Z]+)/.exec(String(celdaEncabezado || ""));
    return m ? m[1] : null;
}

function celdaEn(headerMap, columna, fila) {
    const h = headerMap && headerMap[columna];
    const letras = h ? letrasDe(h.celda) : null;
    return letras && Number.isInteger(fila) ? `${letras}${fila}` : null;
}

/**
 * Duplicates under one identity mode, with a real cell per copy.
 *
 * The consolidation collapses on ONE key (config.IDENTITY_KEY). A review is diagnostic,
 * so it reports the other one too: two rows sharing a DNI are worth seeing even when the
 * run keys on names and would ship both. `colapsa` says which is which, so the report
 * never implies the consolidation does something it does not.
 *
 * The issues raised by this pass are DISCARDED. They would otherwise double the counts
 * in the summary, and the primary pass has already reported the collapse the run performs.
 */
function duplicadosPorModo(records, modo, { headerMap, scope, colapsa }) {
    const columna = KEY_COLUMN_BY_MODE[modo] || null;
    const { collapsed } = dedupe(records, { mode: modo, scope, issues: new IssueList() });

    return collapsed.map((g) => ({
        modo,
        columna,
        colapsa,
        clave: g.key,
        copias: g.copies,
        // The pipeline addresses every source at the anchor cell, which is right for the
        // Errores sheet and useless for "go look here": the cell that matters is the one
        // in the identity column of each duplicated row.
        ubicaciones: (g.sources || [])
            .map((s) => ({ fila: s.fila, celda: celdaEn(headerMap, columna, s.fila) }))
            .filter((u) => u.fila !== null && u.fila !== undefined)
            .sort((a, b) => a.fila - b.fila),
        conflictos: g.conflicts || [],
    }));
}

/** Codes that name a cell and read better as plain Spanish than as pipeline vocabulary. */
const TEXTO_POR_CODIGO = {
    REQUIRED_MISSING: (i) => `Falta ${i.columna}`,
    DATE_UNPARSEABLE: (i) => `No se entiende la fecha de ${i.columna}`,
    DATE_IMPLAUSIBLE: (i) => `Fecha fuera de rango en ${i.columna}`,
    DATE_TWO_DIGIT_YEAR: (i) => `Ano de dos digitos en ${i.columna}`,
    DATE_FRACTIONAL_TRUNCATED: (i) => `Fecha con hora en ${i.columna}`,
    CODE_OUT_OF_DOMAIN: (i) => `Codigo no valido en ${i.columna}`,
    RUC_CHECK_DIGIT: () => "RUC con digito verificador incorrecto",
    RUC_FORMAT: () => "RUC mal formado",
    DNI_LENGTH: (i) => `DNI con largo invalido en ${i.columna}`,
    ROW_NUMERIC_NAME: (i) => `${i.columna} tiene un numero en vez de un nombre`,
    TEXT_NORMALIZED: (i) => `Se limpio el texto de ${i.columna}`,
    ROW_EMPTY: () => "Fila vacia",
    COLUMN_MISSING: (i) => `Falta la columna ${i.columna} en todo el archivo`,
    HEADER_DUPLICATE: (i) => `Encabezado repetido: ${i.columna}`,
    HEADER_UNRECOGNIZED: (i) => `Encabezado no reconocido: ${i.columna}`,
};

/** " (\"X\")" when there was an offending value worth quoting. */
function conValor(i) {
    if (i.valor === null || i.valor === undefined || i.valor === "") return "";
    return ` (valor: "${String(i.valor).slice(0, 60)}")`;
}

/**
 * Codes that carry a row but are not something to go and fix.
 *
 * ANCHOR_FOUND records where the header row was found - it is row 1 of every readable
 * file and belongs in the detail, not in a list of corrections. DUPLICATE_COLLAPSED is
 * covered by `duplicados`, which names every row involved instead of only the winner;
 * leaving it here would print the same duplicate twice, once in pipeline vocabulary.
 */
const NO_ES_CORRECCION = new Set(["ANCHOR_FOUND", "DUPLICATE_COLLAPSED"]);

/**
 * Take the file's own name out of a message.
 *
 * The pipeline embeds the filename so the Errores sheet can say WHICH subcontratista
 * failed - right for a run over many files. A review is one file the operator just
 * picked, so the name adds nothing and can be enormous ("Copia de Formato de Reporte de
 * Headcount -2026_...xlsx"); every line would carry it. It is replaced by "el archivo".
 *
 * Only the review does this - the Errores sheet keeps the name. Literal string replaces,
 * not regex, so a filename with dots or parentheses cannot break the pattern. The
 * subcontratista label goes too: in a review it is the filename stem, the same thing.
 */
function limpiarMensaje(message, { archivo, subcontratista }) {
    let m = String(message === null || message === undefined ? "" : message);
    const a = archivo ? String(archivo) : "";
    const s = subcontratista ? String(subcontratista) : "";
    if (a && s) {
        // Forma "SUBCONTRATA/archivo.xlsx:12" que usa el mensaje de duplicados. La celda
        // ya se muestra en la tabla de Duplicados; aqui basta con la fila.
        m = m.split(`${s}/${a}:`).join("fila ");
        m = m.split(`${s}/${a}`).join("el archivo");
    }
    if (a) {
        m = m.split(` (${a})`).join("");                       // el nombre entre parentesis
        m = m.split(`el archivo "${a}"`).join("el archivo");    // evita "el archivo el archivo"
        m = m.split(`"${a}"`).join("el archivo");
    }
    if (s) {
        m = m.split(` del subcontratista "${s}"`).join("");
        m = m.split(` (${s})`).join("");
    }
    return m;
}

/** Where to look, in Spanish, one line per thing to fix, ordered by row. */
function ubicacionesDe(items, duplicados, headerMap) {
    const salida = [];

    for (const i of items) {
        // Sin fila no hay donde mirar: eso es un problema del archivo entero y ya sale en
        // el veredicto y en el detalle.
        if (i.fila === null || i.fila === undefined) continue;
        if (NO_ES_CORRECCION.has(i.code)) continue;

        const hacer = TEXTO_POR_CODIGO[i.code];
        const base = hacer ? hacer(i) : i.message;
        const celda = i.celda || celdaEn(headerMap, i.columna, i.fila);
        salida.push({
            fila: i.fila,
            celda,
            columna: i.columna,
            severity: i.severity,
            code: i.code,
            texto: `${base} en la fila ${i.fila}${celda ? ` (celda ${celda})` : ""}${conValor(i)}.`,
        });
    }

    for (const d of duplicados) {
        if (d.ubicaciones.length === 0) continue;
        const filas = d.ubicaciones.map((u) => u.fila).join(" y ");
        const celdas = d.ubicaciones.map((u) => u.celda).filter(Boolean).join(", ");
        const que = d.modo === "dni" ? "El DNI" : "El nombre";
        const cola = d.colapsa
            ? "La consolidacion dejaria una sola de esas filas."
            : "La consolidacion NO las une, porque agrupa por otra columna: revise si son la misma persona.";
        salida.push({
            fila: d.ubicaciones[0].fila,
            celda: d.ubicaciones[0].celda,
            columna: d.columna,
            severity: d.colapsa ? "WARNING" : "ERROR",
            code: "DUPLICADO",
            texto: `${que} "${d.clave}" se repite en las filas ${filas}`
                + `${celdas ? ` (celdas ${celdas})` : ""}, columna ${d.columna}. ${cola}`,
        });
    }

    return salida.sort((a, b) => a.fila - b.fila || String(a.celda).localeCompare(String(b.celda)));
}

/**
 * Review one workbook.
 *
 * @param {string} filePath absolute path to the .xlsx
 * @param {object} o
 * @param {string} o.period the report period, "YYYY-MM". Required - see rule 3 above.
 * @param {string} [o.subcontratista] label for the source; defaults to the filename stem
 * @param {string} [o.archivo] filename to show in the report; defaults to basename
 * @param {string} [o.identityKey] dedupe key mode; defaults to config.IDENTITY_KEY
 * @param {string} [o.dedupeScope] dedupe scope; defaults to the pipeline's own default
 * @returns {object} the review report - see the return statement for the shape
 */
function reviewWorkbook(filePath, o = {}) {
    const issues = new IssueList();

    // Before the file is opened, exactly as run.js does it: a bad period is a bad request,
    // not a defect in the workbook, and must not be reported as one.
    const period = parsePeriod(o.period);

    const archivo = o.archivo || path.basename(filePath);
    const subcontratista = o.subcontratista || subcontratistaFromFilename(archivo);

    // `archivo` rather than the temp file's name: the uploaded file on disk is called
    // something like tmp-1-1788408375827, and every issue message embeds this name.
    const read = readWorkbook(filePath, { subcontratista, archivo, issues });

    // readWorkbook has already appended a FAILED issue naming the file and the reason.
    // There are no rows to parse and no duplicates to find, but the report is still a
    // report - the operator needs the reason, not an empty page.
    if (!read.ok) {
        return report({
            ok: false,
            subcontratista,
            archivo,
            period,
            issues,
            items: issues.items.map((i) => ({
                ...i, message: limpiarMensaje(i.message, { archivo, subcontratista }),
            })),
            stats: { filasLeidas: 0, filasRechazadas: 0, filasColapsadas: 0, filasAceptadas: 0, filasEnBlanco: 0 },
            columnas: { faltantes: read.missingColumns, noReconocidas: [] },
            duplicados: [],
            ubicaciones: [],
            conservacion: null,
        });
    }

    // One compiled schema per workbook, as in run.js: headerMap gives every issue a real
    // source cell address, and provenance carries the 1904 date system flag.
    const parser = createRowParser({
        period,
        issues,
        headerMap: read.headerMap,
        missingColumns: read.missingColumns,
        provenance: read.provenance,
        date1904: read.provenance.date1904,
    });

    const accepted = [];
    let schemaRejected = 0;
    for (const raw of read.rows) {
        const parsed = parser.parseRow(raw);
        if (!parsed.ok) { schemaRejected++; continue; }
        accepted.push(parsed.record);
    }

    // The key is computed AFTER normalization (BUG-21), which is why this runs on
    // `accepted` records and not on raw rows.
    const modo = o.identityKey || config.IDENTITY_KEY;
    const deduped = dedupe(accepted, { mode: modo, scope: o.dedupeScope, issues });

    // Both identity keys are reported. The run collapses on one of them; the other is
    // still something the operator has to look at - two rows with the same DNI under
    // different names is a data error whether or not this month's key happens to catch it.
    const otro = modo === "dni" ? "name" : "dni";
    const duplicados = [
        ...duplicadosPorModo(accepted, modo, {
            headerMap: read.headerMap, scope: o.dedupeScope, colapsa: true,
        }),
        ...duplicadosPorModo(accepted, otro, {
            headerMap: read.headerMap, scope: o.dedupeScope, colapsa: false,
        }),
    ];

    const itemsLimpios = issues.items.map((i) => ({
        ...i, message: limpiarMensaje(i.message, { archivo, subcontratista }),
    }));

    const filasRechazadas = read.stats.rowsRejected + schemaRejected;
    const conservacion = conservationCheck({
        read: read.stats.rowsFound,
        rejected: filasRechazadas,
        collapsed: deduped.stats.rowsCollapsed,
        written: deduped.kept.length,
    });

    return report({
        ok: true,
        subcontratista,
        archivo,
        period,
        issues,
        stats: {
            filasLeidas: read.stats.rowsFound,
            filasRechazadas,
            filasColapsadas: deduped.stats.rowsCollapsed,
            filasAceptadas: deduped.kept.length,
            filasEnBlanco: read.stats.blankRows,
        },
        columnas: {
            faltantes: read.missingColumns,
            noReconocidas: read.unrecognizedHeaders,
        },
        duplicados,
        ubicaciones: ubicacionesDe(itemsLimpios, duplicados, read.headerMap),
        items: itemsLimpios,
        conservacion,
    });
}

/** Assemble the report. Kept in one place so both exits produce the same shape. */
function report(o) {
    return {
        ok: o.ok,
        // FAILED means the run would ship an incomplete report and say so loudly; for a
        // single file it means this workbook contributes nothing until it is fixed.
        bloqueante: o.issues.hasBlockingIssues(),
        peorSeveridad: worstSeverity(o.issues),
        subcontratista: o.subcontratista,
        archivo: o.archivo,
        periodo: o.period.key,
        stats: o.stats,
        columnas: o.columnas,
        duplicados: o.duplicados,
        // Donde mirar en el Excel, ordenado por fila. Es lo primero que muestra la pagina.
        ubicaciones: o.ubicaciones,
        conservacion: o.conservacion,
        resumen: {
            porSeveridad: o.issues.counts(),
            porCodigo: o.issues.countsByCode(),
            total: o.issues.length,
        },
        // Mensajes ya sin el nombre del archivo; los conteos de arriba siguen saliendo del
        // IssueList completo, que no depende del texto.
        issues: o.items,
    };
}

module.exports = { reviewWorkbook, subcontratistaFromFilename, SEVERITY };

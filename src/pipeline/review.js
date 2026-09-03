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
const { dedupe, conservationCheck } = require("./dedupe");
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
            stats: { filasLeidas: 0, filasRechazadas: 0, filasColapsadas: 0, filasAceptadas: 0, filasEnBlanco: 0 },
            columnas: { faltantes: read.missingColumns, noReconocidas: [] },
            duplicados: [],
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
    const deduped = dedupe(accepted, {
        mode: o.identityKey || config.IDENTITY_KEY,
        scope: o.dedupeScope,
        issues,
    });

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
        duplicados: deduped.collapsed,
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
        conservacion: o.conservacion,
        resumen: {
            porSeveridad: o.issues.counts(),
            porCodigo: o.issues.countsByCode(),
            total: o.issues.length,
        },
        issues: o.issues.items,
    };
}

module.exports = { reviewWorkbook, subcontratistaFromFilename, SEVERITY };

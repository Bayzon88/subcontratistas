"use strict";
/**
 * The orchestrator. Everything else - `src/cli.js`, `src/server.js` - is a wrapper around
 * `runPipeline()` (05-implementation-plan.md §2.1, §2.3).
 *
 * The flow is 05 §2.2, in order:
 *
 *   input (.zip or an already-extracted folder)
 *     -> zip.js        extractZip into a per-run temp dir, or walk the folder directly
 *     -> zip.js        walkInput -> [{subcontratista, folder, file, archivo}]
 *     -> workbook.js   readWorkbook per file (sheet match, RUC anchor, headers, provenance)
 *     -> schema.js     parseRow per row (dates, codes, identity, text)
 *     -> dedupe.js     collapse on the canonical key, computed AFTER normalization
 *     -> consolidated  ReporteConsolidado - the diffable intermediate
 *     -> metrics.js    the side-car JSON the determinism criteria are asserted on
 *     -> template.js   inject A:R + the five Option-D literals into template-v2.xlsx
 *                      (which runs ooxml.js's patch and the structural verification itself)
 *     -> runReport.js  the Errores sheet (inside the workbook) + run.json beside it
 *
 * and the per-run temp directory is removed in a `finally` on EVERY path.
 *
 * Five rules this module exists to hold:
 *
 * 1. THE PERIOD IS AN ARGUMENT. `parsePeriod` runs before a single file is opened, and no
 *    clock is consulted anywhere on the primary path. The one wall-clock read in this file
 *    is `legacyOutputName()`, which exists only to LOCATE and PROTECT the file the old
 *    pipeline names from `new Date()` in shadow mode - it never names a delivered artifact.
 *
 * 2. LOUD FAILURE, NEVER SILENT LOSS (05 §1 principle 4). A subcontratista whose workbook
 *    cannot be read gets a FAILED issue, is named in `stats.subcontratistas.fallidos`, and
 *    is named again at the top of the Errores sheet that ships inside the workbook. The run
 *    continues - the operator gets every problem in one pass - but the report says, in the
 *    sheet the operator opens, that it is incomplete.
 *
 * 3. NOTHING IS RETAINED (05 §7 step 9). No archivo/, no input corpus, no run history on
 *    disk beyond the Errores sheet and the side-car JSON that ship inside the month's
 *    output. The temp directory goes in the `finally`, success or failure.
 *
 * 4. CONSERVATION. `leidas - rechazadas - colapsadas = escritas` is asserted here and a
 *    mismatch becomes a FAILED issue, so it lands at the top of the Errores sheet instead
 *    of being an inconsistency nobody reads (03 §9 AC 7).
 *
 * 5. SINGLE-FLIGHT. The template round-trip peaks near 944 MB RSS; two at once OOM the pm2
 *    box. A second run is refused, not queued (see "Single flight" below).
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const config = require("../config");
const { IssueList, SEVERITY, CODE } = require("./issues");
const { parsePeriod } = require("./period");
const { extractZip, walkInput, makeRunDir, removeRunDir } = require("./zip");
const { readWorkbook } = require("./workbook");
const { createRowParser } = require("./schema");
const { dedupe, conservationCheck } = require("./dedupe");
const { readLookups, reportLookupDefects } = require("./lookups");
const { unparseableDatesFromIssues } = require("../output/computed");
const { writeConsolidated } = require("../output/consolidated");
const { computeMetrics, serialize, metricsFilename } = require("../output/metrics");
const { writeReport } = require("../output/template");
const { buildErroresSheet, buildRunLog, checkFolderNames } = require("../output/runReport");

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/** Caller / environment errors. A DATA problem is never one of these - it is an issue. */
const RUN_ERROR = Object.freeze({
    BAD_ARGUMENT: "BAD_ARGUMENT",
    INPUT_NOT_FOUND: "INPUT_NOT_FOUND",
    INPUT_UNSUPPORTED: "INPUT_UNSUPPORTED",
    BUSY: "BUSY",
    NO_RECORDS: "NO_RECORDS",
});

class RunError extends Error {
    constructor(code, message, detail) {
        super(message);
        this.name = "RunError";
        this.code = code;
        if (detail !== undefined) this.detail = detail;
    }
}

function fail(code, message, detail) {
    throw new RunError(code, message, detail);
}

/* ------------------------------------------------------------------ *
 * Progress
 * ------------------------------------------------------------------ */

/**
 * The phases `onProgress({phase, current, total, message})` reports. A plain callback:
 * no EventEmitter, no dependency, nothing for `server.js` to unsubscribe from. The server
 * turns these into SSE lines; the CLI prints them; the tests collect them.
 */
const PHASE = Object.freeze({
    INICIO: "inicio",
    EXTRACCION: "extraccion",
    RECORRIDO: "recorrido",
    LECTURA: "lectura",
    DEDUPE: "dedupe",
    CONSOLIDADO: "consolidado",
    METRICAS: "metricas",
    REPORTE: "reporte",
    RUNLOG: "runlog",
    SHADOW: "shadow",
    LIMPIEZA: "limpieza",
    FIN: "fin",
});

/** A callback that throws is the caller's bug and must not take the month's run with it. */
function progressEmitter(onProgress) {
    if (typeof onProgress !== "function") return () => { };
    return (phase, current, total, message) => {
        try {
            onProgress({ phase, current, total, message });
        } catch (err) {
            process.stderr.write(`run.js: onProgress lanzo una excepcion y fue ignorada: ${err && err.message}\n`);
        }
    };
}

/* ------------------------------------------------------------------ *
 * Single flight
 * ------------------------------------------------------------------ */

/**
 * Two guards, because the server may call `runPipeline()` in-process OR fork `src/cli.js`
 * (05 §2.3) and only one of them is visible to a module-level flag:
 *
 *   - `CURRENT`, an in-process flag, refuses a second concurrent call in this process;
 *   - a `run.lock` file under `config.TMP_ROOT` carrying the owner's pid refuses a second
 *     run from another process. A lock whose pid is gone is stale and is reclaimed, so a
 *     killed run does not brick the next one - which is the failure mode BUG-44 already
 *     taught this app once.
 *
 * `config.ALLOW_CONCURRENT_RUNS = true` disables both. It is false for a reason: the
 * template round-trip peaks near 944 MB RSS (912 ms to open, 1,306 ms to write).
 */
let CURRENT = null;

const LOCK_FILE = () => path.join(config.TMP_ROOT, "run.lock");

/** True while a run holds the guard in THIS process. */
function isRunning() {
    return CURRENT !== null;
}

/** A copy of the in-flight run's descriptor, or null. No clock, no promise handle. */
function currentRun() {
    return CURRENT === null ? null : { ...CURRENT };
}

function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === "EPERM";   // alive, just not ours
    }
}

function acquire(descriptor) {
    if (config.ALLOW_CONCURRENT_RUNS) return () => { };

    if (CURRENT !== null) {
        fail(RUN_ERROR.BUSY,
            `ya hay una corrida en curso (periodo ${CURRENT.period}); el pipeline es de una sola via ` +
            "porque la plantilla consume ~944 MB de RSS y dos a la vez agotan la memoria de la maquina",
            { current: { ...CURRENT } });
    }

    fs.mkdirSync(config.TMP_ROOT, { recursive: true });
    const lock = LOCK_FILE();
    let fd = null;
    for (let attempt = 0; attempt < 2 && fd === null; attempt++) {
        try {
            fd = fs.openSync(lock, "wx");
        } catch (err) {
            if (err.code !== "EEXIST") throw err;
            const owner = readLockPid(lock);
            if (owner !== null && owner !== process.pid && pidAlive(owner)) {
                fail(RUN_ERROR.BUSY,
                    `ya hay una corrida en curso en el proceso ${owner} (${lock}); el pipeline es de una sola via`,
                    { pid: owner, lock });
            }
            // Stale: the owner is gone (or it is us, mid-crash-recovery). Reclaim it.
            fs.rmSync(lock, { force: true });
        }
    }
    if (fd === null) {
        fail(RUN_ERROR.BUSY, `no se pudo tomar el cerrojo ${lock}`, { lock });
    }
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, periodo: descriptor.period }) + "\n");
    fs.closeSync(fd);

    CURRENT = { ...descriptor };
    let released = false;
    return () => {
        if (released) return;
        released = true;
        CURRENT = null;
        try { fs.rmSync(lock, { force: true }); } catch { /* the next run reclaims it */ }
    };
}

function readLockPid(lock) {
    try {
        const parsed = JSON.parse(fs.readFileSync(lock, "utf8"));
        return Number.isInteger(parsed.pid) ? parsed.pid : null;
    } catch {
        return null;   // unreadable or truncated: treat as stale
    }
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** "YYYY-MM" or a parsePeriod descriptor -> the descriptor. Never inferred. */
function resolvePeriod(period) {
    if (typeof period === "string") return parsePeriod(period);
    if (period && typeof period === "object" && typeof period.key === "string") {
        // Re-parse: costs microseconds and guarantees every field the later stages read is
        // present, whatever the caller assembled by hand.
        return parsePeriod(period.key);
    }
    fail(RUN_ERROR.BAD_ARGUMENT,
        'period es obligatorio: "YYYY-MM" o el descriptor de period.parsePeriod(). ' +
        "Nunca se deduce del reloj (05 §1 principio 3)");
    return null;
}

function fileBytes(filePath) {
    try { return fs.statSync(filePath).size; } catch { return null; }
}

/** RFC-4180-ish. The Errores CSV of 03 §8.1, from the same AOA the sheet is built from. */
function erroresCsv(aoa) {
    const cell = (v) => {
        if (v === null || v === undefined) return "";
        const s = typeof v === "string" ? v : String(v);
        return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return aoa.map(row => (Array.isArray(row) ? row : []).map(cell).join(",")).join("\r\n") + "\r\n";
}

function writeJsonFile(filePath, value) {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
    return filePath;
}

/* ------------------------------------------------------------------ *
 * runPipeline
 * ------------------------------------------------------------------ */

/**
 * Consolidate one month.
 *
 * @param {object} o
 * @param {string} o.inputPath          a .zip, or an already-extracted folder. Required.
 * @param {string|object} o.period      "YYYY-MM" or a parsePeriod descriptor. REQUIRED -
 *                                      this is the whole point (03 §6, BUG-16).
 * @param {string} [o.templatePath]     defaults to `config.TEMPLATE` (template-v2.xlsx).
 * @param {string} [o.outDir]           defaults to `config.REPORTES_DIR`.
 * @param {IssueList} [o.issues]        collector; a fresh one is created when omitted.
 * @param {function} [o.onProgress]     `({phase, current, total, message}) => void`.
 * @param {boolean|object} [o.shadow]   parallel-run mode (05 Fase 5 tarea 8, §4.3). See
 *                                      `runShadow` - always sequential, never fatal, and
 *                                      never between the operator and the deliverable.
 * @param {"name"|"dni"} [o.identityKey] dedupe key; defaults to `config.IDENTITY_KEY`.
 * @param {"all"|"subcontratista"} [o.dedupeScope]
 * @param {boolean} [o.writeConsolidated=true]  the diffable intermediate.
 * @param {boolean} [o.writeCsv=true]   the standalone Errores CSV of 03 §8.1.
 * @param {object} [o.zipLimits]        overrides for extractZip's caps.
 * @returns {Promise<{records: object[], issues: IssueList, stats: object, outputs: object}>}
 * @throws {RunError} caller/environment problems only: a bad period, a missing input, a
 *         second concurrent run, or a run that accepted zero workers. Every DATA problem
 *         is an issue, never an exception.
 */
async function runPipeline(o = {}) {
    if (!o || typeof o !== "object") {
        fail(RUN_ERROR.BAD_ARGUMENT, "runPipeline requiere un objeto de opciones");
    }

    // ---- 1. arguments, before a single file is touched --------------------
    // parsePeriod throws here, which is the point: a malformed period must stop the run
    // before anything is read, not produce a report labelled with the wrong month.
    const period = resolvePeriod(o.period);

    if (typeof o.inputPath !== "string" || o.inputPath.trim() === "") {
        fail(RUN_ERROR.BAD_ARGUMENT, "inputPath es obligatorio: un .zip o una carpeta ya extraida");
    }
    const inputPath = path.resolve(o.inputPath);
    let inputStat;
    try {
        inputStat = fs.statSync(inputPath);
    } catch {
        fail(RUN_ERROR.INPUT_NOT_FOUND, `no existe la entrada ${inputPath}`);
    }
    const isZip = inputStat.isFile();
    if (isZip && path.extname(inputPath).toLowerCase() !== ".zip") {
        fail(RUN_ERROR.INPUT_UNSUPPORTED,
            `la entrada ${inputPath} no es un .zip ni una carpeta`);
    }

    const templatePath = o.templatePath || config.TEMPLATE;
    const outDir = o.outDir || config.REPORTES_DIR;
    const issues = o.issues && typeof o.issues.add === "function" ? o.issues : new IssueList();
    const identityKey = o.identityKey || config.IDENTITY_KEY;
    const emit = progressEmitter(o.onProgress);
    const shadowOpt = o.shadow === true ? {} : (o.shadow && typeof o.shadow === "object" ? o.shadow : null);

    const release = acquire({ period: period.key, inputPath, outDir });
    let runDir;
    try {
        runDir = makeRunDir("run-");
    } catch (err) {
        release();          // the guard must not outlive the run it was taken for
        throw err;
    }
    const result = {
        records: [],
        issues,
        stats: null,
        outputs: {
            reporte: null,
            metricas: null,
            consolidado: null,
            runLog: null,
            erroresCsv: null,
            shadow: null,
        },
    };
    const started = process.hrtime.bigint();
    const sinceStart = () => Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10;

    try {
        emit(PHASE.INICIO, 0, null, `periodo ${period.key}`);

        // ---- 2. lookups, once per run -------------------------------------
        // Opt-in because readLookups is cached and cannot report from inside the cache
        // (lookups.js says so explicitly: "the caller (run.js) calls this once per run").
        const lookups = readLookups(templatePath);
        reportLookupDefects(lookups, issues);

        // ---- 3. input -> the ordered list of workbooks ---------------------
        let walkRoot = inputPath;
        let extraction = null;
        if (isZip) {
            emit(PHASE.EXTRACCION, 0, null, path.basename(inputPath));
            const dest = path.join(runDir, "entrada");
            extraction = extractZip(inputPath, dest, issues, o.zipLimits || {});
            walkRoot = dest;
        }

        emit(PHASE.RECORRIDO, 0, null, walkRoot);
        const walk = walkInput(walkRoot, issues);
        const walkSummary = walk.summary || null;
        const total = walk.length;

        // ---- 4. per workbook, per row -------------------------------------
        const workbooks = [];
        const accepted = [];
        const unparseableByRecord = new Map();
        let rowsRead = 0;
        let rowsRejected = 0;

        for (let i = 0; i < walk.length; i++) {
            const entry = walk[i];
            emit(PHASE.LECTURA, i + 1, total, entry.subcontratista);

            const bytes = fileBytes(entry.file);
            const read = readWorkbook(entry.file, { subcontratista: entry.subcontratista, issues });

            if (!read.ok) {
                // NOT a silent omission and NOT the end of the run: readWorkbook already
                // appended a FAILED issue naming the subcontratista, the file and the
                // reason. No row counts are recorded, because "we never got far enough to
                // read a row" is a different fact from "we read zero rows" and the run
                // report must not conflate them.
                workbooks.push({
                    subcontratista: entry.subcontratista,
                    archivo: entry.archivo,
                    ok: false,
                    bytes,
                    provenance: read.provenance,
                });
                continue;
            }

            // One compiled schema per workbook - the intended shape. headerMap gives every
            // issue a real source cell address; provenance survives to the output (AC 5).
            const parser = createRowParser({
                period,
                issues,
                headerMap: read.headerMap,
                missingColumns: read.missingColumns,
                provenance: read.provenance,
                date1904: read.provenance.date1904,
            });

            let wbAccepted = 0;
            let wbSchemaRejected = 0;
            for (const raw of read.rows) {
                const parsed = parser.parseRow(raw);
                if (!parsed.ok) { wbSchemaRejected++; continue; }
                accepted.push(parsed.record);
                wbAccepted++;
                // BUG-08: "no cese date" and "a cese date we could not read" are opposite
                // facts and the record cannot carry the difference - only the issue stream
                // still knows. Captured per row, here, where the row's own issues are in
                // hand, and handed to BOTH template.js and metrics.js so the workbook and
                // the side-car cannot disagree about column AI.
                const unreadable = unparseableDatesFromIssues(parsed.issues);
                if (unreadable.size > 0) unparseableByRecord.set(parsed.record, unreadable);
            }

            rowsRead += read.stats.rowsFound;
            rowsRejected += read.stats.rowsRejected + wbSchemaRejected;

            workbooks.push({
                subcontratista: entry.subcontratista,
                archivo: entry.archivo,
                ok: true,
                bytes,
                provenance: read.provenance,
                anchor: read.anchor,
                headerMap: read.headerMap,
                missingColumns: read.missingColumns,
                // The workbook's own rejections PLUS the schema's, so the per-subcontratista
                // arithmetic in the run report closes: leidas - rechazadas = aceptadas.
                stats: {
                    rowsFound: read.stats.rowsFound,
                    rowsRejected: read.stats.rowsRejected + wbSchemaRejected,
                    rowsReturned: wbAccepted,
                    blankRows: read.stats.blankRows,
                },
            });
        }

        // ---- 5. dedupe, on a key computed AFTER normalization (BUG-21) -----
        emit(PHASE.DEDUPE, total, total, `${accepted.length} filas aceptadas`);
        const deduped = dedupe(accepted, { mode: identityKey, scope: o.dedupeScope, issues });
        const records = deduped.kept;
        result.records = records;

        // ---- 6. conservation (03 §9 AC 7) ---------------------------------
        const conservation = conservationCheck({
            read: rowsRead,
            rejected: rowsRejected,
            collapsed: deduped.stats.rowsCollapsed,
            written: records.length,
        });
        if (!conservation.ok) {
            // Loud, at FAILED, so it lands in the block at the top of the Errores sheet
            // rather than being an inconsistency that only a developer would notice.
            issues.failed({
                code: CODE.CONSERVATION_BROKEN,
                message: `conservacion de filas rota: ${conservation.detail.motivo}`,
                detalle: conservation.detail,
            });
        }

        // 05 §8 Q8 / 03 §8.2: the folder is normally named after the subcontratista; a
        // mismatch is a labelling problem, reported, never a reason to drop anybody.
        const { carpetas } = checkFolderNames(records, issues);

        const failedNames = [...new Set(
            issues.items
                .filter(i => i.severity === SEVERITY.FAILED && i.subcontratista)
                .map(i => i.subcontratista)
        )].sort();

        // The single stats object both runReport.js and metrics.js read (both document
        // that they accept exactly this shape, so the two artifacts cannot drift).
        const reportStats = {
            expected: walkSummary
                ? walkSummary.topLevelFolders + walkSummary.looseFiles
                : walk.length,
            workbooks,
            walk: walkSummary,
            read: rowsRead,
            rejected: rowsRejected,
            dedupe: deduped,
            crossSubcontratista: deduped.crossSubcontratista,
            written: records.length,
            carpetas,
        };

        result.stats = {
            periodo: period.key,
            period,
            entrada: {
                path: inputPath,
                tipo: isZip ? "zip" : "carpeta",
                extraccion: extraction,
                raiz: walkSummary ? walkSummary.root : walkRoot,
            },
            subcontratistas: {
                esperados: reportStats.expected,
                leidos: workbooks.filter(w => w.ok).length,
                fallidos: failedNames.length,
                // NAMED, per 05 §1 principle 4 - a count alone is exactly the silence this
                // rework exists to remove.
                nombres: failedNames,
            },
            archivos: {
                vistos: workbooks.length,
                procesados: workbooks.filter(w => w.ok).length,
                fallidos: workbooks.filter(w => !w.ok).length,
            },
            filas: {
                leidas: rowsRead,
                rechazadas: rowsRejected,
                aceptadas: accepted.length,
                colapsadas: deduped.stats.rowsCollapsed,
                escritas: records.length,
            },
            conservacion: {
                ok: conservation.ok,
                formula: conservation.detail.formula,
                esperado: conservation.expected,
                actual: conservation.actual,
                diferencia: conservation.detail.difference,
                motivo: conservation.detail.motivo,
            },
            dedupe: deduped.stats,
            crossSubcontratista: deduped.crossSubcontratista.length,
            incidencias: issues.counts(),
            walk: walkSummary,
            workbooks,
            tiempos: { lecturaMs: sinceStart() },
        };
        // The object runReport.js and metrics.js were handed, so a caller can re-render
        // either artifact without re-running anything. NON-ENUMERABLE: it holds the whole
        // dedupe result, records included, and `JSON.stringify(stats)` in a log line must
        // not drag five thousand workers into it.
        Object.defineProperty(result.stats, "reportStats", {
            value: reportStats, enumerable: false,
        });

        // ---- 7. a run with nothing to write is a failure, not an empty report
        if (records.length === 0) {
            // The report cannot be written (a zero-row Tabla2 would manufacture the very
            // ghost row 03 §7.2 exists to delete), but the diagnosis still has to reach the
            // operator - so the run log and the CSV are written before we throw.
            writeDiagnosticsOnly(outDir, period, issues, reportStats, result, o);
            fail(RUN_ERROR.NO_RECORDS,
                `no se acepto ningun trabajador para el periodo ${period.key}: ` +
                `${walk.length} archivo(s) recorridos, ${failedNames.length} subcontratista(s) fallidos` +
                (failedNames.length > 0 ? ` (${failedNames.join(", ")})` : "") +
                ". No se genera un reporte vacio.",
                { fallidos: failedNames, runLog: result.outputs.runLog });
        }

        fs.mkdirSync(outDir, { recursive: true });

        // Parallel to `records`, which is the order template.js writes and metrics.js
        // reads. Both accept the array form, so both see the same signal.
        const unparseableDates = records.map(r => unparseableByRecord.get(r) || null);

        // ---- 8. the diffable intermediate ---------------------------------
        if (o.writeConsolidated !== false) {
            emit(PHASE.CONSOLIDADO, 0, null, `${records.length} filas`);
            const consolidated = writeConsolidated(
                records,
                path.join(outDir, `${period.filenameBase}_Consolidado.xlsx`),
                { period, issues });
            result.outputs.consolidado = consolidated.path;
            result.stats.consolidado = {
                path: consolidated.path, filas: consolidated.filas, bytes: consolidated.bytes,
            };
        }

        // ---- 9. the metrics side-car (the determinism gate, AC 26) ---------
        emit(PHASE.METRICAS, 0, null, period.key);
        const metrics = computeMetrics(records, {
            period,
            lookups,
            issues,
            stats: reportStats,
            unparseableDates,
            identityKey,
        });
        const metricsPath = path.join(outDir, metricsFilename(period));
        fs.writeFileSync(metricsPath, serialize(metrics));
        result.outputs.metricas = metricsPath;
        // The eight headline metrics of 03 §7.4, so a caller can show the numbers without
        // re-reading the file it just wrote.
        result.stats.metricas = metrics.metricas || null;

        // ---- 10. the report -----------------------------------------------
        // The Errores sheet is built from everything collected up to this point and is
        // injected INTO the workbook (03 §8.1: it travels with the report). Issues raised
        // by template.js / ooxml.js themselves land afterwards, in run.json.
        const erroresSheet = buildErroresSheet(issues, reportStats, period);

        emit(PHASE.REPORTE, 0, null, period.filename);
        const report = await writeReport(records, {
            period,
            issues,
            lookups,
            templatePath,
            outPath: path.join(outDir, period.filename),
            erroresSheet,
            unparseableDates,
        });
        result.outputs.reporte = report.path;
        result.stats.reporte = {
            path: report.path,
            bytes: report.bytes,
            filas: report.filas,
            tabla: report.tabla,
            celdas: report.celdas,
            tiempos: report.tiempos,
            rssPicoBytes: report.rssPicoBytes,
            verificacion: report.verificacion,
        };

        // ---- 11. run.json + the standalone CSV ----------------------------
        emit(PHASE.RUNLOG, 0, null, "run.json");
        const runLog = buildRunLog(issues, reportStats, period);
        result.outputs.runLog = writeJsonFile(
            path.join(outDir, `${period.filenameBase}_run.json`), runLog);
        if (o.writeCsv !== false) {
            // Rebuilt rather than reusing `erroresSheet`: this one is written AFTER the
            // workbook, so it also carries whatever template.js and ooxml.js reported while
            // writing it. The CSV is a superset of the sheet inside the workbook, never a
            // subset - the operator's copy is the one that can be short, and it is the one
            // that ships with the deliverable.
            const csvPath = path.join(outDir, `${period.filenameBase}_Errores.csv`);
            fs.writeFileSync(csvPath, erroresCsv(buildErroresSheet(issues, reportStats, period)));
            result.outputs.erroresCsv = csvPath;
        }
        result.stats.resumen = runLog.resumen || null;
        result.stats.incidencias = issues.counts();

        // ---- 12. shadow mode ----------------------------------------------
        // AFTER the primary has finished and released its memory (05 §4.3 mechanic 1).
        // Sequential, never concurrent; never fatal; never touches the deliverable.
        if (shadowOpt) {
            emit(PHASE.SHADOW, 0, null, "pipeline antiguo");
            result.outputs.shadow = await runShadow({
                extractedRoot: walkSummary ? walkSummary.root : walkRoot,
                runDir,
                outDir,
                period,
                primaryPath: report.path,
                sidecar: metricsPath,
                options: shadowOpt,
                emit,
            });
            result.stats.shadow = {
                ok: result.outputs.shadow.ok,
                error: result.outputs.shadow.error,
                diff: result.outputs.shadow.diff ? result.outputs.shadow.diff.path : null,
                // null when the diff did not run; true means an UNEXPECTED divergence and
                // a blocked cutover (05 §4.5).
                bloquea: result.outputs.shadow.diff ? result.outputs.shadow.diff.bloquea : null,
            };
        }

        result.stats.tiempos.totalMs = sinceStart();
        emit(PHASE.FIN, total, total, report.path);
        return result;
    } finally {
        // 05 §7 step 9 / BUG-43 / BUG-44: on EVERY path, success or failure, and awaited
        // (rmSync) rather than fired into a callback that races the report.
        emit(PHASE.LIMPIEZA, 0, null, runDir);
        let cleanupError = null;
        try {
            removeRunDir(runDir);
        } catch (err) {
            cleanupError = err;
            process.stderr.write(`run.js: no se pudo borrar el directorio temporal ${runDir}: ${err.message}\n`);
        }
        if (result.stats) {
            result.stats.limpieza = {
                runDir,
                ok: cleanupError === null && !fs.existsSync(runDir),
                error: cleanupError ? cleanupError.message : null,
            };
        }
        release();
    }
}

/**
 * A run that accepted nobody still owes the operator the reasons. Best-effort: a failure
 * here must not replace the NO_RECORDS error with an I/O one.
 */
function writeDiagnosticsOnly(outDir, period, issues, reportStats, result, o) {
    try {
        fs.mkdirSync(outDir, { recursive: true });
        result.outputs.runLog = writeJsonFile(
            path.join(outDir, `${period.filenameBase}_run.json`),
            buildRunLog(issues, reportStats, period));
        if (o.writeCsv !== false) {
            const csvPath = path.join(outDir, `${period.filenameBase}_Errores.csv`);
            fs.writeFileSync(csvPath, erroresCsv(buildErroresSheet(issues, reportStats, period)));
            result.outputs.erroresCsv = csvPath;
        }
    } catch (err) {
        process.stderr.write(`run.js: no se pudo escribir el diagnostico de una corrida vacia: ${err.message}\n`);
    }
}

/* ------------------------------------------------------------------ *
 * Shadow mode - 05 Fase 5 tarea 8, §4.3; 03 §9 AC 28
 * ------------------------------------------------------------------ */

/**
 * The old pipeline's hard-coded paths. `excelConsolidation.js` and `excelReporting.js` are
 * NOT edited (05 §1 principle 2) - they are adapted around:
 *
 *   - `consolidateExcelFile(name)` reads `src/subcontratistas/<name>/<carpeta>/<archivo>`,
 *     so the run's extraction is exposed there as a SYMLINK. `fs.rm` on a symlink unlinks
 *     the link and never follows it, so the old pipeline's own (async, unawaited, racy)
 *     cleanup cannot reach the real folder.
 *   - it writes `src/ReporteConsolidado.xlsx` unconditionally - backed up and restored.
 *   - `writeDataToWorksheet("template.xlsx")` derives its output name from `new Date()`
 *     (`getMonthAndYear()`, two months back, with a December special case). We cannot pass
 *     a name in, so the produced file is LOCATED by diffing the directory listing and then
 *     moved into the run's temp directory - where the `finally` deletes it with everything
 *     else. Nothing of the shadow run survives except the diff.
 *   - it swallows its own errors and returns normally, so the output is verified by hand.
 *   - `console.clear()` at excelConsolidation.js:284 wipes the server's terminal; it is
 *     stubbed for the duration and restored, and the old pipeline's console output is
 *     captured instead - `"Error with: <carpeta>"` is the only diagnostic it emits.
 */
const OLD_STAGING_ROOT = path.join(config.SRC, "subcontratistas");
const OLD_CONSOLIDADO = path.join(config.SRC, "ReporteConsolidado.xlsx");
const OLD_REPORTES = path.join(config.SRC, "reportes");
const OLD_TEMPLATE_ARG = "template.xlsx";
const DIFF_TOOL = path.join(config.ROOT, "tools", "diff-reports.js");
const MAX_CAPTURED_LINES = 500;

/**
 * Run the OLD pipeline over the same already-extracted folder and diff the two workbooks.
 *
 * Three hard constraints, all structural rather than aspirational:
 *   1. SEQUENTIAL - this is called after `writeReport` has returned and its ~944 MB
 *      workbook is unreachable. Nothing here runs concurrently with the primary.
 *   2. NEVER FATAL - every path returns an object; nothing throws.
 *   3. THE DELIVERABLE IS UNTOUCHABLE - the primary report is copied aside before the old
 *      pipeline runs and restored if the old pipeline's clock-derived filename collides
 *      with it, which it does whenever the requested period happens to be two months back.
 *
 * @returns {Promise<object>} never throws
 */
async function runShadow({ extractedRoot, runDir, outDir, period, primaryPath, sidecar, options, emit }) {
    const result = {
        ok: false,
        modo: "paralelo",
        path: null,
        diff: null,
        salida: [],
        warnings: [],
        error: null,
    };
    const restore = [];
    const shadowDir = path.join(runDir, "shadow");

    try {
        fs.mkdirSync(shadowDir, { recursive: true });
        fs.mkdirSync(OLD_STAGING_ROOT, { recursive: true });
        fs.mkdirSync(OLD_REPORTES, { recursive: true });

        // --- expose the extraction where the old pipeline hard-codes it ----
        const stageName = `shadow-${crypto.randomBytes(6).toString("hex")}`;
        const stagePath = path.join(OLD_STAGING_ROOT, stageName);
        fs.symlinkSync(extractedRoot, stagePath, "dir");
        restore.push(() => fs.rmSync(stagePath, { force: true, recursive: true }));

        // --- protect the two files the old pipeline overwrites --------------
        const consolidadoBackup = backup(OLD_CONSOLIDADO, path.join(runDir, "old-consolidado.bak"));
        if (consolidadoBackup) restore.push(() => restoreFile(consolidadoBackup, OLD_CONSOLIDADO));
        else restore.push(() => fs.rmSync(OLD_CONSOLIDADO, { force: true }));

        const primaryBackup = backup(primaryPath, path.join(runDir, "primary.bak"));

        const before = snapshot(OLD_REPORTES);
        const expectedLegacy = legacyOutputName();

        // --- run it ---------------------------------------------------------
        emit(PHASE.SHADOW, 1, 3, "consolidando (pipeline antiguo)");
        const captured = captureConsole(result.salida);
        try {
            const { consolidateExcelFile } = require("../excelConsolidation");
            const { writeDataToWorksheet } = require("../excelReporting");
            consolidateExcelFile(stageName);
            emit(PHASE.SHADOW, 2, 3, "generando reporte (pipeline antiguo)");
            await writeDataToWorksheet(OLD_TEMPLATE_ARG);
        } finally {
            captured.restore();
        }

        if (!fs.existsSync(extractedRoot)) {
            // Should be impossible - fs.rm does not follow symlinks - but the primary has
            // already been delivered either way, so this is a report, not a failure mode.
            result.warnings.push(
                `el pipeline antiguo borro la extraccion ${extractedRoot} a traves del enlace simbolico`);
        }

        // --- locate what it produced (its name comes from the wall clock) ---
        const produced = locateProduced(OLD_REPORTES, before, expectedLegacy);
        if (!produced) {
            result.error = "el pipeline antiguo no dejo ningun archivo nuevo en src/reportes "
                + "(writeDataToWorksheet captura sus propios errores y retorna normalmente)";
            return result;
        }

        const producedPath = path.join(OLD_REPORTES, produced.name);
        const shadowPath = path.join(shadowDir, produced.name);
        if (produced.preexisting) {
            // It overwrote a file that was already there and that we did not back up.
            // Copy rather than move: destroying an artifact we never protected would be
            // worse than leaving a stale one behind.
            fs.copyFileSync(producedPath, shadowPath);
            result.warnings.push(
                `el pipeline antiguo sobrescribio ${produced.name}, que ya existia en src/reportes`);
        } else {
            fs.renameSync(producedPath, shadowPath);
        }
        result.path = shadowPath;

        // --- the deliverable, verbatim --------------------------------------
        if (primaryBackup) {
            const changed = !fs.existsSync(primaryPath)
                || fs.statSync(primaryPath).size !== fs.statSync(primaryBackup).size;
            if (changed) {
                restoreFile(primaryBackup, primaryPath);
                result.warnings.push(
                    `el pipeline antiguo escribio sobre ${path.basename(primaryPath)}; `
                    + "se restauro el archivo del pipeline nuevo (es el que se entrega)");
            }
        }

        // --- the diff --------------------------------------------------------
        emit(PHASE.SHADOW, 3, 3, "diff");
        result.diff = await runDiff(shadowPath, primaryPath, options, outDir, period, sidecar);
        result.ok = true;
        return result;
    } catch (err) {
        // A failure in the shadow run is REPORTED and never fails the job (05 §4.3).
        result.error = err && err.stack ? err.stack : String(err);
        process.stderr.write(`run.js: la corrida en paralelo fallo y no afecta al reporte entregado: ${result.error}\n`);
        return result;
    } finally {
        for (const undo of restore.reverse()) {
            try { undo(); } catch (err) { result.warnings.push(`limpieza shadow: ${err.message}`); }
        }
    }
}

/** `Reporte_Subcontratistas_<MES>_<ANIO>.xlsx` exactly as excelReporting.js:69-77 builds it.
 *
 *  THE ONLY WALL-CLOCK READ IN THIS FILE, and it names nothing: it is used to protect a
 *  file that may already exist and as a hint when locating what the old pipeline wrote.
 *  The reproduction is deliberate - including the `getMonth() - 1` that makes it two months
 *  back and the December special case - because the point is to predict the OLD behaviour,
 *  not to correct it. */
function legacyOutputName() {
    const date = new Date();
    const newDate = new Date(date.getFullYear(), date.getMonth() - 1, 1);
    const monthString = newDate.toLocaleString("es-ES", { month: "long" }).toUpperCase();
    const year = monthString === "DICIEMBRE" ? date.getFullYear() - 1 : date.getFullYear();
    return `Reporte_Subcontratistas_${monthString}_${year}.xlsx`;
}

function snapshot(dir) {
    const out = new Map();
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return out; }
    for (const name of names) {
        try {
            const st = fs.statSync(path.join(dir, name));
            out.set(name, { size: st.size, mtimeMs: st.mtimeMs });
        } catch { /* vanished between readdir and stat */ }
    }
    return out;
}

/** New file first; failing that, the one whose bytes changed; the expected name breaks ties. */
function locateProduced(dir, before, expectedName) {
    const after = snapshot(dir);
    const fresh = [...after.keys()].filter(n => !before.has(n));
    if (fresh.length === 1) return { name: fresh[0], preexisting: false };
    if (fresh.length > 1) {
        const hit = fresh.includes(expectedName) ? expectedName : fresh.sort()[0];
        return { name: hit, preexisting: false };
    }
    const touched = [...after.keys()].filter((n) => {
        const b = before.get(n);
        const a = after.get(n);
        return b && a && (b.mtimeMs !== a.mtimeMs || b.size !== a.size);
    });
    if (touched.length === 0) return null;
    const hit = touched.includes(expectedName) ? expectedName : touched.sort()[0];
    return { name: hit, preexisting: true };
}

function backup(from, to) {
    if (!fs.existsSync(from)) return null;
    fs.copyFileSync(from, to);
    return to;
}

function restoreFile(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
}

/**
 * Stub `console.clear()` (excelConsolidation.js:284 wipes the server's terminal) and keep
 * the old pipeline's output instead of losing it - `"Error with: <carpeta>"` at :74 is the
 * entire diagnostic it emits for a subcontratista whose workforce it drops.
 */
function captureConsole(sink) {
    const original = {
        clear: console.clear, log: console.log, info: console.info,
        warn: console.warn, error: console.error,
    };
    const push = (level) => (...args) => {
        if (sink.length >= MAX_CAPTURED_LINES) return;
        sink.push(`${level}: ${args.map(a => (typeof a === "string" ? a : inspectSafe(a))).join(" ")}`);
    };
    console.clear = () => { };
    console.log = push("log");
    console.info = push("info");
    console.warn = push("warn");
    console.error = push("error");
    return {
        restore() {
            console.clear = original.clear;
            console.log = original.log;
            console.info = original.info;
            console.warn = original.warn;
            console.error = original.error;
        },
    };
}

function inspectSafe(value) {
    try { return require("node:util").inspect(value, { depth: 1, breakLength: Infinity }); }
    catch { return String(value); }
}

/**
 * Invoke `tools/diff-reports.js` on the pair and write its report beside the month's
 * output. ARGUMENT ORDER IS (antiguo, nuevo) - the old pipeline's workbook first, which is
 * what the tool documents and what makes "rows only in the new output" mean the RECOVERED
 * subcontratistas (05 §4.4 item 1). The tool is a developer artifact and is not on the
 * pipeline's path, so its absence is reported rather than fatal.
 *
 * Three call shapes, in order of preference:
 *   1. `options.diff(antiguo, nuevo, opciones)` - injected, used by the tests;
 *   2. `require("tools/diff-reports.js").diffReports(antiguo, nuevo, opciones)`, rendered
 *      with the tool's own `formatReport` when it exposes one;
 *   3. `node tools/diff-reports.js <antiguo.xlsx> <nuevo.xlsx> --sidecar … --period …`,
 *      stdout captured - the CLI `npm run diff` already points at.
 *
 * The classified object also lands as `<base>_shadow-diff.json`, and `bloquea` is lifted
 * onto the shadow result: an UNEXPECTED divergence blocks cutover (05 §4.5) and the
 * developer must not have to open a file to find that out.
 */
async function runDiff(oldPath, newPath, options, outDir, period, sidecar) {
    const out = {
        ok: false, herramienta: null, path: null, json: null,
        texto: null, valor: null, bloquea: null, motivo: null,
    };
    const opciones = { sidecar, period: period.key, ...(options.diffOptions || {}) };
    let format = null;

    try {
        if (typeof options.diff === "function") {
            out.herramienta = "inyectada";
            out.valor = await options.diff(oldPath, newPath, opciones);
        } else if (!fs.existsSync(DIFF_TOOL)) {
            out.motivo = `no existe ${DIFF_TOOL} (05 Fase 0 tarea 5); `
                + "la corrida en paralelo produjo los dos libros pero no pudo compararlos";
            return out;
        } else {
            let mod = null;
            try { mod = require(DIFF_TOOL); } catch { mod = null; }
            const fn = typeof mod === "function"
                ? mod
                : (mod && typeof mod.diffReports === "function" ? mod.diffReports : null);
            if (fn) {
                out.herramienta = "modulo";
                if (mod && typeof mod.formatReport === "function") format = mod.formatReport;
                out.valor = await fn(oldPath, newPath, opciones);
            } else {
                out.herramienta = "proceso";
                const argv = [DIFF_TOOL, oldPath, newPath];
                if (sidecar) argv.push("--sidecar", sidecar);
                argv.push("--period", period.key);
                const child = await execFileAsync(
                    process.execPath, argv, { maxBuffer: 64 * 1024 * 1024 });
                out.valor = child.stdout;
            }
        }

        fs.mkdirSync(outDir, { recursive: true });
        if (typeof out.valor === "string") {
            out.texto = out.valor;
        } else {
            if (format) {
                try { out.texto = format(out.valor); } catch { out.texto = null; }
            }
            const json = JSON.stringify(out.valor, null, 2) + "\n";
            if (out.texto === null || out.texto === undefined) out.texto = json;
            out.json = path.join(outDir, `${period.filenameBase}_shadow-diff.json`);
            fs.writeFileSync(out.json, json);
            if (out.valor && typeof out.valor === "object" && out.valor.bloquea !== undefined) {
                out.bloquea = out.valor.bloquea;
            }
        }
        out.path = path.join(outDir, `${period.filenameBase}_shadow-diff.txt`);
        fs.writeFileSync(out.path, out.texto);
        out.ok = true;
        return out;
    } catch (err) {
        out.motivo = err && err.stack ? err.stack : String(err);
        return out;
    }
}

module.exports = {
    runPipeline,

    // the single-flight contract the server refuses a second upload with
    isRunning,
    currentRun,

    RunError,
    RUN_ERROR,
    PHASE,

    // exported for the tests and for the CLI/server, which render the same artifacts
    erroresCsv,
    legacyOutputName,
};

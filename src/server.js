"use strict";
/**
 * The web front door. It owns NO pipeline logic (05-implementation-plan.md §2.1, §2.3):
 * accept the upload, validate it, stage it in a fresh per-run temp directory that a
 * `finally` removes, fork `src/cli.js`, stream its progress to SSE, and hand back a
 * download link to a filename THE SERVER computed.
 *
 * It replaces `src/app.js`, which stays on disk until the cutover (05 §7 step 1) and is
 * still the operator's fallback and the pipeline shadow mode compares against.
 *
 * The defects this file exists to not carry over, each with its old address:
 *
 *   BUG-36/40  `app.js:124` sorts the reports directory with `(a, b) => a.ctime + b.ctime`.
 *              Adding two Dates is not a comparator: it coerces to a string, yields NaN,
 *              and `sort` is a no-op, so `sortedFiles[0]` is whatever `readdirSync`
 *              returned first - alphabetically `Reporte_Subcontratistas_ABRIL_2026.xlsx`.
 *              The client then RENAMED the download to the month it expected. The operator
 *              has been downloading the wrong month wearing the right name. Here there is
 *              no directory scan at all: a job records the exact path it produced and
 *              `GET /descargar/:id` serves that path, under the name the server derived
 *              from the period the operator selected (03 §7.5, AC 23).
 *   BUG-32     `${uploadDestination}${uniqueFilename}` at `app.js:66` concatenates with no
 *              separator - the 0-byte `subcontratistas1741059493565_Febrero-2025` in the
 *              repo root is the artefact. Everything here goes through `path.join` into a
 *              per-run `mkdtemp` directory.
 *   BUG-34/38  `zip.extractAllTo()` with no containment check, no entry cap and no size
 *              cap, behind an `express-fileupload` that buffered the whole upload in RAM.
 *              Extraction is now `pipeline/zip.js` (inside the child), and the upload has
 *              `limits` + `abortOnLimit` + `useTempFiles`, so nothing is held in memory.
 *   BUG-35/45  The work ran ON the request, which is what `req.setTimeout(6000000)` at
 *              `app.js:56` was trying and failing to survive - set inside the handler,
 *              after the socket exists, it never addressed the cause, and the commit
 *              history is six timeout-tuning commits that all missed it. `POST /uploadfiles`
 *              now returns a job id immediately and `GET /progress/:id` is the SSE endpoint
 *              the client was written against but which never existed server-side.
 *   BUG-37     `excelReporting.js:61-63` caught, logged and returned normally, so `app.js`
 *              answered 200 OK and offered a download for a report that was never written.
 *              A non-zero exit, OR a zero exit with no fresh file on disk, is a FAILED job:
 *              non-200 with the reason and the subcontratista that caused it (AC 24).
 *   BUG-43/44  The extracted input was deleted by an unawaited callback that raced the
 *              report, and not at all on the error path, so a failed run bricked the next
 *              one. Every job removes its own directory in a `finally`, on both paths.
 *
 * Single flight (05 §6 risk row 6): the template round-trip peaks near 944 MB RSS, so a
 * second upload while one is in flight is a clean 409, never a second child. `run.js` holds
 * the same guard a second time with a pid-bearing lock file, because the child is a
 * separate process; this one exists so the operator gets an answer instead of an OOM.
 *
 * THE CHILD CONTRACT (`src/cli.js`, 05 §2.1):
 *
 *   argv      --input <zip|dir>  --period YYYY-MM  --out <dir>  --json
 *   progress  one JSON object per line on stdout (that is what `--json` is for) and the
 *             same objects over `process.send()` when there is an IPC channel. Both are
 *             accepted here, and a non-JSON stdout line is shown verbatim, so a plainer
 *             child still produces a watchable run. `{tipo:"progreso", fase, actual,
 *             total, pct, mensaje}` is the shape; `{tipo:"resultado", salidas, resumen}`
 *             and `{tipo:"error", mensaje, codigo}` are the terminal ones.
 *   exit      0  the report was written, no FAILED issue
 *             1  THE REPORT WAS WRITTEN and at least one subcontratista failed - a
 *                deliverable that is INCOMPLETE, not a failed job. The operator still gets
 *                the file, and gets told, by name, who is missing from it (03 §8).
 *             2  usage error   3  no report produced   4  another run holds the guard
 *
 * The server never depends on that protocol for CORRECTNESS: it derives the filename from
 * the period itself, verifies the file exists and is newer than the job, and reads the run
 * log the pipeline writes. The protocol only makes the wait watchable and the failure
 * message specific.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { fork } = require("node:child_process");

const express = require("express");
const fileUpload = require("express-fileupload");

const config = require("./config");
const { parsePeriod, previousMonth, PeriodError } = require("./pipeline/period");
const { makeRunDir, removeRunDir } = require("./pipeline/zip");
const { reviewWorkbook, subcontratistaFromFilename } = require("./pipeline/review");

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** Kept per job so a client that connects to /progress after the run started still sees
 *  the whole story. ~150 workbooks emit ~160 events; the cap is a leak guard, not a limit. */
const MAX_EVENTOS = 2000;
/** Terminal jobs kept in memory so the download link keeps working after a second run. */
const MAX_TRABAJOS = 10;
/** stderr tail carried into the failure body. Enough for a stack, not enough to be a log. */
const MAX_STDERR = 8000;
/** A hung child holds the single-flight guard, so it gets a deadline. The real run is
 *  minutes; this is the "something is wrong" bound, not a budget. */
const TIMEOUT_TRABAJO_MS = 45 * 60 * 1000;
/** SSE keep-alive. nginx and pm2 both drop an idle stream well before a run finishes. */
const LATIDO_MS = 15000;

const ESTADO = Object.freeze({
    EN_CURSO: "en curso",
    LISTO: "listo",
    ERROR: "error",
});

/** `src/cli.js`'s exit codes. Mirrored here rather than imported, because requiring the
 *  CLI would run its `require.main` guard's module-level work in the server process. */
const EXIT = Object.freeze({
    OK: 0,
    INCOMPLETO: 1,   // the report EXISTS and a subcontratista is missing from it
    USO: 2,
    SIN_REPORTE: 3,
    OCUPADO: 4,
});

/** Why the job failed, in the operator's terms. */
const MOTIVO_SALIDA = Object.freeze({
    [EXIT.USO]: "la consolidacion se invoco mal (periodo, entrada o plantilla)",
    [EXIT.SIN_REPORTE]: "no se genero el reporte: ninguna fila fue aceptada o fallo la escritura del libro",
    [EXIT.OCUPADO]: "ya hay otra consolidacion en curso en el servidor",
});

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function esZipPorNombre(nombre) {
    return typeof nombre === "string" && /\.zip$/i.test(nombre.trim());
}

/** /review takes one subcontratista's workbook, not the month's zip. */
function esXlsxPorNombre(nombre) {
    return typeof nombre === "string" && /\.xlsx$/i.test(nombre.trim());
}

/**
 * A .zip local file header, an empty archive, or a spanned archive. Checking the bytes
 * costs one read and refuses the `.xlsx` (or `.exe`) that was renamed to `.zip`, which the
 * extension check alone cannot do.
 */
function pareceZip(filePath) {
    let fd = null;
    try {
        fd = fs.openSync(filePath, "r");
        const head = Buffer.alloc(4);
        const leidos = fs.readSync(fd, head, 0, 4, 0);
        if (leidos < 4) return false;
        return head[0] === 0x50 && head[1] === 0x4b &&
            ((head[2] === 0x03 && head[3] === 0x04) ||
                (head[2] === 0x05 && head[3] === 0x06) ||
                (head[2] === 0x07 && head[3] === 0x08));
    } catch {
        return false;
    } finally {
        if (fd !== null) try { fs.closeSync(fd); } catch { /* nothing to do */ }
    }
}

/** express-fileupload's temp file must not survive a rejected upload. */
function descartarSubida(req) {
    const archivos = req && req.files ? Object.values(req.files) : [];
    for (const f of archivos.flat()) {
        if (f && typeof f.tempFilePath === "string" && f.tempFilePath !== "") {
            try { fs.rmSync(f.tempFilePath, { force: true }); } catch { /* best effort */ }
        }
    }
}

/**
 * Fresh on disk, i.e. written by THIS job. A previous run of the same period leaves a file
 * with the same name behind, and serving that as this run's output would be a quieter
 * version of the bug this file exists to remove.
 */
function frescoDesde(filePath, desdeMs) {
    try {
        const st = fs.statSync(filePath);
        return st.isFile() && st.mtimeMs >= desdeMs - 2000;
    } catch {
        return false;
    }
}

function leerJsonFresco(filePath, desdeMs) {
    if (!frescoDesde(filePath, desdeMs)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
        return null;
    }
}

/** run.json (output/runReport.js buildRunLog) -> the handful of numbers the page shows. */
function resumenDesdeRunLog(runLog) {
    if (!runLog || typeof runLog !== "object") return null;
    const r = runLog.resumen || {};
    return {
        ok: runLog.ok === true,
        filas: r.filas || null,
        subcontratistas: r.subcontratistas || null,
        conservacion: r.conservacion || null,
        incidencias: r.severidades || null,
        fallos: Array.isArray(runLog.fallos)
            ? runLog.fallos.map(f => ({
                subcontratista: f.subcontratista || null,
                archivo: f.archivo || null,
                motivo: f.motivo || null,
            }))
            : [],
    };
}

/* ------------------------------------------------------------------ *
 * The server
 * ------------------------------------------------------------------ */

/**
 * @param {object} [opciones]
 * @param {string} [opciones.cliPath]        child entry point; defaults to src/cli.js.
 * @param {string} [opciones.outDir]         where the child writes; defaults to config.REPORTES_DIR.
 * @param {number} [opciones.maxUploadBytes] defaults to config.MAX_UPLOAD_BYTES.
 * @param {number} [opciones.jobTimeoutMs]
 * @param {function} [opciones.now]          `() => Date`, injected so the future-period
 *                                           refusal and the tests are not at the mercy of
 *                                           the box's clock. The period itself is ALWAYS
 *                                           an argument from the operator - the clock only
 *                                           ever says "no" to it (03 §6, 05 §8 Q5).
 * @returns {import("express").Express} with `app.locals.detener()` and `app.locals.trabajos`.
 */
function createServer(opciones = {}) {
    const cliPath = opciones.cliPath || path.join(config.SRC, "cli.js");
    const outDir = opciones.outDir || config.REPORTES_DIR;
    const maxUploadBytes = Number(opciones.maxUploadBytes) || config.MAX_UPLOAD_BYTES;
    const jobTimeoutMs = Number(opciones.jobTimeoutMs) || TIMEOUT_TRABAJO_MS;
    const ahora = typeof opciones.now === "function" ? opciones.now : () => new Date();
    // express-fileupload's per-file INACTIVITY timer. It arms a timer on every chunk and
    // an aborted upload leaves the last one pending, so this is also how long the process
    // takes to exit after a refused upload - which is why the tests override it.
    const uploadTimeoutMs = Number.isFinite(opciones.uploadTimeoutMs)
        ? opciones.uploadTimeoutMs : 60000;
    const tempFileDir = path.join(config.TMP_ROOT, "subidas");

    fs.mkdirSync(tempFileDir, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });

    /** id -> job. Per-app, not module-level: two servers in one process (the tests) must
     *  not share a single-flight guard. */
    const trabajos = new Map();
    let enCurso = null;

    const app = express();
    app.locals.trabajos = trabajos;

    app.use(express.static(path.join(config.ROOT, "public")));
    app.use(fileUpload({
        useTempFiles: true,                 // never buffer 100+ MB of zip in RAM (BUG-38)
        tempFileDir,
        limits: { fileSize: maxUploadBytes, files: 1 },
        abortOnLimit: true,                 // 413 and close, rather than a truncated zip
        uploadTimeout: uploadTimeoutMs,
        responseOnLimit: `El archivo supera el limite de ${Math.round(maxUploadBytes / (1024 * 1024))} MB.`,
        preserveExtension: 4,
        safeFileNames: true,
        parseNested: false,
    }));

    /* ---------------- job plumbing ---------------- */

    function emitir(job, evento) {
        job.eventos.push(evento);
        if (job.eventos.length > MAX_EVENTOS) {
            job.eventos.splice(0, job.eventos.length - MAX_EVENTOS);
        }
        const payload = `data: ${JSON.stringify(evento)}\n\n`;
        for (const res of job.clientes) {
            try { res.write(payload); } catch { /* the close handler will drop it */ }
        }
    }

    function cerrarClientes(job) {
        for (const res of job.clientes) {
            try { res.end(); } catch { /* already gone */ }
        }
        job.clientes.clear();
    }

    function podar() {
        if (trabajos.size <= MAX_TRABAJOS) return;
        for (const [id, job] of trabajos) {
            if (trabajos.size <= MAX_TRABAJOS) break;
            if (job.estado !== ESTADO.EN_CURSO) trabajos.delete(id);
        }
    }

    /** Terminal state, exactly once, and the per-run temp directory goes in the `finally`
     *  sense of the word: here, on the success path and the failure path alike. */
    function finalizar(job, estado, extra = {}) {
        if (job.estado !== ESTADO.EN_CURSO) return;
        job.estado = estado;
        job.terminado = new Date().toISOString();
        Object.assign(job, extra);

        if (job.temporizador) { clearTimeout(job.temporizador); job.temporizador = null; }
        if (job.latido) { clearInterval(job.latido); job.latido = null; }

        try {
            removeRunDir(job.dirTemporal);
        } catch (err) {
            process.stderr.write(
                `server.js: no se pudo borrar ${job.dirTemporal}: ${err.message}\n`);
        }
        job.limpieza = !fs.existsSync(job.dirTemporal);

        if (enCurso === job.id) enCurso = null;
        job.hijo = null;

        emitir(job, estado === ESTADO.LISTO
            ? { tipo: "fin", ...estadoPublico(job) }
            : { tipo: "error", ...estadoPublico(job) });
        cerrarClientes(job);
        podar();
    }

    function estadoPublico(job) {
        return {
            id: job.id,
            estado: job.estado,
            periodo: job.periodo,
            etiqueta: job.etiqueta,
            archivo: job.nombreArchivo,
            // El reporte existe pero le falta al menos un subcontratista (salida 1 del CLI).
            incompleto: job.incompleto === true,
            descarga: `/descargar/${job.id}`,
            progreso: `/progress/${job.id}`,
            iniciado: job.iniciado,
            terminado: job.terminado,
            resumen: job.resumen,
            error: job.error,
        };
    }

    /** Anything the child says, in any of the shapes it may say it in, as one SSE event. */
    function mensajeDelHijo(job, bruto) {
        if (bruto === null || bruto === undefined) return;

        if (typeof bruto === "string") {
            const texto = bruto.trim();
            if (texto === "") return;
            emitir(job, { tipo: "progreso", mensaje: texto.slice(0, 500) });
            return;
        }
        if (typeof bruto !== "object") return;

        // `runPipeline` returns {records, issues, stats, outputs} and the CLI forwards it
        // as `salidas`: the authoritative path, when we get one.
        const salidas = bruto.outputs || bruto.salidas;
        if (salidas && typeof salidas === "object" && typeof salidas.reporte === "string") {
            job.reporteDelHijo = salidas.reporte;
        }
        // The run log on disk is the primary source for the summary; this is the fallback
        // for when it could not be read.
        if (bruto.resumen && typeof bruto.resumen === "object") {
            job.resumenDelHijo = bruto.resumen;
        }
        // The child's own diagnosis beats "codigo 3".
        if (bruto.tipo === "error") {
            job.errorDelHijo = {
                mensaje: typeof bruto.mensaje === "string" ? bruto.mensaje : null,
                codigo: bruto.codigo ?? null,
            };
            return;
        }
        if (bruto.tipo === "resultado" || bruto.tipo === "inicio") return;

        const fase = bruto.phase ?? bruto.fase ?? null;
        const mensaje = bruto.message ?? bruto.mensaje ?? null;
        if (fase === null && mensaje === null) return;

        emitir(job, {
            tipo: "progreso",
            fase: fase === null ? null : String(fase),
            actual: Number.isFinite(bruto.current) ? bruto.current
                : (Number.isFinite(bruto.actual) ? bruto.actual : null),
            total: Number.isFinite(bruto.total) ? bruto.total : null,
            // The CLI computes its own weighted percentage; there is no reason for the
            // page to invent a second one when it is given this.
            pct: Number.isFinite(bruto.pct) ? bruto.pct : null,
            mensaje: mensaje === null ? null : String(mensaje).slice(0, 500),
        });
    }

    /** Line-buffered stdout: one JSON object per line, or plain text. */
    function lector(job, onLinea) {
        let resto = "";
        return (chunk) => {
            resto += chunk;
            const lineas = resto.split(/\r?\n/);
            resto = lineas.pop();
            if (resto.length > 64 * 1024) resto = "";   // a child printing no newlines
            for (const linea of lineas) onLinea(linea);
        };
    }

    function lanzar(job) {
        let hijo;
        try {
            hijo = fork(cliPath,
                // --json puts NDJSON on stdout and the human log on stderr, which is what
                // the CLI documents the flag for. The IPC channel carries the same objects.
                ["--input", job.zip, "--period", job.periodo, "--out", outDir, "--json"],
                {
                    cwd: config.ROOT,
                    // A pipe plus an IPC channel: the child may use either, and a crash in
                    // it is a dead child, never a dead server (05 Fase 5 tarea 4).
                    stdio: ["ignore", "pipe", "pipe", "ipc"],
                });
        } catch (err) {
            finalizar(job, ESTADO.ERROR, {
                error: {
                    mensaje: `no se pudo iniciar el proceso de consolidacion (${cliPath})`,
                    detalle: err.message,
                    fallos: [],
                },
            });
            return;
        }

        job.hijo = hijo;
        emitir(job, { tipo: "progreso", fase: "inicio", mensaje: `periodo ${job.periodo}` });

        hijo.on("message", (m) => mensajeDelHijo(job, m));

        if (hijo.stdout) {
            hijo.stdout.setEncoding("utf8");
            hijo.stdout.on("data", lector(job, (linea) => {
                const t = linea.trim();
                if (t === "") return;
                if (t.startsWith("{")) {
                    try { return mensajeDelHijo(job, JSON.parse(t)); } catch { /* plain text */ }
                }
                mensajeDelHijo(job, t);
            }));
        }
        if (hijo.stderr) {
            hijo.stderr.setEncoding("utf8");
            hijo.stderr.on("data", (chunk) => {
                job.stderr += chunk;
                if (job.stderr.length > MAX_STDERR) {
                    job.stderr = job.stderr.slice(-MAX_STDERR);
                }
            });
        }

        hijo.on("error", (err) => {
            job.stderr += `\n${err.message}`;
        });

        hijo.on("close", (code, signal) => terminar(job, code, signal));

        job.temporizador = setTimeout(() => {
            job.expirado = true;
            try { hijo.kill("SIGTERM"); } catch { /* already gone */ }
            setTimeout(() => { try { hijo.kill("SIGKILL"); } catch { /* gone */ } }, 5000).unref();
        }, jobTimeoutMs);
        job.temporizador.unref();

        job.latido = setInterval(() => {
            for (const res of job.clientes) {
                try { res.write(": latido\n\n"); } catch { /* dropped on close */ }
            }
        }, LATIDO_MS);
        job.latido.unref();
    }

    function terminar(job, code, signal) {
        if (job.estado !== ESTADO.EN_CURSO) return;

        const runLog = leerJsonFresco(
            path.join(outDir, `${job.base}_run.json`), job.iniciadoMs);
        const resumen = resumenDesdeRunLog(runLog) || job.resumenDelHijo || null;
        const fallos = resumen && Array.isArray(resumen.fallos) ? resumen.fallos : [];

        // Exit 1 is NOT a failed job: the workbook was written and a subcontratista is
        // missing from it. Withholding the file would be worse than the silence this
        // rework exists to remove - the operator needs the report AND the names (03 §8).
        if (code === EXIT.OK || code === EXIT.INCOMPLETO) {
            // The period-derived path FIRST - the name the operator will see is the one the
            // server computed from the period they picked, never one the child chose. The
            // child's own answer is only a fallback. Either way the file has to BE there
            // and be THIS run's (BUG-37 / AC 24): a clean exit with nothing on disk is a
            // failure, not a download button.
            const esperado = path.join(outDir, job.nombreArchivo);
            const candidato = frescoDesde(esperado, job.iniciadoMs) ? esperado
                : (job.reporteDelHijo && frescoDesde(job.reporteDelHijo, job.iniciadoMs)
                    ? job.reporteDelHijo : null);
            if (candidato !== null) {
                job.archivo = candidato;
                return finalizar(job, ESTADO.LISTO, {
                    resumen,
                    incompleto: code === EXIT.INCOMPLETO || fallos.length > 0,
                });
            }
            return finalizar(job, ESTADO.ERROR, {
                resumen,
                error: {
                    mensaje: "el proceso termino sin error pero no escribio el reporte " +
                        `${job.nombreArchivo}`,
                    detalle: job.stderr.trim().slice(-MAX_STDERR) || null,
                    fallos,
                },
            });
        }

        const motivo = job.expirado
            ? `la consolidacion supero el limite de ${Math.round(jobTimeoutMs / 60000)} minutos y fue cancelada`
            : signal
                ? `el proceso de consolidacion fue terminado por la senal ${signal}`
                : (job.errorDelHijo && job.errorDelHijo.mensaje)
                    || MOTIVO_SALIDA[code]
                    || `la consolidacion fallo (codigo ${code})`;

        finalizar(job, ESTADO.ERROR, {
            resumen,
            error: {
                mensaje: motivo,
                codigo: (job.errorDelHijo && job.errorDelHijo.codigo) || null,
                salida: code,
                senal: signal || null,
                // The operator's actual question is WHICH subcontratista, and the run log
                // answers it by name. 03 §8: never a silent omission.
                fallos,
                detalle: job.stderr.trim().slice(-MAX_STDERR) || null,
            },
        });
    }

    /* ---------------- routes ---------------- */

    app.get("/", (_req, res) => res.sendFile(path.join(config.SRC, "index.html")));

    /** The month/year selector's default and its ceiling, computed in ONE place (03 §7.5:
     *  the client stops deriving month names of its own - that duplication is BUG-40). */
    app.get("/api/periodo", (_req, res) => {
        const hoy = ahora();
        res.json({
            sugerido: previousMonth(hoy),
            maximo: `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}`,
            enCurso: enCurso === null ? null : {
                id: enCurso,
                periodo: trabajos.get(enCurso) ? trabajos.get(enCurso).periodo : null,
            },
        });
    });

    app.post("/uploadfiles", async (req, res) => {
        // NO req.setTimeout() here. The request no longer waits for the work (BUG-35).

        // `abortOnLimit` answers 413 from inside the middleware and closes the socket, but
        // busboy still finishes and calls us. Answering twice is an ERR_HTTP_HEADERS_SENT
        // crash, so the oversized upload has to end here.
        if (res.headersSent || res.writableEnded) {
            descartarSubida(req);
            return;
        }

        if (enCurso !== null) {
            const otro = trabajos.get(enCurso);
            descartarSubida(req);
            // 05 §6 risk row 6: the template round-trip peaks near 944 MB RSS. A second
            // run is refused with an answer, not queued and not OOMed.
            return res.status(409).json({
                error: "ya hay una consolidacion en curso",
                mensaje: otro
                    ? `Ya se esta procesando el periodo ${otro.periodo}. Espere a que termine.`
                    : "Ya hay una consolidacion en curso. Espere a que termine.",
                id: enCurso,
                periodo: otro ? otro.periodo : null,
                progreso: `/progress/${enCurso}`,
            });
        }

        const subida = req.files && req.files.zipFile;
        const archivo = Array.isArray(subida) ? subida[0] : subida;
        if (!archivo) {
            descartarSubida(req);
            return res.status(400).json({
                error: "falta el archivo",
                mensaje: "No se recibio ningun archivo. Seleccione el .zip del mes.",
            });
        }
        if (archivo.truncated) {
            descartarSubida(req);
            return res.status(413).json({
                error: "archivo demasiado grande",
                mensaje: `El archivo supera el limite de ${Math.round(maxUploadBytes / (1024 * 1024))} MB.`,
            });
        }
        if (!esZipPorNombre(archivo.name)) {
            descartarSubida(req);
            return res.status(400).json({
                error: "formato invalido",
                mensaje: `El archivo debe estar en formato .zip (se recibio "${archivo.name}").`,
            });
        }
        if (!pareceZip(archivo.tempFilePath)) {
            descartarSubida(req);
            return res.status(400).json({
                error: "formato invalido",
                mensaje: `"${archivo.name}" no es un archivo .zip valido.`,
            });
        }

        // THE PERIOD IS AN ARGUMENT (03 §6, BUG-16). It is never inferred here, and a
        // period in the future is refused outright (05 §8 Q5).
        const solicitado = typeof req.body?.periodo === "string" ? req.body.periodo
            : (typeof req.body?.period === "string" ? req.body.period : "");
        let periodo;
        try {
            periodo = parsePeriod(solicitado, { today: ahora() });
        } catch (err) {
            descartarSubida(req);
            if (err instanceof PeriodError) {
                return res.status(400).json({
                    error: "periodo invalido",
                    codigo: err.code,
                    mensaje: solicitado === ""
                        ? "Seleccione el mes y el anio del reporte."
                        : err.message,
                });
            }
            throw err;
        }

        const id = crypto.randomUUID();
        let dirTemporal;
        try {
            dirTemporal = makeRunDir("upload-");
            const destino = path.join(dirTemporal, "entrada.zip");   // path.join (BUG-32)
            await archivo.mv(destino);

            const job = {
                id,
                periodo: periodo.key,
                etiqueta: periodo.etiqueta,
                base: periodo.filenameBase,
                // Computed ONCE, server-side, from the selected period. The client never
                // derives it again (03 §7.5, BUG-40).
                nombreArchivo: periodo.filename,
                estado: ESTADO.EN_CURSO,
                zip: destino,
                dirTemporal,
                nombreSubida: archivo.name,
                bytes: archivo.size,
                iniciado: new Date().toISOString(),
                iniciadoMs: Date.now(),
                terminado: null,
                eventos: [],
                clientes: new Set(),
                stderr: "",
                archivo: null,
                reporteDelHijo: null,
                resumenDelHijo: null,
                errorDelHijo: null,
                resumen: null,
                incompleto: false,
                error: null,
                hijo: null,
                temporizador: null,
                latido: null,
                expirado: false,
                limpieza: false,
            };
            trabajos.set(id, job);
            enCurso = id;

            res.status(202).json({
                id,
                periodo: periodo.key,
                etiqueta: periodo.etiqueta,
                archivo: periodo.filename,
                progreso: `/progress/${id}`,
                descarga: `/descargar/${id}`,
                estado: `/trabajos/${id}`,
            });

            lanzar(job);
        } catch (err) {
            descartarSubida(req);
            if (dirTemporal) {
                try { removeRunDir(dirTemporal); } catch { /* best effort */ }
            }
            if (enCurso === id) enCurso = null;
            trabajos.delete(id);
            if (!res.headersSent) {
                return res.status(500).json({
                    error: "no se pudo iniciar la consolidacion",
                    mensaje: err.message,
                });
            }
        }
    });

    /** The SSE endpoint `public/js/index.js` was written against and which never existed
     *  server-side (BUG-45). Buffered events are replayed, so connecting late loses nothing. */
    app.get("/progress/:id", (req, res) => {
        const job = trabajos.get(req.params.id);
        if (!job) {
            return res.status(404).json({ error: "trabajo desconocido", id: req.params.id });
        }

        res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",      // nginx buffers text/event-stream by default
        });
        res.write("retry: 3000\n\n");

        for (const evento of job.eventos) {
            res.write(`data: ${JSON.stringify(evento)}\n\n`);
        }
        if (job.estado !== ESTADO.EN_CURSO) return res.end();

        job.clientes.add(res);
        req.on("close", () => job.clientes.delete(res));
    });

    /** JSON status, for a client whose stream dropped. A failed job answers non-200 here
     *  and at /descargar - AC 24: a failure never looks like a success. */
    app.get("/trabajos/:id", (req, res) => {
        const job = trabajos.get(req.params.id);
        if (!job) {
            return res.status(404).json({ error: "trabajo desconocido", id: req.params.id });
        }
        res.status(job.estado === ESTADO.ERROR ? 500 : 200).json(estadoPublico(job));
    });

    /**
     * THE DOWNLOAD. No directory scan, no comparator, no client-side rename: the exact
     * path this job produced, under the name derived from the period the operator picked
     * (BUG-36 / BUG-40 / BUG-50, AC 23).
     */
    app.get("/descargar/:id", (req, res) => {
        const job = trabajos.get(req.params.id);
        if (!job) {
            return res.status(404).json({ error: "trabajo desconocido", id: req.params.id });
        }
        if (job.estado === ESTADO.ERROR) {
            return res.status(500).json({
                error: "la consolidacion fallo",
                mensaje: job.error ? job.error.mensaje : "la consolidacion fallo",
                fallos: job.error ? job.error.fallos : [],
                detalle: job.error ? job.error.detalle : null,
            });
        }
        if (job.estado === ESTADO.EN_CURSO) {
            return res.status(409).json({
                error: "en curso",
                mensaje: "El reporte todavia se esta generando.",
                progreso: `/progress/${job.id}`,
            });
        }
        if (!job.archivo || !fs.existsSync(job.archivo)) {
            return res.status(410).json({
                error: "el archivo ya no esta disponible",
                mensaje: `${job.nombreArchivo} ya no esta en el servidor. Vuelva a generar el reporte.`,
            });
        }
        res.download(job.archivo, job.nombreArchivo);
    });

    /* ---------------- /review ---------------- *
     * Checking one workbook before it is put in the month's zip. It runs the same
     * readWorkbook -> parseRow -> dedupe that a real run does and reports the same issue
     * codes, but stops before anything is produced.
     *
     * Two things it deliberately does NOT do, both of which /uploadfiles must:
     *
     *   - take the single-flight guard. That guard exists because the template round-trip
     *     peaks near 944 MB RSS; a review never opens the template, so making it wait on a
     *     consolidation (or a consolidation wait on it) would be a cost with no cause.
     *   - fork a child and stream progress. One workbook is fast enough to answer inside
     *     the request, so there is no job to poll and nothing to download.
     */
    app.get("/review", (_req, res) => res.sendFile(path.join(config.SRC, "review.html")));

    app.post("/review", (req, res) => {
        if (res.headersSent || res.writableEnded) {
            descartarSubida(req);
            return;
        }

        const subida = req.files && req.files.archivo;
        const archivo = Array.isArray(subida) ? subida[0] : subida;

        try {
            if (!archivo) {
                return res.status(400).json({
                    error: "falta el archivo",
                    mensaje: "No se recibio ningun archivo. Seleccione un .xlsx.",
                });
            }
            if (archivo.truncated) {
                return res.status(413).json({
                    error: "archivo demasiado grande",
                    mensaje: `El archivo supera el limite de ${Math.round(maxUploadBytes / (1024 * 1024))} MB.`,
                });
            }
            if (!esXlsxPorNombre(archivo.name)) {
                return res.status(400).json({
                    error: "formato invalido",
                    mensaje: `Se revisa un archivo .xlsx a la vez (se recibio "${archivo.name}"). `
                        + "Para el zip completo del mes use la pagina principal.",
                });
            }
            // .xlsx is a zip container, so the same local-file-header check applies and
            // refuses anything renamed to .xlsx.
            if (!pareceZip(archivo.tempFilePath)) {
                return res.status(400).json({
                    error: "archivo invalido",
                    mensaje: `"${archivo.name}" no parece un archivo .xlsx valido.`,
                });
            }
            if (archivo.size > config.MAX_REVIEW_BYTES) {
                return res.status(413).json({
                    error: "archivo demasiado grande",
                    mensaje: `Un archivo de revision no puede pasar de `
                        + `${Math.round(config.MAX_REVIEW_BYTES / (1024 * 1024))} MB.`,
                });
            }

            // The period is an argument here for the same reason it is one in run.js: the
            // date checks are relative to it. The clock is only a default for the caller
            // that did not choose, which is the same default /api/periodo suggests.
            let periodo;
            try {
                // `period` is accepted alongside `periodo` for the same reason
                // /uploadfiles accepts both.
                const pedido = typeof req.body?.periodo === "string" && req.body.periodo !== ""
                    ? req.body.periodo
                    : (typeof req.body?.period === "string" && req.body.period !== ""
                        ? req.body.period
                        : previousMonth(ahora()));
                periodo = parsePeriod(pedido);
            } catch (e) {
                if (e instanceof PeriodError) {
                    return res.status(400).json({ error: "periodo invalido", mensaje: e.message });
                }
                throw e;
            }

            // `safeFileNames: true` strips everything but word characters from the upload's
            // filename, so "SUBCONTRATA UNO.xlsx" arrives as "SUBCONTRATAUNO.xlsx". That is
            // the right thing for anything that touches the filesystem and the wrong thing
            // for a label, because a subcontratista's name has spaces in it. The client
            // sends the original for display.
            //
            // DISPLAY ONLY. Neither value is ever joined to a path, opened, or written: the
            // file that gets read is `archivo.tempFilePath`, which express-fileupload named.
            // The page escapes both before rendering.
            const mostrado = req.body && typeof req.body.nombre === "string"
                && req.body.nombre.trim() !== ""
                ? req.body.nombre.trim().slice(0, 200)
                : archivo.name;
            const nombre = req.body && typeof req.body.subcontratista === "string"
                && req.body.subcontratista.trim() !== ""
                ? req.body.subcontratista.trim().slice(0, 200)
                : subcontratistaFromFilename(mostrado);

            const informe = reviewWorkbook(archivo.tempFilePath, {
                period: periodo.key,
                subcontratista: nombre,
                archivo: mostrado,
            });
            return res.json(informe);
        } catch (e) {
            process.stderr.write(`server.js /review: ${e && e.stack ? e.stack : e}\n`);
            return res.status(500).json({
                error: "no se pudo revisar",
                mensaje: e && e.message ? e.message : "No se pudo revisar el archivo.",
            });
        } finally {
            // Nothing is retained (05 §7 step 9). The review read the file; it is gone now.
            descartarSubida(req);
        }
    });

    app.use((req, res) => res.status(404).json({ error: "no encontrado", ruta: req.path }));

    // Express 4 needs the four-argument shape to recognise an error handler. Without it a
    // bad multipart body is an unhandled rejection instead of a message.
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        process.stderr.write(`server.js: ${err && err.stack ? err.stack : err}\n`);
        if (res.headersSent) return;
        res.status(400).json({
            error: "peticion invalida",
            mensaje: err && err.message ? err.message : "peticion invalida",
        });
    });

    /** Kill anything in flight and release the timers - for tests and for a clean shutdown. */
    app.locals.detener = () => {
        for (const job of trabajos.values()) {
            if (job.temporizador) { clearTimeout(job.temporizador); job.temporizador = null; }
            if (job.latido) { clearInterval(job.latido); job.latido = null; }
            if (job.hijo) { try { job.hijo.kill("SIGKILL"); } catch { /* gone */ } }
            cerrarClientes(job);
            if (job.estado === ESTADO.EN_CURSO) {
                job.estado = ESTADO.ERROR;
                try { removeRunDir(job.dirTemporal); } catch { /* best effort */ }
            }
        }
        enCurso = null;
    };

    return app;
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

function main() {
    const app = createServer();
    const server = app.listen(config.PORT, () => {
        process.stdout.write(
            `subcontratistas: escuchando en http://localhost:${config.PORT} ` +
            `(reportes en ${config.REPORTES_DIR})\n`);
    });
    for (const senal of ["SIGINT", "SIGTERM"]) {
        process.on(senal, () => {
            app.locals.detener();
            server.close(() => process.exit(0));
        });
    }
    return server;
}

if (require.main === module) main();

module.exports = { createServer, main, ESTADO };

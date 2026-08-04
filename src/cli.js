"use strict";
/**
 * THE PRODUCT. `src/server.js` is a wrapper around this file; this file is a wrapper
 * around `pipeline/run.js` (05-implementation-plan.md §1 principio 1, §2.3).
 *
 *   node src/cli.js --input <zip|carpeta> --period 2026-02 [--out <dir>] [--shadow]
 *
 * Three things the CLI buys that the current app cannot do at all (05 §2.3):
 *
 *   1. TESTABILIDAD. `runPipeline()` takes a folder and a period string and returns data.
 *      Every fixture test calls it directly - no HTTP, no upload, no browser. There is no
 *      way to write those tests against `src/app.js`, which is why there were none.
 *
 *   2. DETERMINISMO. `--period` is an argument, so February's numbers can be produced in
 *      August. It is REQUIRED and it is never defaulted: silently falling back to the wall
 *      clock is precisely how `getMonthAndYear()` (src/excelReporting.js:69-77) came to
 *      name `Reporte_Subcontratistas_DICIEMBRE_2025.xlsx` a file whose own Altas filter
 *      reads `11-2025` (BUG-16, BUG-40; 03 §6.2). When `--period` is missing this CLI
 *      PRINTS the month it would have guessed and exits non-zero, so the operator confirms
 *      it rather than discovering it in the filename three weeks later.
 *
 *   3. VOLVER A CORRER UN MES. When a subcontratista sends a corrected workbook three
 *      weeks late, the operator reassembles the folder and re-runs one command with the
 *      same `--period`: same period in, same filename out, deterministically overwritten
 *      (03 §7.5). Today that means re-zipping, re-uploading, and getting a filename
 *      derived from today's date.
 *
 * SALIDA. Two channels, and they never mix:
 *
 *   - stderr  is the human channel: progress lines and the final summary. Always on
 *             (`--quiet` drops the per-file progress, never the summary).
 *   - stdout  is the machine channel, and ONLY under `--json`: one JSON object per line
 *             (NDJSON), so `server.js` can `fork('src/cli.js')` and pipe them straight to
 *             the `/progress` SSE endpoint that `public/js/index.js` was already written
 *             against but which has never existed server-side (05 Fase 5 tarea 4).
 *             Without `--json`, stdout carries the human summary and nothing else.
 *             When the process was forked with an IPC channel the same objects also go out
 *             over `process.send()`, so the server does not have to reassemble lines.
 *
 * The ONLY clock read in this file is `now()`, and it names nothing: it suggests a period
 * when the operator forgot one, and it refuses a period in the future (05 §8 Q5). Every
 * reported number comes from the period argument.
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");

const config = require("./config");
const { IssueList, SEVERITY } = require("./pipeline/issues");
const { parsePeriod, previousMonth, PeriodError, PERIOD_ERROR } = require("./pipeline/period");
const { runPipeline, RunError, RUN_ERROR, PHASE } = require("./pipeline/run");

/* ------------------------------------------------------------------ *
 * Exit codes - the contract with CI and with the operator
 * ------------------------------------------------------------------ */

/**
 * The distinction that matters, and the reason this is not just 0/1:
 * "the report was produced" is a DIFFERENT fact from "the report was produced but a
 * subcontratista is missing from it" (05 §1 principio 4). Code 1 is the second one, and
 * it is the code CI fails on while still keeping the artifact.
 */
const EXIT = Object.freeze({
    OK: 0,          // report written, zero FAILED issues
    INCOMPLETO: 1,  // report written, at least one FAILED issue - a subcontratista is missing
    USO: 2,         // caller error: bad/absent arguments, malformed or future period, no input
    SIN_REPORTE: 3, // the run did not produce a workbook (zero rows accepted, or a write failure)
    OCUPADO: 4,     // another run holds the single-flight guard
});

/** Option table. `strict` + no positionals: an unknown flag is a caller error, loudly. */
const OPTIONS = Object.freeze({
    input: { type: "string", short: "i" },
    period: { type: "string", short: "p" },
    out: { type: "string", short: "o" },
    template: { type: "string", short: "t" },
    shadow: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    quiet: { type: "boolean", short: "q", default: false },
    "identity-key": { type: "string" },
    "sin-consolidado": { type: "boolean", default: false },
    "sin-csv": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
    version: { type: "boolean", short: "V", default: false },
});

const HELP = `
Uso: node src/cli.js --input <zip|carpeta> --period YYYY-MM [opciones]

Consolida los libros de los subcontratistas de un mes en el reporte mensual
(Reporte Social - RRHH) y escribe el side-car de metricas y el log de la corrida.

El PERIODO ES SIEMPRE UN ARGUMENTO y nunca se deduce del reloj: febrero se puede
producir en agosto, y volver a correr un mes con un libro corregido es el mismo
comando con el mismo --period (mismo periodo -> mismo nombre de archivo).

Opciones
  -i, --input <ruta>        el .zip subido, o una carpeta ya extraida: una carpeta
                            por subcontratista, un .xlsx dentro. Obligatorio.
  -p, --period <YYYY-MM>    mes reportado. OBLIGATORIO. Sin este argumento el
                            programa sugiere el mes anterior y termina con codigo 2:
                            un valor por defecto tomado del reloj es exactamente
                            como se llego a un archivo DICIEMBRE que reporta
                            NOVIEMBRE. Un periodo futuro se rechaza.
  -o, --out <carpeta>       donde se escriben las salidas (por defecto src/reportes).
  -t, --template <ruta>     plantilla (por defecto src/template-v2.xlsx).
      --shadow              corrida en paralelo (05 §4.3): despues de terminar la
                            corrida principal y liberar su memoria, corre el pipeline
                            ANTIGUO sobre la misma extraccion y compara los dos libros
                            con tools/diff-reports.js. Secuencial, nunca simultanea;
                            un fallo aqui se reporta y NO cambia el codigo de salida;
                            el archivo entregable es siempre el del pipeline nuevo.
      --json                una linea JSON por evento en stdout (NDJSON): inicio,
                            progreso, resultado o error. Para que server.js pueda
                            hacer fork de este CLI y reenviar las lineas por SSE.
      --identity-key <k>    clave de deduplicacion: "name" (por defecto) o "dni".
      --sin-consolidado     no escribir el intermedio ReporteConsolidado.
      --sin-csv             no escribir el CSV de Errores.
  -q, --quiet               sin progreso por archivo; el resumen final se imprime igual.
  -h, --help                esta ayuda.
  -V, --version             version del paquete.

Salidas (todas en --out, todas con el nombre del PERIODO, nunca de la fecha de hoy)
  Reporte_Subcontratistas_<MES>_<ANIO>.xlsx        el reporte entregable
  Reporte_Subcontratistas_<MES>_<ANIO>.json        side-car de metricas
  Reporte_Subcontratistas_<MES>_<ANIO>_Consolidado.xlsx   intermedio comparable
  Reporte_Subcontratistas_<MES>_<ANIO>_run.json    log de la corrida
  Reporte_Subcontratistas_<MES>_<ANIO>_Errores.csv lista de excepciones
  (con --shadow, ademas ..._shadow-diff.txt y ..._shadow-diff.json)

Codigos de salida
  0  limpio: el reporte se genero y no hubo ninguna incidencia FAILED.
  1  el reporte SE GENERO pero hubo al menos una incidencia FAILED: algun
     subcontratista no entro en el. El archivo sirve; esta incompleto y el
     resumen dice quien falta. CI debe fallar con este codigo.
  2  error de uso: falta --input o --period, periodo malformado o futuro,
     opcion desconocida, entrada o plantilla inexistente.
  3  no se genero reporte: ninguna fila aceptada, o fallo la escritura del libro.
     El log de la corrida y el CSV de errores si se escriben - dicen por que.
  4  ya hay una corrida en curso: el pipeline es de una sola via porque la
     plantilla consume ~944 MB de RSS y dos a la vez agotan la memoria.

Ejemplos
  node src/cli.js --input ./entrada/2026-02 --period 2026-02
  node src/cli.js --input subida.zip --period 2026-02 --out ./salida --json
  node src/cli.js --input ./entrada/2026-02 --period 2026-02 --shadow
`.trimStart();

/* ------------------------------------------------------------------ *
 * The one clock read
 * ------------------------------------------------------------------ */

/** Wall clock, isolated in one function so it is obvious there is exactly one, and so the
 *  tests can pass their own. It never names an artifact and never enters a number. */
function now() {
    return new Date();
}

/* ------------------------------------------------------------------ *
 * Event channels
 * ------------------------------------------------------------------ */

/**
 * Rough completion for the SSE progress bar. Monotone by construction: each phase owns a
 * span and only LECTURA and the file walk interpolate inside it. It is a progress bar, not
 * a measurement - the numbers the operator acts on are in the summary.
 */
const SPAN = Object.freeze({
    [PHASE.INICIO]: [0, 1],
    [PHASE.EXTRACCION]: [1, 4],
    [PHASE.RECORRIDO]: [4, 6],
    [PHASE.LECTURA]: [6, 60],
    [PHASE.DEDUPE]: [60, 64],
    [PHASE.CONSOLIDADO]: [64, 70],
    [PHASE.METRICAS]: [70, 76],
    [PHASE.REPORTE]: [76, 92],
    [PHASE.RUNLOG]: [92, 94],
    [PHASE.SHADOW]: [94, 98],
    [PHASE.LIMPIEZA]: [98, 99],
    [PHASE.FIN]: [100, 100],
});

function percentFor(phase, current, total) {
    const span = SPAN[phase];
    if (!span) return null;
    const [from, to] = span;
    if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return from;
    const ratio = Math.max(0, Math.min(1, current / total));
    return Math.round(from + (to - from) * ratio);
}

/**
 * The two output channels, built once. Everything below writes through this object so the
 * tests can capture both streams and so no stray `console.log` can pollute the NDJSON.
 */
function makeIo(flags, streams = {}) {
    const out = streams.stdout || process.stdout;
    const err = streams.stderr || process.stderr;
    const ipc = typeof process.send === "function" ? process.send.bind(process) : null;

    return {
        /** Human, always on stderr. */
        log(line) {
            err.write(`${line}\n`);
        },
        /** The final summary: stdout when a human is reading it, stderr when stdout is
         *  reserved for NDJSON. Either way the operator sees it. */
        summary(text) {
            (flags.json ? err : out).write(text.endsWith("\n") ? text : `${text}\n`);
        },
        /** Machine, only under --json (plus IPC when forked). */
        event(obj) {
            if (flags.json) out.write(`${JSON.stringify(obj)}\n`);
            if (ipc) {
                try { ipc(obj); } catch { /* the parent hung up; the run continues */ }
            }
        },
    };
}

/* ------------------------------------------------------------------ *
 * Argument parsing
 * ------------------------------------------------------------------ */

class UsageError extends Error {
    constructor(message, extra) {
        super(message);
        this.name = "UsageError";
        if (extra) this.extra = extra;
    }
}

/**
 * argv -> a validated plan, or a UsageError. Pure except for `today`, which the caller
 * supplies so this function can be tested without a clock.
 *
 * @param {string[]} argv     process.argv.slice(2)
 * @param {Date|string} today the current date, for the period suggestion and the
 *                            future-period refusal. Explicit, never defaulted here.
 */
function parseCliArgs(argv, today) {
    let parsed;
    try {
        parsed = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false });
    } catch (err) {
        // ERR_PARSE_ARGS_UNKNOWN_OPTION / _UNEXPECTED_POSITIONAL / _INVALID_OPTION_VALUE.
        // A caller error, so it fails loudly rather than being guessed at.
        throw new UsageError(err.message);
    }
    const values = parsed.values;

    if (values.help) return { action: "help" };
    if (values.version) return { action: "version" };

    // --- the period, first, and before anything is read from disk ----------
    // The order is deliberate: a missing or wrong period must be reported even when the
    // input path is also wrong, because it is the one the operator gets wrong silently.
    if (values.period === undefined) {
        let sugerido = null;
        try { sugerido = previousMonth(today); } catch { sugerido = null; }
        throw new UsageError(
            "falta --period. NO se toma del reloj: derivar el periodo de la fecha de hoy es " +
            "como se llego a un archivo llamado DICIEMBRE que reporta NOVIEMBRE (BUG-16).",
            {
                codigo: "PERIOD_MISSING",
                sugerido,
                pista: sugerido
                    ? `si el mes que quiere reportar es el anterior, escriba:  --period ${sugerido}`
                    : "indique el mes reportado como --period YYYY-MM",
            });
    }

    let period;
    try {
        // `today` here is what refuses a future period outright (05 §8 Q5). The CURRENT
        // month is allowed: it is not in the future, only unfinished.
        period = parsePeriod(values.period, { today });
    } catch (err) {
        if (err instanceof PeriodError) {
            throw new UsageError(err.message, {
                codigo: err.code,
                pista: err.code === PERIOD_ERROR.PERIOD_FUTURE
                    ? "un periodo futuro no tiene datos que consolidar; revise el argumento"
                    : 'el formato es "YYYY-MM", por ejemplo --period 2026-02',
            });
        }
        throw err;
    }

    // --- the input ----------------------------------------------------------
    if (values.input === undefined || String(values.input).trim() === "") {
        throw new UsageError(
            "falta --input: el .zip subido o una carpeta ya extraida (una carpeta por " +
            "subcontratista, un .xlsx dentro).",
            { codigo: "INPUT_MISSING" });
    }
    const inputPath = path.resolve(String(values.input).trim());
    if (!fs.existsSync(inputPath)) {
        throw new UsageError(`no existe la entrada ${inputPath}`, { codigo: RUN_ERROR.INPUT_NOT_FOUND });
    }

    // --- the template -------------------------------------------------------
    const templatePath = values.template
        ? path.resolve(String(values.template).trim())
        : config.TEMPLATE;
    if (!fs.existsSync(templatePath)) {
        throw new UsageError(
            `no existe la plantilla ${templatePath}. Los lookups (Hoja1) y las 13 tablas ` +
            "dinamicas se leen de ahi; sin plantilla no hay reporte.",
            { codigo: "TEMPLATE_NOT_FOUND" });
    }

    // --- the rest -----------------------------------------------------------
    const identityKey = values["identity-key"] === undefined
        ? config.IDENTITY_KEY
        : String(values["identity-key"]).trim().toLowerCase();
    if (identityKey !== "name" && identityKey !== "dni") {
        throw new UsageError(
            `--identity-key invalido: ${JSON.stringify(values["identity-key"])} (se espera "name" o "dni")`,
            { codigo: "IDENTITY_KEY_INVALID" });
    }

    return {
        action: "run",
        period,
        inputPath,
        templatePath,
        outDir: values.out ? path.resolve(String(values.out).trim()) : config.REPORTES_DIR,
        identityKey,
        shadow: values.shadow === true,
        writeConsolidated: values["sin-consolidado"] !== true,
        writeCsv: values["sin-csv"] !== true,
        flags: { json: values.json === true, quiet: values.quiet === true },
    };
}

/* ------------------------------------------------------------------ *
 * The human summary
 * ------------------------------------------------------------------ */

const RULE = "-".repeat(78);

function n(value) {
    return value === null || value === undefined ? "?" : String(value);
}

/** Absolute paths, one per line, labelled - "WHERE the three outputs were written". */
function outputLines(outputs) {
    const rows = [
        ["reporte", outputs.reporte],
        ["metricas", outputs.metricas],
        ["consolidado", outputs.consolidado],
        ["run.json", outputs.runLog],
        ["errores.csv", outputs.erroresCsv],
    ];
    const shadowDiff = outputs.shadow && outputs.shadow.diff ? outputs.shadow.diff : null;
    if (shadowDiff && shadowDiff.path) rows.push(["shadow diff", shadowDiff.path]);
    if (shadowDiff && shadowDiff.json) rows.push(["shadow json", shadowDiff.json]);

    const lines = [];
    for (const [label, value] of rows) {
        lines.push(`  ${label.padEnd(12)} ${value || "(no se escribio)"}`);
    }
    return lines;
}

/**
 * Everything 03 §8.2's per-run summary asks for, in the order it asks for it, plus the
 * three output paths. Written to be read in a terminal after a five-minute run.
 */
function formatSummary(stats, outputs, exitCode) {
    const L = [];
    const p = stats.period || {};
    L.push(RULE);
    L.push(`Reporte de subcontratistas   periodo ${n(stats.periodo)}` +
        (p.mesNombre ? `  (${p.mesNombre} ${p.year})` : ""));
    L.push(RULE);

    const a = stats.archivos || {};
    L.push(`Archivos         vistos ${n(a.vistos)} | procesados ${n(a.procesados)} | fallidos ${n(a.fallidos)}`);

    const s = stats.subcontratistas || {};
    L.push(`Subcontratistas  esperados ${n(s.esperados)} | leidos ${n(s.leidos)} | fallidos ${n(s.fallidos)}`);
    // NAMED, never a bare count: a number alone is the silence this rework exists to
    // remove (05 §1 principio 4).
    if (s.nombres && s.nombres.length > 0) {
        L.push("  NO ENTRARON EN EL REPORTE:");
        for (const name of s.nombres) L.push(`    - ${name}`);
    }

    const f = stats.filas || {};
    L.push(`Filas            leidas ${n(f.leidas)} | rechazadas ${n(f.rechazadas)} | ` +
        `colapsadas ${n(f.colapsadas)} | escritas ${n(f.escritas)}`);

    const c = stats.conservacion || {};
    const suma = `${n(f.leidas)} - ${n(f.rechazadas)} - ${n(f.colapsadas)} = ${n(c.esperado)}`;
    L.push(`Conservacion     ${c.ok ? "OK" : "ROTA"}   ${c.formula || "leidas - rechazadas - colapsadas = escritas"}`);
    L.push(`                 ${suma}, escritas ${n(c.actual)}` +
        (c.ok ? "" : `  <-- diferencia ${n(c.diferencia)}`));
    if (!c.ok && c.motivo) L.push(`                 ${c.motivo}`);

    const i = stats.incidencias || {};
    L.push(`Incidencias      INFO ${n(i[SEVERITY.INFO])} | WARNING ${n(i[SEVERITY.WARNING])} | ` +
        `ERROR ${n(i[SEVERITY.ERROR])} | FAILED ${n(i[SEVERITY.FAILED])}`);

    if (stats.dedupe && stats.dedupe.rowsCollapsed > 0) {
        L.push(`Duplicados       ${stats.dedupe.rowsCollapsed} fila(s) colapsada(s) por clave ` +
            `${stats.dedupe.mode || ""}`.trimEnd() +
            (stats.crossSubcontratista ? ` | ${stats.crossSubcontratista} trabajador(es) en 2+ subcontratistas` : ""));
    }

    L.push("Salidas");
    L.push(...outputLines(outputs));

    if (stats.shadow) L.push(...shadowLines(stats.shadow, outputs.shadow));

    L.push(RULE);
    L.push(verdict(exitCode, stats));
    L.push(RULE);
    return L.join("\n");
}

function verdict(exitCode, stats) {
    const fallidos = (stats.subcontratistas && stats.subcontratistas.fallidos) || 0;
    switch (exitCode) {
        case EXIT.OK:
            return "OK: el reporte se genero y no hubo incidencias FAILED.  (exit 0)";
        case EXIT.INCOMPLETO:
            return `ATENCION: el reporte se genero, pero ${fallidos} subcontratista(s) no entraron en el. ` +
                "Revise la hoja Errores dentro del libro y el CSV.  (exit 1)";
        default:
            return `Termino con codigo ${exitCode}.`;
    }
}

/** The parallel-run block. `bloquea === true` is the cutover gate of 05 §4.5. */
function shadowLines(shadow, outputsShadow) {
    const L = ["Corrida en paralelo (--shadow)"];
    if (!shadow.ok) {
        L.push("  el pipeline antiguo no completo. El reporte entregado NO se ve afectado.");
        if (shadow.error) L.push(`  motivo: ${String(shadow.error).split("\n")[0]}`);
        return L;
    }
    const diff = outputsShadow && outputsShadow.diff ? outputsShadow.diff : null;
    if (!diff || !diff.ok) {
        L.push("  los dos libros se produjeron pero no se pudieron comparar.");
        if (diff && diff.motivo) L.push(`  motivo: ${String(diff.motivo).split("\n")[0]}`);
        return L;
    }
    const v = diff.valor && typeof diff.valor === "object" ? diff.valor : null;
    if (v && v.etapas) {
        const e = v.etapas;
        L.push(`  filas       antiguas ${n(e.filas.antiguas)} | nuevas ${n(e.filas.nuevas)} | ` +
            `emparejadas ${n(e.filas.emparejadas)} | solo antiguo ${n(e.filas.soloAntiguo)} | ` +
            `solo nuevo ${n(e.filas.soloNuevo)}`);
        L.push(`  recuperadas ${n(e.filas.recuperadas)} fila(s) de ${n((v.recuperadasPorEmpresa || []).length)} ` +
            "empresa(s) que el pipeline antiguo dejo caer");
        L.push(`  celdas A:R  ${n(e.celdas.divergentes)} divergentes de ${n(e.celdas.comparadas)}`);
        L.push(`  comput S:AI ${n(e.computadas.divergentes)} divergentes de ${n(e.computadas.comparadas)}`);
        L.push(`  pivotes     ${e.pivotes && e.pivotes.ejecutado ? "comparados" : "NO EJECUTADO (requiere --refreshed sobre el libro antiguo)"}`);
        L.push(`  divergencias ${n(v.totalDivergencias)} | inesperadas ${n(v.totalInesperadas)}`);
    }
    if (shadow.bloquea === true) {
        L.push("  BLOQUEA EL CUTOVER: hay divergencias fuera de la lista esperada (05 §4.5).");
    } else if (shadow.bloquea === false) {
        L.push("  sin divergencias inesperadas.");
    }
    L.push("  (el archivo entregable es el del pipeline nuevo; el shadow no cambia el codigo de salida)");
    return L;
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

/**
 * @param {string[]} argv    process.argv.slice(2)
 * @param {object} [deps]    {stdout, stderr, today} - injected by the tests
 * @returns {Promise<number>} the exit CODE. Never calls process.exit(): a pending write to
 *                            a pipe would be truncated, and `server.js` reads that pipe.
 */
async function main(argv, deps = {}) {
    const today = deps.today || now();
    const stdout = deps.stdout || process.stdout;
    const stderr = deps.stderr || process.stderr;

    // The flags are needed to build the channels, and the channels are needed to report a
    // parsing failure, so --json is read off argv before the strict parse. A malformed
    // argv still reports as NDJSON when the caller asked for NDJSON.
    const wantsJson = argv.includes("--json");
    const io = makeIo({ json: wantsJson }, { stdout, stderr });

    let plan;
    try {
        plan = parseCliArgs(argv, today);
    } catch (err) {
        if (err instanceof UsageError) {
            const extra = err.extra || {};
            io.event({ tipo: "error", exit: EXIT.USO, codigo: extra.codigo || "USO", mensaje: err.message, ...extra });
            io.log(`error: ${err.message}`);
            if (extra.sugerido) io.log(`el mes anterior a hoy seria: ${extra.sugerido}`);
            if (extra.pista) io.log(extra.pista);
            io.log("");
            io.log("use --help para ver las opciones y los codigos de salida");
            return EXIT.USO;
        }
        throw err;
    }

    if (plan.action === "help") {
        stdout.write(HELP);
        return EXIT.OK;
    }
    if (plan.action === "version") {
        stdout.write(`${require("../package.json").version}\n`);
        return EXIT.OK;
    }

    const { period, flags } = plan;
    const io2 = makeIo(flags, { stdout, stderr });

    io2.event({
        tipo: "inicio",
        periodo: {
            key: period.key, etiqueta: period.etiqueta, mesNombre: period.mesNombre,
            anio: period.year, mes: period.month, archivo: period.filename,
        },
        entrada: plan.inputPath,
        salida: plan.outDir,
        plantilla: plan.templatePath,
        claveIdentidad: plan.identityKey,
        shadow: plan.shadow,
    });
    io2.log(`periodo ${period.key} (${period.mesNombre} ${period.year}) -> ${period.filename}`);
    io2.log(`entrada  ${plan.inputPath}`);
    io2.log(`salida   ${plan.outDir}`);
    if (plan.shadow) io2.log("shadow   activado: el pipeline antiguo corre despues, en secuencia");

    // Ours, so the summary can be printed even when runPipeline throws.
    const issues = new IssueList();

    // A progress bar that goes backwards is a bug report waiting to happen. LIMPIEZA is
    // emitted from run.js's `finally`, i.e. AFTER FIN on the success path, so the raw
    // percentages are not monotone; the phase name stays exact, the number only advances.
    let lastPct = 0;
    const onProgress = ({ phase, current, total, message }) => {
        const raw = percentFor(phase, current, total);
        const pct = raw === null ? lastPct : Math.max(lastPct, raw);
        lastPct = pct;
        io2.event({
            tipo: "progreso", fase: phase, actual: current ?? null,
            total: total ?? null, pct, mensaje: message ?? null,
        });
        if (flags.quiet) return;
        const counter = Number.isFinite(current) && Number.isFinite(total) && total > 0
            ? ` ${current}/${total}`
            : "";
        io2.log(`[${String(pct).padStart(3)}%] ${phase}${counter}${message ? `  ${message}` : ""}`);
    };

    let result;
    try {
        result = await runPipeline({
            inputPath: plan.inputPath,
            period: period.key,
            templatePath: plan.templatePath,
            outDir: plan.outDir,
            identityKey: plan.identityKey,
            issues,
            onProgress,
            shadow: plan.shadow,
            writeConsolidated: plan.writeConsolidated,
            writeCsv: plan.writeCsv,
        });
    } catch (err) {
        return reportFailure(err, io2, issues, period);
    }

    // ---- the exit code -----------------------------------------------------
    // Any FAILED issue means a whole workbook did not make it into the report. The
    // workbook exists and is worth downloading; it is INCOMPLETE, and the code says so.
    // The shadow run deliberately does not participate: 05 §4.3 requires that a failure
    // there never fail the job.
    const counts = issues.counts();
    const exitCode = counts[SEVERITY.FAILED] > 0 ? EXIT.INCOMPLETO : EXIT.OK;

    io2.summary(formatSummary(result.stats, result.outputs, exitCode));
    io2.event({
        tipo: "resultado",
        ok: exitCode === EXIT.OK,
        exit: exitCode,
        periodo: result.stats.periodo,
        salidas: {
            reporte: result.outputs.reporte,
            metricas: result.outputs.metricas,
            consolidado: result.outputs.consolidado,
            runLog: result.outputs.runLog,
            erroresCsv: result.outputs.erroresCsv,
            shadowDiff: result.outputs.shadow && result.outputs.shadow.diff
                ? result.outputs.shadow.diff.path : null,
        },
        resumen: {
            archivos: result.stats.archivos,
            subcontratistas: result.stats.subcontratistas,
            filas: result.stats.filas,
            conservacion: result.stats.conservacion,
            incidencias: counts,
        },
        metricas: result.stats.metricas || null,
        shadow: result.stats.shadow || null,
    });
    return exitCode;
}

/**
 * Every throwing path, mapped to a code and to a message the operator can act on. A DATA
 * problem never arrives here - it is an issue in the list; these are caller and
 * environment errors only.
 */
function reportFailure(err, io, issues, period) {
    const counts = issues.counts();
    let exitCode = EXIT.SIN_REPORTE;
    let codigo = err && err.code ? err.code : (err && err.name) || "ERROR";
    const salidas = {};

    if (err instanceof RunError) {
        switch (err.code) {
            case RUN_ERROR.BUSY:
                exitCode = EXIT.OCUPADO;
                break;
            case RUN_ERROR.BAD_ARGUMENT:
            case RUN_ERROR.INPUT_NOT_FOUND:
            case RUN_ERROR.INPUT_UNSUPPORTED:
                exitCode = EXIT.USO;
                break;
            case RUN_ERROR.NO_RECORDS:
                exitCode = EXIT.SIN_REPORTE;
                // The run accepted nobody, but run.js still wrote the diagnosis. Point at
                // it: "no report" without a reason is the old pipeline's failure mode.
                if (err.detail && err.detail.runLog) salidas.runLog = err.detail.runLog;
                break;
            default:
                exitCode = EXIT.SIN_REPORTE;
        }
    } else if (err instanceof PeriodError) {
        exitCode = EXIT.USO;
    }

    io.log("");
    io.log(RULE);
    io.log(`NO SE GENERO EL REPORTE (${codigo})`);
    io.log(RULE);
    io.log(err && err.message ? err.message : String(err));
    if (err && err.detail && Array.isArray(err.detail.fallidos) && err.detail.fallidos.length > 0) {
        io.log("subcontratistas fallidos:");
        for (const name of err.detail.fallidos) io.log(`  - ${name}`);
    }
    io.log(`incidencias: INFO ${counts[SEVERITY.INFO]} | WARNING ${counts[SEVERITY.WARNING]} | ` +
        `ERROR ${counts[SEVERITY.ERROR]} | FAILED ${counts[SEVERITY.FAILED]}`);
    if (salidas.runLog) io.log(`el detalle quedo en ${salidas.runLog}`);
    if (exitCode === EXIT.SIN_REPORTE && !(err instanceof RunError) && err && err.stack) {
        io.log(err.stack);
    }
    io.log(RULE);

    io.event({
        tipo: "error",
        exit: exitCode,
        codigo,
        mensaje: err && err.message ? err.message : String(err),
        periodo: period ? period.key : null,
        detalle: err && err.detail ? err.detail : null,
        salidas,
        resumen: { incidencias: counts },
    });
    return exitCode;
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

if (require.main === module) {
    main(process.argv.slice(2))
        .then((code) => {
            // NOT process.exit(): stdout may be a pipe (server.js forks this file) and an
            // exit would truncate the last NDJSON line. Let the loop drain.
            process.exitCode = code;
        })
        .catch((err) => {
            process.stderr.write(`error inesperado en el CLI: ${err && err.stack ? err.stack : err}\n`);
            process.exitCode = EXIT.SIN_REPORTE;
        });
}

module.exports = {
    main,
    parseCliArgs,
    formatSummary,
    percentFor,
    UsageError,
    EXIT,
    HELP,
    OPTIONS,
};

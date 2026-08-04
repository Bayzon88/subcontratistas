"use strict";
/**
 * src/cli.js - the primary interface, exercised the way the operator and `server.js` use
 * it: by SPAWNING IT. Almost nothing here calls a function in-process, because the things
 * this file has to prove are process-level facts - the exit code, which stream a line went
 * to, and whether a workbook exists on disk afterwards.
 *
 * What this file exists to hold (05 §2.3, 03 §6.1 and §9 AC 23/24):
 *
 *   1. `--period` is REQUIRED and is never taken from the clock. The refusal names the
 *      month it would have guessed, so the operator confirms it instead of discovering it
 *      in the filename three weeks later. This is BUG-16 - `DICIEMBRE_2025` reports
 *      November - turned into a test.
 *   2. A period in the future is refused outright (05 §8 Q5).
 *   3. THE EXIT CODE DISTINGUISHES "the report was produced" from "the report was produced
 *      but a subcontratista is missing from it". A run over a folder holding an unreadable
 *      workbook exits NON-ZERO and STILL WRITES THE REPORT - both halves matter: the old
 *      pipeline answered 200 OK and dropped the company silently
 *      (src/excelConsolidation.js:74-77).
 *   4. stdout is machine-readable under `--json` and carries nothing else, so `server.js`
 *      can fork this file and stream the lines to SSE.
 *
 * ISOLATION. Every spawn gets its own `TMP_ROOT` (config.js reads it from the
 * environment), because the single-flight lock lives there and `run.test.js` asserts on
 * the default one - `node --test` runs the two files in parallel. Every spawn also gets
 * its own `--out`, so nothing here writes into `src/reportes`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const XLSX = require("xlsx");

const config = require("../config");
const { CANONICAL } = require("../pipeline/columns");
const { previousMonth } = require("../pipeline/period");
const { parseCliArgs, formatSummary, percentFor, UsageError, EXIT, HELP } = require("../cli");

const CLI = path.join(__dirname, "..", "cli.js");
const FIXTURES = path.join(__dirname, "..", "fixtures");
const MANIFEST = require("../fixtures/manifest.json");
const PERIOD = MANIFEST.period;                 // "2026-02"
const REPORTE = "Reporte_Subcontratistas_FEBRERO_2026.xlsx";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cli-test-"));
/** One TMP_ROOT for the whole file, away from the default the other suites assert on. */
const TMP_ROOT = path.join(TMP, "tmp-root");
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
const scratch = (name) => {
    const dir = path.join(TMP, `${name}-${seq++}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};

/* ------------------------------------------------------------------ *
 * Spawning
 * ------------------------------------------------------------------ */

/**
 * Run the real CLI in a real child process.
 * @returns {{code:number, stdout:string, stderr:string}}
 */
function cli(args, options = {}) {
    const r = spawnSync(process.execPath, [CLI, ...args], {
        encoding: "utf8",
        env: { ...process.env, TMP_ROOT: options.tmpRoot || TMP_ROOT },
        maxBuffer: 32 * 1024 * 1024,
        timeout: 120000,
    });
    if (r.error) throw r.error;
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

/** Synthetic identities. Serial dates, so the fixture does not depend on date parsing. */
function worker(i, over = {}) {
    return {
        "RUC": "20504039123",
        "EMPRESA": "SUBCONTRATA SINTETICA SAC",
        "CONTRATISTA PRNCIPAL": "COSAPI SA",
        "Nro. DNI / CE": String(10000000 + i),
        "APELLIDOS Y NOMBRES": `PEREZ GOMEZ JUAN ${i}`,
        "FECHA NACIMIENTO": 30000 + i,
        "TIPO TRABAJADOR": 1,
        "TITULO DE PUESTO/CARGO": "OPERARIO",
        "NOMBRE DE OBRA DONDE ESTA ASIGNADO DURANTE EL MES REPORTADO": "OBRA CENTRAL",
        "DOMICILIO DE TRABAJADOR": "AV LIMA 100",
        "DISTRITO SEGÚN DNI": "ATE",
        "GENERO": "masculino",
        "FECHA CESE/BAJA": null,
        "NACIONALIDAD": "PERUANA",
        "FECHA INICIO DE LABORES EN OBRA": 46054,     // 2026-02-01, inside the period
        "ESTADO": 1,
        "TIPO DE CONTRATO LABORAL": 2,
        "HPT": 180,
        ...over,
    };
}

function writeCuadro(filePath, rows) {
    const aoa = [CANONICAL.slice(), ...rows.map(r => CANONICAL.map(c => (r[c] === undefined ? null : r[c])))];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Cuadro");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    XLSX.writeFile(wb, filePath);
}

/** Two subcontratistas whose workbooks are readable. Five workers each, all distinct. */
function goodFolder(name = "entrada") {
    const root = scratch(name);
    writeCuadro(path.join(root, "ALFA CONTRATISTAS SAC", "personal.xlsx"),
        [1, 2, 3, 4, 5].map(i => worker(i)));
    writeCuadro(path.join(root, "BETA SERVICIOS SRL", "personal.xlsx"),
        [6, 7, 8, 9, 10].map(i => worker(i, { "EMPRESA": "BETA SERVICIOS SRL" })));
    return root;
}

/** The name of the subcontratista whose workbook cannot be opened at all. */
const ILEGIBLE = "GAMMA ILEGIBLE EIRL";

/** A folder that produces a report AND a FAILED issue: the exit-code-1 case. */
function folderWithUnreadableWorkbook() {
    const root = goodFolder("entrada-rota");
    const bad = path.join(root, ILEGIBLE);
    fs.mkdirSync(bad, { recursive: true });
    // Not a zip container at all, so `xlsx` cannot open it: WORKBOOK_UNREADABLE, FAILED,
    // named. The other two folders are untouched and must still reach the report.
    fs.writeFileSync(path.join(bad, "personal.xlsx"), "esto no es un libro de Excel\n");
    return root;
}

/* ------------------------------------------------------------------ *
 * 1. Arguments - no pipeline work happens in any of these
 * ------------------------------------------------------------------ */

test("--help documents the five exit codes and the flags the operator needs", () => {
    const r = cli(["--help"]);
    assert.equal(r.code, EXIT.OK);
    assert.equal(r.stdout, HELP, "la ayuda va a stdout, entera");

    // The codes are the contract with CI and with the operator (the brief: document them
    // in --help), so the test reads them out of the text rather than trusting a constant.
    assert.match(r.stdout, /Codigos de salida/);
    assert.match(r.stdout, /^\s*0\s+limpio/m);
    assert.match(r.stdout, /^\s*1\s+el reporte SE GENERO pero/m);
    assert.match(r.stdout, /^\s*2\s+error de uso/m);
    assert.match(r.stdout, /^\s*3\s+no se genero reporte/m);
    assert.match(r.stdout, /^\s*4\s+ya hay una corrida en curso/m);

    for (const flag of ["--input", "--period", "--out", "--shadow", "--template", "--json"]) {
        assert.ok(r.stdout.includes(flag), `--help menciona ${flag}`);
    }
    // And it says why the period is an argument, because that is the whole point.
    assert.match(r.stdout, /nunca se deduce del reloj/);
});

test("--version prints the package version", () => {
    const r = cli(["--version"]);
    assert.equal(r.code, EXIT.OK);
    assert.equal(r.stdout.trim(), require("../../package.json").version);
});

test("without --period it REFUSES to run and prints the month it would have guessed", () => {
    const input = goodFolder();
    const out = scratch("out-sin-periodo");
    const r = cli(["--input", input, "--out", out]);

    // Non-zero: silently defaulting to the wall clock is how the app came to name a
    // December file that reports November (BUG-16 / 03 §6.2).
    assert.equal(r.code, EXIT.USO);
    assert.match(r.stderr, /falta --period/);
    assert.match(r.stderr, /DICIEMBRE que reporta NOVIEMBRE|BUG-16/);

    // It suggests, it does not decide. The suggestion is exactly previousMonth(hoy).
    const sugerido = previousMonth(new Date());
    assert.ok(r.stderr.includes(sugerido), `sugiere ${sugerido}`);
    assert.match(r.stderr, new RegExp(`--period ${sugerido}`));

    // And nothing ran: no workbook, no side-car, not even an empty out dir entry.
    assert.deepEqual(fs.readdirSync(out), []);
});

test("a period in the future is refused outright", () => {
    const input = goodFolder();
    const out = scratch("out-futuro");
    const r = cli(["--input", input, "--period", "2099-01", "--out", out]);

    assert.equal(r.code, EXIT.USO);
    assert.match(r.stderr, /futuro/);
    assert.ok(r.stderr.includes("2099-01"));
    assert.deepEqual(fs.readdirSync(out), []);
});

test("a malformed period stops before anything is read", () => {
    for (const bad of ["2026-2", "febrero-2026", "2026/02", "2026-13", "2026-02-01"]) {
        const r = cli(["--input", goodFolder(), "--period", bad, "--out", scratch("out-mal")]);
        assert.equal(r.code, EXIT.USO, `--period ${bad}`);
        assert.match(r.stderr, /periodo invalido/);
    }
});

test("an unknown option, a positional, a missing input and a missing template are caller errors", () => {
    const input = goodFolder();

    const unknown = cli(["--input", input, "--period", PERIOD, "--refresh-pivots"]);
    assert.equal(unknown.code, EXIT.USO);
    assert.match(unknown.stderr, /--refresh-pivots/);

    const positional = cli([input, "--period", PERIOD]);
    assert.equal(positional.code, EXIT.USO);

    const noInput = cli(["--period", PERIOD]);
    assert.equal(noInput.code, EXIT.USO);
    assert.match(noInput.stderr, /falta --input/);

    const gone = cli(["--input", path.join(TMP, "no-existe"), "--period", PERIOD]);
    assert.equal(gone.code, EXIT.USO);
    assert.match(gone.stderr, /no existe la entrada/);

    const noTemplate = cli(["--input", input, "--period", PERIOD,
        "--template", path.join(TMP, "no-existe.xlsx")]);
    assert.equal(noTemplate.code, EXIT.USO);
    assert.match(noTemplate.stderr, /no existe la plantilla/);

    // Every one of them points at --help rather than at a stack trace.
    for (const r of [unknown, positional, noInput, gone, noTemplate]) {
        assert.match(r.stderr, /--help/);
        assert.equal(r.stdout, "", "un error de uso no ensucia stdout");
    }
});

test("parseCliArgs: the clock is an argument here too, so the refusals are testable", () => {
    const input = goodFolder();

    // `today` injected: no wall clock anywhere in this assertion.
    const plan = parseCliArgs(["--input", input, "--period", "2026-02"], "2026-08");
    assert.equal(plan.action, "run");
    assert.equal(plan.period.key, "2026-02");
    assert.equal(plan.period.filename, REPORTE);
    assert.equal(plan.inputPath, path.resolve(input));
    assert.equal(plan.outDir, config.REPORTES_DIR, "por defecto src/reportes");
    assert.equal(plan.templatePath, config.TEMPLATE);
    assert.equal(plan.identityKey, config.IDENTITY_KEY);
    assert.equal(plan.shadow, false);
    assert.equal(plan.writeConsolidated, true);

    // The current month is allowed: unfinished is not the same as future.
    assert.equal(parseCliArgs(["--input", input, "--period", "2026-08"], "2026-08").period.key, "2026-08");
    assert.throws(() => parseCliArgs(["--input", input, "--period", "2026-09"], "2026-08"),
        (err) => err instanceof UsageError && /futuro/.test(err.message));

    // The suggestion travels on the error, so the CLI and the server print the same thing.
    assert.throws(() => parseCliArgs(["--input", input], "2026-08"),
        (err) => {
            assert.ok(err instanceof UsageError);
            assert.equal(err.extra.codigo, "PERIOD_MISSING");
            assert.equal(err.extra.sugerido, "2026-07");
            return true;
        });

    assert.throws(() => parseCliArgs(["--input", input, "--period", PERIOD, "--identity-key", "nombre"], "2026-08"),
        (err) => err instanceof UsageError && /identity-key/.test(err.message));
    assert.equal(
        parseCliArgs(["--input", input, "--period", PERIOD, "--identity-key", "DNI"], "2026-08").identityKey,
        "dni", "se acepta en mayusculas y se normaliza");

    assert.equal(parseCliArgs(["--help"], "2026-08").action, "help");
    assert.equal(parseCliArgs(["--version"], "2026-08").action, "version");

    // The flags that only change what runPipeline is asked to do.
    const flags = parseCliArgs(
        ["--input", input, "--period", PERIOD, "--shadow", "--sin-consolidado", "--sin-csv",
            "--out", TMP, "--json", "--quiet"], "2026-08");
    assert.equal(flags.shadow, true, "--shadow se pasa a runPipeline");
    assert.equal(flags.writeConsolidated, false);
    assert.equal(flags.writeCsv, false);
    assert.equal(flags.outDir, path.resolve(TMP));
    assert.deepEqual(flags.flags, { json: true, quiet: true });
});

test("--shadow: the diff summary is what the parallel month is read from", () => {
    // The mode itself is covered end to end in run.test.js - it runs the OLD pipeline,
    // which writes into src/. What belongs here is the rendering: after two months of
    // parallel running, `bloquea` is the line the developer acts on (05 §4.5), and it must
    // not be buried in a file.
    const stats = {
        periodo: PERIOD,
        period: { mesNombre: "FEBRERO", year: 2026 },
        archivos: { vistos: 2, procesados: 2, fallidos: 0 },
        subcontratistas: { esperados: 2, leidos: 2, fallidos: 0, nombres: [] },
        filas: { leidas: 10, rechazadas: 0, colapsadas: 0, escritas: 10 },
        conservacion: { ok: true, formula: "leidas - rechazadas - colapsadas = escritas", esperado: 10, actual: 10 },
        incidencias: { INFO: 1, WARNING: 0, ERROR: 0, FAILED: 0 },
        shadow: { ok: true, error: null, diff: "/salida/x_shadow-diff.txt", bloquea: true },
    };
    const outputs = {
        reporte: "/salida/x.xlsx", metricas: "/salida/x.json", consolidado: "/salida/x_c.xlsx",
        runLog: "/salida/x_run.json", erroresCsv: "/salida/x.csv",
        shadow: {
            ok: true,
            diff: {
                ok: true, path: "/salida/x_shadow-diff.txt", json: "/salida/x_shadow-diff.json",
                valor: {
                    etapas: {
                        filas: { antiguas: 8816, nuevas: 5540, emparejadas: 5400, soloAntiguo: 3416, soloNuevo: 140, recuperadas: 140 },
                        celdas: { comparadas: 97200, divergentes: 12 },
                        computadas: { comparadas: 91800, divergentes: 5, sinValorCacheado: 3 },
                        pivotes: { ejecutado: false },
                        conteos: {},
                    },
                    recuperadasPorEmpresa: [{ empresa: "SUBCONTRATA RECUPERADA SAC", ruc: "20504039123", filas: 140 }],
                    totalDivergencias: 17, totalInesperadas: 2,
                },
            },
        },
    };

    const text = formatSummary(stats, outputs, EXIT.OK);
    assert.match(text, /Corrida en paralelo \(--shadow\)/);
    assert.match(text, /recuperadas 140 fila\(s\) de 1 empresa\(s\)/);
    assert.match(text, /divergencias 17 \| inesperadas 2/);
    assert.match(text, /BLOQUEA EL CUTOVER/);
    assert.match(text, /pivotes\s+NO EJECUTADO/);
    assert.ok(text.includes("/salida/x_shadow-diff.txt"), "dice donde quedo el diff");
    // The deliverable is never the shadow's.
    assert.match(text, /el archivo entregable es el del pipeline nuevo/);
});

test("the progress percentage never runs backwards inside a phase", () => {
    assert.equal(percentFor("inicio", 0, null), 0);
    assert.ok(percentFor("lectura", 1, 10) < percentFor("lectura", 9, 10));
    assert.ok(percentFor("lectura", 10, 10) <= percentFor("reporte", 0, null));
    assert.equal(percentFor("fin", 1, 1), 100);
    assert.equal(percentFor("fase-inventada", 1, 1), null);
});

/* ------------------------------------------------------------------ *
 * 2. A clean run
 * ------------------------------------------------------------------ */

test("a clean run: exit 0, and the summary says where all three outputs went", () => {
    const out = scratch("out-limpio");
    const r = cli(["--input", goodFolder(), "--period", PERIOD, "--out", out]);

    assert.equal(r.code, EXIT.OK, r.stderr);

    // The workbook, the side-car and the diffable intermediate, at the paths printed.
    const reporte = path.join(out, REPORTE);
    const metricas = path.join(out, "Reporte_Subcontratistas_FEBRERO_2026.json");
    const consolidado = path.join(out, "Reporte_Subcontratistas_FEBRERO_2026_Consolidado.xlsx");
    for (const p of [reporte, metricas, consolidado]) {
        assert.ok(fs.existsSync(p), `existe ${path.basename(p)}`);
        assert.ok(r.stdout.includes(p), `el resumen dice donde quedo ${path.basename(p)}`);
    }
    assert.ok(fs.statSync(reporte).size > 100_000, "el libro lleva la plantilla entera");

    // The facts the brief asks the summary to carry.
    assert.match(r.stdout, /Archivos\s+vistos 2 \| procesados 2 \| fallidos 0/);
    assert.match(r.stdout, /Subcontratistas\s+esperados 2 \| leidos 2 \| fallidos 0/);
    assert.match(r.stdout, /Filas\s+leidas 10 \| rechazadas 0 \| colapsadas 0 \| escritas 10/);
    assert.match(r.stdout, /Conservacion\s+OK/);
    assert.match(r.stdout, /leidas - rechazadas - colapsadas = escritas/);
    assert.match(r.stdout, /Incidencias\s+INFO \d+ \| WARNING \d+ \| ERROR \d+ \| FAILED 0/);
    assert.match(r.stdout, /exit 0/);

    // Progress went to stderr and the summary to stdout - they never mix.
    assert.match(r.stderr, /lectura 1\/2/);
    assert.match(r.stderr, /lectura 2\/2/);
    assert.ok(!r.stdout.includes("[ "), "el progreso no ensucia stdout");

    // The side-car is the artifact CI asserts determinism on, and it names the period.
    const sidecar = JSON.parse(fs.readFileSync(metricas, "utf8"));
    assert.equal(sidecar.periodo.key, PERIOD);
    assert.equal(sidecar.periodo.archivo, REPORTE);
});

test("--json: stdout is one JSON object per line and nothing else", () => {
    const out = scratch("out-json");
    const r = cli(["--input", goodFolder(), "--period", PERIOD, "--out", out, "--json", "--quiet"]);

    assert.equal(r.code, EXIT.OK, r.stderr);
    const lines = r.stdout.trim().split("\n");
    const events = lines.map((line, i) => {
        try { return JSON.parse(line); } catch (err) {
            assert.fail(`la linea ${i + 1} de stdout no es JSON: ${line.slice(0, 120)}`);
        }
    });

    // The shape server.js forks this file for.
    assert.equal(events[0].tipo, "inicio");
    assert.equal(events[0].periodo.key, PERIOD);
    assert.equal(events[0].periodo.archivo, REPORTE);

    const progreso = events.filter(e => e.tipo === "progreso");
    assert.ok(progreso.length >= 6, "hay progreso por fase");
    assert.ok(progreso.some(e => e.fase === "lectura" && e.total === 2));
    let last = -1;
    for (const e of progreso) {
        assert.ok(Number.isInteger(e.pct) && e.pct >= 0 && e.pct <= 100);
        assert.ok(e.pct >= last, `pct no retrocede (${e.fase} ${e.pct} tras ${last})`);
        last = e.pct;
    }
    assert.equal(progreso.at(-1).pct, 100);

    const resultado = events.at(-1);
    assert.equal(resultado.tipo, "resultado");
    assert.equal(resultado.ok, true);
    assert.equal(resultado.exit, EXIT.OK);
    // AC 23: the server serves THIS path verbatim rather than scanning a directory.
    assert.equal(resultado.salidas.reporte, path.join(out, REPORTE));
    assert.ok(fs.existsSync(resultado.salidas.reporte));
    assert.equal(resultado.resumen.filas.escritas, 10);
    assert.equal(resultado.resumen.incidencias.FAILED, 0);
    assert.equal(resultado.resumen.conservacion.ok, true);
    assert.ok(resultado.metricas, "las metricas de cabecera viajan en la linea final");

    // With stdout reserved for NDJSON, the human summary still reaches the operator.
    assert.match(r.stderr, /Conservacion\s+OK/);
});

test("re-running the same month is the same command: same names, identical side-car", () => {
    // 05 §2.3 - a subcontratista sends a corrected workbook three weeks late; the operator
    // reassembles the folder and re-runs with the SAME --period. Same period in, same
    // filename out (03 §7.5), overwritten deterministically.
    const input = goodFolder("entrada-rerun");
    const out = scratch("out-rerun");

    const first = cli(["--input", input, "--period", PERIOD, "--out", out, "--quiet"]);
    assert.equal(first.code, EXIT.OK, first.stderr);
    const metricas = path.join(out, "Reporte_Subcontratistas_FEBRERO_2026.json");
    const antes = fs.readFileSync(metricas, "utf8");
    const listadoAntes = fs.readdirSync(out).sort();

    const second = cli(["--input", input, "--period", PERIOD, "--out", out, "--quiet"]);
    assert.equal(second.code, EXIT.OK, second.stderr);

    assert.deepEqual(fs.readdirSync(out).sort(), listadoAntes, "no aparece un segundo juego de archivos");
    assert.equal(fs.readFileSync(metricas, "utf8"), antes,
        "el side-car depende del periodo y de la entrada, nunca del momento de la corrida");
});

/* ------------------------------------------------------------------ *
 * 3. Failure, and the exit code that tells the two failures apart
 * ------------------------------------------------------------------ */

test("an unreadable workbook: exit NON-ZERO, and the report is written anyway", () => {
    const out = scratch("out-ilegible");
    const r = cli(["--input", folderWithUnreadableWorkbook(), "--period", PERIOD, "--out", out]);

    // "the report was produced" vs "the report was produced but a subcontratista is
    // missing from it" - the whole reason the exit code is not just 0/1 on completion.
    assert.equal(r.code, EXIT.INCOMPLETO);

    const reporte = path.join(out, REPORTE);
    assert.ok(fs.existsSync(reporte), "el reporte SE ESCRIBE: los otros dos si se pudieron leer");
    assert.ok(fs.statSync(reporte).size > 100_000);
    assert.ok(fs.existsSync(path.join(out, "Reporte_Subcontratistas_FEBRERO_2026.json")));

    // And it is loud about who is missing - named, never a bare count (05 §1 principio 4).
    assert.match(r.stdout, /NO ENTRARON EN EL REPORTE/);
    assert.ok(r.stdout.includes(ILEGIBLE));
    assert.match(r.stdout, /Subcontratistas\s+esperados 3 \| leidos 2 \| fallidos 1/);
    assert.match(r.stdout, /FAILED 1/);
    assert.match(r.stdout, /exit 1/);

    // The two survivors still made it in, so a failure really is per-workbook.
    assert.match(r.stdout, /Filas\s+leidas 10 \|/);

    // The operator's copy of the exception list says the same thing.
    const csv = fs.readFileSync(path.join(out, "Reporte_Subcontratistas_FEBRERO_2026_Errores.csv"), "utf8");
    assert.ok(csv.includes(ILEGIBLE));
    assert.match(csv, /FAILED/);
});

test("a run that accepts nobody: exit 3, no empty workbook, but the diagnosis is written", () => {
    const root = scratch("entrada-vacia");
    fs.mkdirSync(path.join(root, ILEGIBLE), { recursive: true });
    fs.writeFileSync(path.join(root, ILEGIBLE, "personal.xlsx"), "esto no es un libro\n");
    const out = scratch("out-vacia");

    const r = cli(["--input", root, "--period", PERIOD, "--out", out, "--quiet"]);

    assert.equal(r.code, EXIT.SIN_REPORTE);
    assert.equal(fs.existsSync(path.join(out, REPORTE)), false, "no se fabrica un reporte vacio");

    const log = path.join(out, "Reporte_Subcontratistas_FEBRERO_2026_run.json");
    assert.ok(fs.existsSync(log), "pero el log de la corrida si se escribe");
    assert.ok(fs.readFileSync(log, "utf8").includes(ILEGIBLE));

    assert.match(r.stderr, /NO SE GENERO EL REPORTE \(NO_RECORDS\)/);
    assert.ok(r.stderr.includes(ILEGIBLE));
    assert.ok(r.stderr.includes(log), "y dice donde quedo el detalle");
});

test("a second run while one is in flight is refused with its own code", () => {
    if (config.ALLOW_CONCURRENT_RUNS) return;

    // A dedicated TMP_ROOT: the lock this test plants must not be seen by any other spawn.
    const tmpRoot = scratch("tmp-root-ocupado");
    // pid 1 always exists; `process.kill(1, 0)` answers EPERM, which the guard reads as
    // "alive, just not ours" - exactly the state a real concurrent run leaves behind.
    fs.writeFileSync(path.join(tmpRoot, "run.lock"),
        JSON.stringify({ pid: 1, periodo: PERIOD }) + "\n");

    const out = scratch("out-ocupado");
    const r = cli(["--input", goodFolder(), "--period", PERIOD, "--out", out, "--quiet"], { tmpRoot });

    assert.equal(r.code, EXIT.OCUPADO);
    assert.match(r.stderr, /una sola via|944 MB/);
    assert.deepEqual(fs.readdirSync(out), [], "una corrida rechazada no escribe nada");
});

test("--json reports a failure as one JSON object too", () => {
    const out = scratch("out-json-error");
    const r = cli(["--input", path.join(TMP, "no-existe"), "--period", PERIOD, "--out", out, "--json"]);

    assert.equal(r.code, EXIT.USO);
    const events = r.stdout.trim().split("\n").map(l => JSON.parse(l));
    assert.equal(events.length, 1);
    assert.equal(events[0].tipo, "error");
    assert.equal(events[0].exit, EXIT.USO);
    assert.equal(events[0].codigo, "INPUT_NOT_FOUND");
    assert.match(events[0].mensaje, /no existe la entrada/);
});

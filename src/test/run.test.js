"use strict";
/**
 * pipeline/run.js - the orchestrator, driven end to end.
 *
 * Everything here calls `runPipeline()` the way `src/cli.js` and `src/server.js` will:
 * a folder (or a zip) and a period in, a workbook, a side-car and a run log out. No stubs
 * on the primary path - the fixtures are the committed corpus of 03 §9 criterion 31 and
 * the synthetic tree is built with the same `xlsx` writer the subcontratistas' own files
 * come out of.
 *
 * The five claims this file exists to hold, all from the brief and from 05 §2.2:
 *
 *   1. conservation - leidas - rechazadas - colapsadas = escritas (03 §9 AC 7);
 *   2. a workbook with no `Cuadro` sheet is a FAILED issue that NAMES the subcontratista,
 *      appears in the summary and in the Errores sheet inside the delivered workbook, and
 *      does NOT abort the run;
 *   3. the per-run temp directory is gone afterwards - on the success path AND on the
 *      failure path (05 §7 step 9, BUG-43/BUG-44);
 *   4. the same input under two different system clocks produces a byte-identical side-car
 *      (03 §9 AC 26 - the determinism gate);
 *   5. the run is single-flight, because two template round-trips at ~944 MB RSS OOM the
 *      box (05 §4.3 mechanic 1).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const XLSX = require("xlsx");

const config = require("../config");
const { CANONICAL } = require("../pipeline/columns");
const { SEVERITY, CODE, IssueList } = require("../pipeline/issues");
const { PeriodError } = require("../pipeline/period");
const {
    runPipeline,
    isRunning,
    currentRun,
    RunError,
    RUN_ERROR,
    PHASE,
    erroresCsv,
    legacyOutputName,
} = require("../pipeline/run");

const FIXTURES = path.join(__dirname, "..", "fixtures");
const MANIFEST = require("../fixtures/manifest.json");
const PERIOD = MANIFEST.period;              // "2026-02"

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "run-test-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
const scratch = (name) => {
    const dir = path.join(TMP, `${name}-${seq++}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

/** The committed corpus as an upload: one folder per fixture, one workbook inside. */
function corpusFolder() {
    const root = scratch("corpus");
    for (const name of MANIFEST.workbooks) {
        const folder = path.join(root, name.toUpperCase().replace(/-/g, " "));
        fs.mkdirSync(folder, { recursive: true });
        fs.copyFileSync(path.join(FIXTURES, `${name}.xlsx`), path.join(folder, "lista.xlsx"));
    }
    return root;
}

/** Synthetic identities, real districts (they drive Hoja1's lookup). Dates are serials. */
function worker(i, over = {}) {
    return {
        "RUC": "20504039123",
        "EMPRESA": "SUBCONTRATA SINTETICA SAC",
        "CONTRATISTA PRNCIPAL": "COSAPI SA",
        "Nro. DNI / CE": String(10000000 + i),
        "APELLIDOS Y NOMBRES": `PEREZ GOMEZ JUAN ${i}`,
        "FECHA NACIMIENTO": 30000 + i,                  // 1982-02-2x
        "TIPO TRABAJADOR": 1,
        "TITULO DE PUESTO/CARGO": "OPERARIO",
        "NOMBRE DE OBRA DONDE ESTA ASIGNADO DURANTE EL MES REPORTADO": "OBRA CENTRAL",
        "DOMICILIO DE TRABAJADOR": "AV LIMA 100",
        "DISTRITO SEGÚN DNI": "ATE",
        "GENERO": "masculino",
        "FECHA CESE/BAJA": null,
        "NACIONALIDAD": "PERUANA",
        "FECHA INICIO DE LABORES EN OBRA": 46054,       // 2026-02-01, inside the period
        "ESTADO": 1,
        "TIPO DE CONTRATO LABORAL": 2,
        "HPT": 180,
        ...over,
    };
}

function writeCuadro(filePath, rows, sheetName = "Cuadro") {
    const aoa = [CANONICAL.slice(), ...rows.map(r => CANONICAL.map(c => (r[c] === undefined ? null : r[c])))];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheetName);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    XLSX.writeFile(wb, filePath);
}

/**
 * Four subcontratistas, and the arithmetic they are built to produce:
 *
 *   ALFA    5 filas, 5 aceptadas
 *   BETA    5 filas (una es el trabajador 3 de ALFA)          -> 1 colapsada, cruzada
 *   GAMMA   5 filas: 3 nuevas, 1 duplicada interna, 1 con     -> 1 rechazada, 1 colapsada
 *           APELLIDOS Y NOMBRES numerico (el bloque desplazado)
 *   SIN CUADRO  un libro sin hoja "Cuadro"                    -> FAILED, sin filas
 *
 *   leidas 15 - rechazadas 1 - colapsadas 2 = escritas 12
 */
function syntheticFolder() {
    const root = scratch("sintetico");
    writeCuadro(path.join(root, "CONSTRUCTORA ALFA SAC", "personal.xlsx"),
        [1, 2, 3, 4, 5].map(i => worker(i)));
    writeCuadro(path.join(root, "SERVICIOS BETA EIRL", "personal.xlsx"),
        [worker(6), worker(7), worker(8), worker(9), worker(3)]);
    writeCuadro(path.join(root, "MONTAJES GAMMA SA", "personal.xlsx"), [
        worker(10), worker(11), worker(12), worker(10),
        worker(13, { "APELLIDOS Y NOMBRES": 20101155588 }),
    ]);
    // 03 §9 criterion 1 / BUG-01: the workbook is readable, the sheet simply is not there.
    writeCuadro(path.join(root, "SUBCONTRATA SIN CUADRO", "personal.xlsx"),
        [worker(20)], "Hoja1");
    return root;
}

const SIN_CUADRO = "SUBCONTRATA SIN CUADRO";
const EXPECTED = Object.freeze({ leidas: 15, rechazadas: 1, colapsadas: 2, escritas: 12 });

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Runs the pipeline while recording every progress event. */
async function run(o) {
    const progress = [];
    const result = await runPipeline({ ...o, onProgress: (p) => progress.push(p) });
    result.progress = progress;
    return result;
}

/** The run directory, as reported by the LIMPIEZA phase - available on EVERY path. */
function runDirFrom(progress) {
    const limpieza = progress.filter(p => p.phase === PHASE.LIMPIEZA);
    assert.equal(limpieza.length, 1, "la fase de limpieza se emite exactamente una vez");
    return limpieza[0].message;
}

function texto(issue) {
    return `${issue.message} ${issue.subcontratista ?? ""} ${issue.archivo ?? ""}`;
}

/** The Errores sheet as it ships INSIDE the delivered workbook. */
function erroresSheetText(xlsxPath) {
    const wb = XLSX.readFile(xlsxPath, { sheets: ["Errores"], cellFormula: false, cellStyles: false });
    const ws = wb.Sheets["Errores"];
    assert.ok(ws, "el reporte entregado lleva la hoja Errores");
    return XLSX.utils.sheet_to_csv(ws);
}

/**
 * Freeze the system clock for the duration of `fn`. Deliberately crude and global: this is
 * exactly what AC 26 asks about - "two runs, a week apart, on machines with different
 * clocks" - and the only thing that may move as a result is a log line.
 */
async function withClock(iso, fn) {
    const Real = Date;
    const fixed = Real.parse(iso);
    class Frozen extends Real {
        constructor(...args) {
            if (args.length === 0) super(fixed);
            else super(...args);
        }
        static now() { return fixed; }
    }
    globalThis.Date = Frozen;
    try {
        return await fn();
    } finally {
        globalThis.Date = Real;
    }
}

/* ------------------------------------------------------------------ *
 * 1. The whole pipeline over the committed fixture corpus
 * ------------------------------------------------------------------ */

test("the fixture corpus runs end to end and produces every artifact", async () => {
    const outDir = scratch("out-corpus");
    const r = await run({ inputPath: corpusFolder(), period: PERIOD, outDir, identityKey: "name" });

    // Every artifact of 05 §2.2 is on disk, named from the PERIOD and nothing else.
    assert.equal(r.outputs.reporte, path.join(outDir, `Reporte_Subcontratistas_FEBRERO_2026.xlsx`));
    assert.equal(r.outputs.metricas, path.join(outDir, `Reporte_Subcontratistas_FEBRERO_2026.json`));
    for (const file of Object.values(r.outputs)) {
        if (typeof file === "string") assert.ok(fs.existsSync(file), `${file} existe`);
    }
    assert.ok(fs.existsSync(r.outputs.consolidado), "el intermedio diffable se escribe");
    assert.ok(fs.existsSync(r.outputs.runLog), "run.json se escribe");
    assert.ok(fs.existsSync(r.outputs.erroresCsv), "el CSV de Errores se escribe (03 §8.1)");

    // The two pathological fixtures are FAILED and named; the other fifteen are read.
    assert.deepEqual(r.stats.subcontratistas.nombres, ["DUPLICATE HEADER", "NO CUADRO SHEET"]);
    assert.equal(r.stats.subcontratistas.fallidos, 2);
    assert.equal(r.stats.subcontratistas.leidos, 15);
    assert.equal(r.stats.subcontratistas.esperados, 17);

    // Conservation over the corpus, whatever the corpus happens to contain.
    const f = r.stats.filas;
    assert.equal(f.leidas - f.rechazadas - f.colapsadas, f.escritas);
    assert.equal(f.escritas, r.records.length);
    assert.equal(r.stats.conservacion.ok, true);

    // The side-car reconciles with the same numbers.
    const metrics = JSON.parse(fs.readFileSync(r.outputs.metricas, "utf8"));
    assert.equal(metrics.proceso.filas.escritas, r.records.length);
    assert.equal(metrics.proceso.conservacion.ok, true);
    assert.equal(metrics.periodo.key, PERIOD);
    assert.deepEqual(r.stats.metricas, metrics.metricas,
        "las metricas de cabecera vuelven al llamador sin releer el archivo");

    // The temp directory is gone (success path).
    assert.equal(fs.existsSync(runDirFrom(r.progress)), false);
    assert.equal(r.stats.limpieza.ok, true);
});

test("a zip input is extracted, walked and consolidated on the same path", async () => {
    const outDir = scratch("out-zip");
    const zip = path.join(FIXTURES, "containers", "zip-macosx-resource-fork.zip");
    const r = await run({ inputPath: zip, period: PERIOD, outDir, identityKey: "name" });

    assert.equal(r.stats.entrada.tipo, "zip");
    assert.equal(r.stats.entrada.extraccion.extracted, 1, "solo el .xlsx real se extrae");
    assert.ok(r.stats.entrada.extraccion.skipped.macosx > 0, "__MACOSX/ y ._ se descartan");
    assert.ok(r.progress.some(p => p.phase === PHASE.EXTRACCION));
    assert.ok(fs.existsSync(r.outputs.reporte));
    assert.equal(fs.existsSync(runDirFrom(r.progress)), false, "la extraccion no sobrevive a la corrida");
});

/* ------------------------------------------------------------------ *
 * 2. The synthetic multi-subcontratista folder - the arithmetic
 * ------------------------------------------------------------------ */

test("the synthetic folder: conservation, dedupe and the cross-subcontratista report", async () => {
    const outDir = scratch("out-sintetico");
    const r = await run({ inputPath: syntheticFolder(), period: PERIOD, outDir, identityKey: "name" });

    assert.deepEqual(r.stats.filas, {
        leidas: EXPECTED.leidas,
        rechazadas: EXPECTED.rechazadas,
        aceptadas: EXPECTED.leidas - EXPECTED.rechazadas,
        colapsadas: EXPECTED.colapsadas,
        escritas: EXPECTED.escritas,
    });
    assert.equal(r.records.length, EXPECTED.escritas);
    assert.equal(r.stats.conservacion.ok, true);
    assert.equal(r.stats.conservacion.diferencia, 0);

    // The numeric name is a rejection with a reason, not a worker called 20101155588.
    const numeric = r.issues.byCode(CODE.ROW_NUMERIC_NAME);
    assert.equal(numeric.length, 1);
    assert.equal(numeric[0].subcontratista, "MONTAJES GAMMA SA");

    // One duplicate inside a folder (INFO) and one across two (WARNING - the `Dos
    // Subcontratas por Mes` population, which must stay visible).
    const collapsed = r.issues.byCode(CODE.DUPLICATE_COLLAPSED);
    assert.equal(collapsed.length, 2);
    assert.equal(collapsed.filter(i => i.severity === SEVERITY.WARNING).length, 1);
    assert.equal(r.stats.crossSubcontratista, 1);

    // Provenance survives to the output (03 §9 AC 5).
    for (const record of r.records) {
        assert.ok(record.provenance, "cada registro conserva su procedencia");
        assert.ok(record.provenance.subcontratista);
        assert.equal(record.provenance.hoja, "Cuadro");
    }

    // Progress: one LECTURA event per workbook walked, in order, with a total.
    const lecturas = r.progress.filter(p => p.phase === PHASE.LECTURA);
    assert.equal(lecturas.length, 4);
    assert.deepEqual(lecturas.map(p => p.current), [1, 2, 3, 4]);
    assert.ok(lecturas.every(p => p.total === 4));
    assert.deepEqual(
        r.progress.filter(p => p.phase === PHASE.REPORTE).map(p => p.message),
        ["Reporte_Subcontratistas_FEBRERO_2026.xlsx"]);
});

/* ------------------------------------------------------------------ *
 * 3. Loud failure, never silent loss
 * ------------------------------------------------------------------ */

test("a folder whose workbook has no Cuadro sheet FAILS loudly, by name, and the run finishes", async () => {
    const outDir = scratch("out-fallo");
    const r = await run({ inputPath: syntheticFolder(), period: PERIOD, outDir, identityKey: "name" });

    // (a) a FAILED issue that names the subcontratista, the file and the sheets present
    const failed = r.issues.bySeverity(SEVERITY.FAILED);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].code, CODE.SHEET_NOT_FOUND);
    assert.equal(failed[0].subcontratista, SIN_CUADRO);
    assert.ok(texto(failed[0]).includes(SIN_CUADRO));
    assert.ok(failed[0].message.includes("Hoja1"), "nombra las hojas que SI existen");

    // (b) named in the summary, never a bare count
    assert.deepEqual(r.stats.subcontratistas.nombres, [SIN_CUADRO]);
    assert.equal(r.stats.subcontratistas.fallidos, 1);
    assert.equal(r.stats.archivos.fallidos, 1);

    // (c) the run completed anyway - one pass, every problem
    assert.ok(fs.existsSync(r.outputs.reporte));
    assert.equal(r.records.length, EXPECTED.escritas);

    // (d) and the delivered workbook carries the incompleteness where the operator looks
    const errores = erroresSheetText(r.outputs.reporte);
    assert.ok(errores.includes(SIN_CUADRO), "la hoja Errores nombra al subcontratista fallido");
    assert.ok(/FALLID|FAILED/i.test(errores), "la hoja Errores marca el estado del run");

    // (e) run.json says the same thing, structurally
    const log = JSON.parse(fs.readFileSync(r.outputs.runLog, "utf8"));
    assert.equal(log.resumen.subcontratistas.fallidos, 1);
    assert.ok(JSON.stringify(log).includes(SIN_CUADRO));

    // (f) the CSV of 03 §8.1 is the same table, comma-separated
    const csv = fs.readFileSync(r.outputs.erroresCsv, "utf8");
    assert.ok(csv.includes(SIN_CUADRO));
    assert.ok(csv.includes("SHEET_NOT_FOUND"));
});

test("a run that accepts nobody fails loudly - and still writes the diagnosis", async () => {
    const root = scratch("vacio");
    writeCuadro(path.join(root, SIN_CUADRO, "personal.xlsx"), [worker(1)], "Hoja1");
    const outDir = scratch("out-vacio");

    const progress = [];
    await assert.rejects(
        () => runPipeline({ inputPath: root, period: PERIOD, outDir, onProgress: p => progress.push(p) }),
        (err) => {
            assert.ok(err instanceof RunError);
            assert.equal(err.code, RUN_ERROR.NO_RECORDS);
            assert.ok(err.message.includes(SIN_CUADRO), "nombra al culpable en el propio error");
            return true;
        });

    // No empty workbook was manufactured...
    assert.equal(fs.existsSync(path.join(outDir, "Reporte_Subcontratistas_FEBRERO_2026.xlsx")), false);
    // ...but the operator still gets the reasons.
    const log = path.join(outDir, "Reporte_Subcontratistas_FEBRERO_2026_run.json");
    assert.ok(fs.existsSync(log));
    assert.ok(fs.readFileSync(log, "utf8").includes(SIN_CUADRO));

    // The temp directory is gone on the FAILURE path too (BUG-44: the old cleanup was
    // commented out on the error path and bricked the next run).
    assert.equal(fs.existsSync(runDirFrom(progress)), false);
    assert.equal(isRunning(), false, "el cerrojo se libera aunque la corrida falle");
    assert.equal(fs.existsSync(path.join(config.TMP_ROOT, "run.lock")), false);
});

test("conservation is asserted, and a broken one is a FAILED issue rather than a silence", async () => {
    const outDir = scratch("out-conservacion");
    const r = await run({ inputPath: syntheticFolder(), period: PERIOD, outDir, identityKey: "name" });

    // The identity, restated three times over: the run, the side-car and the run log.
    const f = r.stats.filas;
    assert.equal(f.leidas - f.rechazadas - f.colapsadas, f.escritas);
    assert.equal(r.issues.byCode(CODE.CONSERVATION_BROKEN).length, 0);

    const metrics = JSON.parse(fs.readFileSync(r.outputs.metricas, "utf8"));
    assert.deepEqual(metrics.proceso.filas, {
        leidas: f.leidas, rechazadas: f.rechazadas, colapsadas: f.colapsadas, escritas: f.escritas,
    });
    const log = JSON.parse(fs.readFileSync(r.outputs.runLog, "utf8"));
    assert.equal(log.resumen.conservacion.estado, "OK");
    assert.equal(log.resumen.conservacion.escritas, f.escritas);
    assert.deepEqual(log.resumen.filas, {
        leidas: f.leidas, rechazadas: f.rechazadas, colapsadas: f.colapsadas, escritas: f.escritas,
    });

    // And the code exists, so the mismatch has somewhere to be reported.
    assert.equal(CODE.CONSERVATION_BROKEN, "CONSERVATION_BROKEN");
    const issues = new IssueList();
    issues.failed({ code: CODE.CONSERVATION_BROKEN, message: "prueba" });
    assert.equal(issues.hasBlockingIssues(), true);
});

/* ------------------------------------------------------------------ *
 * 4. Determinism - 03 §9 AC 26
 * ------------------------------------------------------------------ */

test("the same input twice under two different system clocks: identical side-car", async () => {
    const input = syntheticFolder();
    const outA = scratch("out-reloj-a");
    const outB = scratch("out-reloj-b");

    const a = await withClock("2026-03-04T12:21:00Z",
        () => run({ inputPath: input, period: PERIOD, outDir: outA, identityKey: "name" }));
    const b = await withClock("2027-11-19T23:05:00Z",
        () => run({ inputPath: input, period: PERIOD, outDir: outB, identityKey: "name" }));

    const sidecarA = fs.readFileSync(a.outputs.metricas, "utf8");
    const sidecarB = fs.readFileSync(b.outputs.metricas, "utf8");
    assert.equal(sidecarA, sidecarB, "el side-car no depende del reloj (03 §9 AC 26)");

    // Same for the run log: 05 §2.2 keeps the clock out of both artifacts.
    assert.equal(fs.readFileSync(a.outputs.runLog, "utf8"), fs.readFileSync(b.outputs.runLog, "utf8"));

    // And the filenames come from the PERIOD, not from the month the run happens in.
    assert.equal(path.basename(a.outputs.reporte), path.basename(b.outputs.reporte));
    assert.equal(path.basename(a.outputs.reporte), "Reporte_Subcontratistas_FEBRERO_2026.xlsx");
});

/* ------------------------------------------------------------------ *
 * 5. Arguments, the period, and the single-flight guard
 * ------------------------------------------------------------------ */

test("a malformed period stops the run before a single file is read", async () => {
    // The input does not exist: if the period were validated second, this would fail with
    // INPUT_NOT_FOUND instead.
    await assert.rejects(
        () => runPipeline({ inputPath: path.join(TMP, "no-existe"), period: "febrero-2026" }),
        PeriodError);
    await assert.rejects(
        () => runPipeline({ inputPath: path.join(TMP, "no-existe"), period: "2026-13" }),
        PeriodError);
    await assert.rejects(
        () => runPipeline({ inputPath: path.join(TMP, "no-existe") }),
        (err) => err instanceof RunError && err.code === RUN_ERROR.BAD_ARGUMENT);
});

test("a missing or unsupported input is a caller error, not an empty report", async () => {
    await assert.rejects(
        () => runPipeline({ inputPath: path.join(TMP, "no-existe"), period: PERIOD }),
        (err) => err instanceof RunError && err.code === RUN_ERROR.INPUT_NOT_FOUND);

    const notAZip = path.join(scratch("suelto"), "lista.txt");
    fs.writeFileSync(notAZip, "no soy un zip");
    await assert.rejects(
        () => runPipeline({ inputPath: notAZip, period: PERIOD }),
        (err) => err instanceof RunError && err.code === RUN_ERROR.INPUT_UNSUPPORTED);
});

test("single-flight: a second run is refused while one is in flight", async (t) => {
    if (config.ALLOW_CONCURRENT_RUNS) return t.skip("ALLOW_CONCURRENT_RUNS esta activo");

    const input = syntheticFolder();
    assert.equal(isRunning(), false);

    const first = runPipeline({ inputPath: input, period: PERIOD, outDir: scratch("out-flight-1") });
    assert.equal(isRunning(), true, "el cerrojo se toma antes del primer await");
    assert.equal(currentRun().period, PERIOD);
    assert.ok(fs.existsSync(path.join(config.TMP_ROOT, "run.lock")), "y deja un cerrojo entre procesos");

    await assert.rejects(
        () => runPipeline({ inputPath: input, period: PERIOD, outDir: scratch("out-flight-2") }),
        (err) => {
            assert.ok(err instanceof RunError);
            assert.equal(err.code, RUN_ERROR.BUSY);
            assert.ok(/944 MB|una sola via/.test(err.message));
            return true;
        });

    await first;
    assert.equal(isRunning(), false, "y se libera al terminar");
    assert.equal(currentRun(), null);
    assert.equal(fs.existsSync(path.join(config.TMP_ROOT, "run.lock")), false);
});

test("a stale lock from a dead process is reclaimed, not a permanent brick", async () => {
    const lock = path.join(config.TMP_ROOT, "run.lock");
    fs.mkdirSync(config.TMP_ROOT, { recursive: true });
    // A pid that cannot be alive: 2^22 is above every default pid_max.
    fs.writeFileSync(lock, JSON.stringify({ pid: 4194304, periodo: "2026-01" }) + "\n");

    const r = await run({
        inputPath: syntheticFolder(), period: PERIOD, outDir: scratch("out-stale"), identityKey: "name",
    });
    assert.ok(fs.existsSync(r.outputs.reporte));
    assert.equal(fs.existsSync(lock), false);
});

test("a throwing onProgress callback never takes the run with it", async () => {
    const outDir = scratch("out-progress");
    const r = await runPipeline({
        inputPath: syntheticFolder(),
        period: PERIOD,
        outDir,
        identityKey: "name",
        onProgress: () => { throw new Error("la UI se cayo"); },
    });
    assert.ok(fs.existsSync(r.outputs.reporte));
});

test("the caller's IssueList is the one that is filled", async () => {
    const issues = new IssueList();
    const r = await run({
        inputPath: syntheticFolder(), period: PERIOD, outDir: scratch("out-issues"),
        identityKey: "name", issues,
    });
    assert.equal(r.issues, issues);
    assert.ok(issues.length > 0);
    assert.equal(issues.hasBlockingIssues(), true, "el libro sin Cuadro es bloqueante");
});

/* ------------------------------------------------------------------ *
 * 6. Shadow mode - 05 Fase 5 tarea 8, §4.3
 * ------------------------------------------------------------------ */

test("shadow mode runs the OLD pipeline over the same extraction and diffs the pair", async () => {
    const outDir = scratch("out-shadow");
    const repoConsolidado = path.join(config.SRC, "ReporteConsolidado.xlsx");
    const before = fs.existsSync(repoConsolidado) ? fs.statSync(repoConsolidado).size : null;
    const reportesBefore = fs.existsSync(config.REPORTES_DIR) ? fs.readdirSync(config.REPORTES_DIR).sort() : [];

    const seen = [];
    const input = syntheticFolder();
    const r = await run({
        inputPath: input,
        period: PERIOD,
        outDir,
        identityKey: "name",
        shadow: {
            diff: (viejo, nuevo) => {
                seen.push([viejo, nuevo]);
                return `viejo=${path.basename(viejo)}\nnuevo=${path.basename(nuevo)}\n`;
            },
        },
    });

    const shadow = r.outputs.shadow;
    assert.equal(shadow.ok, true, shadow.error || "");
    assert.deepEqual(shadow.warnings, []);

    // Two workbooks were produced and the diff was written beside the month's output.
    assert.equal(seen.length, 1);
    assert.equal(shadow.diff.ok, true);
    assert.ok(fs.existsSync(shadow.diff.path));
    assert.ok(fs.readFileSync(shadow.diff.path, "utf8").includes("nuevo=Reporte_Subcontratistas_FEBRERO_2026.xlsx"));

    // The delivered file is the PRIMARY pipeline's, untouched.
    assert.equal(r.outputs.reporte, path.join(outDir, "Reporte_Subcontratistas_FEBRERO_2026.xlsx"));
    assert.ok(fs.existsSync(r.outputs.reporte));

    // The old pipeline's own output does not survive the job (05 §4.3: nothing is kept
    // but the diff), and neither does its staging directory.
    assert.equal(fs.existsSync(shadow.path), false);
    assert.equal(fs.existsSync(runDirFrom(r.progress)), false);
    const staging = path.join(config.SRC, "subcontratistas");
    assert.deepEqual(fs.existsSync(staging) ? fs.readdirSync(staging) : [], []);

    // It consumed the SAME extraction, which the symlink protects from its own cleanup.
    assert.ok(fs.existsSync(path.join(input, "CONSTRUCTORA ALFA SAC", "personal.xlsx")));

    // The two files the old pipeline overwrites by hard-coded path are back as they were.
    assert.equal(fs.existsSync(repoConsolidado) ? fs.statSync(repoConsolidado).size : null, before);
    assert.deepEqual(
        fs.existsSync(config.REPORTES_DIR) ? fs.readdirSync(config.REPORTES_DIR).sort() : [],
        reportesBefore, "src/reportes queda como estaba");

    // Its only diagnostic - `console.log("Error with: " + directory)` - is captured rather
    // than wiped by the console.clear() at excelConsolidation.js:284.
    assert.ok(shadow.salida.length > 0);
    assert.ok(shadow.salida.some(line => line.includes("Progress")));
});

test("a shadow failure is reported and never fails the job", async () => {
    const outDir = scratch("out-shadow-roto");
    const r = await run({
        inputPath: syntheticFolder(),
        period: PERIOD,
        outDir,
        identityKey: "name",
        shadow: { diff: () => { throw new Error("diff-reports exploto"); } },
    });

    assert.ok(fs.existsSync(r.outputs.reporte), "el reporte entregado no depende del shadow");
    assert.equal(r.outputs.shadow.ok, true, "el pipeline antiguo si corrio");
    assert.equal(r.outputs.shadow.diff.ok, false);
    assert.ok(r.outputs.shadow.diff.motivo.includes("diff-reports exploto"));
});

test("the default shadow path invokes tools/diff-reports.js itself", async () => {
    const outDir = scratch("out-shadow-real");
    const r = await run({
        inputPath: syntheticFolder(), period: PERIOD, outDir, identityKey: "name", shadow: true,
    });

    // The pair is produced either way, and the deliverable is the primary pipeline's.
    assert.equal(r.outputs.shadow.ok, true, r.outputs.shadow.error || "");
    assert.ok(fs.existsSync(r.outputs.reporte));

    const diff = r.outputs.shadow.diff;
    if (!fs.existsSync(path.join(config.ROOT, "tools", "diff-reports.js"))) {
        // 05 Fase 0 tarea 5 has not landed: named, never silent.
        assert.equal(diff.ok, false);
        assert.ok(diff.motivo.includes("diff-reports.js"));
        return;
    }

    assert.equal(diff.ok, true, diff.motivo || "");
    assert.ok(["modulo", "proceso"].includes(diff.herramienta));
    assert.ok(fs.existsSync(diff.path), "el informe de texto queda junto al reporte del mes");
    if (diff.herramienta === "modulo") {
        assert.ok(fs.existsSync(diff.json), "y el objeto clasificado, para releerlo sin re-correr");
        assert.equal(typeof r.stats.shadow.bloquea, "boolean",
            "una divergencia INESPERADA bloquea el cutover y el orquestador lo dice");
    }
    // ARGUMENT ORDER: antiguo primero. The tool prints the old workbook's own filename,
    // which the wall clock named and which is never the period's.
    const informe = fs.readFileSync(diff.path, "utf8");
    assert.ok(informe.includes(legacyOutputName()), "el lado 'antiguo' es la salida del pipeline viejo");
    assert.ok(informe.includes("Reporte_Subcontratistas_FEBRERO_2026.xlsx"), "y el 'nuevo' es el del periodo");
});

test("legacyOutputName reproduces excelReporting.js:69-77 exactly", () => {
    // The replica exists to LOCATE and PROTECT the file the old pipeline names from the
    // wall clock. If it drifts, shadow mode stops protecting the deliverable.
    const date = new Date();
    const month = date.getMonth() - 1;
    const newDate = new Date(date.getFullYear(), month, 1);
    const monthString = newDate.toLocaleString("es-ES", { month: "long" }).toUpperCase();
    const year = monthString === "DICIEMBRE" ? date.getFullYear() - 1 : date.getFullYear();
    assert.equal(legacyOutputName(), `Reporte_Subcontratistas_${monthString}_${year}.xlsx`);
});

/* ------------------------------------------------------------------ *
 * 7. The CSV renderer
 * ------------------------------------------------------------------ */

test("erroresCsv quotes what needs quoting and nothing else", () => {
    const csv = erroresCsv([
        ["subcontratista", "motivo"],
        ["ALFA SAC", 'dijo "hola"'],
        ["BETA, EIRL", "linea 1\nlinea 2"],
        [null, 3],
    ]);
    assert.equal(csv,
        "subcontratista,motivo\r\n"
        + 'ALFA SAC,"dijo ""hola"""\r\n'
        + '"BETA, EIRL","linea 1\nlinea 2"\r\n'
        + ",3\r\n");
});

"use strict";
/**
 * tools/diff-reports.js - the parallel-run gate.
 *
 * WHAT THESE TESTS ARE, AND WHAT THEY ARE NOT
 * -------------------------------------------
 * Every workbook below is BUILT HERE, in this file, from a handful of synthetic rows. None
 * of them is a baseline, and none of them is a real month: there is no historical corpus
 * and there never will be one (05-implementation-plan.md §4.6). What is under test is the
 * TOOL - that it keys rows the way §4.4 item 1 says, that it reports a type change as a
 * type change and never as an inequality (§4.4 item 2), that every divergence it emits is
 * classified against the frozen list of §4.5, and that an unclassified one makes the exit
 * code non-zero. The pipeline's own correctness is proved by the fixture corpus and the
 * structural assertions, not here.
 *
 * The Phase 0 task 5 self-test ("a file against a copy of itself must report zero
 * differences; two genuinely different workbooks must report a large one") is the first
 * suite below, and it carries the same caveat: it exercises the script.
 */

const test = require("node:test");
const { after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const XLSX = require("xlsx");
const JSZip = require("jszip");

const diff = require("../../tools/diff-reports");
const { CANONICAL, INDEX_BY_CANONICAL } = require("../pipeline/columns");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "diff-reports-test-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
function outPath(name) {
    return path.join(TMP, `${String(++seq).padStart(3, "0")}-${name}.xlsx`);
}

/* ------------------------------------------------------------------ *
 * Workbook builders
 * ------------------------------------------------------------------ */

const COMPUTED = diff.COMPUTED_COLUMNS_AI;
const HEADERS = CANONICAL.concat(COMPUTED.map((c) => c.name));

/** A raw row as an object keyed by canonical name; absent keys become empty cells. */
function fila(overrides = {}) {
    const r = {};
    for (const c of CANONICAL) r[c] = null;
    return Object.assign(r, overrides);
}

/** A worker with a full, plausible, entirely synthetic identity. */
function trabajador(n, over = {}) {
    return fila(Object.assign({
        RUC: "20100000001",
        EMPRESA: "CONSTRUCTORA SINTETICA SAC",
        "CONTRATISTA PRNCIPAL": "CONSTRUCTORA SINTETICA SAC",
        "Nro. DNI / CE": `4000000${n}`,
        "APELLIDOS Y NOMBRES": `PEREZ SINTETICO TRABAJADOR ${n}`,
        "FECHA NACIMIENTO": 30000 + n,
        GENERO: "masculino",
        "DISTRITO SEGÚN DNI": "ATE",
        "FECHA INICIO DE LABORES EN OBRA": 45000,
        ESTADO: 1,
        HPT: 100,
    }, over));
}

/**
 * Write a workbook with a `Cuadro` sheet, and optionally the pivot sheets.
 *
 * `filas` is an array of `{raw, comp}` where `raw` is a canonical-keyed object and `comp`
 * maps a computed column letter to either a scalar (a literal) or `{f, v}` (a formula,
 * with `v` omitted for the cached-value-stripped shape xlsx-populate always produces).
 */
function escribirLibro(file, filas, opciones = {}) {
    const aoa = [HEADERS.slice()];
    for (const _f of filas) aoa.push(new Array(HEADERS.length).fill(null));
    const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: false });

    filas.forEach((entrada, i) => {
        const r = i + 1;
        const raw = entrada.raw || {};
        for (const nombre of CANONICAL) {
            const c = INDEX_BY_CANONICAL.get(nombre);
            const addr = XLSX.utils.encode_cell({ r, c });
            const v = raw[nombre];
            if (v === null || v === undefined) { delete ws[addr]; continue; }
            ws[addr] = celda(v);
        }
        const comp = entrada.comp || {};
        for (const col of COMPUTED) {
            const addr = `${col.letter}${r + 1}`;
            const v = comp[col.letter];
            if (v === undefined) { delete ws[addr]; continue; }
            if (v !== null && typeof v === "object" && "f" in v) {
                ws[addr] = v.v === undefined
                    ? { t: "s", v: "", f: v.f }        // formula, cached <v> stripped
                    : Object.assign(celda(v.v), { f: v.f });
                continue;
            }
            if (v === null) { delete ws[addr]; continue; }
            ws[addr] = celda(v);
        }
    });

    ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: filas.length, c: HEADERS.length - 1 } });

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Cuadro");
    for (const [nombre, datos] of Object.entries(opciones.hojas || {})) {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(datos), nombre);
    }
    XLSX.writeFile(wb, file, { bookType: "xlsx" });
    return file;
}

function celda(v) {
    if (typeof v === "number") return { t: "n", v };
    if (typeof v === "boolean") return { t: "b", v };
    if (v && typeof v === "object" && v.error) return { t: "e", v: 0x0f, w: "#VALUE!" };
    return { t: "s", v: String(v) };
}

/**
 * Inject a STUB `xl/pivotCache/pivotCacheDefinition1.xml` so the tool has a
 * `refreshedDate` to judge. It is a few bytes of XML with the three attributes
 * `readZipMeta` regex-scans and nothing else - not a real pivot cache, and never opened
 * by Excel. Real pivot parts are never written by anything in this repo (05 §6 row 1).
 */
async function inyectarCache(file, { refreshedDate, refreshedBy = "Operador", refreshOnLoad = false }) {
    const zip = await JSZip.loadAsync(await fs.promises.readFile(file));
    zip.file(
        "xl/pivotCache/pivotCacheDefinition1.xml",
        `<?xml version="1.0" encoding="UTF-8"?><pivotCacheDefinition refreshedBy="${refreshedBy}" ` +
        `refreshedDate="${refreshedDate}" refreshOnLoad="${refreshOnLoad ? 1 : 0}" recordCount="10"/>`
    );
    await fs.promises.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
    return file;
}

/** The side-car shape metrics.js publishes, reduced to what the diff reads. */
function sidecar(over = {}) {
    return Object.assign({
        version: 1,
        tipo: "metricas",
        periodo: { key: "2026-02", etiqueta: "2-2026" },
        metricas: {
            headcount: { filas: 2, sumaTrabajadoresUnicos: 2 },
            porZonaGenero: {
                zonas: [{ zona: "ATE", femenino: 0, masculino: 2, total: 2 }],
                totales: { femenino: 0, masculino: 2 }, total: 2,
            },
            bajas: { zonas: [], totales: { femenino: 0, masculino: 0 }, total: 0, enPeriodo: 0 },
            altas: { zonas: [], totales: { femenino: 0, masculino: 0 }, total: 0 },
            cjvEpc: { grupos: [{ epc: "CJV", valor: 2 }], total: 2 },
            horas: { grupos: [{ epc: "CJV", valor: 200 }], total: 200 },
            contratistas: { suma: 1, distintos: 1 },
            excepciones: {
                listas: {
                    edad: { sinFecha: 0, rangos: [{ rango: "24 - 31", filas: 2 }] },
                    identificadores: { sinRuc: 0, validarDniCorregir: 0 },
                    dosSubcontratistas: { grupos: 0 },
                },
            },
        },
        proceso: { filas: { leidas: 2, rechazadas: 0, colapsadas: 0, escritas: 2 }, conservacion: { ok: true, verificable: true } },
    }, over);
}

function escribirSidecar(nombre, contenido) {
    const p = path.join(TMP, `${nombre}.json`);
    fs.writeFileSync(p, JSON.stringify(contenido, null, 2));
    return p;
}

/** Run `main()` with stdout/stderr captured, so exercising the CLI does not scribble
 *  over the test runner's own output. Returns `{code, out, err}`. */
async function correrCli(argv) {
    const salida = { out: "", err: "" };
    const so = process.stdout.write.bind(process.stdout);
    const se = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk) => { salida.out += chunk; return true; };
    process.stderr.write = (chunk) => { salida.err += chunk; return true; };
    try {
        salida.code = await diff.main(argv);
    } finally {
        process.stdout.write = so;
        process.stderr.write = se;
    }
    return salida;
}

/** Classes of a result, as `{id: total}`. */
function clases(res) {
    const out = {};
    for (const c of res.clases) out[c.id] = c.total;
    return out;
}

function divergenciasDe(res, clase) {
    return res.clases.filter((c) => c.id === clase).flatMap((c) => c.ejemplos);
}

/* ================================================================== *
 * 1. The Phase 0 task 5 self-test
 * ================================================================== */

test("autoprueba (05 Phase 0 task 5)", async (t) => {
    // NOTE: this exercises the SCRIPT. It is not a correctness gate on the pipeline, and
    // neither workbook is a baseline - there is none (05 §4.6).
    const a = escribirLibro(outPath("auto-a"), [
        { raw: trabajador(1) }, { raw: trabajador(2) }, { raw: trabajador(3) },
    ]);
    const b = escribirLibro(outPath("auto-b"), [
        { raw: trabajador(9, { EMPRESA: "OTRA EMPRESA SAC", RUC: "20999999999" }) },
    ]);

    await t.test("un archivo contra una COPIA de si mismo: cero diferencias", async () => {
        const res = await diff.selfTest(a, null);
        assert.equal(res.identidad.divergencias, 0);
        assert.equal(res.identidad.ok, true);
        assert.equal(res.ok, true);
    });

    await t.test("dos libros genuinamente distintos: una diferencia grande", async () => {
        const res = await diff.selfTest(a, b);
        assert.equal(res.identidad.ok, true);
        assert.ok(res.distinto.divergencias > 0, "esperaba divergencias entre libros distintos");
        assert.equal(res.distinto.ok, true);
        assert.equal(res.ok, true);
    });

    await t.test("la nota deja claro que no es una linea base", async () => {
        const res = await diff.selfTest(a, null);
        assert.match(res.nota, /no es una prueba de correccion del pipeline/i);
        assert.match(res.nota, /linea base/i);
    });

    await t.test("una copia byte a byte tambien pasa por la CLI", async () => {
        const { code } = await correrCli(["--self-test", a, b]);
        assert.equal(code, diff.EXIT.OK);
    });
});

/* ================================================================== *
 * 2. Stage 1 - the multiset over Cuadro!A:R
 * ================================================================== */

test("etapa 1: multiset sobre las 18 columnas crudas", async (t) => {
    await t.test("la clave son las cuatro columnas de §4.4 item 1", () => {
        assert.deepEqual(diff.KEY_COLUMNS, [
            "RUC", "Nro. DNI / CE", "APELLIDOS Y NOMBRES", "FECHA INICIO DE LABORES EN OBRA",
        ]);
    });

    await t.test("filas RECUPERADAS: empresa ausente del libro antiguo, reportada primero", async () => {
        const antiguo = escribirLibro(outPath("rec-old"), [{ raw: trabajador(1) }]);
        const nuevo = escribirLibro(outPath("rec-new"), [
            { raw: trabajador(1) },
            { raw: trabajador(50, { RUC: "20555555555", EMPRESA: "SUBCONTRATA PERDIDA SAC", "CONTRATISTA PRNCIPAL": "SUBCONTRATA PERDIDA SAC" }) },
            { raw: trabajador(51, { RUC: "20555555555", EMPRESA: "SUBCONTRATA PERDIDA SAC", "CONTRATISTA PRNCIPAL": "SUBCONTRATA PERDIDA SAC" }) },
        ]);
        const res = await diff.diffReports(antiguo, nuevo);
        assert.equal(res.etapas.filas.soloNuevo, 2);
        assert.equal(res.etapas.filas.recuperadas, 2);
        assert.equal(clases(res).X1, 2);
        assert.equal(res.totalInesperadas, 0);
        assert.equal(res.exitCode, diff.EXIT.OK);

        // tallied by company over ALL recovered rows, not over the printed sample
        assert.deepEqual(res.recuperadasPorEmpresa, [
            { empresa: "SUBCONTRATA PERDIDA SAC", ruc: "20555555555", filas: 2 },
        ]);

        // and the report leads with them
        const texto = diff.formatReport(res);
        const iRec = texto.indexOf("FILAS RECUPERADAS");
        const iEtapas = texto.indexOf("2. ETAPAS");
        assert.ok(iRec > 0 && iRec < iEtapas, "la seccion de recuperadas va primero");
        assert.match(texto, /SUBCONTRATA PERDIDA SAC/);
    });

    await t.test("filas fantasma solo en el antiguo -> E1", async () => {
        const antiguo = escribirLibro(outPath("ghost-old"), [
            { raw: trabajador(1) },
            { raw: fila() },                                   // sin una sola celda
            { raw: fila({ EMPRESA: "" }) },                    // cadena vacia, el caso del writer viejo
        ]);
        const nuevo = escribirLibro(outPath("ghost-new"), [{ raw: trabajador(1) }]);
        const res = await diff.diffReports(antiguo, nuevo);
        assert.equal(res.etapas.filas.soloAntiguo, 2);
        assert.equal(clases(res).E1, 2);
        assert.equal(res.totalInesperadas, 0);
    });

    await t.test("una copia de mas de una clave presente en ambos lados -> E10 (dedupe)", async () => {
        const antiguo = escribirLibro(outPath("dup-old"), [
            { raw: trabajador(1) }, { raw: trabajador(1) }, { raw: trabajador(2) },
        ]);
        const nuevo = escribirLibro(outPath("dup-new"), [{ raw: trabajador(1) }, { raw: trabajador(2) }]);
        const res = await diff.diffReports(antiguo, nuevo);
        assert.equal(res.etapas.filas.soloAntiguo, 1);
        assert.equal(clases(res).E10, 1);
        assert.equal(res.totalInesperadas, 0);
    });

    await t.test("nombre numerico solo en el antiguo -> E4 (el bloque desplazado)", async () => {
        const antiguo = escribirLibro(outPath("shift-old"), [
            { raw: fila({ "APELLIDOS Y NOMBRES": 20101155588, "DISTRITO SEGÚN DNI": "ATE" }) },
        ]);
        const nuevo = escribirLibro(outPath("shift-new"), [{ raw: trabajador(1) }]);
        const res = await diff.diffReports(antiguo, nuevo);
        assert.equal(clases(res).E4, 1, "la fila con RUC en el nombre es E4");
    });

    await t.test("una fila real que el pipeline nuevo perdio es INESPERADA y bloquea", async () => {
        const antiguo = escribirLibro(outPath("lost-old"), [{ raw: trabajador(1) }, { raw: trabajador(2) }]);
        const nuevo = escribirLibro(outPath("lost-new"), [{ raw: trabajador(1) }]);
        const res = await diff.diffReports(antiguo, nuevo);
        assert.equal(res.totalInesperadas, 1);
        assert.equal(res.bloquea, true);
        assert.equal(res.exitCode, diff.EXIT.INESPERADA);
    });

    await t.test("la clave se normaliza, asi que una fecha de texto NO parte la fila en dos", async () => {
        const antiguo = escribirLibro(outPath("key-old"), [
            { raw: trabajador(1, { "FECHA INICIO DE LABORES EN OBRA": "04/07/2023" }) },
        ]);
        const nuevo = escribirLibro(outPath("key-new"), [
            { raw: trabajador(1, { "FECHA INICIO DE LABORES EN OBRA": 45111 }) },   // 2023-07-04
        ]);
        const res = await diff.diffReports(antiguo, nuevo);
        assert.equal(res.etapas.filas.emparejadas, 1, "la fila empareja pese al cambio de tipo");
        assert.equal(res.etapas.filas.soloAntiguo, 0);
        assert.equal(res.etapas.filas.soloNuevo, 0);
    });

    await t.test("rowKey normaliza RUC, DNI, nombre y fecha", () => {
        const crudas = CANONICAL.map(() => ({ v: null, t: "vacio", vacia: true, texto: "" }));
        const set = (nombre, cell) => { crudas[INDEX_BY_CANONICAL.get(nombre)] = cell; };
        set("RUC", { v: "201 00000001 ", t: "texto", vacia: false, texto: "201 00000001 " });
        set("Nro. DNI / CE", { v: 9994533, t: "numero", vacia: false, texto: "9994533" });
        set("APELLIDOS Y NOMBRES", { v: " perez  lopez juan ", t: "texto", vacia: false, texto: " perez  lopez juan " });
        set("FECHA INICIO DE LABORES EN OBRA", { v: 45000, t: "numero", vacia: false, texto: "45000" });
        const k = diff.rowKey(crudas);
        assert.equal(k.partes.ruc, "20100000001");
        assert.equal(k.partes.nombre, "PEREZ LOPEZ JUAN");
        assert.equal(k.partes.inicio, "2023-03-15");
        assert.equal(k.vacia, false);
    });

    await t.test("dateKey lee dia primero y acepta serial, texto e ISO", () => {
        const cell = (v, t) => ({ v, t, vacia: false, texto: String(v) });
        assert.equal(diff.dateKey(cell(45000, "numero")), "2023-03-15");
        assert.equal(diff.dateKey(cell("04/07/1994", "texto")), "1994-07-04");
        assert.equal(diff.dateKey(cell("14/2/1989", "texto")), "1989-02-14");
        assert.equal(diff.dateKey(cell("1994-07-04", "texto")), "1994-07-04");
        assert.equal(diff.dateKey({ v: null, t: "vacio", vacia: true, texto: "" }), "");
        assert.equal(diff.dateKey(cell("ACTIVO", "texto")), "t:ACTIVO");
    });
});

/* ================================================================== *
 * 3. Stage 2 - cells, value AND type
 * ================================================================== */

test("etapa 2: celdas A:R, valor Y tipo", async (t) => {
    await t.test("una fecha de texto que se vuelve serial es un cambio de TIPO, no de valor", async () => {
        const antiguo = escribirLibro(outPath("date-old"), [
            { raw: trabajador(1, { "FECHA NACIMIENTO": "04/07/1994" }) },
        ]);
        const nuevo = escribirLibro(outPath("date-new"), [
            { raw: trabajador(1, { "FECHA NACIMIENTO": 34519 }) },
        ]);
        const res = await diff.diffReports(antiguo, nuevo);
        const ds = divergenciasDe(res, "E2");
        assert.equal(ds.length, 1);
        assert.equal(ds[0].tipo, diff.KIND.TIPO, "reportado como TIPO");
        assert.notEqual(ds[0].tipo, diff.KIND.VALOR, "nunca como desigualdad");
        assert.equal(ds[0].columna, "F");
        assert.equal(res.totalInesperadas, 0);
    });

    await t.test("compareCells: el tipo cortocircuita el valor", () => {
        const texto = { v: "1", t: diff.TIPO.TEXTO, vacia: false, texto: "1" };
        const numero = { v: 1, t: diff.TIPO.NUMERO, vacia: false, texto: "1" };
        assert.equal(diff.compareCells(texto, numero), diff.KIND.TIPO);
        assert.equal(diff.compareCells(numero, { ...numero, v: 2 }), diff.KIND.VALOR);
        assert.equal(diff.compareCells(numero, numero), null);
    });

    await t.test("celda ausente y cadena vacia son ambas 'sin valor', nunca una divergencia", () => {
        const ausente = { v: null, t: diff.TIPO.VACIO, vacia: true, texto: "" };
        const vacia = { v: "", t: diff.TIPO.TEXTO, vacia: true, texto: "" };
        assert.equal(diff.compareCells(ausente, vacia), null);
        assert.equal(diff.compareCells(vacia, ausente), null);
    });

    await t.test("los centinelas de FECHA CESE/BAJA -> celda vacia son E8, no E2", async () => {
        const casos = ["-", " -", "---", "ACTIVO"];
        const antiguo = escribirLibro(outPath("cent-old"),
            casos.map((s, i) => ({ raw: trabajador(i, { "FECHA CESE/BAJA": s }) })));
        const nuevo = escribirLibro(outPath("cent-new"),
            casos.map((_s, i) => ({ raw: trabajador(i) })));
        const res = await diff.diffReports(antiguo, nuevo);
        assert.equal(clases(res).E8, casos.length);
        assert.equal(clases(res).E2, undefined, "un centinela no es una fecha de texto");
        assert.equal(res.totalInesperadas, 0);
    });

    await t.test("el GENERO 'undefined' -> vacio es E8", async () => {
        const antiguo = escribirLibro(outPath("undef-old"), [{ raw: trabajador(1, { GENERO: "undefined" }) }]);
        const nuevo = escribirLibro(outPath("undef-new"), [{ raw: trabajador(1, { GENERO: null }) }]);
        const res = await diff.diffReports(antiguo, nuevo);
        assert.equal(clases(res).E8, 1);
        assert.equal(res.totalInesperadas, 0);
    });

    await t.test("la grafia de CONTRATISTA PRNCIPAL que colapsa es E9; las otras columnas X3", async () => {
        const antiguo = escribirLibro(outPath("graf-old"), [
            { raw: trabajador(1, { "CONTRATISTA PRNCIPAL": " CLJ CONTRUCTORA SAC", EMPRESA: "CLJ  CONTRUCTORA SAC " }) },
        ]);
        const nuevo = escribirLibro(outPath("graf-new"), [
            { raw: trabajador(1, { "CONTRATISTA PRNCIPAL": "CLJ CONTRUCTORA SAC", EMPRESA: "CLJ CONTRUCTORA SAC" }) },
        ]);
        const res = await diff.diffReports(antiguo, nuevo);
        assert.equal(clases(res).E9, 1);
        assert.equal(clases(res).X3, 1);
        assert.equal(res.totalInesperadas, 0);
    });

    await t.test("un cambio de dato real en una columna de texto sigue siendo INESPERADO", async () => {
        const antiguo = escribirLibro(outPath("dato-old"), [{ raw: trabajador(1, { EMPRESA: "EMPRESA UNO SAC" }) }]);
        const nuevo = escribirLibro(outPath("dato-new"), [{ raw: trabajador(1, { EMPRESA: "EMPRESA DOS SAC" }) }]);
        const res = await diff.diffReports(antiguo, nuevo);
        assert.equal(res.totalInesperadas, 1);
        assert.equal(res.exitCode, diff.EXIT.INESPERADA);
    });

    await t.test("RUC/DNI numerico -> texto con el cero inicial es X4 (mismo valor)", async () => {
        const antiguo = escribirLibro(outPath("id-old"), [
            { raw: trabajador(1, { RUC: 20100000001, "Nro. DNI / CE": 9994533 }) },
        ]);
        const nuevo = escribirLibro(outPath("id-new"), [
            { raw: trabajador(1, { RUC: "20100000001", "Nro. DNI / CE": "09994533" }) },
        ]);
        const res = await diff.diffReports(antiguo, nuevo);
        assert.equal(clases(res).X4, 2);
        assert.equal(res.totalInesperadas, 0);
    });

    await t.test("X4 NO cubre un identificador cuyo valor cambio", async () => {
        const antiguo = escribirLibro(outPath("id2-old"), [{ raw: trabajador(1, { ESTADO: "1" }) }]);
        const nuevo = escribirLibro(outPath("id2-new"), [{ raw: trabajador(1, { ESTADO: 2 }) }]);
        const res = await diff.diffReports(antiguo, nuevo);
        assert.equal(res.totalInesperadas, 1);
    });
});

/* ================================================================== *
 * 4. Stage 3 - the computed columns S..AI
 * ================================================================== */

test("etapa 3: columnas computadas S..AI", async (t) => {
    const formulaVieja = "IF(((TODAY()-Tabla2[[#This Row],[FECHA NACIMIENTO]])/365)<18,\"Corregir\",1)";

    await t.test("formula -> literal en las cinco columnas Option-D es X2", async () => {
        const antiguo = escribirLibro(outPath("optd-old"), [{
            raw: trabajador(1),
            comp: { V: { f: formulaVieja }, W: { f: formulaVieja }, AG: { f: formulaVieja }, AH: { f: formulaVieja }, AI: { f: formulaVieja } },
        }]);
        const nuevo = escribirLibro(outPath("optd-new"), [{
            raw: trabajador(1),
            comp: { V: 32, W: "32 - 40", AG: "No", AH: "No Aplica", AI: "No Aplica" },
        }]);
        const res = await diff.diffReports(antiguo, nuevo);
        assert.equal(clases(res).X2, 5);
        assert.equal(res.totalInesperadas, 0);
    });

    await t.test("formula -> literal en una columna que debe seguir siendo formula es INESPERADO", async () => {
        const antiguo = escribirLibro(outPath("optd2-old"), [{ raw: trabajador(1), comp: { S: { f: "VLOOKUP(1,Hoja1!A:B,2,FALSE)" } } }]);
        const nuevo = escribirLibro(outPath("optd2-new"), [{ raw: trabajador(1), comp: { S: "CJV" } }]);
        const res = await diff.diffReports(antiguo, nuevo);
        assert.equal(res.totalInesperadas, 1);
        assert.equal(res.exitCode, diff.EXIT.INESPERADA);
    });

    await t.test("Validar Edad y ValidarDNI cambian de formula por diseño -> E7", async () => {
        const antiguo = escribirLibro(outPath("val-old"), [{
            raw: trabajador(1),
            comp: { X: { f: "IF(LOWER(Tabla2[[#This Row],[GENERO]])=\"masculino\",\"Ok\",\"Corregir\")" }, AA: { f: "IF(LOWER(Tabla2[[#This Row],[GENERO]])=\"masculino\",\"Ok\",\"Corregir\")" } },
        }]);
        const nuevo = escribirLibro(outPath("val-new"), [{
            raw: trabajador(1),
            comp: { X: { f: "+IF(Tabla2[[#This Row],[Edad]]=\"Corregir\",\"Corregir\",\"Ok\")" }, AA: { f: "+IF(LEN(Tabla2[[#This Row],[Nro. DNI / CE]])<8,\"Corregir\",\"Ok\")" } },
        }]);
        const res = await diff.diffReports(antiguo, nuevo);
        assert.equal(clases(res).E7, 2);
        assert.equal(res.totalInesperadas, 0);
    });

    await t.test("una formula distinta en una de las doce columnas restantes es INESPERADA", async () => {
        const antiguo = escribirLibro(outPath("form-old"), [{ raw: trabajador(1), comp: { Y: { f: "VLOOKUP(A1,Hoja1!$A$2:$B$61,2,FALSE)" } } }]);
        const nuevo = escribirLibro(outPath("form-new"), [{ raw: trabajador(1), comp: { Y: { f: "VLOOKUP(A1,Hoja1!$A$2:$B$99,2,FALSE)" } } }]);
        const res = await diff.diffReports(antiguo, nuevo);
        assert.equal(res.totalInesperadas, 1);
    });

    await t.test("misma formula con distinto prefijo/espaciado no es divergencia", () => {
        assert.equal(diff.normalizeFormula("+IF(A1=1,2,3)"), diff.normalizeFormula("=IF(A1 = 1, 2, 3)"));
    });

    await t.test("dos formulas sin valor cacheado no son comparables y se cuentan", async () => {
        const comp = {};
        for (const c of COMPUTED) comp[c.letter] = { f: "SUM(1)" };
        const antiguo = escribirLibro(outPath("cache-old"), [{ raw: trabajador(1), comp }]);
        const nuevo = escribirLibro(outPath("cache-new"), [{ raw: trabajador(1), comp }]);
        const res = await diff.diffReports(antiguo, nuevo);
        assert.equal(res.etapas.computadas.divergentes, 0);
        assert.equal(res.totalDivergencias, 0);
    });

    await t.test("un #VALUE! cacheado en Edad/Rango Edades es E3", async () => {
        const antiguo = escribirLibro(outPath("value-old"), [{
            raw: trabajador(1),
            comp: { V: { error: true }, W: { error: true } },
        }]);
        const nuevo = escribirLibro(outPath("value-new"), [{
            raw: trabajador(1),
            comp: { V: 32, W: "32 - 40" },
        }]);
        const res = await diff.diffReports(antiguo, nuevo);
        assert.equal(clases(res).E3, 2);
        assert.equal(res.totalInesperadas, 0);
    });
});

/* ================================================================== *
 * 5. Stage 4 - pivot totals, and the stale-cache rule
 * ================================================================== */

/** The `Reporte Social - RRHH` blocks, in the template's own layout - deliberately at
 *  DIFFERENT row numbers from the addresses 03 §9 item 28 quotes, because those addresses
 *  move with the pivot body and the tool must find the block by its labels. */
function hojaRRHH({ totalFem = 0, totalMasc = 2, filtroCesados = "Borrar", etiquetaAltas = "2-2026", extraGenero = null } = {}) {
    const fila7 = ["Zona de Influencia", "femenino", "masculino"];
    if (extraGenero) fila7.push(extraGenero);
    fila7.push("Total");
    const zona = ["ATE", 0, 2];
    if (extraGenero) zona.push(1);
    zona.push(extraGenero ? 3 : 2);
    const total = ["Total", totalFem, totalMasc];
    if (extraGenero) total.push(1);
    total.push(extraGenero ? totalFem + totalMasc + 1 : totalFem + totalMasc);

    return [
        [],
        [null, null, "Reporte Zona de Influencia", null, null, null, null, null, null, null,
            null, null, null, null, null, null, null, null, null, null, "Detalle Cesados Zona de Influencia"],
        [],
        [null, null, "BajasAntiguas", "No", null, null, null, null, null, null,
            null, null, null, null, null, null, null, null, null, null, "Bajas2", filtroCesados],
        [],
        [null, null, "Sum of Trabajdores Unicos Zona Influencia"],
        fila7.reduce((acc, v, i) => { acc[2 + i] = v; return acc; }, []),
        zona.reduce((acc, v, i) => { acc[2 + i] = v; return acc; }, []),
        total.reduce((acc, v, i) => { acc[2 + i] = v; return acc; }, []),
        [],
        [null, null, "Rango de Edades", "femenino", "masculino", "Total"],
        [null, null, "24 - 31", 0, 2, 2],
        [null, null, "Total", 0, 2, 2],
        [],
        [null, null, "Sum of Bajas Zona Influencia"],
        [null, null, "Zona de Influencia", "femenino", "masculino", "Total Bajas"],
        [null, null, "Total Bajas", 0, 0, 0],
        [],
        [null, null, "Altas", etiquetaAltas],
        [null, null, "Sum of Altas Zona de Influencia"],
        [null, null, "Zona de Influencia", "femenino", "masculino", "Total Ingresos"],
        [null, null, "Total Ingresos", 0, 0, 0],
    ];
}

const HOJAS_PIVOTE = (over = {}) => ({
    "Reporte Social - RRHH": hojaRRHH(over),
    "CJ Y EPC": [
        [], [], [null, "ESTADO", 1], [null, "BajasAntiguas", "No"], [],
        [null, "CJV & EPC", "# Trabajadores", "# Horas"],
        [null, "CJV", over.cjv === undefined ? 2 : over.cjv, 200],
        [null, "Total Trabajadores Activos", over.cjv === undefined ? 2 : over.cjv, 200],
    ],
    Tabla: [[], [], [null, null, null, "ESTADO"], ["Grand Total", null, null, 1, 0, 0, 1]],
    Contratistas: [[], [], [null, null, "Total"], ["Grand Total", null, over.contratistas === undefined ? 1 : over.contratistas]],
    "Dos Subcontratas por Mes": [[], [], [], [], [],
        ["Zona de Influencia", "APELLIDOS Y NOMBRES", "Trabajador"]],
    Validacion: [[], [], [], [], [], [],
        ["CONTRATISTA PRNCIPAL", "APELLIDOS Y NOMBRES", "FECHA NACIMIENTO", "Total", null, null, "CONTRATISTA PRNCIPAL", "APELLIDOS Y NOMBRES", "Nro. DNI / CE", "Total"],
        ["Grand Total", null, null, over.cuentaRuc === undefined ? 2 : over.cuentaRuc, null, null, "Grand Total"],
    ],
});

test("etapa 4: totales de pivote y la regla de la cache obsoleta", async (t) => {
    const sc = escribirSidecar("pivotes", sidecar());

    await t.test("sin --refreshed la etapa NO corre y el motivo queda registrado", async () => {
        const antiguo = escribirLibro(outPath("piv-old"), [{ raw: trabajador(1) }, { raw: trabajador(2) }], { hojas: HOJAS_PIVOTE() });
        const nuevo = escribirLibro(outPath("piv-new"), [{ raw: trabajador(1) }, { raw: trabajador(2) }], { hojas: HOJAS_PIVOTE() });
        const res = await diff.diffReports(antiguo, nuevo, { sidecar: sc });
        assert.equal(res.etapas.pivotes.ejecutado, false);
        assert.match(res.etapas.pivotes.motivo, /BUG-14/);
        assert.match(res.etapas.pivotes.motivo, /--refreshed/);
        assert.equal(res.clases.filter((c) => c.porEtapa.pivotes).length, 0, "cero divergencias de pivote");
        // ...and the report says so where nobody can miss it
        assert.match(diff.formatReport(res), /NO EJECUTADO/);
    });

    await t.test("--require-pivots convierte una etapa 4 no ejecutada en fallo (exit 3)", async () => {
        const antiguo = escribirLibro(outPath("piv-req-old"), [{ raw: trabajador(1) }, { raw: trabajador(2) }], { hojas: HOJAS_PIVOTE() });
        const nuevo = escribirLibro(outPath("piv-req-new"), [{ raw: trabajador(1) }, { raw: trabajador(2) }], { hojas: HOJAS_PIVOTE() });
        const res = await diff.diffReports(antiguo, nuevo, { sidecar: sc, requirePivots: true });
        assert.equal(res.exitCode, diff.EXIT.ETAPA_FALTANTE);
        assert.equal(res.bloquea, false, "no es una divergencia: es una etapa que falta");
    });

    await t.test("con --refreshed y una cache posterior al periodo, la etapa corre y cuadra", async () => {
        const antiguo = escribirLibro(outPath("piv-ok-old"), [{ raw: trabajador(1) }, { raw: trabajador(2) }], { hojas: HOJAS_PIVOTE() });
        const nuevo = escribirLibro(outPath("piv-ok-new"), [{ raw: trabajador(1) }, { raw: trabajador(2) }], { hojas: HOJAS_PIVOTE({ filtroCesados: "2-2026" }) });
        await inyectarCache(antiguo, { refreshedDate: 46085 });   // 2026-03-04
        const res = await diff.diffReports(antiguo, nuevo, { sidecar: sc, refreshed: true });
        assert.equal(res.etapas.pivotes.ejecutado, true);
        assert.equal(res.etapas.pivotes.veredictoCache.refresco, "2026-03-04");
        assert.ok(res.etapas.pivotes.bloques.length >= 10, "se comparo la mayoria de los bloques");
        // The one divergence is the page filter BUG-26 pins on "Borrar" -> the period.
        assert.equal(clases(res).E5, 1);
        assert.equal(res.totalInesperadas, 0);
    });

    await t.test("una cache anterior al periodo gana sobre --refreshed: la etapa no corre", async () => {
        const antiguo = escribirLibro(outPath("piv-stale-old"), [{ raw: trabajador(1) }, { raw: trabajador(2) }], { hojas: HOJAS_PIVOTE() });
        const nuevo = escribirLibro(outPath("piv-stale-new"), [{ raw: trabajador(1) }, { raw: trabajador(2) }], { hojas: HOJAS_PIVOTE() });
        // 45566 is the serial the five stale delivered reports actually carry
        // (`refreshedBy="Alvaro" refreshedDate="45566.353..."`) - 1 October 2024, which is
        // why they still display September-2024 numbers.
        await inyectarCache(antiguo, { refreshedDate: 45566, refreshedBy: "Alvaro" });
        const res = await diff.diffReports(antiguo, nuevo, { sidecar: sc, refreshed: true });
        assert.equal(res.etapas.pivotes.ejecutado, false);
        assert.match(res.etapas.pivotes.motivo, /OBSOLETA/);
        assert.match(res.etapas.pivotes.motivo, /2024-10-01/);
    });

    await t.test("judgeRefresh: sin cache, sin refreshedDate, antes y despues del periodo", () => {
        const periodo = { key: "2026-02", etiqueta: "2-2026" };
        assert.equal(diff.judgeRefresh(null, periodo).ok, false);
        assert.equal(diff.judgeRefresh({ presente: true, refreshedYMD: null }, periodo).ok, false);
        assert.equal(diff.judgeRefresh({ presente: true, refreshedYMD: { y: 2024, m: 9, d: 11 } }, periodo).ok, false);
        assert.equal(diff.judgeRefresh({ presente: true, refreshedYMD: { y: 2026, m: 3, d: 4 } }, periodo).ok, true);
        // no period known: it runs, but says it could not contrast the date
        const sinPeriodo = diff.judgeRefresh({ presente: true, refreshedYMD: { y: 2020, m: 1, d: 1 } }, { key: null });
        assert.equal(sinPeriodo.ok, true);
        assert.match(sinPeriodo.nota, /no se pudo contrastar/);
    });

    await t.test("un bloque sin equivalente en el side-car se declara NO COMPARABLE con motivo", async () => {
        const antiguo = escribirLibro(outPath("piv-nc-old"), [{ raw: trabajador(1) }, { raw: trabajador(2) }], { hojas: HOJAS_PIVOTE() });
        const nuevo = escribirLibro(outPath("piv-nc-new"), [{ raw: trabajador(1) }, { raw: trabajador(2) }], { hojas: HOJAS_PIVOTE({ filtroCesados: "2-2026" }) });
        await inyectarCache(antiguo, { refreshedDate: 46085 });
        const res = await diff.diffReports(antiguo, nuevo, { sidecar: sc, refreshed: true });
        const tabla = res.etapas.pivotes.noComparables.find((n) => n.id === "tabla.granTotal");
        assert.ok(tabla, "Tabla!D64:G64 no tiene equivalente en el side-car y debe decirlo");
        assert.match(tabla.motivo, /side-car/);
        assert.deepEqual(tabla.valoresAntiguos, [1, 0, 0, 1]);
    });

    await t.test("los bloques se localizan por etiqueta, no por direccion", async () => {
        // Two extra zone rows push every total down; the addresses of §9 item 28 no longer
        // apply and the tool must still read the right cells.
        const hojas = HOJAS_PIVOTE();
        const rrhh = hojas["Reporte Social - RRHH"];
        rrhh.splice(8, 0, [null, null, "CALLAO", 0, 5, 5], [null, null, "SAN LUIS", 0, 3, 3]);
        rrhh[10] = [null, null, "Total", 0, 10, 10];
        const antiguo = escribirLibro(outPath("piv-mov-old"), [{ raw: trabajador(1) }, { raw: trabajador(2) }], { hojas });
        await inyectarCache(antiguo, { refreshedDate: 46085 });
        const nuevo = escribirLibro(outPath("piv-mov-new"), [{ raw: trabajador(1) }, { raw: trabajador(2) }], { hojas: HOJAS_PIVOTE({ filtroCesados: "2-2026" }) });
        const res = await diff.diffReports(antiguo, nuevo, { sidecar: sc, refreshed: true });
        const headcount = res.etapas.pivotes.bloques.find((b) => b.id === "rrhh.headcount");
        assert.ok(headcount, "el bloque se encontro pese al desplazamiento");
        assert.equal(headcount.celdaTotal, "D11/E11/F11", "leyo la fila Total real, no D15/E15/F15");
        // CALLAO and SAN LUIS exist only on the old side, and the masculino total moved.
        assert.ok(res.totalInesperadas >= 1, "un total de pivote que no cuadra bloquea");
    });

    await t.test("una tercera columna de genero en el pivote antiguo es E8", async () => {
        const antiguo = escribirLibro(outPath("piv-gen-old"), [{ raw: trabajador(1) }, { raw: trabajador(2) }], { hojas: HOJAS_PIVOTE({ extraGenero: "undefined" }) });
        await inyectarCache(antiguo, { refreshedDate: 46085 });
        const nuevo = escribirLibro(outPath("piv-gen-new"), [{ raw: trabajador(1) }, { raw: trabajador(2) }], { hojas: HOJAS_PIVOTE({ filtroCesados: "2-2026" }) });
        const res = await diff.diffReports(antiguo, nuevo, { sidecar: sc, refreshed: true });
        const e8 = divergenciasDe(res, "E8");
        assert.ok(e8.some((d) => d.ctx && d.ctx.columnaExtraAntiguo === "undefined"),
            "la columna de genero espuria se reporta");
    });

    await t.test("los totales fraccionarios NO son una divergencia (§4.5 #11)", async () => {
        const scFrac = escribirSidecar("frac", sidecar({
            metricas: Object.assign(sidecar().metricas, {
                cjvEpc: { grupos: [{ epc: "CJV", valor: 5096.833333333334 }], total: 5096.833333333334 },
                horas: { grupos: [{ epc: "CJV", valor: 200 }], total: 200 },
            }),
        }));
        const hojas = HOJAS_PIVOTE({ cjv: 5096.833333333334, filtroCesados: "2-2026" });
        const antiguo = escribirLibro(outPath("frac-old"), [{ raw: trabajador(1) }, { raw: trabajador(2) }], { hojas });
        await inyectarCache(antiguo, { refreshedDate: 46085 });
        const nuevo = escribirLibro(outPath("frac-new"), [{ raw: trabajador(1) }, { raw: trabajador(2) }], { hojas });
        const res = await diff.diffReports(antiguo, nuevo, { sidecar: scFrac, refreshed: true });
        const cj = res.clases.flatMap((c) => c.ejemplos).filter((d) => d.id === "cjyepc");
        assert.equal(cj.length, 0, "5096,833... es correcto y no se reporta");
    });

    await t.test("equalNumbers absorbe el ruido de ULP y nada mas", () => {
        // The measured drift of summing 84 reciprocals (metrics.js buildContratistas) is
        // float noise and IS equality; a gap a human could notice is not.
        assert.equal(diff.equalNumbers(84, 83.999999999996), true);
        assert.equal(diff.equalNumbers(84, 83.99), false);
        assert.equal(diff.equalNumbers(5096.833333333334, 5096.833333333334), true);
        assert.equal(diff.equalNumbers(5096.833333333334, 5096.9), false);
        assert.equal(diff.pivotEqual(null, 0), true, "una celda de pivote vacia es un cero");
        assert.equal(diff.pivotEqual(null, 1), false);
    });
});

/* ================================================================== *
 * 6. Stage 5 - the counts
 * ================================================================== */

test("etapa 5: conteos por lado", async (t) => {
    await t.test("el lado antiguo no publica conteos: NO DISPONIBLE, nunca 0", async () => {
        const antiguo = escribirLibro(outPath("cnt-old"), [{ raw: trabajador(1) }]);
        const nuevo = escribirLibro(outPath("cnt-new"), [{ raw: trabajador(1) }]);
        const res = await diff.diffReports(antiguo, nuevo);
        assert.equal(res.etapas.conteos.antiguo.leidas, null);
        assert.equal(res.etapas.conteos.antiguo.rechazadas, null);
        assert.equal(res.etapas.conteos.antiguo.colapsadas, null);
        assert.equal(res.etapas.conteos.antiguo.escritas, 1);
        assert.match(diff.formatReport(res), /NO DISPONIBLE/);
    });

    await t.test("el side-car alimenta los cuatro conteos del lado nuevo", async () => {
        const antiguo = escribirLibro(outPath("cnt2-old"), [{ raw: trabajador(1) }, { raw: trabajador(2) }]);
        const nuevo = escribirLibro(outPath("cnt2-new"), [{ raw: trabajador(1) }, { raw: trabajador(2) }]);
        const sc = escribirSidecar("conteos", sidecar());
        const res = await diff.diffReports(antiguo, nuevo, { sidecar: sc });
        assert.equal(res.etapas.conteos.nuevo.leidas, 2);
        assert.equal(res.etapas.conteos.nuevo.escritas, 2);
        assert.equal(res.totalInesperadas, 0);
    });

    await t.test("si el side-car y el libro nuevo no coinciden, bloquea", async () => {
        const antiguo = escribirLibro(outPath("cnt3-old"), [{ raw: trabajador(1) }, { raw: trabajador(2) }]);
        const nuevo = escribirLibro(outPath("cnt3-new"), [{ raw: trabajador(1) }, { raw: trabajador(2) }]);
        const sc = escribirSidecar("conteos-malos", sidecar({
            proceso: { filas: { leidas: 9, rechazadas: 0, colapsadas: 0, escritas: 9 }, conservacion: { ok: true, verificable: true } },
        }));
        const res = await diff.diffReports(antiguo, nuevo, { sidecar: sc });
        const d = res.clases.flatMap((c) => c.ejemplos).find((x) => x.id === "sidecar.escritas");
        assert.ok(d, "la discrepancia side-car/libro se reporta");
        assert.equal(res.bloquea, true);
    });

    await t.test("una conservacion que no cierra en el run nuevo bloquea (AC 7)", async () => {
        const antiguo = escribirLibro(outPath("cnt4-old"), [{ raw: trabajador(1) }, { raw: trabajador(2) }]);
        const nuevo = escribirLibro(outPath("cnt4-new"), [{ raw: trabajador(1) }, { raw: trabajador(2) }]);
        const sc = escribirSidecar("conservacion-mala", sidecar({
            proceso: { filas: { leidas: 5, rechazadas: 1, colapsadas: 1, escritas: 2 }, conservacion: { ok: false, verificable: true, esperadas: 3, escritas: 2, motivo: "no cuadra" } },
        }));
        const res = await diff.diffReports(antiguo, nuevo, { sidecar: sc });
        assert.ok(res.clases.flatMap((c) => c.ejemplos).some((x) => x.id === "sidecar.conservacion"));
        assert.equal(res.bloquea, true);
    });

    await t.test("la reconciliacion del propio diff se publica y cierra", async () => {
        const antiguo = escribirLibro(outPath("cnt5-old"), [{ raw: trabajador(1) }, { raw: trabajador(2) }]);
        const nuevo = escribirLibro(outPath("cnt5-new"), [{ raw: trabajador(1) }, { raw: trabajador(3) }]);
        const res = await diff.diffReports(antiguo, nuevo);
        assert.equal(res.etapas.conteos.reconciliacion.ok, true);
        assert.equal(res.etapas.conteos.reconciliacion.esperado, 2);
    });
});

/* ================================================================== *
 * 7. The expected-divergence list itself
 * ================================================================== */

test("la lista de divergencias esperadas (05 §4.5) es data revisable", async (t) => {
    await t.test("las once entradas de §4.5 estan, en orden, y citan su fuente", () => {
        const base = diff.EXPECTED_DIVERGENCES.filter((e) => !e.extension);
        assert.equal(base.length, 11, "§4.5 enumera once divergencias");
        assert.deepEqual(base.map((e) => e.id), ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9", "E10", "E11"]);
        base.forEach((e, i) => {
            assert.equal(e.fuente, `05 §4.5 #${i + 1}`);
            assert.equal(typeof e.titulo, "string");
            assert.ok(e.titulo.length > 0);
            assert.equal(typeof e.match, "function");
        });
    });

    await t.test("cada extension se declara como tal y dice de donde sale", () => {
        const ext = diff.EXPECTED_DIVERGENCES.filter((e) => e.extension);
        assert.ok(ext.length > 0);
        for (const e of ext) {
            assert.equal(e.extension, true);
            assert.match(e.fuente, /extension/i);
            assert.ok(e.detalle.length > 80, "una extension se justifica por escrito");
        }
    });

    await t.test("E11 es una supresion: nunca clasifica nada", () => {
        const e11 = diff.EXPECTED_DIVERGENCES.find((e) => e.id === "E11");
        assert.equal(e11.supresion, true);
        assert.equal(e11.match({}), false);
    });

    await t.test("una divergencia que no cae en ninguna entrada devuelve null", () => {
        assert.equal(diff.classify({ etapa: "celdas", tipo: "valor", columna: "N", ctx: {}, antiguo: {}, nuevo: {} }), null);
    });

    await t.test("un matcher que lanza no cuenta como coincidencia", () => {
        // ctx ausente: todos los matchers lo tocan, ninguno debe explotar hacia arriba
        assert.doesNotThrow(() => diff.classify({ etapa: "celdas", tipo: "tipo", columna: "F" }));
    });

    await t.test("las 17 columnas computadas coinciden con output/computed.js", () => {
        assert.equal(diff.COMPUTED_COLUMNS_AI.length, 17);
        assert.deepEqual(
            diff.COMPUTED_COLUMNS_AI.filter((c) => c.tipo === "literal").map((c) => c.letter),
            ["V", "W", "AG", "AH", "AI"]
        );
    });

    await t.test("los bloques de pivote cubren la tabla de 03 §9 item 28", () => {
        const ids = diff.PIVOT_BLOCKS.map((b) => b.id);
        for (const esperado of [
            "rrhh.headcount", "rrhh.rangos", "rrhh.bajas", "rrhh.altas", "cjyepc",
            "tabla.granTotal", "contratistas.granTotal", "dosSubcontratas.filas",
            "validacion.cuentaRuc", "validacion.bloqueDerecho", "rrhh.detalleCesados",
        ]) {
            assert.ok(ids.includes(esperado), `falta el bloque ${esperado}`);
        }
        for (const b of diff.PIVOT_BLOCKS) {
            assert.equal(typeof b.referencia, "string", `${b.id} debe citar la direccion documentada`);
            assert.equal(typeof b.delSidecar, "function");
        }
        // D49 / AG4, y el filtro que BUG-26 fija en "Borrar"
        assert.deepEqual(diff.PIVOT_FILTERS.map((p) => p.referencia), ["D49", "AG4", "V4"]);
    });
});

/* ================================================================== *
 * 8. CLI and reporting
 * ================================================================== */

test("CLI y salida", async (t) => {
    await t.test("exit 0 cuando todo clasifica, exit 1 cuando algo no", async () => {
        const antiguo = escribirLibro(outPath("cli-old"), [{ raw: trabajador(1) }, { raw: fila() }]);
        const limpio = escribirLibro(outPath("cli-new"), [{ raw: trabajador(1) }]);
        const sucio = escribirLibro(outPath("cli-bad"), [{ raw: trabajador(1, { NACIONALIDAD: "PERUANO" }) }]);

        assert.equal((await diff.diffReports(antiguo, limpio)).exitCode, diff.EXIT.OK);
        assert.equal((await diff.diffReports(antiguo, sucio)).exitCode, diff.EXIT.INESPERADA);
    });

    await t.test("--json escribe el resultado completo", async () => {
        const antiguo = escribirLibro(outPath("json-old"), [{ raw: trabajador(1) }]);
        const nuevo = escribirLibro(outPath("json-new"), [{ raw: trabajador(1) }]);
        const destino = path.join(TMP, "resultado.json");
        const { code } = await correrCli([antiguo, nuevo, "--json", destino, "--quiet"]);
        assert.equal(code, diff.EXIT.OK);
        const leido = JSON.parse(fs.readFileSync(destino, "utf8"));
        assert.equal(leido.tipo, "diff-reportes");
        assert.equal(leido.version, diff.VERSION);
        assert.equal(leido.totalDivergencias, 0);
    });

    await t.test("--json trae la lista completa por clase, no solo los ejemplos", async () => {
        const antiguo = escribirLibro(outPath("json2-old"),
            Array.from({ length: 12 }, () => ({ raw: fila() })).concat([{ raw: trabajador(1) }]));
        const nuevo = escribirLibro(outPath("json2-new"), [{ raw: trabajador(1) }]);
        const res = await diff.diffReports(antiguo, nuevo, { ejemplos: 2 });
        const e1 = res.clases.find((c) => c.id === "E1");
        assert.equal(e1.total, 12);
        assert.equal(e1.ejemplos.length, 2, "el texto muestra pocos ejemplos");
        assert.equal(e1.items.length, 12, "el JSON trae la clase entera");
        assert.equal(e1.omitidas, 0);
    });

    await t.test("un archivo sin hoja Cuadro falla fuerte, con el nombre y las hojas", async () => {
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["nada"]]), "Otra");
        const malo = outPath("sin-cuadro");
        XLSX.writeFile(wb, malo);
        const bueno = escribirLibro(outPath("bueno"), [{ raw: trabajador(1) }]);
        await assert.rejects(() => diff.diffReports(malo, bueno), /Cuadro/);
        const cli = await correrCli([malo, bueno]);
        assert.equal(cli.code, diff.EXIT.USO);
        assert.match(cli.err, /Cuadro/);
    });

    await t.test("una opcion desconocida es error de uso", async () => {
        const cli = await correrCli(["a.xlsx", "b.xlsx", "--inventada"]);
        assert.equal(cli.code, diff.EXIT.USO);
        assert.match(cli.err, /opcion desconocida/);
    });

    await t.test("el informe agrupa por clase, con conteo y ejemplos", async () => {
        const antiguo = escribirLibro(outPath("rep-old"),
            [{ raw: trabajador(1, { "FECHA NACIMIENTO": "04/07/1994" }) }, { raw: fila() }, { raw: fila() }]);
        const nuevo = escribirLibro(outPath("rep-new"), [{ raw: trabajador(1, { "FECHA NACIMIENTO": 34519 }) }]);
        const res = await diff.diffReports(antiguo, nuevo, { ejemplos: 1 });
        const texto = diff.formatReport(res, { ejemplos: 1 });
        assert.match(texto, /\[E1\] Las filas fantasma desaparecen/);
        assert.match(texto, /2 divergencia\(s\)/);
        assert.match(texto, /\[E2\]/);
        assert.match(texto, /05 §4\.5 #2/);
        assert.match(texto, /RESULTADO/);
    });

    await t.test("el informe de una corrida bloqueada cita la regla de §4.5", async () => {
        const antiguo = escribirLibro(outPath("blk-old"), [{ raw: trabajador(1) }, { raw: trabajador(2) }]);
        const nuevo = escribirLibro(outPath("blk-new"), [{ raw: trabajador(1) }]);
        const texto = diff.formatReport(await diff.diffReports(antiguo, nuevo));
        assert.match(texto, /BLOQUEADO/);
        assert.match(texto, /blocks cutover/);
    });
});

/* ================================================================== *
 * 9. Determinism
 * ================================================================== */

test("dos corridas del diff sobre los mismos dos archivos dan lo mismo", async () => {
    const antiguo = escribirLibro(outPath("det-old"), [
        { raw: trabajador(1, { "FECHA NACIMIENTO": "04/07/1994" }) },
        { raw: fila() },
        { raw: trabajador(2, { "CONTRATISTA PRNCIPAL": " CLJ CONTRUCTORA SAC" }) },
    ]);
    const nuevo = escribirLibro(outPath("det-new"), [
        { raw: trabajador(1, { "FECHA NACIMIENTO": 34519 }) },
        { raw: trabajador(2, { "CONTRATISTA PRNCIPAL": "CLJ CONTRUCTORA SAC" }) },
    ]);
    const a = await diff.diffReports(antiguo, nuevo);
    const b = await diff.diffReports(antiguo, nuevo);
    assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
    assert.equal(diff.formatReport(a), diff.formatReport(b));
});

"use strict";
/**
 * /review - checking one subcontratista's workbook before it goes into the month's zip.
 *
 * Two halves, because the feature has two:
 *
 *   1. `pipeline/review.js` over the fixture corpus. The claim is that a review reports
 *      what a RUN would report - same codes, same severities, same arithmetic - because it
 *      runs the same readWorkbook -> parseRow -> dedupe. So the assertions here are about
 *      agreement with the pipeline, not about hand-written expectations.
 *   2. `POST /review` over real HTTP, same harness style as server.test.js.
 *
 * The claim worth the most attention is the last test in this file: a review must NOT take
 * the single-flight guard. That guard exists because the template round-trip peaks near
 * 944 MB RSS; a review never opens the template. If reviewing a file could be blocked by a
 * running consolidation - or could block one - the feature would be unusable exactly when
 * an operator needs it, which is while the month is being processed.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const { createServer } = require("../server");
const { reviewWorkbook, subcontratistaFromFilename } = require("../pipeline/review");
const config = require("../config");

const FIXTURES = path.join(__dirname, "..", "fixtures");
const PERIODO = "2026-02";
const AHORA = () => new Date(2026, 2, 15, 10, 0, 0);

const leer = (n) => fs.readFileSync(path.join(FIXTURES, n));
const todos = () => fs.readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".xlsx") && !f.startsWith("~$"));

/* ------------------------------------------------------------------ *
 * pipeline/review.js
 * ------------------------------------------------------------------ */

test("un libro ilegible se reporta como bloqueante, no como vacio", () => {
    const r = reviewWorkbook(path.join(FIXTURES, "no-cuadro-sheet.xlsx"), { period: PERIODO });

    assert.equal(r.ok, false);
    assert.equal(r.bloqueante, true);
    assert.equal(r.peorSeveridad, "FAILED");
    // "no pudimos leerlo" y "leimos cero filas" son hechos distintos: el informe da el
    // motivo, no una tabla vacia.
    assert.ok(r.resumen.total > 0, "debe traer al menos una incidencia con el motivo");
    assert.equal(r.stats.filasAceptadas, 0);
});

test("un libro legible con filas rechazadas las cuenta y las explica", () => {
    const r = reviewWorkbook(path.join(FIXTURES, "column-shifted.xlsx"), { period: PERIODO });

    assert.equal(r.ok, true);
    assert.ok(r.stats.filasRechazadas > 0, "esta fixture existe para producir rechazos");
    assert.equal(r.peorSeveridad, "ERROR");
    assert.ok(r.issues.some((i) => i.severity === "ERROR"));
});

test("la conservacion cierra en todo el corpus: leidas - rechazadas - colapsadas = aceptadas", () => {
    for (const f of todos()) {
        const r = reviewWorkbook(path.join(FIXTURES, f), { period: PERIODO });
        const s = r.stats;
        assert.equal(
            s.filasLeidas - s.filasRechazadas - s.filasColapsadas,
            s.filasAceptadas,
            `${f}: ${s.filasLeidas} - ${s.filasRechazadas} - ${s.filasColapsadas} != ${s.filasAceptadas}`
        );
        if (r.conservacion) assert.equal(r.conservacion.ok, true, `${f}: conservacion rota`);
    }
});

test("todo libro del corpus produce un informe con la forma completa", () => {
    for (const f of todos()) {
        const r = reviewWorkbook(path.join(FIXTURES, f), { period: PERIODO });
        assert.equal(typeof r.ok, "boolean", f);
        assert.equal(typeof r.bloqueante, "boolean", f);
        assert.equal(r.periodo, PERIODO, f);
        assert.ok(Array.isArray(r.issues), f);
        assert.ok(Array.isArray(r.duplicados), f);
        assert.ok(r.resumen && typeof r.resumen.porSeveridad === "object", f);
        // Los codigos son los del pipeline: un informe no inventa vocabulario propio.
        for (const i of r.issues) {
            assert.ok(["INFO", "WARNING", "ERROR", "FAILED"].includes(i.severity), `${f}: ${i.severity}`);
            assert.equal(typeof i.code, "string", f);
        }
    }
});

test("revisar no escribe nada: ni reporte, ni dir de corrida, ni log", () => {
    const antes = (dir) => {
        try { return fs.readdirSync(dir).sort().join("|"); } catch { return "(no existe)"; }
    };
    const tmpAntes = antes(config.TMP_ROOT);
    const repAntes = antes(config.REPORTES_DIR);

    for (const f of todos()) reviewWorkbook(path.join(FIXTURES, f), { period: PERIODO });

    assert.equal(antes(config.TMP_ROOT), tmpAntes, "TMP_ROOT cambio");
    assert.equal(antes(config.REPORTES_DIR), repAntes, "REPORTES_DIR cambio");
});

test("un periodo invalido es un error de la peticion, no un defecto del libro", () => {
    assert.throws(
        () => reviewWorkbook(path.join(FIXTURES, "text-dates.xlsx"), { period: "no-es-un-periodo" }),
        (e) => e && typeof e.message === "string"
    );
});

test("el periodo cambia el veredicto sobre las fechas", () => {
    // Mismo libro, dos periodos: las fechas se validan contra el periodo, asi que el
    // informe no puede ser identico. Esto es lo que hace que el selector importe.
    const a = reviewWorkbook(path.join(FIXTURES, "text-dates.xlsx"), { period: "2026-02" });
    const b = reviewWorkbook(path.join(FIXTURES, "text-dates.xlsx"), { period: "2019-07" });
    assert.equal(a.periodo, "2026-02");
    assert.equal(b.periodo, "2019-07");
});

test("subcontratistaFromFilename usa el nombre del archivo como etiqueta", () => {
    assert.equal(subcontratistaFromFilename("SUBCONTRATA UNO.xlsx"), "SUBCONTRATA UNO");
    assert.equal(subcontratistaFromFilename("/tmp/x/lista.xlsx"), "lista");
    assert.equal(subcontratistaFromFilename(""), "(sin nombre)");
    assert.equal(subcontratistaFromFilename("   .xlsx"), "(sin nombre)");
});

/* ------------------------------------------------------------------ *
 * HTTP harness - mismo estilo que server.test.js
 * ------------------------------------------------------------------ */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "review-test-"));
const CLI_DIR = path.join(TMP, "cli");
fs.mkdirSync(CLI_DIR, { recursive: true });
// Un CLI que no termina solo: sirve para dejar una consolidacion "en curso" y probar que
// la revision NO queda detras de ella.
fs.writeFileSync(path.join(CLI_DIR, "cli-cuelga.js"), "setInterval(() => {}, 1000);\n");

const servidores = [];
test.after(() => {
    for (const { app, server } of servidores) {
        try { app.locals.detener(); } catch { /* ya detenido */ }
        try { server.closeAllConnections(); } catch { /* ya cerrado */ }
        try { server.close(); } catch { /* ya cerrado */ }
    }
    fs.rmSync(TMP, { recursive: true, force: true });
});

async function levantar(opciones = {}) {
    const outDir = path.join(TMP, `reportes-${crypto.randomBytes(4).toString("hex")}`);
    fs.mkdirSync(outDir, { recursive: true });
    const app = createServer({
        cliPath: path.join(CLI_DIR, opciones.cli || "cli-cuelga.js"),
        outDir,
        maxUploadBytes: opciones.maxUploadBytes || 4 * 1024 * 1024,
        now: AHORA,
        uploadTimeoutMs: 250,
    });
    const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    servidores.push({ app, server });
    return { app, server, port: server.address().port };
}

function pedir(port, ruta, opciones = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: "127.0.0.1", port, path: ruta,
            method: opciones.method || "GET",
            headers: opciones.headers || {},
        }, (res) => {
            const trozos = [];
            res.on("data", (d) => trozos.push(d));
            res.on("end", () => {
                const texto = Buffer.concat(trozos).toString("utf8");
                let json = null;
                try { json = JSON.parse(texto); } catch { /* no es JSON */ }
                resolve({ status: res.statusCode, headers: res.headers, texto, json });
            });
        });
        req.on("error", reject);
        req.end(opciones.cuerpo);
    });
}

function multipart(campos = {}, archivo = null) {
    const boundary = "----review" + crypto.randomBytes(8).toString("hex");
    const partes = [];
    for (const [k, v] of Object.entries(campos)) {
        partes.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    if (archivo) {
        partes.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${archivo.campo || "archivo"}"; ` +
            `filename="${archivo.nombre}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
        partes.push(archivo.datos);
        partes.push(Buffer.from("\r\n"));
    }
    partes.push(Buffer.from(`--${boundary}--\r\n`));
    const cuerpo = Buffer.concat(partes);
    return {
        cuerpo,
        headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": String(cuerpo.length),
        },
    };
}

function revisar(port, { periodo = PERIODO, nombre = "lista.xlsx", datos = null, sinArchivo = false, campo, mostrado } = {}) {
    const campos = periodo === null ? {} : { periodo };
    if (mostrado !== undefined) campos.nombre = mostrado;
    const m = multipart(campos, sinArchivo ? null : { nombre, datos: datos || leer("text-dates.xlsx"), campo });
    return pedir(port, "/review", { method: "POST", headers: m.headers, cuerpo: m.cuerpo });
}

/* ------------------------------------------------------------------ *
 * POST /review
 * ------------------------------------------------------------------ */

test("GET /review sirve la pagina", async () => {
    const { port } = await levantar();
    const res = await pedir(port, "/review");
    assert.equal(res.status, 200);
    assert.match(res.texto, /Revisar un archivo/);
});

test("un .xlsx real devuelve el informe", async () => {
    const { port } = await levantar();
    const res = await revisar(port, {
        nombre: "SUBCONTRATA UNO.xlsx",
        mostrado: "SUBCONTRATA UNO.xlsx",
        datos: leer("text-dates.xlsx"),
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.periodo, PERIODO);
    // El nombre con espacios sobrevive: safeFileNames se los quita al archivo subido, asi
    // que el rotulo viaja aparte (si no, el operador ve "SUBCONTRATAUNO").
    assert.equal(res.json.archivo, "SUBCONTRATA UNO.xlsx");
    assert.equal(res.json.subcontratista, "SUBCONTRATA UNO");
    assert.ok(res.json.resumen.total > 0);
});

test("sin el nombre original se cae al que saneo la subida", async () => {
    const { port } = await levantar();
    const res = await revisar(port, { nombre: "SUBCONTRATA UNO.xlsx" });
    assert.equal(res.status, 200);
    assert.equal(res.json.archivo, "SUBCONTRATAUNO.xlsx");
});

test("el nombre mostrado es solo una etiqueta y no toca el disco", async () => {
    const { port } = await levantar();
    const res = await revisar(port, { mostrado: "../../../etc/passwd" });
    assert.equal(res.status, 200);
    // Se devuelve tal cual para mostrarlo (la pagina lo escapa), pero el archivo leido fue
    // el temporal de la subida: el informe trae filas, no el contenido de otra ruta.
    assert.equal(res.json.archivo, "../../../etc/passwd");
    assert.equal(res.json.ok, true);
    assert.ok(res.json.stats.filasLeidas > 0);
});

test("un .zip se rechaza: la revision es de un archivo, no del mes", async () => {
    const { port } = await levantar();
    const res = await revisar(port, { nombre: "subcontratistas.zip" });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "formato invalido");
});

test("un archivo renombrado a .xlsx se rechaza por sus bytes", async () => {
    const { port } = await levantar();
    const res = await revisar(port, { nombre: "trampa.xlsx", datos: Buffer.from("no soy un xlsx") });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "archivo invalido");
});

test("sin archivo se responde 400 y se dice que falta", async () => {
    const { port } = await levantar();
    const res = await revisar(port, { sinArchivo: true });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "falta el archivo");
});

test("un periodo invalido es 400, no un informe", async () => {
    const { port } = await levantar();
    const res = await revisar(port, { periodo: "2026-13" });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "periodo invalido");
});

test("sin periodo se usa el mes anterior, igual que /api/periodo sugiere", async () => {
    const { port } = await levantar();
    const res = await revisar(port, { periodo: null });
    assert.equal(res.status, 200);
    // AHORA es 2026-03-15, asi que el mes anterior es 2026-02.
    assert.equal(res.json.periodo, "2026-02");
});

test("el temporal de la subida no sobrevive a la peticion", async () => {
    const { app, port } = await levantar();
    const tempDir = app.locals.tempFileDir || path.join(config.TMP_ROOT, "uploads");
    const antes = fs.existsSync(tempDir) ? fs.readdirSync(tempDir).length : 0;

    await revisar(port, {});
    await revisar(port, { nombre: "otro.xlsx", datos: leer("cese-sentinels.xlsx") });

    const despues = fs.existsSync(tempDir) ? fs.readdirSync(tempDir).length : 0;
    assert.equal(despues, antes, "quedaron temporales de la revision en disco");
});

test("revisar NO espera a una consolidacion en curso", async () => {
    const { port } = await levantar({ cli: "cli-cuelga.js" });

    // Arranca una consolidacion que no termina, para tomar el guardia de flujo unico.
    const m = multipart({ periodo: PERIODO }, {
        campo: "zipFile",
        nombre: "mes.zip",
        datos: Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]),
    });
    const arranque = await pedir(port, "/uploadfiles", { method: "POST", headers: m.headers, cuerpo: m.cuerpo });
    assert.equal(arranque.status, 202, "la consolidacion deberia haber arrancado");

    // Una segunda consolidacion SI se rechaza - es el guardia haciendo su trabajo.
    const segunda = await pedir(port, "/uploadfiles", { method: "POST", ...multipart({ periodo: PERIODO }, {
        campo: "zipFile", nombre: "mes.zip",
        datos: Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]),
    }) });
    assert.equal(segunda.status, 409, "el guardia de flujo unico deberia seguir puesto");

    // La revision, en cambio, pasa: no abre la plantilla y no compite por esa memoria.
    const res = await revisar(port, {});
    assert.equal(res.status, 200, "la revision no debe quedar detras de la consolidacion");
    assert.equal(res.json.ok, true);
});

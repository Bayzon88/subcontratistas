"use strict";
/**
 * src/server.js - the web front door, driven over real HTTP on an ephemeral port.
 *
 * No supertest and no new dependency: `node:http` against `app.listen(0)` is the whole
 * harness. The child is a stub `cli.js` written into a temp directory, because what is
 * under test here is the SERVER's half of the contract - it owns no pipeline logic
 * (05-implementation-plan.md §2.3), and `pipeline/run.js` already has its own end-to-end
 * suite over the fixture corpus.
 *
 * The seven claims this file holds, each a defect the old `src/app.js` shipped:
 *
 *   1. a non-zip is refused (by extension AND by its bytes), and so is a period in the
 *      future or missing (03 §6, 05 §8 Q5);
 *   2. an upload over the cap is refused with 413 instead of being buffered into RAM
 *      (BUG-38);
 *   3. `POST /uploadfiles` answers immediately with a job id - the work is off the request
 *      and `req.setTimeout(6000000)` is gone (BUG-35);
 *   4. a second run while one is in flight is a 409, not a second 944 MB child
 *      (05 §6 risk row 6);
 *   5. `GET /progress/:id` really streams - it never existed server-side before (BUG-45);
 *   6. the download serves THE FILE THIS JOB PRODUCED, with a decoy sitting in the same
 *      directory that the old `(a, b) => a.ctime + b.ctime` scan would have served
 *      instead (BUG-36 / BUG-40, AC 23);
 *   7. a failed job answers non-200 and NAMES the subcontratista that caused it - including
 *      the case that used to answer 200 OK with a download button for a report that was
 *      never written (BUG-37, AC 24).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const { createServer } = require("../server");
const { parsePeriod, PERIOD_ERROR } = require("../pipeline/period");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "server-test-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
const scratch = (nombre) => {
    const dir = path.join(TMP, `${nombre}-${seq++}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};

/** The period every test uses, and the name the SERVER must derive from it. */
const PERIODO = "2026-02";
const PERIOD = parsePeriod(PERIODO);
const NOMBRE = PERIOD.filename;                 // Reporte_Subcontratistas_FEBRERO_2026.xlsx
const RUN_JSON = `${PERIOD.filenameBase}_run.json`;
/** Alphabetically first in the reports directory - what the old download route served. */
const SENUELO = "Reporte_Subcontratistas_ABRIL_2026.xlsx";
const AHORA = () => new Date(2026, 2, 15, 10, 0, 0);   // 2026-03-15, so 2026-02 is past

const CONTENIDO = "REPORTE DE FEBRERO 2026 - el archivo que este trabajo produjo";

/* ------------------------------------------------------------------ *
 * Stub CLIs
 * ------------------------------------------------------------------ */

const RESUMEN = {
    version: 1,
    ok: false,
    resumen: {
        subcontratistas: {
            esperados: 3, leidos: 2, fallidos: 1,
            nombresFallidos: ["CONSTRUCTORA FALLIDA SAC"],
        },
        archivos: { vistos: 3, procesados: 2, fallidos: 1 },
        filas: { leidas: 15, rechazadas: 2, colapsadas: 1, escritas: 12 },
        conservacion: { ok: true },
    },
    fallos: [{
        subcontratista: "CONSTRUCTORA FALLIDA SAC",
        archivo: "personal.xlsx",
        motivo: "no se encontro la hoja Cuadro",
    }],
};

const PREAMBULO = `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
const entrada = arg("--input"), periodo = arg("--period"), salida = arg("--out");
if (!entrada || !periodo || !salida) { console.error("faltan argumentos: " + argv.join(" ")); process.exit(2); }
if (!fs.existsSync(entrada)) { console.error("no existe la entrada " + entrada); process.exit(2); }
const NOMBRE = ${JSON.stringify(NOMBRE)};
const RUN_JSON = ${JSON.stringify(RUN_JSON)};
const CONTENIDO = ${JSON.stringify(CONTENIDO)};
const RESUMEN = ${JSON.stringify(RESUMEN)};
const dormir = (ms) => new Promise(r => setTimeout(r, ms));
`;

/** Progress over BOTH channels the server accepts, plus one plain-text line. */
const PROGRESO = `
if (process.send) process.send({ phase: "extraccion", message: path.basename(entrada) });
process.stdout.write(JSON.stringify({ phase: "lectura", current: 1, total: 2, message: "ACME SAC" }) + "\\n");
process.stdout.write(JSON.stringify({ phase: "lectura", current: 2, total: 2, message: "OTRA SAC" }) + "\\n");
process.stdout.write("consolidando filas\\n");
`;

const CLIS = {
    // The happy path: writes the report, the run log, and reports its outputs over IPC.
    "cli-ok.js": PREAMBULO + PROGRESO + `
fs.writeFileSync(path.join(salida, NOMBRE), CONTENIDO);
fs.writeFileSync(path.join(salida, RUN_JSON), JSON.stringify(RESUMEN));
if (process.send) process.send({ phase: "fin", message: NOMBRE, outputs: { reporte: path.join(salida, NOMBRE) } });
process.exit(0);
`,
    // The same, slowly, so a second upload has something to collide with.
    "cli-lento.js": PREAMBULO + PROGRESO + `
(async () => {
  await dormir(700);
  fs.writeFileSync(path.join(salida, NOMBRE), CONTENIDO);
  fs.writeFileSync(path.join(salida, RUN_JSON), JSON.stringify(RESUMEN));
  process.exit(0);
})();
`,
    // Salida 1 del CLI: el reporte SI se escribio y le falta un subcontratista. Es un
    // entregable incompleto, no un trabajo fallido (03 §8).
    "cli-incompleto.js": PREAMBULO + PROGRESO + `
fs.writeFileSync(path.join(salida, NOMBRE), CONTENIDO);
fs.writeFileSync(path.join(salida, RUN_JSON), JSON.stringify(RESUMEN));
if (process.send) process.send({ tipo: "resultado", ok: false, exit: 1, salidas: { reporte: path.join(salida, NOMBRE) }, resumen: RESUMEN.resumen });
process.exit(1);
`,
    // Salida 3 del CLI (SIN_REPORTE): no hay libro. El motivo va por el evento de error,
    // el diagnostico por stderr, y el culpable queda nombrado en el log de la corrida.
    "cli-falla.js": PREAMBULO + PROGRESO + `
fs.writeFileSync(path.join(salida, RUN_JSON), JSON.stringify(RESUMEN));
if (process.send) process.send({ tipo: "error", exit: 3, codigo: "NO_RECORDS",
  mensaje: "no se acepto ningun trabajador para el periodo " + periodo, resumen: RESUMEN.resumen });
console.error("error: no se acepto ningun trabajador para el periodo " + periodo);
console.error("  CONSTRUCTORA FALLIDA SAC: no se encontro la hoja Cuadro");
process.exit(3);
`,
    // BUG-37 in miniature: exits 0 having written nothing. The old app answered 200 OK and
    // offered a download for exactly this.
    "cli-mudo.js": PREAMBULO + `
process.exit(0);
`,
    // A crash inside the child must not take the server with it.
    "cli-explota.js": PREAMBULO + `
throw new Error("boom: xlsx-populate se quedo sin memoria");
`,
};

const CLI_DIR = path.join(TMP, "clis");
fs.mkdirSync(CLI_DIR, { recursive: true });
for (const [nombre, cuerpo] of Object.entries(CLIS)) {
    fs.writeFileSync(path.join(CLI_DIR, nombre), cuerpo);
}
const cli = (nombre) => path.join(CLI_DIR, nombre);

/* ------------------------------------------------------------------ *
 * HTTP harness
 * ------------------------------------------------------------------ */

const servidores = [];
test.after(() => {
    for (const { app, server } of servidores) {
        try { app.locals.detener(); } catch { /* ya detenido */ }
        try { server.closeAllConnections(); } catch { /* ya cerrado */ }
        try { server.close(); } catch { /* ya cerrado */ }
    }
});

async function levantar(opciones = {}) {
    const outDir = opciones.outDir || scratch("reportes");
    const app = createServer({
        cliPath: cli(opciones.cli || "cli-ok.js"),
        outDir,
        maxUploadBytes: opciones.maxUploadBytes || 4 * 1024 * 1024,
        now: opciones.now || AHORA,
        // El temporizador de inactividad de express-fileupload queda armado tras una subida
        // abortada; en produccion son 60 s de un proceso que vive meses, aqui son 60 s de
        // suite colgada.
        uploadTimeoutMs: 250,
        ...(opciones.jobTimeoutMs ? { jobTimeoutMs: opciones.jobTimeoutMs } : {}),
    });
    const server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    servidores.push({ app, server });
    return { app, server, outDir, port: server.address().port };
}

function pedir(port, ruta, opciones = {}) {
    return new Promise((resolve, reject) => {
        let resuelto = false;
        const req = http.request({
            host: "127.0.0.1", port, path: ruta,
            method: opciones.method || "GET",
            headers: opciones.headers || {},
        }, (res) => {
            const trozos = [];
            res.on("data", (d) => trozos.push(d));
            res.on("end", () => {
                const cuerpo = Buffer.concat(trozos);
                const texto = cuerpo.toString("utf8");
                let json = null;
                try { json = JSON.parse(texto); } catch { /* no es JSON */ }
                resuelto = true;
                resolve({ status: res.statusCode, headers: res.headers, cuerpo, texto, json });
            });
        });
        req.on("error", (err) => { if (!resuelto) reject(err); });
        req.end(opciones.cuerpo);
    });
}

/** multipart/form-data, hand-rolled - the browser's half of the upload. */
function multipart(campos = {}, archivo = null) {
    const boundary = "----subcontratistas" + crypto.randomBytes(8).toString("hex");
    const partes = [];
    for (const [k, v] of Object.entries(campos)) {
        partes.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    if (archivo) {
        partes.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${archivo.campo || "zipFile"}"; ` +
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

/** A minimal, genuinely-shaped zip: the end-of-central-directory record of an empty one. */
const ZIP_VACIO = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);
const zipDe = (bytes) => Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(Math.max(0, bytes - 4), 0x41)]);

function subir(port, { periodo = PERIODO, nombre = "subcontratistas.zip", datos = ZIP_VACIO, campos = {}, sinArchivo = false } = {}) {
    const cuerpoCampos = periodo === null ? { ...campos } : { periodo, ...campos };
    const m = multipart(cuerpoCampos, sinArchivo ? null : { nombre, datos });
    return pedir(port, "/uploadfiles", { method: "POST", headers: m.headers, cuerpo: m.cuerpo });
}

/** Read the SSE stream until a terminal event arrives. */
function escuchar(port, id, limiteMs = 15000) {
    return new Promise((resolve, reject) => {
        const eventos = [];
        let hecho = false;
        const terminar = (fn, arg) => { if (hecho) return; hecho = true; clearTimeout(reloj); try { req.destroy(); } catch { /* ya */ } fn(arg); };
        const req = http.get({ host: "127.0.0.1", port, path: `/progress/${id}` }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return terminar(reject, new Error(`SSE respondio ${res.statusCode}`));
            }
            res.setEncoding("utf8");
            let resto = "";
            res.on("data", (chunk) => {
                resto += chunk;
                let i;
                while ((i = resto.indexOf("\n\n")) !== -1) {
                    const bloque = resto.slice(0, i);
                    resto = resto.slice(i + 2);
                    for (const linea of bloque.split("\n")) {
                        if (!linea.startsWith("data:")) continue;
                        try { eventos.push(JSON.parse(linea.slice(5).trim())); } catch { /* retry/latido */ }
                    }
                    const ultimo = eventos[eventos.length - 1];
                    if (ultimo && (ultimo.tipo === "fin" || ultimo.tipo === "error")) {
                        return terminar(resolve, eventos);
                    }
                }
            });
            res.on("end", () => terminar(resolve, eventos));
        });
        const reloj = setTimeout(() => terminar(reject, new Error("SSE sin evento terminal")), limiteMs);
        req.on("error", (err) => terminar(reject, err));
    });
}

async function esperarEstado(app, id, estados, limiteMs = 15000) {
    const fin = Date.now() + limiteMs;
    for (;;) {
        const job = app.locals.trabajos.get(id);
        if (job && estados.includes(job.estado)) return job;
        if (Date.now() > fin) throw new Error(`el trabajo ${id} sigue en ${job ? job.estado : "(desconocido)"}`);
        await new Promise(r => setTimeout(r, 25));
    }
}

/* ------------------------------------------------------------------ *
 * La pagina
 * ------------------------------------------------------------------ */

test("GET / sirve la pagina, sin CDN y con selector de periodo", async () => {
    const { port } = await levantar();
    const res = await pedir(port, "/");

    assert.equal(res.status, 200);
    // BUG-54: el <title>Document</title> y las tres CDN que dejaban la pagina inutilizable
    // sin internet.
    assert.match(res.texto, /<title>Consolidar subcontratistas<\/title>/);
    assert.doesNotMatch(res.texto, /cdn\.jsdelivr|cdnjs\.cloudflare|unpkg\.com/);
    assert.doesNotMatch(res.texto, /alvarobeltran\.dev/);
    // El selector de periodo, mostrado ANTES de subir (05 §8 Q5).
    assert.match(res.texto, /id="mes"/);
    assert.match(res.texto, /id="anio"/);
    // La instruccion duplicada "El archivo debe estar en formato zip" aparecia dos veces.
    assert.equal(res.texto.split("debe estar en formato").length - 1, 1);
});

test("el cliente ya no calcula el nombre del archivo", async () => {
    // BUG-40: public/js/index.js:103-111 duplicaba getMonthAndYear() y RENOMBRABA la
    // descarga. El nombre lo manda el servidor.
    const js = fs.readFileSync(path.join(__dirname, "..", "..", "public", "js", "index.js"), "utf8");
    // No arma el nombre del archivo en ninguna parte, ni con el reloj ni con una tabla.
    assert.doesNotMatch(js, /Reporte_Subcontratistas/);
    assert.doesNotMatch(js, /toLocaleString/);
    assert.doesNotMatch(js, /downloadElement\.download|\.download\s*=/);
    assert.doesNotMatch(js, /axios/);
    assert.match(js, /EventSource/);
});

test("GET /api/periodo sugiere el mes calendario anterior", async () => {
    const { port } = await levantar();
    const res = await pedir(port, "/api/periodo");

    assert.equal(res.status, 200);
    assert.equal(res.json.sugerido, "2026-02");   // el reloj inyectado dice 2026-03-15
    assert.equal(res.json.maximo, "2026-03");
});

/* ------------------------------------------------------------------ *
 * Validacion de la subida
 * ------------------------------------------------------------------ */

test("rechaza una subida sin archivo", async () => {
    const { port } = await levantar();
    const res = await subir(port, { sinArchivo: true });

    assert.equal(res.status, 400);
    assert.match(res.json.mensaje, /No se recibio ningun archivo/);
});

test("rechaza un archivo que no es .zip por extension", async () => {
    const { port } = await levantar();
    const res = await subir(port, { nombre: "personal.xlsx", datos: Buffer.from("PKxx") });

    assert.equal(res.status, 400);
    assert.equal(res.json.error, "formato invalido");
    assert.match(res.json.mensaje, /\.zip/);
});

test("rechaza un archivo .zip que no es un zip", async () => {
    const { port } = await levantar();
    const res = await subir(port, { nombre: "personal.zip", datos: Buffer.from("esto no es un zip") });

    assert.equal(res.status, 400);
    assert.equal(res.json.error, "formato invalido");
});

test("rechaza una subida que supera el limite (413, sin bufferearla en memoria)", async () => {
    const { port } = await levantar({ maxUploadBytes: 1024 });
    const res = await subir(port, { datos: zipDe(64 * 1024) });

    // BUG-38: express-fileupload venia sin limits y sin abortOnLimit.
    assert.equal(res.status, 413);
    assert.match(res.texto, /limite/i);
});

test("rechaza un periodo ausente y un periodo futuro", async () => {
    const { port } = await levantar();

    const sin = await subir(port, { periodo: null });
    assert.equal(sin.status, 400);
    assert.match(sin.json.mensaje, /Seleccione el mes/);

    const futuro = await subir(port, { periodo: "2026-04" });   // el reloj dice 2026-03
    assert.equal(futuro.status, 400);
    assert.equal(futuro.json.codigo, PERIOD_ERROR.PERIOD_FUTURE);

    const malo = await subir(port, { periodo: "febrero-2026" });
    assert.equal(malo.status, 400);
    assert.equal(malo.json.codigo, PERIOD_ERROR.PERIOD_MALFORMED);
});

/* ------------------------------------------------------------------ *
 * El trabajo
 * ------------------------------------------------------------------ */

test("POST /uploadfiles devuelve un id de trabajo de inmediato", async () => {
    const { app, port } = await levantar({ cli: "cli-lento.js" });
    const t0 = Date.now();
    const res = await subir(port);
    const transcurrido = Date.now() - t0;

    assert.equal(res.status, 202);
    assert.match(res.json.id, /^[0-9a-f-]{36}$/);
    assert.equal(res.json.periodo, PERIODO);
    // El nombre lo calcula el servidor a partir del periodo elegido (03 §7.5, AC 23).
    assert.equal(res.json.archivo, NOMBRE);
    assert.equal(res.json.progreso, `/progress/${res.json.id}`);
    // BUG-35: el trabajo dura ~700 ms; la respuesta no lo espera.
    assert.ok(transcurrido < 500, `la respuesta tardo ${transcurrido} ms`);

    await esperarEstado(app, res.json.id, ["listo", "error"]);
});

test("refuse un segundo trabajo mientras uno esta en curso (409, no un OOM)", async () => {
    const { app, port } = await levantar({ cli: "cli-lento.js" });

    const primero = await subir(port);
    assert.equal(primero.status, 202);

    const segundo = await subir(port);
    // 05 §6 fila 6: la plantilla consume ~944 MB de RSS; dos a la vez agotan la maquina.
    assert.equal(segundo.status, 409);
    assert.equal(segundo.json.periodo, PERIODO);
    assert.equal(segundo.json.id, primero.json.id);
    assert.match(segundo.json.mensaje, /en curso|procesando/i);

    // Y el cerrojo se libera al terminar.
    await esperarEstado(app, primero.json.id, ["listo"]);
    const tercero = await subir(port);
    assert.equal(tercero.status, 202);
    await esperarEstado(app, tercero.json.id, ["listo", "error"]);
});

test("GET /progress/:id transmite el avance y el evento final", async () => {
    const { app, port } = await levantar({ cli: "cli-lento.js" });
    const alta = await subir(port);

    const eventos = await escuchar(port, alta.json.id);
    const progresos = eventos.filter(e => e.tipo === "progreso");
    const fin = eventos[eventos.length - 1];

    // BUG-45: /progress nunca existio del lado del servidor.
    assert.ok(progresos.length >= 4, `solo llegaron ${progresos.length} eventos de progreso`);
    // Tanto el mensaje por IPC como las lineas JSON de stdout y el texto plano.
    assert.ok(progresos.some(e => e.fase === "extraccion"));
    const lectura = progresos.filter(e => e.fase === "lectura");
    assert.equal(lectura.length, 2);
    assert.deepEqual([lectura[0].actual, lectura[0].total], [1, 2]);
    assert.ok(progresos.some(e => e.mensaje === "consolidando filas"));

    assert.equal(fin.tipo, "fin");
    assert.equal(fin.estado, "listo");
    assert.equal(fin.archivo, NOMBRE);
    assert.equal(fin.resumen.filas.escritas, 12);
    assert.deepEqual(fin.resumen.subcontratistas.nombresFallidos, ["CONSTRUCTORA FALLIDA SAC"]);

    await esperarEstado(app, alta.json.id, ["listo"]);
});

test("GET /progress/:id repite los eventos ya emitidos a quien se conecta tarde", async () => {
    const { app, port } = await levantar({ cli: "cli-ok.js" });
    const alta = await subir(port);
    await esperarEstado(app, alta.json.id, ["listo"]);

    // El trabajo ya termino: el stream entrega todo y cierra.
    const eventos = await escuchar(port, alta.json.id, 5000);
    assert.ok(eventos.length >= 5);
    assert.equal(eventos[eventos.length - 1].tipo, "fin");
});

/* ------------------------------------------------------------------ *
 * La descarga
 * ------------------------------------------------------------------ */

test("la descarga sirve EL archivo que este trabajo produjo, no el primero del directorio", async () => {
    const outDir = scratch("reportes");
    // El archivo que la ruta vieja servia: `filesWithStats.sort((a,b) => a.ctime + b.ctime)`
    // no ordena nada, y ABRIL_2026 es el primero por orden alfabetico (BUG-36).
    fs.writeFileSync(path.join(outDir, SENUELO), "SENUELO - el mes equivocado");
    const { app, port } = await levantar({ cli: "cli-ok.js", outDir });

    const alta = await subir(port);
    await esperarEstado(app, alta.json.id, ["listo"]);

    const res = await pedir(port, `/descargar/${alta.json.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.texto, CONTENIDO);
    assert.notEqual(res.texto, "SENUELO - el mes equivocado");
    // Y bajo el nombre que el servidor calculo del periodo, no uno que arme el cliente.
    assert.match(res.headers["content-disposition"], new RegExp(NOMBRE));

    const job = app.locals.trabajos.get(alta.json.id);
    assert.equal(job.archivo, path.join(outDir, NOMBRE));
});

test("dos periodos seguidos: cada trabajo sirve el suyo", async () => {
    const outDir = scratch("reportes");
    const { app, port } = await levantar({ cli: "cli-ok.js", outDir });

    const primero = await subir(port);
    await esperarEstado(app, primero.json.id, ["listo"]);
    // El segundo reescribe el mismo nombre (mismo periodo): la ruta sigue sirviendo por id.
    const segundo = await subir(port);
    await esperarEstado(app, segundo.json.id, ["listo"]);

    const a = await pedir(port, `/descargar/${primero.json.id}`);
    const b = await pedir(port, `/descargar/${segundo.json.id}`);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.texto, CONTENIDO);
    assert.equal(b.texto, CONTENIDO);
});

test("un trabajo desconocido es 404 en progreso y en descarga", async () => {
    const { port } = await levantar();
    const inventado = crypto.randomUUID();

    assert.equal((await pedir(port, `/descargar/${inventado}`)).status, 404);
    assert.equal((await pedir(port, `/progress/${inventado}`)).status, 404);
});

/* ------------------------------------------------------------------ *
 * Los fallos
 * ------------------------------------------------------------------ */

test("un trabajo fallido responde non-200 y NOMBRA al subcontratista", async () => {
    const { app, port } = await levantar({ cli: "cli-falla.js" });
    const alta = await subir(port);
    assert.equal(alta.status, 202);

    const eventos = await escuchar(port, alta.json.id);
    const ultimo = eventos[eventos.length - 1];
    assert.equal(ultimo.tipo, "error");
    // El motivo que dio el hijo, no un "codigo 3" generico.
    assert.match(ultimo.error.mensaje, /no se acepto ningun trabajador/);
    assert.equal(ultimo.error.codigo, "NO_RECORDS");
    assert.equal(ultimo.error.salida, 3);
    assert.equal(ultimo.error.fallos[0].subcontratista, "CONSTRUCTORA FALLIDA SAC");
    assert.match(ultimo.error.fallos[0].motivo, /Cuadro/);
    // El stderr del hijo llega como diagnostico, en vez de perderse en un console.clear().
    assert.match(ultimo.error.detalle, /CONSTRUCTORA FALLIDA SAC/);

    // AC 24: la falla se propaga como respuesta non-200, en las dos rutas.
    const estado = await pedir(port, `/trabajos/${alta.json.id}`);
    assert.equal(estado.status, 500);
    assert.equal(estado.json.estado, "error");

    const descarga = await pedir(port, `/descargar/${alta.json.id}`);
    assert.equal(descarga.status, 500);
    assert.equal(descarga.json.fallos[0].subcontratista, "CONSTRUCTORA FALLIDA SAC");

    await esperarEstado(app, alta.json.id, ["error"]);
});

test("salida 1: el reporte se entrega igual, marcado INCOMPLETO y con los nombres", async () => {
    // El CLI distingue "no se genero" de "se genero y falta alguien". Negarle el archivo
    // al operador por lo segundo seria peor que el silencio que este rework elimina: lo
    // que hace falta es el archivo Y los nombres (03 §8).
    const { app, port } = await levantar({ cli: "cli-incompleto.js" });
    const alta = await subir(port);

    const eventos = await escuchar(port, alta.json.id);
    const fin = eventos[eventos.length - 1];
    assert.equal(fin.tipo, "fin");
    assert.equal(fin.estado, "listo");
    assert.equal(fin.incompleto, true);
    assert.deepEqual(fin.resumen.subcontratistas.nombresFallidos, ["CONSTRUCTORA FALLIDA SAC"]);

    const descarga = await pedir(port, `/descargar/${alta.json.id}`);
    assert.equal(descarga.status, 200);
    assert.equal(descarga.texto, CONTENIDO);
});

test("salir con exito sin escribir el reporte es un fallo, no una descarga", async () => {
    // BUG-37 exactamente: excelReporting.js atrapaba el error y volvia normalmente, y
    // app.js:94 respondia 200 OK con boton de descarga para un reporte inexistente.
    const { app, port } = await levantar({ cli: "cli-mudo.js" });
    const alta = await subir(port);
    const job = await esperarEstado(app, alta.json.id, ["error"]);

    assert.equal(job.estado, "error");
    assert.match(job.error.mensaje, /no escribio el reporte/);
    assert.match(job.error.mensaje, new RegExp(NOMBRE));
    assert.equal((await pedir(port, `/descargar/${alta.json.id}`)).status, 500);
});

test("no presenta el resumen de una corrida anterior como si fuera el de esta", async () => {
    const outDir = scratch("reportes");
    // Restos de un run.json de la corrida del mes pasado, con la misma cara.
    const viejo = path.join(outDir, RUN_JSON);
    fs.writeFileSync(viejo, JSON.stringify(RESUMEN));
    const hace1h = new Date(Date.now() - 3600_000);
    fs.utimesSync(viejo, hace1h, hace1h);

    const { app, port } = await levantar({ cli: "cli-mudo.js", outDir });
    const alta = await subir(port);
    const job = await esperarEstado(app, alta.json.id, ["error"]);

    assert.equal(job.resumen, null);
});

test("un hijo que revienta no se lleva al servidor", async () => {
    const { app, port } = await levantar({ cli: "cli-explota.js" });
    const alta = await subir(port);
    const job = await esperarEstado(app, alta.json.id, ["error"]);

    assert.equal(job.estado, "error");
    assert.match(job.error.detalle, /boom/);
    // Y el servidor sigue atendiendo, con el cerrojo liberado.
    assert.equal((await pedir(port, "/api/periodo")).status, 200);
    const otra = await subir(port);
    assert.equal(otra.status, 202);
    await esperarEstado(app, otra.json.id, ["error"]);
});

test("si falta src/cli.js el trabajo falla con un mensaje, no con un cuelgue", async () => {
    const { app, port } = await levantar({ cli: "cli-que-no-existe.js" });
    const alta = await subir(port);
    const job = await esperarEstado(app, alta.json.id, ["error"]);

    assert.equal(job.estado, "error");
    assert.match(job.error.detalle, /Cannot find module|no such file/i);
});

/* ------------------------------------------------------------------ *
 * Limpieza
 * ------------------------------------------------------------------ */

test("el directorio temporal del trabajo se borra al terminar, bien y mal", async () => {
    for (const [stub, estado] of [["cli-ok.js", "listo"], ["cli-falla.js", "error"]]) {
        const { app, port } = await levantar({ cli: stub });
        const alta = await subir(port);
        const job = await esperarEstado(app, alta.json.id, [estado]);

        // BUG-43 / BUG-44: el borrado corria en un callback sin await que competia con el
        // reporte, y en el camino de error no corria en absoluto, lo que dejaba tildada la
        // corrida siguiente.
        assert.equal(job.estado, estado);
        assert.equal(fs.existsSync(job.dirTemporal), false, `${job.dirTemporal} sobrevivio (${stub})`);
        assert.equal(job.limpieza, true);
    }
});

test("el zip subido va a un directorio propio, con separador (BUG-32)", async () => {
    const { app, port } = await levantar({ cli: "cli-lento.js" });
    const alta = await subir(port);

    const job = app.locals.trabajos.get(alta.json.id);
    assert.equal(path.basename(job.zip), "entrada.zip");
    assert.equal(path.dirname(job.zip), job.dirTemporal);
    assert.equal(fs.existsSync(job.zip), true);
    assert.match(path.basename(job.dirTemporal), /^upload-/);

    await esperarEstado(app, alta.json.id, ["listo", "error"]);
});

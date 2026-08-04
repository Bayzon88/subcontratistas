"use strict";
/**
 * Cliente de la pagina de consolidacion. Sin framework, sin build, sin CDN:
 * `fetch()` para subir y `EventSource` para el avance, que es todo lo que hace falta
 * (05-implementation-plan.md Fase 6 tarea 7).
 *
 * Lo que cambio respecto de la version anterior, y por que:
 *
 *  - **No existe mas `getMonthAndYear()` aqui.** El cliente calculaba el nombre del
 *    archivo con el reloj del navegador y RENOMBRABA la descarga a ese nombre, mientras
 *    el servidor mandaba cualquier archivo que `readdirSync` hubiera devuelto primero
 *    (BUG-36 / BUG-40). El operador venia descargando el mes equivocado con el nombre
 *    correcto. Ahora el nombre lo calcula el servidor una sola vez, a partir del periodo
 *    elegido, y la descarga es un enlace al trabajo que lo produjo.
 *  - **El periodo se elige antes de subir** (05 seccion 8 Q5): mes + anio, por defecto el
 *    mes calendario anterior, y un periodo futuro se rechaza aqui ademas de en el servidor.
 *  - **Hay avance real.** Antes el boton quedaba deshabilitado varios minutos sin decir
 *    nada, porque `/progress` nunca existio del lado del servidor (BUG-45).
 *  - **Un error dice que fallo y quien lo causo**, en vez de un boton "Error: Refresh Page".
 */

/** Solo para rotular el selector. El NOMBRE DEL ARCHIVO no se arma aqui: lo calcula el
 *  servidor a partir del periodo elegido y lo devuelve (03-expected-output.md 7.5). */
const MESES = [
    "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

/** Etiquetas de las fases que emite pipeline/run.js, y cuanto de la barra lleva cada una. */
const FASES = {
    inicio: { texto: "Iniciando", desde: 0, hasta: 4 },
    extraccion: { texto: "Descomprimiendo el archivo", desde: 4, hasta: 12 },
    recorrido: { texto: "Buscando los archivos de cada subcontratista", desde: 12, hasta: 16 },
    lectura: { texto: "Leyendo subcontratistas", desde: 16, hasta: 68 },
    dedupe: { texto: "Quitando duplicados", desde: 68, hasta: 72 },
    consolidado: { texto: "Escribiendo el consolidado", desde: 72, hasta: 78 },
    metricas: { texto: "Calculando metricas", desde: 78, hasta: 82 },
    reporte: { texto: "Generando el reporte", desde: 82, hasta: 93 },
    runlog: { texto: "Escribiendo el registro de la corrida", desde: 93, hasta: 96 },
    shadow: { texto: "Comparando con el pipeline anterior", desde: 96, hasta: 97 },
    limpieza: { texto: "Limpiando archivos temporales", desde: 97, hasta: 99 },
    fin: { texto: "Listo", desde: 100, hasta: 100 },
};

const $ = (id) => document.getElementById(id);

const el = {
    mes: $("mes"),
    anio: $("anio"),
    nota: $("periodo-nota"),
    zona: $("zona"),
    archivo: $("archivo"),
    etiquetaArchivo: $("etiqueta-archivo"),
    procesar: $("procesar"),
    avance: $("avance"),
    barra: $("barra"),
    fase: $("fase"),
    detalle: $("detalle"),
    resultado: $("resultado"),
};

const TEXTO_ARCHIVO = el.etiquetaArchivo.textContent.trim();

/** Tope del selector: el mes en curso. Un periodo futuro no se puede consolidar porque
 *  todavia no ocurrio; el servidor lo rechaza igual (05 seccion 8 Q5). */
let maximo = mesActualLocal();
let fuente = null;      // EventSource
let sondeo = null;      // respaldo por si el stream se corta
let trabajo = null;

/* ------------------------------------------------------------------ *
 * Periodo
 * ------------------------------------------------------------------ */

function mesActualLocal() {
    const hoy = new Date();
    return { anio: hoy.getFullYear(), mes: hoy.getMonth() + 1 };
}

function mesAnteriorLocal() {
    const { anio, mes } = mesActualLocal();
    return mes === 1 ? { anio: anio - 1, mes: 12 } : { anio, mes: mes - 1 };
}

function clave() {
    return `${el.anio.value}-${String(el.mes.value).padStart(2, "0")}`;
}

function esFuturo() {
    const anio = Number(el.anio.value);
    const mes = Number(el.mes.value);
    return anio > maximo.anio || (anio === maximo.anio && mes > maximo.mes);
}

function poblarSelectores(porDefecto) {
    MESES.forEach((nombre, i) => {
        const o = document.createElement("option");
        o.value = String(i + 1);
        o.textContent = nombre;
        el.mes.appendChild(o);
    });
    for (let a = maximo.anio + 1; a >= maximo.anio - 6; a--) {
        const o = document.createElement("option");
        o.value = String(a);
        o.textContent = String(a);
        el.anio.appendChild(o);
    }
    el.mes.value = String(porDefecto.mes);
    el.anio.value = String(porDefecto.anio);
}

function revisarPeriodo() {
    const futuro = esFuturo();
    el.nota.classList.toggle("error", futuro);
    el.nota.textContent = futuro
        ? `El periodo ${MESES[Number(el.mes.value) - 1]} ${el.anio.value} todavia no ocurre. Elija un periodo pasado o el mes en curso.`
        : `Se consolidara el periodo ${MESES[Number(el.mes.value) - 1]} ${el.anio.value}.`;
    el.procesar.disabled = futuro || trabajo !== null;
    return !futuro;
}

/* ------------------------------------------------------------------ *
 * Vista
 * ------------------------------------------------------------------ */

function mostrarAvance(evento) {
    const { fase, mensaje, actual, total } = evento;
    el.avance.hidden = false;
    const f = FASES[fase] || null;
    el.fase.textContent = f ? f.texto : (fase || "Procesando");

    el.detalle.textContent = Number.isFinite(actual) && Number.isFinite(total) && total > 0
        ? (mensaje ? `${actual}/${total} - ${mensaje}` : `${actual}/${total}`)
        : (mensaje || "");

    // El CLI ya calcula su propio porcentaje ponderado; solo se estima cuando no lo manda.
    let pct = Number.isFinite(evento.pct) ? evento.pct : null;
    if (pct === null && f) {
        pct = Number.isFinite(actual) && Number.isFinite(total) && total > 0
            ? f.desde + ((f.hasta - f.desde) * Math.min(actual, total)) / total
            : f.desde;
    }
    if (pct === null) {
        el.barra.classList.add("indeterminado");
    } else {
        el.barra.classList.remove("indeterminado");
        el.barra.style.width = `${Math.max(0, Math.min(100, Math.round(pct)))}%`;
    }
}

function cifra(valor, rotulo) {
    if (valor === null || valor === undefined) return "";
    return `<li><span class="valor">${valor}</span><span class="rotulo">${rotulo}</span></li>`;
}

function escapar(texto) {
    return String(texto === null || texto === undefined ? "" : texto)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Los subcontratistas que no se pudieron leer, con nombre y motivo. Si esta lista no
 *  esta vacia el reporte esta incompleto, y el operador no puede no verlo. */
function bloqueFallidos(nombres, fallos) {
    const lista = [];
    const vistos = new Set();
    for (const f of fallos || []) {
        const nombre = f.subcontratista || f.archivo || "(sin nombre)";
        vistos.add(nombre);
        lista.push(`<li><strong>${escapar(nombre)}</strong>${f.motivo ? ` &mdash; ${escapar(f.motivo)}` : ""}</li>`);
    }
    for (const nombre of nombres || []) {
        if (!vistos.has(nombre)) lista.push(`<li><strong>${escapar(nombre)}</strong></li>`);
    }
    if (lista.length === 0) return "";
    return `<div class="fallidos">
        <h4>${lista.length} subcontratista(s) no se pudieron procesar &mdash; el reporte esta INCOMPLETO</h4>
        <ul>${lista.join("")}</ul>
      </div>`;
}

function mostrarFin(estado) {
    el.avance.hidden = false;
    el.barra.classList.remove("indeterminado");
    el.barra.style.width = "100%";
    el.fase.textContent = "Listo";
    el.detalle.textContent = "";

    const r = estado.resumen || {};
    const filas = r.filas || {};
    const subs = r.subcontratistas || {};
    const fallidos = bloqueFallidos(subs.nombresFallidos, r.fallos);
    // El reporte existe pero le falta gente: se entrega igual, y se dice.
    const incompleto = estado.incompleto === true || fallidos !== "";

    el.resultado.hidden = false;
    el.resultado.className = "resultado ok";
    el.resultado.innerHTML = `
      <h3>${incompleto ? "Reporte generado, INCOMPLETO" : "Reporte generado"}: ${escapar(estado.archivo)}</h3>
      <ul class="cifras">
        ${cifra(filas.escritas, "trabajadores")}
        ${cifra(filas.rechazadas, "filas rechazadas")}
        ${cifra(filas.colapsadas, "duplicados")}
        ${cifra(subs.leidos, "subcontratistas leidos")}
        ${cifra(subs.fallidos, "fallidos")}
      </ul>
      ${fallidos}
      <a class="descarga" href="${estado.descarga}">Descargar reporte</a>
      <p class="nota">El detalle completo esta en la hoja <strong>Errores</strong> dentro del archivo.</p>`;
}

function mostrarError(mensaje, error) {
    el.avance.hidden = true;
    el.resultado.hidden = false;
    el.resultado.className = "resultado fallo";
    const e = error || {};
    el.resultado.innerHTML = `
      <h3>La consolidacion fallo</h3>
      <p>${escapar(e.mensaje || mensaje)}</p>
      ${bloqueFallidos(null, e.fallos)}
      ${e.detalle ? `<details><summary>Detalle tecnico</summary><pre class="detalle-tecnico">${escapar(e.detalle)}</pre></details>` : ""}
      <p class="nota">Corrija lo indicado y vuelva a procesar. No hace falta recargar la pagina.</p>`;
}

/* ------------------------------------------------------------------ *
 * Trabajo
 * ------------------------------------------------------------------ */

function cerrarStream() {
    if (fuente) { fuente.close(); fuente = null; }
    if (sondeo) { clearInterval(sondeo); sondeo = null; }
}

function liberar() {
    trabajo = null;
    cerrarStream();
    revisarPeriodo();
    el.procesar.textContent = "Procesar";
}

function seguir(id) {
    fuente = new EventSource(`/progress/${id}`);
    fuente.onmessage = (ev) => {
        let dato;
        try { dato = JSON.parse(ev.data); } catch { return; }
        if (dato.tipo === "progreso") {
            mostrarAvance(dato);
        } else if (dato.tipo === "fin") {
            cerrarStream();
            mostrarFin(dato);
            liberar();
        } else if (dato.tipo === "error") {
            cerrarStream();
            mostrarError("La consolidacion fallo", dato.error);
            liberar();
        }
    };
    // Si el stream se corta (proxy, suspension del equipo) el trabajo sigue corriendo en
    // el servidor: se pregunta por su estado hasta que termine.
    fuente.onerror = () => {
        if (trabajo === null || sondeo !== null) return;
        sondeo = setInterval(async () => {
            try {
                const res = await fetch(`/trabajos/${id}`);
                const cuerpo = await res.json();
                if (cuerpo.estado === "listo") { cerrarStream(); mostrarFin(cuerpo); liberar(); }
                else if (cuerpo.estado === "error") { cerrarStream(); mostrarError("La consolidacion fallo", cuerpo.error); liberar(); }
            } catch { /* se reintenta en el proximo tick */ }
        }, 5000);
    };
}

async function procesar() {
    if (trabajo !== null) return;
    if (!revisarPeriodo()) return;

    const archivo = el.archivo.files[0];
    if (!archivo) {
        el.nota.classList.add("error");
        el.nota.textContent = "Seleccione el archivo .zip del mes.";
        return;
    }
    if (!/\.zip$/i.test(archivo.name)) {
        el.nota.classList.add("error");
        el.nota.textContent = `"${archivo.name}" no es un .zip.`;
        return;
    }

    el.resultado.hidden = true;
    el.resultado.innerHTML = "";
    el.procesar.disabled = true;
    el.procesar.textContent = "Procesando...";
    mostrarAvance({ fase: "inicio", mensaje: `Subiendo ${archivo.name}` });

    const cuerpo = new FormData();
    cuerpo.append("periodo", clave());
    cuerpo.append("zipFile", archivo);

    let res;
    try {
        res = await fetch("/uploadfiles", { method: "POST", body: cuerpo });
    } catch (err) {
        mostrarError(`No se pudo contactar al servidor: ${err.message}`, null);
        liberar();
        return;
    }

    let dato = null;
    try { dato = await res.json(); } catch { /* respuesta sin JSON */ }

    if (!res.ok) {
        mostrarError(
            (dato && (dato.mensaje || dato.error)) || `El servidor respondio ${res.status}.`,
            dato && dato.error ? { mensaje: dato.mensaje || dato.error } : null);
        liberar();
        return;
    }

    trabajo = dato.id;
    mostrarAvance({ fase: "inicio", mensaje: `Periodo ${dato.periodo}` });
    seguir(dato.id);
}

/* ------------------------------------------------------------------ *
 * Arranque
 * ------------------------------------------------------------------ */

el.zona.addEventListener("dragover", (e) => { e.preventDefault(); el.zona.classList.add("encima"); });
el.zona.addEventListener("dragleave", () => el.zona.classList.remove("encima"));
el.zona.addEventListener("drop", (e) => {
    e.preventDefault();
    el.zona.classList.remove("encima");
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        el.archivo.files = e.dataTransfer.files;
        el.archivo.dispatchEvent(new Event("change"));
    }
});

el.archivo.addEventListener("change", () => {
    const f = el.archivo.files[0];
    el.zona.classList.toggle("cargado", Boolean(f));
    el.etiquetaArchivo.textContent = f ? `Archivo seleccionado: ${f.name}` : TEXTO_ARCHIVO;
});

el.mes.addEventListener("change", revisarPeriodo);
el.anio.addEventListener("change", revisarPeriodo);
el.procesar.addEventListener("click", procesar);

(async function iniciar() {
    // El servidor calcula el periodo por defecto (el mes calendario anterior) y su tope.
    // Si no responde, el navegador hace la misma cuenta: es un valor por defecto de la
    // interfaz, no un numero del reporte.
    let porDefecto = mesAnteriorLocal();
    try {
        const res = await fetch("/api/periodo");
        const dato = await res.json();
        const s = /^(\d{4})-(\d{2})$/.exec(dato.sugerido || "");
        const m = /^(\d{4})-(\d{2})$/.exec(dato.maximo || "");
        if (s) porDefecto = { anio: Number(s[1]), mes: Number(s[2]) };
        if (m) maximo = { anio: Number(m[1]), mes: Number(m[2]) };
    } catch { /* se usan los valores locales */ }
    poblarSelectores(porDefecto);
    revisarPeriodo();
})();

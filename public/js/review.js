"use strict";
/**
 * Cliente de /review. Mismas reglas que index.js: sin framework, sin build, sin CDN.
 *
 * Diferencias con la pagina de consolidacion, y por que:
 *
 *  - **No hay EventSource.** Un solo archivo se revisa dentro de la peticion: no hay
 *    trabajo que seguir, no hay barra de avance y no hay nada que descargar al final.
 *  - **No se bloquea con una consolidacion en curso.** La revision no abre la plantilla,
 *    asi que no compite por memoria y el servidor no la hace esperar.
 *  - **El periodo importa igual.** Las fechas se validan contra el periodo elegido, asi
 *    que el selector es el mismo y por defecto es el mes anterior.
 */

const MESES = [
    "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

/** Como se rotula cada severidad de pipeline/issues.js, de menor a mayor alarma. */
const SEVERIDAD = {
    INFO: { texto: "Informativo", clase: "sev-info" },
    WARNING: { texto: "Advertencia", clase: "sev-warning" },
    ERROR: { texto: "Error", clase: "sev-error" },
    FAILED: { texto: "Falla", clase: "sev-failed" },
};
const ORDEN = ["FAILED", "ERROR", "WARNING", "INFO"];

/** Un archivo puede producir cientos de incidencias; la pagina muestra las primeras y
 *  dice cuantas quedaron fuera, en vez de volverse ilegible. */
const MAX_FILAS = 200;

const $ = (id) => document.getElementById(id);

const el = {
    mes: $("mes"),
    anio: $("anio"),
    nota: $("periodo-nota"),
    zona: $("zona"),
    archivo: $("archivo"),
    etiquetaArchivo: $("etiqueta-archivo"),
    revisar: $("revisar"),
    resultado: $("resultado"),
};

let maximo = { anio: new Date().getFullYear(), mes: new Date().getMonth() + 1 };
let ocupado = false;

/* ------------------------------------------------------------------ *
 * Periodo
 * ------------------------------------------------------------------ */

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

function clave() {
    return `${el.anio.value}-${String(el.mes.value).padStart(2, "0")}`;
}

function esFuturo() {
    const a = Number(el.anio.value);
    const m = Number(el.mes.value);
    return a > maximo.anio || (a === maximo.anio && m > maximo.mes);
}

function revisarPeriodo() {
    const futuro = esFuturo();
    el.nota.classList.toggle("error", futuro);
    el.nota.textContent = futuro
        ? `El periodo ${MESES[Number(el.mes.value) - 1]} ${el.anio.value} todavia no ocurre. Elija un periodo pasado o el mes en curso.`
        : `Se revisara contra el periodo ${MESES[Number(el.mes.value) - 1]} ${el.anio.value}.`;
    el.revisar.disabled = futuro || ocupado;
    return !futuro;
}

/* ------------------------------------------------------------------ *
 * Vista
 * ------------------------------------------------------------------ */

function escapar(texto) {
    return String(texto === null || texto === undefined ? "" : texto)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cifra(valor, rotulo) {
    if (valor === null || valor === undefined) return "";
    return `<li><span class="valor">${valor}</span><span class="rotulo">${rotulo}</span></li>`;
}

/** El titular. Lo primero que tiene que quedar claro es si el archivo sirve. */
function veredicto(informe) {
    const c = informe.resumen.porSeveridad;
    if (informe.bloqueante || !informe.ok) {
        return {
            clase: "sev-failed",
            texto: "No se pudo leer este archivo",
            detalle: "Tal como esta, este subcontratista no aportaria ninguna fila al reporte.",
        };
    }
    if (c.ERROR > 0) {
        return {
            clase: "sev-error",
            texto: `Se leyo, pero hay ${c.ERROR} error(es)`,
            detalle: "Hay valores rechazados. Esas filas o columnas saldrian vacias o incompletas.",
        };
    }
    if (c.WARNING > 0) {
        return {
            clase: "sev-warning",
            texto: `Se leyo con ${c.WARNING} advertencia(s)`,
            detalle: "Se acepto todo, con reparos. Conviene revisarlos antes de enviar el archivo.",
        };
    }
    return {
        clase: "sev-ok",
        texto: "Sin problemas",
        detalle: "El archivo se leyo completo y no hubo nada que reportar.",
    };
}

function bloqueColumnas(columnas) {
    const partes = [];
    if (columnas.faltantes && columnas.faltantes.length > 0) {
        partes.push(`<p><strong>Columnas que faltan:</strong> ${escapar(columnas.faltantes.join(", "))}</p>`);
    }
    const no = (columnas.noReconocidas || [])
        .map((h) => (typeof h === "string" ? h : (h && (h.encabezado || h.columna || h.valor))))
        .filter(Boolean);
    if (no.length > 0) {
        partes.push(`<p><strong>Encabezados no reconocidos:</strong> ${escapar(no.join(", "))}</p>`);
    }
    return partes.join("");
}

/**
 * Donde corregir. Es lo que el operador viene a buscar: una linea por cosa que arreglar,
 * con la celda del Excel, ordenada por fila. El servidor ya la arma y la ordena; aqui
 * solo se pinta.
 */
function bloqueUbicaciones(ubicaciones) {
    if (!ubicaciones || ubicaciones.length === 0) return "";
    const filas = ubicaciones.slice(0, MAX_FILAS).map((u) => {
        const s = SEVERIDAD[u.severity] || { texto: u.severity, clase: "" };
        return `<tr>
            <td><span class="pastilla ${s.clase}">${escapar(s.texto)}</span></td>
            <td class="celda">${escapar(u.celda || (u.fila ? "fila " + u.fila : ""))}</td>
            <td>${escapar(u.texto)}</td>
          </tr>`;
    }).join("");
    const resto = ubicaciones.length > MAX_FILAS
        ? `<p class="nota">Se muestran ${MAX_FILAS} de ${ubicaciones.length}.</p>` : "";
    return `<h3>Donde corregir (${ubicaciones.length})</h3>
      <p class="nota">Cada linea apunta a una celda del archivo, en orden de fila.</p>
      <div class="tabla-scroll"><table class="tabla">
        <thead><tr><th>Gravedad</th><th>Celda</th><th>Que corregir</th></tr></thead>
        <tbody>${filas}</tbody>
      </table></div>${resto}`;
}

/** Los duplicados, por nombre y por DNI, con las celdas de cada copia. */
function bloqueDuplicados(duplicados) {
    if (!duplicados || duplicados.length === 0) return "";
    const filas = duplicados.slice(0, MAX_FILAS).map((d) => {
        const celdas = (d.ubicaciones || [])
            .map((u) => u.celda || (u.fila ? `fila ${u.fila}` : ""))
            .filter(Boolean).join(", ");
        // `colapsa` distingue el duplicado que la consolidacion realmente une del que solo
        // se reporta. Decir lo contrario haria que el operador confie en una union que no
        // va a ocurrir.
        const efecto = d.colapsa
            ? "Se unen en una fila"
            : "<strong>No se unen</strong>";
        return `<tr>
            <td>${escapar(d.columna)}</td>
            <td>${escapar(d.clave)}</td>
            <td>${escapar(d.copias)}</td>
            <td class="celda">${escapar(celdas)}</td>
            <td>${efecto}</td>
          </tr>`;
    }).join("");
    const resto = duplicados.length > MAX_FILAS
        ? `<p class="nota">Se muestran ${MAX_FILAS} de ${duplicados.length}.</p>` : "";
    return `<h3>Duplicados (${duplicados.length})</h3>
      <p class="nota">
        Se revisa por <strong>nombre</strong> y por <strong>DNI</strong>. La consolidacion
        agrupa por una sola de las dos, asi que un duplicado marcado &laquo;no se unen&raquo;
        igual hay que mirarlo: puede ser la misma persona cargada dos veces.
      </p>
      <div class="tabla-scroll"><table class="tabla">
        <thead><tr><th>Columna</th><th>Valor repetido</th><th>Copias</th><th>Celdas</th><th>En el reporte</th></tr></thead>
        <tbody>${filas}</tbody>
      </table></div>${resto}`;
}

/** Una fila por incidencia, ordenadas por gravedad, con la celda de origen cuando existe. */
function bloqueIncidencias(issues) {
    if (!issues || issues.length === 0) return "";
    const ordenadas = issues.slice().sort(
        (a, b) => ORDEN.indexOf(a.severity) - ORDEN.indexOf(b.severity)
    );
    const filas = ordenadas.slice(0, MAX_FILAS).map((i) => {
        const s = SEVERIDAD[i.severity] || { texto: i.severity, clase: "" };
        const donde = i.celda ? i.celda : (i.fila ? `fila ${i.fila}` : "");
        return `<tr>
            <td><span class="pastilla ${s.clase}">${escapar(s.texto)}</span></td>
            <td>${escapar(donde)}</td>
            <td>${escapar(i.columna || "")}</td>
            <td>${escapar(i.message)}</td>
          </tr>`;
    }).join("");
    const resto = ordenadas.length > MAX_FILAS
        ? `<p class="nota">Se muestran ${MAX_FILAS} de ${ordenadas.length} incidencias.</p>` : "";
    return `<h3>Detalle (${issues.length})</h3>
      <div class="tabla-scroll"><table class="tabla">
        <thead><tr><th>Gravedad</th><th>Donde</th><th>Columna</th><th>Que paso</th></tr></thead>
        <tbody>${filas}</tbody>
      </table></div>${resto}`;
}

function mostrar(informe) {
    const v = veredicto(informe);
    const s = informe.stats;
    el.resultado.hidden = false;
    el.resultado.className = "resultado";
    el.resultado.innerHTML = `
      <div class="veredicto ${v.clase}">
        <h3>${escapar(v.texto)}</h3>
        <p>${escapar(v.detalle)}</p>
      </div>
      <p class="nota">
        <strong>${escapar(informe.archivo)}</strong> &mdash; ${escapar(informe.subcontratista)}
        &mdash; periodo ${escapar(informe.periodo)}
      </p>
      <ul class="cifras">
        ${cifra(s.filasLeidas, "leidas")}
        ${cifra(s.filasRechazadas, "rechazadas")}
        ${cifra(s.filasColapsadas, "duplicadas")}
        ${cifra(s.filasAceptadas, "quedarian")}
      </ul>
      ${bloqueColumnas(informe.columnas)}
      ${bloqueUbicaciones(informe.ubicaciones)}
      ${bloqueDuplicados(informe.duplicados)}
      ${bloqueIncidencias(informe.issues)}
    `;
}

function mostrarError(mensaje, detalle) {
    el.resultado.hidden = false;
    el.resultado.className = "resultado";
    el.resultado.innerHTML = `
      <div class="veredicto sev-failed">
        <h3>${escapar(mensaje)}</h3>
        ${detalle ? `<p>${escapar(detalle)}</p>` : ""}
      </div>`;
}

/* ------------------------------------------------------------------ *
 * Envio
 * ------------------------------------------------------------------ */

async function revisar() {
    if (!revisarPeriodo()) return;

    const archivo = el.archivo.files && el.archivo.files[0];
    if (!archivo) {
        mostrarError("Falta el archivo", "Seleccione un archivo .xlsx.");
        return;
    }
    if (!/\.xlsx$/i.test(archivo.name)) {
        mostrarError("Formato invalido",
            `Se revisa un archivo .xlsx a la vez (se eligio "${archivo.name}").`);
        return;
    }

    ocupado = true;
    el.revisar.disabled = true;
    el.revisar.textContent = "Revisando…";
    el.resultado.hidden = true;

    const cuerpo = new FormData();
    cuerpo.append("archivo", archivo);
    cuerpo.append("periodo", clave());
    // El servidor sanea el nombre del archivo subido (safeFileNames), lo que le quita los
    // espacios: "SUBCONTRATA UNO.xlsx" llega como "SUBCONTRATAUNO.xlsx". El nombre real va
    // aparte, solo para mostrarlo.
    cuerpo.append("nombre", archivo.name);

    try {
        const res = await fetch("/review", { method: "POST", body: cuerpo });
        let datos = null;
        try { datos = await res.json(); } catch { /* respuesta no-JSON */ }

        if (!res.ok) {
            mostrarError(
                (datos && datos.error) || `Error ${res.status}`,
                datos && datos.mensaje ? datos.mensaje : "No se pudo revisar el archivo."
            );
            return;
        }
        mostrar(datos);
    } catch (e) {
        mostrarError("No se pudo contactar al servidor", e && e.message ? e.message : "");
    } finally {
        ocupado = false;
        el.revisar.textContent = "Revisar";
        revisarPeriodo();
    }
}

/* ------------------------------------------------------------------ *
 * Eventos
 * ------------------------------------------------------------------ */

el.zona.addEventListener("dragover", (e) => { e.preventDefault(); el.zona.classList.add("encima"); });
el.zona.addEventListener("dragleave", () => el.zona.classList.remove("encima"));
el.zona.addEventListener("drop", (e) => {
    e.preventDefault();
    el.zona.classList.remove("encima");
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        el.archivo.files = e.dataTransfer.files;
        el.etiquetaArchivo.textContent = e.dataTransfer.files[0].name;
    }
});
el.archivo.addEventListener("change", () => {
    el.etiquetaArchivo.textContent = el.archivo.files && el.archivo.files[0]
        ? el.archivo.files[0].name
        : "Seleccione el archivo .xlsx o arrastrelo aqui";
});
el.mes.addEventListener("change", revisarPeriodo);
el.anio.addEventListener("change", revisarPeriodo);
el.revisar.addEventListener("click", revisar);

(async function iniciar() {
    let porDefecto = null;
    try {
        // El mismo origen que usa la pagina principal, para que las dos sugieran el mismo
        // periodo: el servidor decide cual es, no el reloj del navegador.
        const res = await fetch("/api/periodo");
        if (res.ok) {
            const datos = await res.json();
            const [ma, mm] = String(datos.maximo).split("-").map(Number);
            maximo = { anio: ma, mes: mm };
            const [sa, sm] = String(datos.sugerido).split("-").map(Number);
            porDefecto = { anio: sa, mes: sm };
        }
    } catch { /* sin red: se cae al calculo local de abajo */ }

    if (porDefecto === null) {
        const hoy = new Date();
        const m = hoy.getMonth();
        porDefecto = m === 0
            ? { anio: hoy.getFullYear() - 1, mes: 12 }
            : { anio: hoy.getFullYear(), mes: m };
    }
    poblarSelectores(porDefecto);
    revisarPeriodo();
})();

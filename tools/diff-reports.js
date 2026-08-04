"use strict";
/**
 * tools/diff-reports.js - THE PARALLEL-RUN GATE.
 *
 * 05-implementation-plan.md Phase 0 task 5, specified by §4.4 (what it compares) and
 * §4.5 (the eleven divergences that are allowed to exist). Run by §4.3 and §7.
 *
 * WHY THIS IS A DELIVERABLE AND NOT A SCRATCH SCRIPT
 * -------------------------------------------------
 * There is no historical baseline and there never will be one: the app deletes its
 * inputs on every run and the owner has decided that is fine (05 §4.1, §4.6). So the
 * parallel run - the operator's single monthly upload processed by BOTH pipelines inside
 * the same job - is the plan's PRIMARY end-to-end verification, and this file is the
 * only way anyone reads it. If this tool is wrong, the rework ships on the strength of
 * the fixture corpus alone.
 *
 * Three consequences shape everything below.
 *
 *   1. THE EXPECTED-DIVERGENCE LIST IS DATA, NOT PROSE. `EXPECTED_DIVERGENCES` below is
 *      05 §4.5 transcribed entry by entry, each with its own matcher. A divergence
 *      either matches an entry - and is printed with the entry it matched - or it is
 *      UNEXPECTED. "Anything not on this list blocks cutover - not 'is investigated',
 *      blocks" (§4.5), so an unexpected divergence is a non-zero exit code and nothing
 *      softer. Widening the list after reading a diff is the exact failure mode §4.5
 *      exists to prevent; every entry therefore carries the citation it came from, and
 *      the handful of entries that are NOT in §4.5 are flagged `extension: true`,
 *      printed in their own section, and justified in place (05 §7 step 2 sanctions
 *      extending the list BEFORE the first parallel month, never after).
 *
 *   2. VALUE AND TYPE ARE NEVER CONFLATED. §4.4 item 2 is explicit: a text date that
 *      became a serial must report as a TYPE change, not as an inequality. So a cell
 *      whose types differ produces exactly one divergence, of kind `tipo`, and never
 *      also a `valor`. That distinction is most of the signal in the whole run.
 *
 *   3. A STALE CACHED PIVOT VALUE IS NEVER COMPARED AS THOUGH IT WERE LIVE. The OLD
 *      pipeline's output ships with stale cached pivot values - BUG-14, five of the
 *      fourteen delivered reports still display September-2024 numbers - so its side of
 *      the pivot comparison means nothing until a human opens the file in Excel and
 *      refreshes it. Stage 4 therefore runs ONLY when the operator passes `--refreshed`,
 *      and even then it re-checks `refreshedDate` in the pivot cache against the period
 *      and refuses if the bytes disagree with the claim. Stages 1, 2, 3 and 5 run
 *      unattended; stage 4 costs one manual refresh per parallel month, and the report
 *      records which was done (§4.4).
 *
 * WHAT IT COMPARES, in §4.4's order:
 *
 *   1. filas      - `Cuadro!A:R` as a MULTISET keyed on (RUC, Nro. DNI / CE,
 *                   APELLIDOS Y NOMBRES, FECHA INICIO DE LABORES EN OBRA). Rows only in
 *                   the NEW output are the RECOVERED ones - subcontratistas the old
 *                   pipeline silently dropped - and they are reported first and loudest,
 *                   because they are "the single most valuable thing this diff can
 *                   surface".
 *   2. celdas     - the same 18 columns cell by cell for matched rows, value AND type.
 *   3. computadas - the computed columns S..AI for matched rows, cell by cell.
 *   4. pivotes    - the headline cells of 03-expected-output.md §9 item 28, old side
 *                   from the refreshed workbook, new side from the metrics side-car.
 *   5. conteos    - rows read / rejected / deduplicated / written on each side.
 *
 * THE KEY IS NORMALIZED ON PURPOSE. If rows were keyed on raw cell values, the very
 * type change stage 2 exists to report - a text date becoming a serial - would push
 * every affected row into "only in the old" AND "only in the new" and stage 2 would see
 * nothing at all. So the key runs through `identity.js` and a serial/day-first date
 * normalizer, and the type change is then reported where it belongs, on the matched row.
 *
 * DETERMINISM. Nothing here reads a clock. The period is an argument or it comes from
 * the side-car. Two runs of this tool over the same two files produce identical output.
 *
 * MEMORY. Both workbooks are read one at a time and reduced to compact row arrays before
 * the next is opened; the SheetJS workbook object is dropped as soon as it has been
 * walked. The shadow run's own budget is the tight one (the template round-trip peaks
 * near 944 MB RSS, 05 §4.3), and this tool runs after both pipelines have released it.
 *
 * USAGE
 *   node tools/diff-reports.js <antiguo.xlsx> <nuevo.xlsx> [opciones]
 *
 *     --json <archivo>     write the whole classified result as JSON
 *     --sidecar <archivo>  the NEW pipeline's metrics side-car (output/metrics.js).
 *                          Without it stage 4 has no new side and stage 5 is partial.
 *     --sidecar-antiguo <archivo>  an old-side side-car, if one was ever produced
 *     --period YYYY-MM     the report period, when no side-car carries it
 *     --refreshed          the OLD workbook's pivot cache was manually refreshed in
 *                          Excel. Without this stage 4 does not run (BUG-14).
 *     --require-pivots     make a stage 4 that did not run a failure (exit 3)
 *     --examples N         examples printed per class (default 5)
 *     --self-test          run the Phase 0 task 5 self-test on the two files instead
 *     --quiet              only the summary
 *
 *   Exit codes: 0 clean, 1 UNEXPECTED divergence (blocks cutover), 2 usage/IO error,
 *   3 a required stage did not run.
 *
 * SHADOW MODE. `diffReports(antiguo, nuevo, opciones)` returns the same structure the
 * CLI prints, so Phase 5 task 8 calls it in-process and attaches `formatReport(result)`
 * to the run's output. A failure here is reported and never fails the operator's job.
 */

const fs = require("node:fs");
const path = require("node:path");

const XLSX = require("xlsx");
const JSZip = require("jszip");

const { CANONICAL, INDEX_BY_CANONICAL } = require("../src/pipeline/columns");
const { normalizeRuc, normalizeDni, normalizeNameKey } = require("../src/pipeline/identity");
const { normalizeForColumn } = require("../src/pipeline/text");
const { serialToYMD } = require("../src/pipeline/dates");
const { COMPUTED_COLUMNS, RANGO_LABELS } = require("../src/output/computed");

/* ================================================================== *
 * 0. Identity of the artifact, and the shapes it reads
 * ================================================================== */

/** Bump when the JSON result's shape changes. CI and run.js pin on it. */
const VERSION = 1;

/** The data sheet, in both pipelines' output - both inject into the same template. */
const CUADRO = "Cuadro";

/** A:R. The 18 raw columns come from columns.js so a reorder there cannot leave this
 *  file comparing the wrong letters. */
const RAW_COLUMN_COUNT = CANONICAL.length;

/** Canonical name -> 0-based column offset. `columns.js` exports it as a Map; this is
 *  the accessor, so a missing name is a loud caller bug rather than `undefined`. */
function iCol(name) {
    const i = INDEX_BY_CANONICAL.get(name);
    if (i === undefined) throw new Error(`tools/diff-reports.js: columna canonica desconocida ${JSON.stringify(name)}`);
    return i;
}

/** The four columns §4.4 item 1 keys the multiset on, in its order. */
const KEY_COLUMNS = Object.freeze([
    "RUC",
    "Nro. DNI / CE",
    "APELLIDOS Y NOMBRES",
    "FECHA INICIO DE LABORES EN OBRA",
]);

/** F, M and O, derived rather than spelled, for the same reason. */
const DATE_COLUMN_LETTERS = Object.freeze([
    "FECHA NACIMIENTO",
    "FECHA CESE/BAJA",
    "FECHA INICIO DE LABORES EN OBRA",
].map((name) => colLetter(iCol(name))));

/**
 * S..AI - the 17 computed columns, in output order.
 *
 * `tipo` is what the NEW pipeline writes: `literal` for the five Option-D columns whose
 * formulas were volatile or anchored on `TODAY()-30` (05 §5), `formula` for the twelve
 * VLOOKUP/COUNTIF/SUMPRODUCT columns that stay Excel's. The OLD pipeline writes all
 * seventeen as formulas, which is why `formula -> literal` on exactly these five is an
 * expected divergence and on any other column is not.
 */
const COMPUTED_COLUMNS_AI = Object.freeze([
    Object.freeze({ letter: "S", name: "EPC/CJV", tipo: "formula" }),
    Object.freeze({ letter: "T", name: "Tipo de Empresa", tipo: "formula" }),
    Object.freeze({ letter: "U", name: "Contratistas", tipo: "formula" }),
    Object.freeze({ letter: "V", name: "Edad", tipo: "literal" }),
    Object.freeze({ letter: "W", name: "Rango Edades", tipo: "literal" }),
    Object.freeze({ letter: "X", name: "Validar Edad", tipo: "formula" }),
    Object.freeze({ letter: "Y", name: "Zona de Influencia", tipo: "formula" }),
    Object.freeze({ letter: "Z", name: "Validar Genero", tipo: "formula" }),
    Object.freeze({ letter: "AA", name: "ValidarDNI", tipo: "formula" }),
    Object.freeze({ letter: "AB", name: "Trabajador", tipo: "formula" }),
    Object.freeze({ letter: "AC", name: "Trabajadores Unicos", tipo: "formula" }),
    // sic - the typo is the template's own column name and the pivots bind to it.
    Object.freeze({ letter: "AD", name: "Trabajdores Unicos Zona Influencia", tipo: "formula" }),
    Object.freeze({ letter: "AE", name: "Altas Zona de Influencia", tipo: "formula" }),
    Object.freeze({ letter: "AF", name: "Bajas Zona Influencia", tipo: "formula" }),
    Object.freeze({ letter: "AG", name: "BajasAntiguas", tipo: "literal" }),
    Object.freeze({ letter: "AH", name: "Bajas2", tipo: "literal" }),
    Object.freeze({ letter: "AI", name: "Altas", tipo: "literal" }),
]);

/** Zero-based sheet column index of each of the 17, resolved once. */
const COMPUTED_INDEXES = Object.freeze(COMPUTED_COLUMNS_AI.map((c) => colIndex(c.letter)));

/** Load-time cross-check: the five literal columns here ARE output/computed.js's five.
 *  A rename there must be a loud failure here, not a silently unclassified divergence. */
(function assertOptionDAgreement() {
    const mine = COMPUTED_COLUMNS_AI.filter((c) => c.tipo === "literal")
        .map((c) => `${c.letter}:${c.name}`).join(",");
    const theirs = COMPUTED_COLUMNS.map((c) => `${c.letter}:${c.name}`).join(",");
    if (mine !== theirs) {
        throw new Error(
            `tools/diff-reports.js: las cinco columnas Option-D no coinciden con ` +
            `output/computed.js (aqui ${mine} / alli ${theirs})`
        );
    }
})();

/** SheetJS cell types, mapped to the words the report prints. */
const TIPO = Object.freeze({
    VACIO: "vacio",
    TEXTO: "texto",
    NUMERO: "numero",
    BOOLEANO: "booleano",
    ERROR: "error",
    FECHA: "fecha",
});

/** Excel's error codes as SheetJS stores them in `.v` for `t:"e"`. */
const ERROR_CODES = Object.freeze({
    0x00: "#NULL!", 0x07: "#DIV/0!", 0x0f: "#VALUE!", 0x17: "#REF!",
    0x1d: "#NAME?", 0x24: "#NUM!", 0x2a: "#N/A",
});

/**
 * Float tolerance. 05 §4.5 entry 11 is explicit that fractional totals are CORRECT -
 * `Trabajadores Unicos` is a de-duplication weight, so `5096.833...` is the right answer
 * and must never be flagged. What this epsilon absorbs is only the last-ULP drift of
 * summing thousands of reciprocals (measured: 84 contratistas summing to
 * `83.999999999996`). Anything larger is a real divergence and is reported.
 */
const EPS_REL = 1e-9;

/** Stages, in §4.4's order. */
const ETAPA = Object.freeze({
    FILAS: "filas",
    CELDAS: "celdas",
    COMPUTADAS: "computadas",
    PIVOTES: "pivotes",
    CONTEOS: "conteos",
});

/** Kinds of divergence. */
const KIND = Object.freeze({
    SOLO_NUEVO: "solo-en-nuevo",
    SOLO_ANTIGUO: "solo-en-antiguo",
    TIPO: "tipo",
    VALOR: "valor",
    FORMULA: "formula",
    FORMULA_A_LITERAL: "formula-a-literal",
    LITERAL_A_FORMULA: "literal-a-formula",
    FALTANTE: "faltante",
    CONTEO: "conteo",
});

const EXIT = Object.freeze({
    OK: 0,
    INESPERADA: 1,
    USO: 2,
    ETAPA_FALTANTE: 3,
});

/** The sentinels 03 §9 criterion 10 enumerates, plus the two JS coercion artefacts. */
const SENTINELS = Object.freeze(new Set([
    "-", " -", "- ", "---", "ACTIVO", "UNDEFINED", "NAN", "NULL", "#VALUE!", "#N/A",
]));

/* ================================================================== *
 * 1. THE EXPECTED DIVERGENCES - 05 §4.5, as data
 * ================================================================== *
 *
 * Eleven entries, transcribed in order, each with the citation it came from. A matcher
 * returns true when the divergence it is handed is an instance of that entry.
 *
 * The matchers are deliberately NARROW. A matcher that returns true for anything in its
 * neighbourhood turns the gate into a rubber stamp: the point of §4.5 is that an
 * unexpected divergence is the SIGNAL, so a matcher is written to accept the shape the
 * fix produces and nothing else. When in doubt the divergence is left UNEXPECTED and a
 * human classifies it - that is the cheap failure. The expensive failure is a matcher
 * that swallows a real regression.
 *
 * `extension: true` marks the entries that are NOT in §4.5. 05 §7 step 2 says the list
 * is extended with what the phases turned up and then FROZEN before the first parallel
 * month; these are those, each with the reason it is here. They print in their own
 * section so a reviewer can see at a glance how much of a clean run rests on them.
 */
const EXPECTED_DIVERGENCES = Object.freeze([
    Object.freeze({
        id: "E1",
        fuente: "05 §4.5 #1",
        bugs: ["BUG-10", "BUG-11"],
        titulo: "Las filas fantasma desaparecen",
        detalle:
            "Validacion!D2521 (Cuenta de RUC) cae de la altura de la tabla (8.816) a la " +
            "poblacion real (~5.540), y con ella todo COUNTIF/SUMPRODUCT de columna entera.",
        match(d) {
            if (d.etapa === ETAPA.FILAS && d.tipo === KIND.SOLO_ANTIGUO && d.ctx.fantasma) return true;
            if (d.etapa === ETAPA.PIVOTES && d.id === "validacion.cuentaRuc") {
                return numeric(d.antiguo) !== null && numeric(d.nuevo) !== null && numeric(d.nuevo) < numeric(d.antiguo);
            }
            return false;
        },
    }),

    Object.freeze({
        id: "E2",
        fuente: "05 §4.5 #2",
        bugs: ["BUG-06", "BUG-08"],
        titulo: "Las fechas de texto se vuelven seriales",
        detalle:
            "~200 de 5.065 filas cambian de TIPO en F, M y O, y entran en los conteos de " +
            "Altas/Bajas de los que estaban excluidas en silencio.",
        match(d) {
            if (d.etapa === ETAPA.CELDAS && d.tipo === KIND.TIPO && DATE_COLUMN_LETTERS.includes(d.columna)) {
                // A DATE that was text, not a sentinel that was text - `"-"` in
                // FECHA CESE/BAJA is E8's, and the two must not be attributed to each other.
                return d.antiguo.t === TIPO.TEXTO
                    && looksLikeTextDate(d.antiguo.v)
                    && (d.nuevo.t === TIPO.NUMERO || d.nuevo.vacia === true);
            }
            // The rows they belong to entering Altas/Bajas: only for a row that actually
            // carried a text date on the old side, and only when the divergence is about
            // the VALUE. The mechanical formula -> literal change is X2's, on every row.
            if (d.etapa === ETAPA.COMPUTADAS && ["AG", "AH", "AI"].includes(d.columna)) {
                return d.tipo !== KIND.FORMULA_A_LITERAL && d.ctx.fechaTextoEnAntiguo === true;
            }
            return false;
        },
    }),

    Object.freeze({
        id: "E3",
        fuente: "05 §4.5 #3",
        bugs: ["BUG-07"],
        titulo: "El bucket #VALUE! se vacia",
        detalle:
            "Los 36 trabajadores de 'Reporte Social - RRHH'!C29 se redistribuyen en buckets " +
            "reales de Rango Edades (o en el bucket nombrado \"Sin Fecha\").",
        match(d) {
            if (d.etapa === ETAPA.COMPUTADAS && ["V", "W"].includes(d.columna)) {
                return d.antiguo.t === TIPO.ERROR;
            }
            if (d.etapa === ETAPA.PIVOTES && d.id === "rrhh.rangos") {
                return d.ctx.etiqueta === "#VALUE!" || d.ctx.etiqueta === "Sin Fecha";
            }
            return false;
        },
    }),

    Object.freeze({
        id: "E4",
        fuente: "05 §4.5 #4",
        bugs: ["BUG-04"],
        titulo: "Las 643 filas del libro desplazado recuperan identidad",
        detalle:
            "Dejan de ser un trabajador llamado 20101155588 y pasan a ser 643 trabajadores " +
            "con RUC, EMPRESA y CONTRATISTA PRNCIPAL, y Tipo de Empresa deja de leer " +
            "blanco = blanco como TRUE y de etiquetarlos a todos Principal.",
        match(d) {
            if (d.etapa === ETAPA.FILAS && d.tipo === KIND.SOLO_ANTIGUO) return d.ctx.nombreNumerico === true;
            if (d.etapa === ETAPA.FILAS && d.tipo === KIND.SOLO_NUEVO) return d.ctx.desplazada === true;
            // Identity gained on a matched row: A/B/C were empty on the old side.
            if (d.etapa === ETAPA.CELDAS && ["A", "B", "C"].includes(d.columna)) {
                return d.antiguo.vacia === true && d.nuevo.vacia === false;
            }
            if (d.etapa === ETAPA.COMPUTADAS && d.columna === "T") return d.ctx.identidadRecuperada === true;
            return false;
        },
    }),

    Object.freeze({
        id: "E5",
        fuente: "05 §4.5 #5",
        bugs: ["BUG-26"],
        titulo: "Detalle Cesados crece de 55 a 79 filas",
        detalle:
            "El filtro de pagina deja de seleccionar Bajas2 = \"Borrar\" y pasa a filtrar por " +
            "el periodo; la columna Total deja de ser cero y el detalle cuadra con Total Bajas (F46).",
        match(d) {
            if (d.etapa !== ETAPA.PIVOTES) return false;
            if (d.id === "rrhh.detalleCesados") return true;
            if (d.id === "rrhh.filtro.detalleCesados") return textOf(d.antiguo) === "Borrar";
            return false;
        },
    }),

    Object.freeze({
        id: "E6",
        fuente: "05 §4.5 #6",
        bugs: ["BUG-24"],
        titulo: "El bloque derecho de Validacion deja de estar vacio",
        detalle:
            "723 filas con DNI ausente en la ultima corrida, contra una lista vacia hoy: " +
            "ValidarDNI deja de ser una copia byte a byte de Validar Genero.",
        match(d) {
            return d.etapa === ETAPA.PIVOTES && d.id === "validacion.bloqueDerecho"
                && numeric(d.antiguo) === 0 && numeric(d.nuevo) > 0;
        },
    }),

    Object.freeze({
        id: "E7",
        fuente: "05 §4.5 #7",
        bugs: ["BUG-24"],
        titulo: "Validar Edad y ValidarDNI cambian por diseño",
        detalle: "Dejan de ser copias byte a byte de Validar Genero.",
        match(d) {
            if (d.etapa !== ETAPA.COMPUTADAS || !["X", "AA"].includes(d.columna)) return false;
            // The FORMULAS change. These two columns stay formulas (only the five
            // Option-D columns become literals), so a formula/literal swap here would be
            // a Phase 4 mistake and stays unexpected.
            return d.tipo !== KIND.FORMULA_A_LITERAL && d.tipo !== KIND.LITERAL_A_FORMULA;
        },
    }),

    Object.freeze({
        id: "E8",
        fuente: "05 §4.5 #8",
        bugs: ["BUG-18", "BUG-19", "BUG-20"],
        titulo: "Centinelas, \"undefined\" y NaN pasan a celda vacia",
        detalle:
            "\"-\" x754, \" -\" x154, \"---\" x125, \"ACTIVO\" x58 en FECHA CESE/BAJA; los 10 " +
            "generos \"undefined\"; todo default de parseInt.",
        match(d) {
            if (d.etapa === ETAPA.CELDAS && (d.tipo === KIND.VALOR || d.tipo === KIND.TIPO)) {
                return d.ctx.centinelaEnAntiguo === true && d.nuevo.vacia === true;
            }
            // The third gender column the OCTUBRE_2025 regression produced.
            if (d.etapa === ETAPA.PIVOTES && d.tipo === KIND.FALTANTE && d.ctx.columnaExtraAntiguo) {
                return isSentinelText(d.ctx.columnaExtraAntiguo);
            }
            return false;
        },
    }),

    Object.freeze({
        id: "E9",
        fuente: "05 §4.5 #9",
        bugs: ["BUG-25", "BUG-29"],
        titulo: "Las grafias de contratista colapsan (352 -> ~84)",
        detalle:
            "Mueve Contratistas!C91, el peso de contratista distinto de la columna U y toda " +
            "lista de filtro de pivote.",
        match(d) {
            if (d.etapa === ETAPA.CELDAS && d.columna === "C") return d.ctx.soloNormalizacion === true;
            if (d.etapa === ETAPA.PIVOTES && d.id === "contratistas.granTotal") {
                return numeric(d.antiguo) !== null && numeric(d.nuevo) !== null && numeric(d.nuevo) <= numeric(d.antiguo);
            }
            return false;
        },
    }),

    Object.freeze({
        id: "E10",
        fuente: "05 §4.5 #10",
        bugs: ["BUG-12"],
        titulo: "El dedupe cambia",
        detalle:
            "La clave se calcula AHORA despues de normalizar, en vez de por JSON.stringify " +
            "sobre filas crudas, asi que cambia aunque la clave de identidad no cambie " +
            "(05 §8 Q3). Un cambio de clave a DNI necesita firma del dueño ANTES del mes paralelo.",
        match(d) {
            if (d.etapa !== ETAPA.FILAS) return false;
            // An extra or missing COPY of a key that exists on both sides: the multiset
            // moved, the population did not. A row with NO identity at all is excluded -
            // it was never de-duplicated against anything, and a row carrying data but
            // no RUC, no DNI, no name and no start date is exactly the thing a human
            // should look at once rather than a class to be waved through.
            return d.ctx.claveEnAmbosLados === true && d.ctx.claveVacia !== true;
        },
    }),

    Object.freeze({
        id: "E11",
        fuente: "05 §4.5 #11",
        bugs: [],
        titulo: "Los totales fraccionarios PERSISTEN y son correctos",
        detalle:
            "5096,833... y 3830,666... son de-duplicacion ponderada: un trabajador reportado " +
            "por dos subcontratistas aporta 0,5 + 0,5. NO se corrigen los decimales y NO se " +
            "reportan como divergencia. Esta entrada es una SUPRESION, no un permiso: nada " +
            "la invoca, porque un total fraccionario identico en ambos lados jamas llega a " +
            "producir una divergencia (ver `equalNumbers`).",
        supresion: true,
        match() { return false; },
    }),

    /* ---------------- extensions (05 §7 step 2), frozen before month one ---------- */

    Object.freeze({
        id: "X1",
        fuente: "05 §4.4 item 1 / §7 step 4 (extension)",
        extension: true,
        bugs: ["BUG-01", "BUG-45"],
        titulo: "Subcontratistas RECUPERADOS: el pipeline antiguo los descartaba en silencio",
        detalle:
            "Filas presentes SOLO en la salida nueva cuya EMPRESA/CONTRATISTA no aparece en " +
            "ninguna fila de la salida antigua: el libro entero se perdio en el " +
            "console.log(\"Error with: \" + directory) de excelConsolidation.js:75. §4.4 la " +
            "llama \"the single most valuable thing this diff can surface\" y §7 step 4 la " +
            "lista como evidencia de que los arreglos aterrizaron, pero no es una de las once " +
            "entradas de §4.5, asi que se declara aqui de forma explicita.",
        match(d) {
            return d.etapa === ETAPA.FILAS && d.tipo === KIND.SOLO_NUEVO && d.ctx.recuperada === true;
        },
    }),

    Object.freeze({
        id: "X2",
        fuente: "05 §5 Option D / Phase 4 task 3 (extension)",
        extension: true,
        bugs: ["BUG-15", "BUG-16"],
        titulo: "Las cinco columnas Option-D pasan de formula a literal",
        detalle:
            "Edad (V), Rango Edades (W), BajasAntiguas (AG), Bajas2 (AH) y Altas (AI) se " +
            "calculan en JS contra un periodo explicito y se escriben como literales, y su " +
            "<calculatedColumnFormula> se borra de table1.xml. Es el diseño entero de la " +
            "Opcion D; no aparece en §4.5 porque §4.5 enumera efectos en los NUMEROS, no el " +
            "cambio de mecanismo. Solo aplica a esas cinco letras: en cualquier otra columna " +
            "un formula -> literal es INESPERADO.",
        match(d) {
            if (d.etapa !== ETAPA.COMPUTADAS || d.tipo !== KIND.FORMULA_A_LITERAL) return false;
            const col = COMPUTED_COLUMNS_AI.find((c) => c.letter === d.columna);
            return Boolean(col && col.tipo === "literal");
        },
    }),

    Object.freeze({
        id: "X3",
        fuente: "05 §4.5 #9 extendido a las 7 columnas de texto (extension)",
        extension: true,
        bugs: ["BUG-25"],
        titulo: "La normalizacion de texto colapsa grafias en las otras columnas normalizadas",
        detalle:
            "§4.5 #9 nombra CONTRATISTA PRNCIPAL. Phase 2 task 7 normaliza siete columnas " +
            "(text.js NORMALIZED_COLUMNS), asi que EMPRESA, APELLIDOS Y NOMBRES, TITULO DE " +
            "PUESTO/CARGO, DISTRITO SEGUN DNI, NOMBRE DE OBRA y DOMICILIO tambien colapsan. " +
            "Solo cuenta cuando los dos valores son IGUALES despues de normalizar: si " +
            "difieren tras normalizar es un cambio de dato y sigue siendo INESPERADO.",
        match(d) {
            return d.etapa === ETAPA.CELDAS && d.columna !== "C" && d.ctx.soloNormalizacion === true;
        },
    }),

    Object.freeze({
        id: "X4",
        fuente: "03 §9 AC 13 / AC 11 - Phase 2 \"Dates and typed coercion\" (extension)",
        extension: true,
        bugs: ["BUG-23", "BUG-21"],
        titulo: "Coercion tipada: identificadores a TEXTO, codigos a NUMERO, mismo valor",
        detalle:
            "AC 13 exige que RUC y Nro. DNI / CE sean TEXTO con el cero inicial intacto " +
            "(\"09994533\" no se vuelve 9994533); el pipeline antiguo los dejaba como los " +
            "trajera json_to_sheet, casi siempre numeros. AC 11 cierra los dominios " +
            "codificados a numeros. Es un cambio de REPRESENTACION, no de dato, y §4.5 no lo " +
            "lista porque §4.5 enumera efectos en los numeros. El matcher solo acepta el caso " +
            "en que los DOS lados dicen el mismo valor: si difieren tras la coercion sigue " +
            "siendo INESPERADO.",
        match(d) {
            if (d.etapa !== ETAPA.CELDAS || d.tipo !== KIND.TIPO) return false;
            const columnas = ["RUC", "Nro. DNI / CE", "TIPO TRABAJADOR", "ESTADO", "TIPO DE CONTRATO LABORAL", "HPT"]
                .map((n) => colLetter(iCol(n)));
            if (!columnas.includes(d.columna)) return false;
            const tipos = new Set([d.antiguo.t, d.nuevo.t]);
            if (!tipos.has(TIPO.NUMERO) || !tipos.has(TIPO.TEXTO)) return false;
            return sameScalar(d.antiguo.v, d.nuevo.v);
        },
    }),
]);

/* ================================================================== *
 * 2. THE PIVOT CELLS - 03-expected-output.md §9 item 28, as data
 * ================================================================== *
 *
 * WHY THESE ARE FOUND BY LABEL AND NOT BY ADDRESS. §9 item 28 quotes addresses measured
 * on `Reporte_Subcontratistas_FEBRERO_2026.xlsx` - `F46`, `D60`, `C91`, `D2521`. Those
 * addresses are NOT stable: a pivot body grows and shrinks with the number of items, so
 * `src/template.xlsx`'s own copy of the same block has Total Ingresos on row 59 where
 * FEBRERO_2026 has it on row 60, and `Contratistas`'s grand total on row 57 where
 * FEBRERO_2026 has it on 91. Hard-coding the addresses would compare a zone row against
 * a total, silently, and produce exactly the kind of plausible wrong number this whole
 * rework exists to remove.
 *
 * So each block is located by its own label - the pivot's data-field caption and its
 * total row's caption, both authored in the template and both stable - and the report
 * prints the address it ACTUALLY read next to the one §9 documents.
 *
 * `delSidecar` is the NEW side. It returns `undefined` when the side-car has no
 * equivalent for that block, and the block is then reported as NO COMPARABLE with the
 * reason. A missing mapping is never faked: `Tabla!D64:G64` is Σ Trabajadores Unicos
 * split by ESTADO with BajasAntiguas="No", and the side-car publishes neither that split
 * nor that measure, so it says so.
 */
const PIVOT_BLOCKS = Object.freeze([
    Object.freeze({
        id: "rrhh.headcount",
        hoja: "Reporte Social - RRHH",
        referencia: "C8:F14 + D15/E15/F15",
        titulo: "Headcount por Zona de Influencia x GENERO",
        tipoBloque: "matriz",
        columna: "C",
        ancla: "Sum of Trabajdores Unicos Zona Influencia",
        cabeceraEn: "ancla+1",
        totalEtiqueta: "Total",
        delSidecar: (sc) => matrizDeSidecar(sc && sc.metricas && sc.metricas.porZonaGenero, "zona"),
    }),
    Object.freeze({
        id: "rrhh.rangos",
        hoja: "Reporte Social - RRHH",
        referencia: "C23:F28 + C29 (bucket #VALUE!)",
        titulo: "Headcount por Rango de Edades x GENERO",
        tipoBloque: "matriz",
        columna: "C",
        ancla: "Rango de Edades",
        cabeceraEn: "ancla",
        totalEtiqueta: "Total",
        // The side-car publishes the rango distribution as ROW COUNTS
        // (excepciones.listas.edad.rangos[].filas); the sheet shows the weighted
        // `Trabajdores Unicos Zona Influencia`. Different measures - so only the LABEL
        // SET is comparable, which is exactly what AC 17 asks about (`#VALUE!` gone,
        // "Sin Fecha" named).
        soloEtiquetas: true,
        delSidecar(sc) {
            const rangos = sc && sc.metricas && sc.metricas.excepciones
                && sc.metricas.excepciones.listas && sc.metricas.excepciones.listas.edad
                && sc.metricas.excepciones.listas.edad.rangos;
            if (!Array.isArray(rangos)) return undefined;
            const filas = rangos
                .filter((r) => Number(r.filas) > 0 || RANGO_LABELS.includes(r.rango))
                .map((r) => ({ etiqueta: String(r.rango), valores: null }));
            return { cabeceras: null, filas, total: null };
        },
    }),
    Object.freeze({
        id: "rrhh.bajas",
        hoja: "Reporte Social - RRHH",
        referencia: "C39:F45 + D46/E46/F46 (Total Bajas)",
        titulo: "Bajas por Zona de Influencia x GENERO",
        tipoBloque: "matriz",
        columna: "C",
        ancla: "Sum of Bajas Zona Influencia",
        cabeceraEn: "ancla+1",
        totalEtiqueta: "Total Bajas",
        delSidecar: (sc) => matrizDeSidecar(sc && sc.metricas && sc.metricas.bajas, "zona"),
    }),
    Object.freeze({
        id: "rrhh.altas",
        hoja: "Reporte Social - RRHH",
        referencia: "C53:F59 + D60/E60/F60 (Total Ingresos)",
        titulo: "Altas por Zona de Influencia x GENERO",
        tipoBloque: "matriz",
        columna: "C",
        ancla: "Sum of Altas Zona de Influencia",
        cabeceraEn: "ancla+1",
        totalEtiqueta: "Total Ingresos",
        delSidecar: (sc) => matrizDeSidecar(sc && sc.metricas && sc.metricas.altas, "zona"),
    }),
    Object.freeze({
        id: "cjyepc",
        hoja: "CJ Y EPC",
        referencia: "C7/D7, C8/D8, C9/D9",
        titulo: "CJV / EPC: # Trabajadores y # Horas",
        tipoBloque: "matriz",
        columna: "B",
        ancla: "CJV & EPC",
        cabeceraEn: "ancla",
        totalEtiqueta: "Total Trabajadores Activos",
        delSidecar(sc) {
            const t = sc && sc.metricas && sc.metricas.cjvEpc;
            const h = sc && sc.metricas && sc.metricas.horas;
            if (!t || !h) return undefined;
            const porEpc = new Map();
            for (const g of t.grupos || []) porEpc.set(String(g.epc), [num(g.valor), null]);
            for (const g of h.grupos || []) {
                const row = porEpc.get(String(g.epc)) || [null, null];
                row[1] = num(g.valor);
                porEpc.set(String(g.epc), row);
            }
            const filas = [...porEpc.entries()]
                .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
                .map(([etiqueta, valores]) => ({ etiqueta, valores }));
            return {
                cabeceras: ["# Trabajadores", "# Horas"],
                filas,
                total: { etiqueta: "Total Trabajadores Activos", valores: [num(t.total), num(h.total)] },
            };
        },
    }),
    Object.freeze({
        id: "tabla.granTotal",
        hoja: "Tabla",
        referencia: "D64/E64/F64/G64",
        titulo: "Tabla: Σ Trabajadores Unicos por ESTADO (gran total)",
        tipoBloque: "filaTotal",
        columna: "A",
        totalEtiqueta: "Grand Total",
        columnas: ["D", "E", "F", "G"],
        // No side-car equivalent, and none is invented: the measure is Σ Trabajadores
        // Unicos filtered on BajasAntiguas="No" and split by ESTADO, and metrics.js
        // publishes ESTADO only as a row tally (excepciones.listas.estado).
        delSidecar: () => undefined,
        motivoSinSidecar:
            "el side-car publica ESTADO como conteo de filas, no como Σ Trabajadores Unicos con filtro BajasAntiguas=\"No\"",
    }),
    Object.freeze({
        id: "contratistas.granTotal",
        hoja: "Contratistas",
        referencia: "C91",
        titulo: "Contratistas distintos (Σ columna U)",
        tipoBloque: "filaTotal",
        columna: "A",
        totalEtiqueta: "Grand Total",
        columnas: ["C"],
        delSidecar(sc) {
            const c = sc && sc.metricas && sc.metricas.contratistas;
            if (!c) return undefined;
            return { cabeceras: ["Total"], filas: [], total: { etiqueta: "Grand Total", valores: [num(c.suma)] } };
        },
    }),
    Object.freeze({
        id: "dosSubcontratas.filas",
        hoja: "Dos Subcontratas por Mes",
        referencia: "A7:E61",
        titulo: "Dos Subcontratas por Mes: filas de detalle",
        tipoBloque: "conteoDetalle",
        columnaDetalle: "B",
        primeraFila: 7,
        delSidecar(sc) {
            const d = sc && sc.metricas && sc.metricas.excepciones && sc.metricas.excepciones.listas
                && sc.metricas.excepciones.listas.dosSubcontratistas;
            if (!d) return undefined;
            return { cabeceras: ["filas"], filas: [], total: { etiqueta: "filas", valores: [num(d.grupos)] } };
        },
    }),
    Object.freeze({
        id: "validacion.cuentaRuc",
        hoja: "Validacion",
        referencia: "D2521",
        titulo: "Validacion: Cuenta de RUC (gran total)",
        tipoBloque: "filaTotal",
        columna: "A",
        totalEtiqueta: "Grand Total",
        columnas: ["D"],
        delSidecar(sc) {
            const filas = sc && sc.metricas && sc.metricas.headcount && sc.metricas.headcount.filas;
            const sinRuc = sc && sc.metricas && sc.metricas.excepciones && sc.metricas.excepciones.listas
                && sc.metricas.excepciones.listas.identificadores
                && sc.metricas.excepciones.listas.identificadores.sinRuc;
            if (!Number.isFinite(Number(filas)) || !Number.isFinite(Number(sinRuc))) return undefined;
            return {
                cabeceras: ["Total"],
                filas: [],
                total: { etiqueta: "Grand Total", valores: [Number(filas) - Number(sinRuc)] },
            };
        },
    }),
    Object.freeze({
        id: "validacion.bloqueDerecho",
        hoja: "Validacion",
        referencia: "G7:J… (ValidarDNI = Corregir)",
        titulo: "Validacion: bloque derecho (DNI ausente o < 8)",
        tipoBloque: "conteoDetalle",
        columnaDetalle: "H",
        primeraFila: 8,
        excluir: ["(blank)", "Grand Total"],
        delSidecar(sc) {
            const i = sc && sc.metricas && sc.metricas.excepciones && sc.metricas.excepciones.listas
                && sc.metricas.excepciones.listas.identificadores;
            if (!i) return undefined;
            return { cabeceras: ["filas"], filas: [], total: { etiqueta: "filas", valores: [num(i.validarDniCorregir)] } };
        },
    }),
    Object.freeze({
        id: "rrhh.detalleCesados",
        hoja: "Reporte Social - RRHH",
        referencia: "U2 block (Detalle Cesados Zona de Influencia)",
        titulo: "Detalle Cesados Zona de Influencia: filas de detalle",
        tipoBloque: "conteoDetalle",
        columnaDetalle: "V",
        primeraFila: 8,
        excluir: ["Total", "APELLIDOS Y NOMBRES"],
        delSidecar(sc) {
            const b = sc && sc.metricas && sc.metricas.bajas;
            if (!b) return undefined;
            // AC 19: the detail row count must equal Total Bajas. `enPeriodo` is the
            // population the fixed page filter selects.
            return { cabeceras: ["filas"], filas: [], total: { etiqueta: "filas", valores: [num(b.enPeriodo)] } };
        },
    }),
]);

/** The three page-filter cells that carry the report period label (03 §9 item 28
 *  `D49` / `AG4`, plus the Detalle Cesados filter that BUG-26 pins on "Borrar"). */
const PIVOT_FILTERS = Object.freeze([
    Object.freeze({
        id: "rrhh.filtro.altas", hoja: "Reporte Social - RRHH",
        columna: "C", etiqueta: "Altas", referencia: "D49", esperaPeriodo: true,
    }),
    Object.freeze({
        id: "rrhh.filtro.detalleIngresos", hoja: "Reporte Social - RRHH",
        columna: "AF", etiqueta: "Altas", referencia: "AG4", esperaPeriodo: true,
    }),
    Object.freeze({
        id: "rrhh.filtro.detalleCesados", hoja: "Reporte Social - RRHH",
        columna: "U", etiqueta: "Bajas2", referencia: "V4", esperaPeriodo: false,
    }),
]);

/** Sheets stage 4 needs. Parsed only when stage 4 runs. */
const PIVOT_SHEETS = Object.freeze([...new Set(PIVOT_BLOCKS.map((b) => b.hoja))]);

/* ================================================================== *
 * 3. Reading a report
 * ================================================================== */

/**
 * Read one generated workbook into the compact shape the diff needs.
 *
 * The SheetJS workbook is walked once and dropped: what survives is the row array, the
 * pivot blocks (when asked for) and the pivot-cache metadata. That keeps two reports
 * comparable without holding two parsed workbooks at the same time.
 *
 * @param {string} file
 * @param {{pivotes?: boolean, maxFilas?: number}} [options]
 */
async function readReport(file, options = {}) {
    const buf = await fs.promises.readFile(file);

    const hojas = [CUADRO].concat(options.pivotes ? PIVOT_SHEETS : []);
    const wb = XLSX.read(buf, {
        type: "buffer",
        cellFormula: true,
        cellDates: false,
        cellStyles: false,
        cellNF: false,
        sheets: hojas,
    });

    const hoja = wb.Sheets[CUADRO];
    if (!hoja) {
        throw new DiffError(
            `${path.basename(file)}: no tiene una hoja "${CUADRO}" ` +
            `(hojas: ${wb.SheetNames.join(", ")})`
        );
    }

    const cuadro = readCuadro(hoja, options.maxFilas);
    const pivotes = options.pivotes ? readPivotSheets(wb) : null;
    const zip = await readZipMeta(buf);

    return {
        archivo: file,
        nombre: path.basename(file),
        bytes: buf.length,
        hojas: wb.SheetNames.slice(),
        cuadro,
        pivotes,
        zip,
    };
}

/** `Cuadro` -> `{encabezados, filas, ultimaFila}`; row 1 is the header row. */
function readCuadro(hoja, maxFilas) {
    const ref = hoja["!ref"];
    if (!ref) return { encabezados: [], filas: [], ultimaFila: 1, columnas: 0 };
    const range = XLSX.utils.decode_range(ref);
    const columnas = Math.max(range.e.c + 1, RAW_COLUMN_COUNT);

    const encabezados = [];
    for (let c = 0; c < columnas; c++) encabezados.push(textOf(cellAt(hoja, 0, c)));

    const limite = Number.isInteger(maxFilas) && maxFilas > 0
        ? Math.min(range.e.r, maxFilas)
        : range.e.r;

    const filas = [];
    for (let r = 1; r <= limite; r++) {
        const crudas = [];
        for (let c = 0; c < RAW_COLUMN_COUNT; c++) crudas.push(cellAt(hoja, r, c));
        const computadas = COMPUTED_INDEXES.map((c) => cellAt(hoja, r, c));

        // A GHOST ROW is one with nothing in any of the 18 raw columns - whether it holds
        // empty strings (what the old writer's "DELETE ALL DATA" loop leaves behind) or no
        // cells at all, and whether or not the table's calculated columns still carry
        // formulas over it. That is the 3,277-row population of BUG-10, and it is a
        // property of the ROW: a row with no identity can never be matched against
        // anything, so it is never a cell-level divergence.
        const fantasma = crudas.every((c) => c.vacia);

        filas.push({
            fila: r + 1,
            crudas,
            computadas,
            fantasma,
            clave: null,      // filled by keyRows()
            partes: null,
        });
    }
    return { encabezados, filas, ultimaFila: range.e.r + 1, columnas };
}

function readPivotSheets(wb) {
    const out = {};
    for (const name of PIVOT_SHEETS) {
        const hoja = wb.Sheets[name];
        out[name] = hoja ? { presente: true, hoja } : { presente: false, hoja: null };
    }
    return out;
}

/**
 * The two facts about the file that only the zip carries: the pivot cache's
 * `refreshedDate`/`refreshedBy`/`refreshOnLoad` (BUG-14 - is this side live or stale?)
 * and `Tabla2`'s declared `ref` (BUG-10 - how tall does the file claim to be?).
 *
 * Read with a targeted regex over two small parts, never by parsing and reserializing:
 * the whole point of 05 §6 row 1 is that nothing in this repo round-trips a pivot part.
 */
async function readZipMeta(buf) {
    const meta = {
        cache: { presente: false, refreshedBy: null, refreshedDate: null, refreshedYMD: null, refreshOnLoad: false, recordCount: null },
        tabla: { presente: false, ref: null, filas: null },
    };
    let zip;
    try {
        zip = await JSZip.loadAsync(buf);
    } catch {
        return meta;   // not a zip we can read; the workbook read already succeeded or failed
    }

    const defName = Object.keys(zip.files).find((n) => /^xl\/pivotCache\/pivotCacheDefinition\d+\.xml$/.test(n));
    if (defName) {
        const xml = await zip.files[defName].async("string");
        const head = xml.slice(0, 4000);
        meta.cache.presente = true;
        meta.cache.refreshedBy = attr(head, "refreshedBy");
        const rd = attr(head, "refreshedDate");
        meta.cache.refreshedDate = rd === null ? null : Number(rd);
        meta.cache.refreshedYMD = Number.isFinite(meta.cache.refreshedDate)
            ? serialToYMD(meta.cache.refreshedDate)
            : null;
        meta.cache.refreshOnLoad = attr(head, "refreshOnLoad") === "1";
        const rc = attr(head, "recordCount");
        meta.cache.recordCount = rc === null ? null : Number(rc);
    }

    const tablaName = Object.keys(zip.files).find((n) => /^xl\/tables\/table\d+\.xml$/.test(n));
    if (tablaName) {
        const xml = await zip.files[tablaName].async("string");
        meta.tabla.presente = true;
        meta.tabla.ref = attr(xml.slice(0, 2000), "ref");
        const m = meta.tabla.ref && /^[A-Z]+(\d+):[A-Z]+(\d+)$/.exec(meta.tabla.ref);
        meta.tabla.filas = m ? Number(m[2]) - Number(m[1]) : null;
    }
    return meta;
}

function attr(xml, name) {
    const m = new RegExp(`\\s${name}="([^"]*)"`).exec(xml);
    return m ? m[1] : null;
}

/* ------------------------------- cells ---------------------------- */

const CELDA_VACIA = Object.freeze({ v: null, t: TIPO.VACIO, f: null, vacia: true, texto: "" });

/**
 * One cell, normalized for comparison.
 *
 * `vacia` is TRUE both for an absent cell and for a cell holding an empty or
 * whitespace-only string, because both mean "no value" to a reader. `t` still reports
 * what was actually stored, so the report can say "texto" for the empty-string cells the
 * old writer leaves behind - the distinction 03 §7.2 turns on.
 */
function cellAt(hoja, r, c) {
    const cell = hoja[XLSX.utils.encode_cell({ r, c })];
    if (!cell) return CELDA_VACIA;
    const f = typeof cell.f === "string" && cell.f !== "" ? cell.f : null;

    switch (cell.t) {
        case "n": {
            const v = typeof cell.v === "number" ? cell.v : Number(cell.v);
            if (!Number.isFinite(v)) {
                // A NaN that reached the file (BUG-20). Not empty, not a number: reported
                // verbatim so it classifies against E8 instead of vanishing.
                return { v: String(cell.v), t: TIPO.TEXTO, f, vacia: false, texto: String(cell.v) };
            }
            return { v, t: TIPO.NUMERO, f, vacia: false, texto: String(v) };
        }
        case "d": {
            const iso = cell.v instanceof Date ? cell.v.toISOString().slice(0, 10) : String(cell.v);
            return { v: iso, t: TIPO.FECHA, f, vacia: false, texto: iso };
        }
        case "b":
            return { v: Boolean(cell.v), t: TIPO.BOOLEANO, f, vacia: false, texto: String(Boolean(cell.v)) };
        case "e": {
            const code = typeof cell.v === "number" ? (ERROR_CODES[cell.v] || `#ERR(${cell.v})`) : String(cell.w || cell.v);
            return { v: code, t: TIPO.ERROR, f, vacia: false, texto: code };
        }
        case "z":
            return f ? { v: null, t: TIPO.VACIO, f, vacia: true, texto: "" } : CELDA_VACIA;
        default: {
            const s = cell.v === null || cell.v === undefined ? "" : String(cell.v);
            const vacia = s.trim() === "";
            return { v: s, t: TIPO.TEXTO, f, vacia, texto: s };
        }
    }
}

function textOf(cell) {
    if (cell === null || cell === undefined) return "";
    if (typeof cell === "object" && "texto" in cell) return cell.texto;
    return String(cell);
}

function numeric(cell) {
    if (cell === null || cell === undefined) return null;
    if (typeof cell === "number") return Number.isFinite(cell) ? cell : null;
    if (typeof cell === "object") {
        if (cell.t === TIPO.NUMERO) return cell.v;
        if (cell.vacia) return null;
        const n = Number(cell.texto);
        return Number.isFinite(n) ? n : null;
    }
    const n = Number(cell);
    return Number.isFinite(n) ? n : null;
}

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/** 0 -> "A", 34 -> "AI". */
function colLetter(index) {
    let n = index;
    let out = "";
    do {
        out = String.fromCharCode(65 + (n % 26)) + out;
        n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return out;
}

/** "AI" -> 34. */
function colIndex(letter) {
    let n = 0;
    for (const ch of letter) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
}

/* ================================================================== *
 * 4. Stage 1 - the multiset over Cuadro!A:R
 * ================================================================== */

/**
 * The identity key of one row: (RUC, Nro. DNI / CE, APELLIDOS Y NOMBRES,
 * FECHA INICIO DE LABORES EN OBRA), each normalized.
 *
 * NORMALIZED, not raw, and that is the single most consequential decision in this file.
 * The old pipeline writes `"04/07/1994"` as text where the new one writes serial 34519;
 * it writes `"09994533"` where the new one writes the same string but the old SheetJS
 * path may have made it the number 9994533. Keyed raw, every one of those rows would
 * appear twice - once as "only in the old", once as "only in the new" - stage 2 would
 * have nothing left to compare, and the type change §4.4 item 2 asks for would be
 * invisible. Keyed normalized, the row matches and the type change is reported on it.
 */
function rowKey(crudas) {
    const ruc = normalizeRuc(crudas[iCol("RUC")].v).text;
    const dni = normalizeDni(crudas[iCol("Nro. DNI / CE")].v).text;
    const nombre = normalizeNameKey(crudas[iCol("APELLIDOS Y NOMBRES")].v);
    const inicio = dateKey(crudas[iCol("FECHA INICIO DE LABORES EN OBRA")]);
    return {
        partes: { ruc, dni, nombre, inicio },
        clave: [ruc, dni, nombre, inicio].join(""),
        vacia: ruc === "" && dni === "" && nombre === "" && inicio === "",
    };
}

/**
 * A date cell reduced to `YYYY-MM-DD`, whatever it was stored as.
 *
 * Self-contained on purpose: `dates.parseDateCell` needs a period (it does plausibility
 * checks against it) and this key must exist with or without one. Serial arithmetic
 * still goes through `dates.serialToYMD`, so the 1900-leap-year quirk is not
 * re-implemented here.
 */
function dateKey(cell) {
    if (!cell || cell.vacia) return "";
    if (cell.t === TIPO.NUMERO) {
        const ymd = serialToYMD(Math.trunc(cell.v));
        return ymd ? fmtYMD(ymd) : `n:${cell.v}`;
    }
    if (cell.t === TIPO.FECHA) return String(cell.v).slice(0, 10);
    const s = cell.texto.trim();
    const m = /^(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{1,4})$/.exec(s);
    if (m) {
        // Day-first is the rule (03 §3.2). A 4-digit first field is an ISO date.
        let y; let mo; let d;
        if (m[1].length === 4) { y = +m[1]; mo = +m[2]; d = +m[3]; }
        else { d = +m[1]; mo = +m[2]; y = +m[3]; }
        if (y < 100) y += y <= 30 ? 2000 : 1900;
        if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 9999) {
            return fmtYMD({ y, m: mo, d });
        }
    }
    return `t:${s.toUpperCase()}`;
}

function fmtYMD(ymd) {
    return `${String(ymd.y).padStart(4, "0")}-${String(ymd.m).padStart(2, "0")}-${String(ymd.d).padStart(2, "0")}`;
}

/** Attach keys, and the row-shape flags the matchers read. */
function keyRows(cuadro) {
    const idxNombre = iCol("APELLIDOS Y NOMBRES");
    for (const fila of cuadro.filas) {
        const k = rowKey(fila.crudas);
        fila.clave = k.clave;
        fila.partes = k.partes;
        fila.claveVacia = k.vacia;

        const nombre = fila.crudas[idxNombre];
        // BUG-04's fingerprint: a RUC sitting in APELLIDOS Y NOMBRES. A numeric cell or
        // an all-digit text of RUC/DNI length, never a name that merely starts with a digit.
        fila.nombreNumerico = !nombre.vacia
            && (nombre.t === TIPO.NUMERO || /^\d{8,11}$/.test(nombre.texto.trim()));
    }
    return cuadro;
}

/**
 * The multiset comparison. Same key on both sides pairs off in row order; the surplus on
 * either side is "only in ...".
 */
function matchRows(antiguo, nuevo) {
    const index = new Map();
    for (const fila of antiguo.filas) push(index, fila.clave, "antiguas", fila);
    for (const fila of nuevo.filas) push(index, fila.clave, "nuevas", fila);

    const pares = [];
    const soloAntiguo = [];
    const soloNuevo = [];

    for (const [clave, grupo] of index) {
        const a = grupo.antiguas || [];
        const n = grupo.nuevas || [];
        const comunes = Math.min(a.length, n.length);
        for (let i = 0; i < comunes; i++) pares.push({ clave, antiguo: a[i], nuevo: n[i] });
        for (let i = comunes; i < a.length; i++) {
            soloAntiguo.push({ clave, fila: a[i], claveEnAmbosLados: n.length > 0 });
        }
        for (let i = comunes; i < n.length; i++) {
            soloNuevo.push({ clave, fila: n[i], claveEnAmbosLados: a.length > 0 });
        }
    }

    return { pares, soloAntiguo, soloNuevo };

    function push(map, clave, lado, fila) {
        let g = map.get(clave);
        if (!g) { g = {}; map.set(clave, g); }
        (g[lado] || (g[lado] = [])).push(fila);
    }
}

/**
 * The recovered-subcontratista test.
 *
 * A row present only in the new output is RECOVERED when the company it belongs to does
 * not appear ANYWHERE in the old output: that is a whole workbook the old pipeline
 * dropped on the floor with a `console.log` (excelConsolidation.js:75). Keyed on the
 * normalized RUC first - the strongest company identifier - and on the normalized
 * EMPRESA text when the row has no RUC.
 */
function companySets(cuadro) {
    const rucs = new Set();
    const empresas = new Set();
    const iRuc = iCol("RUC");
    const iEmp = iCol("EMPRESA");
    const iCon = iCol("CONTRATISTA PRNCIPAL");
    for (const fila of cuadro.filas) {
        if (fila.fantasma) continue;
        const ruc = normalizeRuc(fila.crudas[iRuc].v).text;
        if (ruc !== "") rucs.add(ruc);
        for (const i of [iEmp, iCon]) {
            const t = normText("EMPRESA", fila.crudas[i].v);
            if (t !== "") empresas.add(t);
        }
    }
    return { rucs, empresas };
}

function companyOf(fila) {
    const ruc = normalizeRuc(fila.crudas[iCol("RUC")].v).text;
    const empresa = normText("EMPRESA", fila.crudas[iCol("EMPRESA")].v);
    const contratista = normText("EMPRESA", fila.crudas[iCol("CONTRATISTA PRNCIPAL")].v);
    return { ruc, empresa, contratista };
}

function normText(columna, value) {
    const r = normalizeForColumn(columna, value);
    return r.value === null || r.value === undefined ? "" : String(r.value).toUpperCase();
}

/* ================================================================== *
 * 5. Stages 2 and 3 - cells
 * ================================================================== */

/**
 * Compare two cells. Returns a divergence KIND or null.
 *
 * The order is the contract: a TYPE difference short-circuits, so it is never also
 * reported as a value inequality (§4.4 item 2). Two empty cells are equal regardless of
 * how each side spelled "empty" - an absent cell and an empty string both mean "no
 * value", and the difference between them is a ROW-level property (a ghost row), not a
 * cell-level divergence.
 */
function compareCells(a, b) {
    if (a.vacia && b.vacia) return null;
    if (a.t !== b.t) return KIND.TIPO;
    if (a.t === TIPO.NUMERO) return equalNumbers(a.v, b.v) ? null : KIND.VALOR;
    if (a.t === TIPO.BOOLEANO) return a.v === b.v ? null : KIND.VALOR;
    return a.texto === b.texto ? null : KIND.VALOR;
}

/**
 * Numeric equality with the ULP tolerance of `EPS_REL`.
 *
 * This is where 05 §4.5 entry 11 is actually honoured: `5096.833333333334` on both sides
 * is EQUAL and produces no divergence at all, so nothing downstream ever has to decide
 * whether a fractional total is a bug. It is not, and the decimals are never rounded.
 */
function equalNumbers(a, b) {
    if (a === b) return true;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return Math.abs(a - b) <= EPS_REL * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * Numeric equality INSIDE A PIVOT BODY, where an empty cell means "no items in this
 * intersection", i.e. zero - the sheet leaves `D13` blank for a zone with no women while
 * the side-car publishes `femenino: 0`. Only used for pivot values; a blank raw cell in
 * `Cuadro` is never silently a zero.
 */
function pivotEqual(a, b) {
    return equalNumbers(a === null || a === undefined ? 0 : a, b === null || b === undefined ? 0 : b);
}

function isSentinelText(s) {
    if (s === null || s === undefined) return false;
    const t = String(s).trim().toUpperCase();
    if (t === "") return false;
    return SENTINELS.has(t) || SENTINELS.has(String(s).toUpperCase());
}

/**
 * Text that is plausibly a DATE rather than a sentinel or a label - digits and date
 * separators only, at least one digit. `"04/07/1994"`, `"09/10/205"` and
 * `"10-11-202-6"` qualify; `"-"`, `"---"` and `"ACTIVO"` do not, which is what keeps
 * E2 (a text date became a serial) and E8 (a sentinel became an empty cell) from
 * claiming each other's divergences.
 */
function looksLikeTextDate(s) {
    const t = String(s === null || s === undefined ? "" : s).trim();
    return /\d/.test(t) && /^[\d\s./-]+$/.test(t);
}

/**
 * The same scalar written two ways: `9994533` and `"09994533"`, `1` and `"1"`,
 * `8.5` and `"8.5"`. Leading zeros are stripped on the text side ONLY for comparison -
 * preserving them in the output is the whole point of AC 13.
 */
function sameScalar(a, b) {
    const norm = (v) => {
        if (v === null || v === undefined) return null;
        const s = String(v).trim();
        if (s === "") return null;
        if (/^\d+$/.test(s)) return s.replace(/^0+(?=\d)/, "");
        const n = Number(s);
        return Number.isFinite(n) ? String(n) : s.toUpperCase();
    };
    const na = norm(a);
    const nb = norm(b);
    return na !== null && na === nb;
}

/* ================================================================== *
 * 6. Stage 4 - the pivot blocks
 * ================================================================== */

/** Find a label in one column of a sheet. Returns `{r, c}` or null. */
function findLabel(hoja, letra, texto, opciones = {}) {
    const ref = hoja && hoja["!ref"];
    if (!ref) return null;
    const range = XLSX.utils.decode_range(ref);
    const c = colIndex(letra);
    if (c < range.s.c || c > range.e.c) return null;
    const objetivo = squash(texto);
    const desde = opciones.desde === undefined ? range.s.r : opciones.desde;
    for (let r = desde; r <= range.e.r; r++) {
        if (squash(textOf(cellAt(hoja, r, c))) === objetivo) return { r, c };
    }
    return null;
}

function squash(s) {
    return String(s === null || s === undefined ? "" : s)
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ").trim().toUpperCase();
}

/**
 * A pivot body: label column + N value columns, ending at the total row.
 *
 * Located from the block's own captions rather than from an address (see the note on
 * PIVOT_BLOCKS), and it returns the addresses it read so the report can print them.
 */
function readMatrixBlock(hoja, spec) {
    const ancla = findLabel(hoja, spec.columna, spec.ancla);
    if (!ancla) return null;
    const rCab = spec.cabeceraEn === "ancla" ? ancla.r : ancla.r + 1;
    const c0 = ancla.c;

    const cabeceras = [];
    for (let c = c0 + 1; ; c++) {
        const t = textOf(cellAt(hoja, rCab, c));
        if (t.trim() === "") break;
        cabeceras.push({ texto: t, c });
        if (cabeceras.length > 12) break;   // a runaway header row is a layout change
    }
    if (cabeceras.length === 0) return null;

    const filas = [];
    let total = null;
    const objetivoTotal = squash(spec.totalEtiqueta);
    for (let r = rCab + 1; r <= rCab + 400; r++) {
        const etiqueta = textOf(cellAt(hoja, r, c0));
        const esTotal = squash(etiqueta) === objetivoTotal;
        if (etiqueta.trim() === "" && !esTotal) break;
        const entrada = {
            etiqueta,
            valores: cabeceras.map((h) => numeric(cellAt(hoja, r, h.c))),
            celdas: cabeceras.map((h) => XLSX.utils.encode_cell({ r, c: h.c })),
        };
        if (esTotal) { total = entrada; break; }
        filas.push(entrada);
    }

    return {
        cabeceras: cabeceras.map((h) => h.texto),
        filas,
        total,
        ancla: XLSX.utils.encode_cell({ r: ancla.r, c: ancla.c }),
    };
}

/** A single labelled total row, read on named columns. */
function readTotalRow(hoja, spec) {
    const pos = findLabel(hoja, spec.columna, spec.totalEtiqueta);
    if (!pos) return null;
    const valores = spec.columnas.map((L) => numeric(cellAt(hoja, pos.r, colIndex(L))));
    return {
        cabeceras: spec.columnas.slice(),
        filas: [],
        total: {
            etiqueta: spec.totalEtiqueta,
            valores,
            celdas: spec.columnas.map((L) => `${L}${pos.r + 1}`),
        },
        ancla: XLSX.utils.encode_cell({ r: pos.r, c: pos.c }),
    };
}

/** A detail listing: how many rows carry a value in the detail column. */
function readDetailCount(hoja, spec) {
    const ref = hoja && hoja["!ref"];
    if (!ref) return null;
    const range = XLSX.utils.decode_range(ref);
    const c = colIndex(spec.columnaDetalle);
    const excluir = new Set((spec.excluir || []).map(squash));
    let n = 0;
    let primera = null;
    let ultima = null;
    for (let r = (spec.primeraFila || 1) - 1; r <= range.e.r; r++) {
        const t = textOf(cellAt(hoja, r, c)).trim();
        if (t === "" || excluir.has(squash(t))) continue;
        n += 1;
        if (primera === null) primera = r;
        ultima = r;
    }
    return {
        cabeceras: ["filas"],
        filas: [],
        total: {
            etiqueta: "filas",
            valores: [n],
            celdas: [primera === null
                ? `${spec.columnaDetalle}${spec.primeraFila || 1}`
                : `${spec.columnaDetalle}${primera + 1}:${spec.columnaDetalle}${ultima + 1}`],
        },
        ancla: null,
    };
}

function readPivotBlock(hoja, spec) {
    if (!hoja) return null;
    if (spec.tipoBloque === "matriz") return readMatrixBlock(hoja, spec);
    if (spec.tipoBloque === "filaTotal") return readTotalRow(hoja, spec);
    if (spec.tipoBloque === "conteoDetalle") return readDetailCount(hoja, spec);
    return null;
}

/** metrics.js matrix -> the block shape, so the two are compared row label by row label. */
function matrizDeSidecar(metric, campoEtiqueta) {
    if (!metric || !Array.isArray(metric.zonas)) return undefined;
    const filas = metric.zonas.map((z) => ({
        etiqueta: String(z[campoEtiqueta] === null || z[campoEtiqueta] === undefined ? "" : z[campoEtiqueta]),
        valores: [num(z.femenino), num(z.masculino), num(z.total)],
    }));
    const t = metric.totales || {};
    return {
        cabeceras: ["femenino", "masculino", "Total"],
        filas,
        total: { etiqueta: "Total", valores: [num(t.femenino), num(t.masculino), num(metric.total)] },
    };
}

/* ================================================================== *
 * 7. Divergence assembly and classification
 * ================================================================== */

function divergencia(o) {
    return Object.assign(
        { etapa: null, tipo: null, id: null, hoja: CUADRO, columna: null, nombre: null, celda: null, clave: null, antiguo: null, nuevo: null, ctx: {} },
        o
    );
}

/**
 * The gate. Returns the first entry whose matcher accepts the divergence, or null -
 * and null means UNEXPECTED, which means cutover is blocked.
 *
 * First match wins, and the order of `EXPECTED_DIVERGENCES` is therefore meaningful:
 * §4.5's own order, with the extensions last, so a divergence is always attributed to
 * the plan's entry when one applies and to an extension only when none does.
 */
function classify(d) {
    for (const entry of EXPECTED_DIVERGENCES) {
        if (entry.supresion) continue;
        let ok = false;
        try {
            ok = entry.match(d) === true;
        } catch {
            ok = false;   // a throwing matcher must never look like a match
        }
        if (ok) return entry;
    }
    return null;
}

/* ================================================================== *
 * 8. The diff itself
 * ================================================================== */

class DiffError extends Error {
    constructor(message) { super(message); this.name = "DiffError"; }
}

/**
 * Diff two generated reports.
 *
 * @param {string} antiguoPath  the OLD pipeline's workbook - the one delivered to the
 *                              client during the parallel months
 * @param {string} nuevoPath    the NEW pipeline's workbook (shadow output)
 * @param {object} [opciones]
 * @param {string|object} [opciones.sidecar]         the new run's metrics side-car
 * @param {string|object} [opciones.sidecarAntiguo]  an old-side side-car, if any
 * @param {boolean} [opciones.refreshed]  the OLD workbook's pivot cache was manually
 *                                        refreshed in Excel. Stage 4 does not run without it.
 * @param {string} [opciones.period]      "YYYY-MM"; only used to sanity-check the refresh
 * @param {number} [opciones.ejemplos]    examples kept per class (default 5)
 * @param {number} [opciones.maxPorClase] divergences serialized per class (default 500)
 * @returns {Promise<object>} the classified result; `.bloquea` and `.exitCode` are the gate
 */
async function diffReports(antiguoPath, nuevoPath, opciones = {}) {
    const opts = opciones || {};
    const ejemplos = Number.isInteger(opts.ejemplos) && opts.ejemplos >= 0 ? opts.ejemplos : 5;
    const maxPorClase = Number.isInteger(opts.maxPorClase) && opts.maxPorClase >= 0 ? opts.maxPorClase : 500;

    const sidecar = loadSidecar(opts.sidecar, "--sidecar");
    const sidecarAntiguo = loadSidecar(opts.sidecarAntiguo, "--sidecar-antiguo");
    const periodo = resolvePeriodLabel(opts.period, sidecar);

    /* ---- stage 4 admissibility, decided BEFORE anything is compared ------------- */
    const pivotes = { ejecutado: false, motivo: null, refrescoDeclarado: Boolean(opts.refreshed), cache: null, bloques: [], noComparables: [] };

    const antiguo = await readReport(antiguoPath, { pivotes: Boolean(opts.refreshed) });
    const nuevo = await readReport(nuevoPath, { pivotes: Boolean(opts.refreshed) });

    pivotes.cache = {
        antiguo: antiguo.zip.cache,
        nuevo: nuevo.zip.cache,
    };

    if (!opts.refreshed) {
        pivotes.motivo =
            "no se paso --refreshed: la salida ANTIGUA lleva valores de pivote cacheados y " +
            "obsoletos (BUG-14; cinco de catorce reportes entregados siguen mostrando numeros " +
            "de septiembre-2024), asi que su lado solo significa algo despues de que un humano " +
            "abra el archivo en Excel y actualice. Presupuesto: una actualizacion manual por mes paralelo.";
    } else if (!sidecar) {
        pivotes.motivo =
            "se paso --refreshed pero no --sidecar: el lado NUEVO de los totales de pivote sale " +
            "del side-car de metricas (sin sesion de Excel), y sin el no hay con que comparar.";
    } else {
        const veredicto = judgeRefresh(antiguo.zip.cache, periodo);
        if (!veredicto.ok) {
            pivotes.motivo = veredicto.motivo;
        } else {
            pivotes.ejecutado = true;
            pivotes.veredictoCache = veredicto;
        }
    }

    /* ---- stage 1 ---------------------------------------------------------------- */
    keyRows(antiguo.cuadro);
    keyRows(nuevo.cuadro);
    const empresasAntiguo = companySets(antiguo.cuadro);
    const emparejado = matchRows(antiguo.cuadro, nuevo.cuadro);

    const divergencias = [];

    for (const item of emparejado.soloNuevo) {
        const { fila } = item;
        const empresa = companyOf(fila);
        const recuperada = !fila.fantasma
            && (empresa.ruc !== "" || empresa.empresa !== "")
            && !(empresa.ruc !== "" && empresasAntiguo.rucs.has(empresa.ruc))
            && !(empresa.empresa !== "" && empresasAntiguo.empresas.has(empresa.empresa))
            && !(empresa.contratista !== "" && empresasAntiguo.empresas.has(empresa.contratista));
        // A row whose RUC is present but whose name key matches nothing on the old side,
        // where the old side carried that same RUC on a numeric-name row: BUG-04's block.
        const desplazada = !recuperada && empresa.ruc !== "" && empresasAntiguo.rucs.has(empresa.ruc)
            && item.claveEnAmbosLados === false && !fila.fantasma;

        divergencias.push(divergencia({
            etapa: ETAPA.FILAS,
            tipo: KIND.SOLO_NUEVO,
            clave: displayKey(fila),
            celda: { nuevo: `A${fila.fila}` },
            nuevo: { fila: fila.fila, empresa: empresa.empresa, ruc: empresa.ruc, contratista: empresa.contratista },
            ctx: {
                fantasma: fila.fantasma,
                claveVacia: fila.claveVacia,
                recuperada,
                desplazada,
                claveEnAmbosLados: item.claveEnAmbosLados,
                nombreNumerico: fila.nombreNumerico,
            },
        }));
    }

    for (const item of emparejado.soloAntiguo) {
        const { fila } = item;
        const empresa = companyOf(fila);
        divergencias.push(divergencia({
            etapa: ETAPA.FILAS,
            tipo: KIND.SOLO_ANTIGUO,
            clave: displayKey(fila),
            celda: { antiguo: `A${fila.fila}` },
            antiguo: { fila: fila.fila, empresa: empresa.empresa, ruc: empresa.ruc, contratista: empresa.contratista },
            ctx: {
                fantasma: fila.fantasma,
                claveVacia: fila.claveVacia,
                nombreNumerico: fila.nombreNumerico,
                claveEnAmbosLados: item.claveEnAmbosLados,
            },
        }));
    }

    /* ---- stages 2 and 3 --------------------------------------------------------- */
    let celdasComparadas = 0;
    let computadasComparadas = 0;
    let sinValorCacheado = 0;

    for (const par of emparejado.pares) {
        const a = par.antiguo;
        const n = par.nuevo;

        // Does this row carry a text date on the old side? E2's matcher needs it, and it
        // is a property of the ROW, not of the cell that happens to differ.
        let fechaTextoEnAntiguo = false;
        for (const letra of DATE_COLUMN_LETTERS) {
            const c = a.crudas[colIndex(letra)];
            if (c && !c.vacia && c.t === TIPO.TEXTO) { fechaTextoEnAntiguo = true; break; }
        }
        const identidadRecuperada = a.crudas[iCol("RUC")].vacia
            && !n.crudas[iCol("RUC")].vacia;

        for (let i = 0; i < RAW_COLUMN_COUNT; i++) {
            celdasComparadas += 1;
            const ca = a.crudas[i];
            const cn = n.crudas[i];
            const kind = compareCells(ca, cn);
            if (!kind) continue;

            const columna = colLetter(i);
            const nombre = CANONICAL[i];
            const soloNormalizacion = sameAfterNormalization(nombre, ca, cn);

            divergencias.push(divergencia({
                etapa: ETAPA.CELDAS,
                tipo: kind,
                columna,
                nombre,
                clave: displayKey(n),
                celda: { antiguo: `${columna}${a.fila}`, nuevo: `${columna}${n.fila}` },
                antiguo: cellSummary(ca),
                nuevo: cellSummary(cn),
                ctx: {
                    soloNormalizacion,
                    centinelaEnAntiguo: isSentinelText(ca.texto),
                    fechaTextoEnAntiguo,
                    identidadRecuperada,
                },
            }));
        }

        for (let i = 0; i < COMPUTED_COLUMNS_AI.length; i++) {
            const col = COMPUTED_COLUMNS_AI[i];
            const ca = a.computadas[i];
            const cn = n.computadas[i];

            const aTieneF = Boolean(ca.f);
            const nTieneF = Boolean(cn.f);

            if (aTieneF && nTieneF) {
                computadasComparadas += 1;
                if (normalizeFormula(ca.f) === normalizeFormula(cn.f)) continue;
                divergencias.push(computedDivergence(KIND.FORMULA, col, a, n, ca, cn, { fechaTextoEnAntiguo, identidadRecuperada }));
                continue;
            }
            if (aTieneF && !nTieneF) {
                computadasComparadas += 1;
                divergencias.push(computedDivergence(KIND.FORMULA_A_LITERAL, col, a, n, ca, cn, { fechaTextoEnAntiguo, identidadRecuperada }));
                continue;
            }
            if (!aTieneF && nTieneF) {
                computadasComparadas += 1;
                divergencias.push(computedDivergence(KIND.LITERAL_A_FORMULA, col, a, n, ca, cn, { fechaTextoEnAntiguo, identidadRecuperada }));
                continue;
            }
            // Neither side has a formula. If neither has a value either, the writer
            // stripped the cached <v> on both sides (xlsx-populate always does) and there
            // is nothing to compare - counted, never silently called equal.
            if (ca.vacia && cn.vacia) { sinValorCacheado += 1; continue; }
            computadasComparadas += 1;
            const kind = compareCells(ca, cn);
            if (!kind) continue;
            divergencias.push(computedDivergence(kind, col, a, n, ca, cn, { fechaTextoEnAntiguo, identidadRecuperada }));
        }
    }

    /* ---- stage 4 ---------------------------------------------------------------- */
    if (pivotes.ejecutado) {
        comparePivots(antiguo, nuevo, sidecar, divergencias, pivotes, periodo);
    }

    /* ---- stage 5 ---------------------------------------------------------------- */
    const conteos = compareCounts(antiguo, nuevo, emparejado, sidecar, sidecarAntiguo, divergencias);

    /* ---- classify --------------------------------------------------------------- */
    const clases = new Map();
    const inesperadas = [];
    for (const d of divergencias) {
        const entry = classify(d);
        d.clase = entry ? entry.id : "INESPERADA";
        d.esperada = Boolean(entry);
        const key = d.clase;
        if (!clases.has(key)) {
            clases.set(key, {
                id: key,
                titulo: entry ? entry.titulo : "DIVERGENCIA INESPERADA - BLOQUEA EL CUTOVER",
                fuente: entry ? entry.fuente : null,
                extension: entry ? Boolean(entry.extension) : false,
                total: 0,
                porEtapa: {},
                ejemplos: [],
                items: [],
            });
        }
        const clase = clases.get(key);
        clase.total += 1;
        clase.porEtapa[d.etapa] = (clase.porEtapa[d.etapa] || 0) + 1;
        if (clase.ejemplos.length < ejemplos) clase.ejemplos.push(d);
        if (clase.items.length < maxPorClase) clase.items.push(d);
        if (!entry) inesperadas.push(d);
    }

    const recuperadas = divergencias.filter((d) => d.etapa === ETAPA.FILAS && d.tipo === KIND.SOLO_NUEVO && d.ctx.recuperada);

    // The recovered rows tallied BY COMPANY, over all of them rather than over the
    // sample: "which subcontratistas did the old pipeline drop, and how many workers
    // each" is the question §4.4 item 1 is really asking, and a count taken from the
    // first twenty examples would answer it wrongly.
    const porEmpresa = new Map();
    for (const d of recuperadas) {
        const empresa = (d.nuevo && d.nuevo.empresa) || null;
        const ruc = (d.nuevo && d.nuevo.ruc) || null;
        const k = `${empresa || "?"}${ruc || ""}`;
        if (!porEmpresa.has(k)) porEmpresa.set(k, { empresa, ruc, filas: 0 });
        porEmpresa.get(k).filas += 1;
    }
    const recuperadasPorEmpresa = [...porEmpresa.values()].sort(
        (a, b) => b.filas - a.filas || String(a.empresa).localeCompare(String(b.empresa))
    );

    const bloquea = inesperadas.length > 0;
    const faltaEtapa = opts.requirePivots === true && !pivotes.ejecutado;

    return {
        version: VERSION,
        tipo: "diff-reportes",
        antiguo: describe(antiguo),
        nuevo: describe(nuevo),
        periodo,
        sidecar: sidecar ? { presente: true, version: sidecar.version ?? null, periodo: sidecar.periodo ?? null } : { presente: false },
        etapas: {
            filas: {
                antiguas: antiguo.cuadro.filas.length,
                nuevas: nuevo.cuadro.filas.length,
                fantasmaAntiguo: antiguo.cuadro.filas.filter((f) => f.fantasma).length,
                fantasmaNuevo: nuevo.cuadro.filas.filter((f) => f.fantasma).length,
                emparejadas: emparejado.pares.length,
                soloAntiguo: emparejado.soloAntiguo.length,
                soloNuevo: emparejado.soloNuevo.length,
                recuperadas: recuperadas.length,
            },
            celdas: { comparadas: celdasComparadas, divergentes: divergencias.filter((d) => d.etapa === ETAPA.CELDAS).length },
            computadas: {
                comparadas: computadasComparadas,
                divergentes: divergencias.filter((d) => d.etapa === ETAPA.COMPUTADAS).length,
                sinValorCacheado,
            },
            pivotes,
            conteos,
        },
        recuperadas: recuperadas.slice(0, Math.max(ejemplos, 20)).map(shortDivergence),
        recuperadasPorEmpresa,
        clases: [...clases.values()]
            .sort(ordenClases)
            .map((c) => ({
                id: c.id,
                titulo: c.titulo,
                fuente: c.fuente,
                extension: c.extension,
                total: c.total,
                porEtapa: c.porEtapa,
                ejemplos: c.ejemplos.map(shortDivergence),
                // The full list, capped: `--json` is where the developer classifies the
                // month, and the plain-text report deliberately shows only a few examples
                // per class ("the developer reads classes, not five thousand lines").
                items: c.items.map(shortDivergence),
                omitidas: Math.max(0, c.total - c.items.length),
            })),
        totalDivergencias: divergencias.length,
        inesperadas: inesperadas.slice(0, maxPorClase).map(shortDivergence),
        totalInesperadas: inesperadas.length,
        bloquea,
        exitCode: bloquea ? EXIT.INESPERADA : (faltaEtapa ? EXIT.ETAPA_FALTANTE : EXIT.OK),
    };
}

function computedDivergence(kind, col, a, n, ca, cn, ctx) {
    return divergencia({
        etapa: ETAPA.COMPUTADAS,
        tipo: kind,
        columna: col.letter,
        nombre: col.name,
        clave: displayKey(n),
        celda: { antiguo: `${col.letter}${a.fila}`, nuevo: `${col.letter}${n.fila}` },
        antiguo: cellSummary(ca),
        nuevo: cellSummary(cn),
        ctx: Object.assign({ tipoColumna: col.tipo }, ctx),
    });
}

function cellSummary(c) {
    return { v: c.t === TIPO.NUMERO ? c.v : c.texto, t: c.t, f: c.f, vacia: c.vacia };
}

function displayKey(fila) {
    const p = fila.partes || { ruc: "", dni: "", nombre: "", inicio: "" };
    return `${p.ruc || "-"} / ${p.dni || "-"} / ${p.nombre || "-"} / ${p.inicio || "-"}`;
}

function shortDivergence(d) {
    return {
        etapa: d.etapa, tipo: d.tipo, id: d.id, hoja: d.hoja, columna: d.columna,
        nombre: d.nombre, celda: d.celda, clave: d.clave,
        antiguo: d.antiguo, nuevo: d.nuevo, clase: d.clase, ctx: d.ctx,
    };
}

/** UNEXPECTED first - it is the only thing on the page that blocks - then §4.5's own
 *  order, then the extensions. */
function ordenClases(a, b) {
    const rank = (c) => (c.id === "INESPERADA" ? -1 : (c.extension ? 100 : 0) + Number(String(c.id).replace(/\D/g, "")));
    return rank(a) - rank(b);
}

function describe(r) {
    return {
        archivo: r.archivo,
        nombre: r.nombre,
        bytes: r.bytes,
        hojas: r.hojas,
        filasCuadro: r.cuadro.filas.length,
        ultimaFila: r.cuadro.ultimaFila,
        tabla: r.zip.tabla,
        cache: r.zip.cache,
    };
}

/**
 * Two values that differ only by the normalization Phase 2 task 7 applies -
 * trim, whitespace collapse, CR/LF, and upper-casing on the two uppercased columns.
 * Anything that differs AFTER normalization is a change of data and stays unexpected.
 */
function sameAfterNormalization(nombre, ca, cn) {
    if (ca.vacia || cn.vacia) return false;
    const a = normalizeForColumn(nombre, ca.texto);
    const b = normalizeForColumn(nombre, cn.texto);
    if (!a.applied || !b.applied) return false;
    const av = a.value === null ? "" : String(a.value);
    const bv = b.value === null ? "" : String(b.value);
    return av !== "" && av === bv && ca.texto !== cn.texto;
}

/** Formula text differs only by leading `=`/`+` and whitespace in irrelevant places. */
function normalizeFormula(f) {
    return String(f).replace(/^[=+]+/, "").replace(/\s+/g, "").toUpperCase();
}

/* ------------------------------ stage 4 ---------------------------- */

/**
 * Is the OLD file's pivot cache actually live?
 *
 * `--refreshed` is a human claim. `refreshedDate` is a fact in the bytes. When the fact
 * contradicts the claim - the cache was last refreshed before the period it is supposed
 * to report - the claim loses and stage 4 does not run. That is the whole content of
 * "never silently compare a stale cached value as though it were live": the tool refuses
 * rather than trusting a checkbox.
 */
function judgeRefresh(cache, periodo) {
    if (!cache || !cache.presente) {
        return { ok: false, motivo: "el archivo antiguo no trae xl/pivotCache/pivotCacheDefinition*.xml: no hay cache que juzgar" };
    }
    if (!cache.refreshedYMD) {
        return { ok: false, motivo: "el pivotCacheDefinition no declara refreshedDate: no se puede demostrar que la actualizacion manual ocurrio" };
    }
    const refresco = fmtYMD(cache.refreshedYMD);
    if (!periodo || !periodo.key) {
        return {
            ok: true,
            refresco,
            refreshedBy: cache.refreshedBy,
            nota: "sin periodo conocido (--period o side-car): no se pudo contrastar refreshedDate contra el periodo",
        };
    }
    // The cache must have been refreshed at or after the first day of the reported month;
    // anything earlier is the BUG-14 shape (a September-2024 cache on a 2026 report).
    if (refresco < `${periodo.key}-01`) {
        return {
            ok: false,
            motivo:
                `se paso --refreshed pero el pivotCacheDefinition declara refreshedDate=${refresco} ` +
                `(refreshedBy=${cache.refreshedBy || "?"}), anterior al periodo ${periodo.key}: la cache sigue ` +
                "OBSOLETA (BUG-14) y sus valores NO se comparan.",
            refresco,
        };
    }
    return { ok: true, refresco, refreshedBy: cache.refreshedBy };
}

function comparePivots(antiguo, nuevo, sidecar, divergencias, pivotes, periodo) {
    for (const spec of PIVOT_BLOCKS) {
        const entrada = antiguo.pivotes && antiguo.pivotes[spec.hoja];
        const hoja = entrada && entrada.presente ? entrada.hoja : null;
        const leido = readPivotBlock(hoja, spec);
        const delSidecar = typeof spec.delSidecar === "function" ? spec.delSidecar(sidecar) : undefined;

        if (!leido) {
            pivotes.noComparables.push({
                id: spec.id, hoja: spec.hoja, referencia: spec.referencia,
                motivo: hoja ? "no se encontro el bloque por su etiqueta en el archivo antiguo" : `la hoja "${spec.hoja}" no esta en el archivo antiguo`,
            });
            continue;
        }
        if (delSidecar === undefined) {
            pivotes.noComparables.push({
                id: spec.id, hoja: spec.hoja, referencia: spec.referencia,
                leidoEn: leido.ancla, valoresAntiguos: leido.total ? leido.total.valores : null,
                motivo: spec.motivoSinSidecar || "el side-car de metricas no publica un equivalente de este bloque",
            });
            continue;
        }

        pivotes.bloques.push({
            id: spec.id, hoja: spec.hoja, titulo: spec.titulo,
            referenciaDocumentada: spec.referencia,
            leidoEn: leido.ancla,
            celdaTotal: leido.total && leido.total.celdas ? leido.total.celdas.join("/") : null,
            soloEtiquetas: Boolean(spec.soloEtiquetas),
        });

        // Extra value columns on the old side - the "undefined" third gender column of
        // the OCTUBRE_2025 regression, which pushed the Total from F to G and let the
        // pivot body overwrite the percentage formulas outright (03 §9 criterion 30).
        //
        // The pivot's Total column is excluded from the comparison on both sides: its
        // caption is the data field's ("Total", "Total Bajas", "Total Ingresos") and the
        // side-car has no reason to reproduce that wording. Only the ITEM columns are
        // compared, which is where a third gender would appear.
        if (spec.tipoBloque === "matriz" && leido.cabeceras && delSidecar.cabeceras) {
            const items = (list) => list.filter((h) => !squash(h).startsWith("TOTAL"));
            const itemsN = items(delSidecar.cabeceras);
            for (const h of items(leido.cabeceras)) {
                const conocido = itemsN.some((k) => squash(k) === squash(h));
                if (!conocido) {
                    divergencias.push(divergencia({
                        etapa: ETAPA.PIVOTES, tipo: KIND.FALTANTE, id: spec.id, hoja: spec.hoja,
                        nombre: spec.titulo, celda: { antiguo: leido.ancla },
                        antiguo: h, nuevo: null,
                        ctx: { columnaExtraAntiguo: h, etiqueta: h },
                    }));
                }
            }
        }

        // row labels, both directions
        const etiquetasA = new Map(leido.filas.map((f) => [squash(f.etiqueta), f]));
        const etiquetasN = new Map(delSidecar.filas.map((f) => [squash(f.etiqueta), f]));
        for (const [k, fa] of etiquetasA) {
            if (!etiquetasN.has(k)) {
                divergencias.push(pivotDiff(spec, KIND.FALTANTE, fa.etiqueta, fa.valores, null, fa.celdas));
            }
        }
        for (const [k, fn] of etiquetasN) {
            if (!etiquetasA.has(k)) {
                divergencias.push(pivotDiff(spec, KIND.FALTANTE, fn.etiqueta, null, fn.valores, null));
            }
        }
        if (!spec.soloEtiquetas) {
            for (const [k, fa] of etiquetasA) {
                const fn = etiquetasN.get(k);
                if (!fn || !fa.valores || !fn.valores) continue;
                for (let i = 0; i < Math.min(fa.valores.length, fn.valores.length); i++) {
                    if (pivotEqual(fa.valores[i], fn.valores[i])) continue;
                    divergencias.push(pivotDiff(
                        spec, KIND.VALOR, `${fa.etiqueta} / ${leido.cabeceras[i] || i}`,
                        fa.valores[i], fn.valores[i], fa.celdas ? [fa.celdas[i]] : null
                    ));
                }
            }
            const ta = leido.total;
            const tn = delSidecar.total;
            if (ta && tn && ta.valores && tn.valores) {
                for (let i = 0; i < Math.min(ta.valores.length, tn.valores.length); i++) {
                    if (pivotEqual(ta.valores[i], tn.valores[i])) continue;
                    divergencias.push(pivotDiff(
                        spec, KIND.VALOR, `${ta.etiqueta} / ${leido.cabeceras[i] || i}`,
                        ta.valores[i], tn.valores[i], ta.celdas ? [ta.celdas[i]] : null
                    ));
                }
            }
        }
    }

    // page-filter cells: the period label, and BUG-26's "Borrar"
    const etiquetaEsperada = periodo && periodo.etiqueta ? periodo.etiqueta : null;
    for (const spec of PIVOT_FILTERS) {
        const entradaA = antiguo.pivotes && antiguo.pivotes[spec.hoja];
        const entradaN = nuevo.pivotes && nuevo.pivotes[spec.hoja];
        const hojaA = entradaA && entradaA.presente ? entradaA.hoja : null;
        const hojaN = entradaN && entradaN.presente ? entradaN.hoja : null;
        const posA = hojaA ? findLabel(hojaA, spec.columna, spec.etiqueta) : null;
        const posN = hojaN ? findLabel(hojaN, spec.columna, spec.etiqueta) : null;
        if (!posA || !posN) {
            pivotes.noComparables.push({
                id: spec.id, hoja: spec.hoja, referencia: spec.referencia,
                motivo: `no se encontro la etiqueta de filtro "${spec.etiqueta}" en la columna ${spec.columna}`,
            });
            continue;
        }
        const va = textOf(cellAt(hojaA, posA.r, posA.c + 1));
        const vn = textOf(cellAt(hojaN, posN.r, posN.c + 1));
        pivotes.bloques.push({
            id: spec.id, hoja: spec.hoja, titulo: `filtro de pagina ${spec.etiqueta}`,
            referenciaDocumentada: spec.referencia,
            leidoEn: XLSX.utils.encode_cell({ r: posA.r, c: posA.c + 1 }),
            antiguo: va, nuevo: vn,
        });
        if (va !== vn) {
            divergencias.push(divergencia({
                etapa: ETAPA.PIVOTES, tipo: KIND.VALOR, id: spec.id, hoja: spec.hoja,
                nombre: `filtro ${spec.etiqueta}`,
                celda: { antiguo: XLSX.utils.encode_cell({ r: posA.r, c: posA.c + 1 }) },
                antiguo: va, nuevo: vn,
                ctx: { etiqueta: spec.etiqueta, esperaPeriodo: spec.esperaPeriodo, etiquetaPeriodo: etiquetaEsperada },
            }));
        }
    }
}

function pivotDiff(spec, tipo, etiqueta, antiguo, nuevo, celdas) {
    return divergencia({
        etapa: ETAPA.PIVOTES, tipo, id: spec.id, hoja: spec.hoja,
        nombre: `${spec.titulo}: ${etiqueta}`,
        celda: celdas ? { antiguo: celdas.filter(Boolean).join("/") } : null,
        antiguo, nuevo,
        ctx: { etiqueta, referencia: spec.referencia },
    });
}

/* ------------------------------ stage 5 ---------------------------- */

/**
 * The per-side counts, and the two reconciliations that are worth blocking on.
 *
 * The old pipeline never counted anything - it has no run report, no side-car and no
 * itemised rejections - so `leidas`, `rechazadas` and `colapsadas` are reported as NO
 * DISPONIBLE on its side rather than as 0. A zero there would read as "a clean run".
 *
 * Two things here ARE divergences, and both are defects rather than expected movement:
 *
 *   - the new side-car's `filas.escritas` not matching the rows actually in the new
 *     workbook: the side-car is what stage 4 compares against and what AC 26 diffs, so
 *     the two disagreeing means one of them is lying;
 *   - the diff's own conservation identity failing:
 *     `escritasAntiguo - soloAntiguo + soloNuevo == escritasNuevo`. If that does not
 *     close, the multiset matching in stage 1 is wrong and nothing below it can be
 *     trusted. Reported as UNEXPECTED on purpose.
 */
function compareCounts(antiguo, nuevo, emparejado, sidecar, sidecarAntiguo, divergencias) {
    const filasA = antiguo.cuadro.filas.length;
    const filasN = nuevo.cuadro.filas.length;
    const noFantasmaA = antiguo.cuadro.filas.filter((f) => !f.fantasma).length;
    const noFantasmaN = nuevo.cuadro.filas.filter((f) => !f.fantasma).length;

    const scA = sidecarAntiguo && sidecarAntiguo.proceso ? sidecarAntiguo.proceso.filas : null;
    const scN = sidecar && sidecar.proceso ? sidecar.proceso.filas : null;

    const conteos = {
        antiguo: {
            fuente: scA ? "side-car" : "el libro (el pipeline antiguo no publica conteos)",
            leidas: scA ? scA.leidas : null,
            rechazadas: scA ? scA.rechazadas : null,
            colapsadas: scA ? scA.colapsadas : null,
            escritas: scA ? scA.escritas : noFantasmaA,
            filasEnCuadro: filasA,
            filasFantasma: filasA - noFantasmaA,
            refTabla: antiguo.zip.tabla.ref,
        },
        nuevo: {
            fuente: scN ? "side-car" : "el libro (sin --sidecar)",
            leidas: scN ? scN.leidas : null,
            rechazadas: scN ? scN.rechazadas : null,
            colapsadas: scN ? scN.colapsadas : null,
            escritas: scN ? scN.escritas : noFantasmaN,
            filasEnCuadro: filasN,
            filasFantasma: filasN - noFantasmaN,
            refTabla: nuevo.zip.tabla.ref,
        },
        conservacionSidecar: sidecar && sidecar.proceso ? sidecar.proceso.conservacion : null,
        reconciliacion: null,
    };

    if (scN && Number.isFinite(Number(scN.escritas)) && Number(scN.escritas) !== noFantasmaN) {
        divergencias.push(divergencia({
            etapa: ETAPA.CONTEOS, tipo: KIND.CONTEO, id: "sidecar.escritas", hoja: CUADRO,
            nombre: "el side-car y el libro nuevo no coinciden en filas escritas",
            antiguo: Number(scN.escritas), nuevo: noFantasmaN,
            ctx: { fuente: "side-car proceso.filas.escritas vs filas no fantasma en Cuadro" },
        }));
    }

    if (sidecar && sidecar.proceso && sidecar.proceso.conservacion
        && sidecar.proceso.conservacion.verificable === true
        && sidecar.proceso.conservacion.ok === false) {
        divergencias.push(divergencia({
            etapa: ETAPA.CONTEOS, tipo: KIND.CONTEO, id: "sidecar.conservacion", hoja: CUADRO,
            nombre: "la conservacion de filas del run NUEVO no cierra (AC 7)",
            antiguo: sidecar.proceso.conservacion.esperadas,
            nuevo: sidecar.proceso.conservacion.escritas,
            ctx: { motivo: sidecar.proceso.conservacion.motivo },
        }));
    }

    const esperado = filasA - emparejado.soloAntiguo.length + emparejado.soloNuevo.length;
    conteos.reconciliacion = {
        formula: "filasAntiguo - soloAntiguo + soloNuevo == filasNuevo",
        esperado,
        real: filasN,
        ok: esperado === filasN,
    };
    if (esperado !== filasN) {
        divergencias.push(divergencia({
            etapa: ETAPA.CONTEOS, tipo: KIND.CONTEO, id: "diff.reconciliacion", hoja: CUADRO,
            nombre: "la aritmetica del propio diff no cierra: el emparejamiento por multiset es incorrecto",
            antiguo: esperado, nuevo: filasN,
            ctx: { formula: conteos.reconciliacion.formula },
        }));
    }

    return conteos;
}

/* ------------------------------ inputs ----------------------------- */

function loadSidecar(value, flag) {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value === "object") return value;
    let text;
    try {
        text = fs.readFileSync(value, "utf8");
    } catch (err) {
        throw new DiffError(`${flag}: no se pudo leer ${value} (${err.message})`);
    }
    try {
        return JSON.parse(text);
    } catch (err) {
        throw new DiffError(`${flag}: ${value} no es JSON valido (${err.message})`);
    }
}

/** `"2026-02"` -> `{key, etiqueta}`; the side-car wins when both are present, because it
 *  is the artefact the new run actually published. */
function resolvePeriodLabel(period, sidecar) {
    if (sidecar && sidecar.periodo && sidecar.periodo.key) {
        return {
            key: sidecar.periodo.key,
            etiqueta: sidecar.periodo.etiqueta || null,
            fuente: "side-car",
        };
    }
    if (typeof period === "string" && /^\d{4}-\d{2}$/.test(period)) {
        const [y, m] = period.split("-");
        return { key: period, etiqueta: `${Number(m)}-${y}`, fuente: "--period" };
    }
    return { key: null, etiqueta: null, fuente: null };
}

/* ================================================================== *
 * 9. The report
 * ================================================================== */

function formatReport(r, opciones = {}) {
    const ejemplos = Number.isInteger(opciones.ejemplos) ? opciones.ejemplos : 5;
    const L = [];
    const line = (s = "") => L.push(s);
    const rule = (ch = "=") => line(ch.repeat(78));

    rule();
    line("DIFF DE REPORTES - la corrida paralela (05-implementation-plan.md §4.3-§4.5)");
    rule();
    line(`antiguo : ${r.antiguo.nombre}  (${r.antiguo.filasCuadro} filas en Cuadro, Tabla2 ref ${r.antiguo.tabla.ref || "?"})`);
    line(`nuevo   : ${r.nuevo.nombre}  (${r.nuevo.filasCuadro} filas en Cuadro, Tabla2 ref ${r.nuevo.tabla.ref || "?"})`);
    line(`periodo : ${r.periodo.key || "desconocido"}${r.periodo.etiqueta ? ` (${r.periodo.etiqueta})` : ""}${r.periodo.fuente ? ` [${r.periodo.fuente}]` : ""}`);
    line(`side-car: ${r.sidecar.presente ? "si" : "NO - las etapas 4 y 5 quedan parciales"}`);
    line();

    /* ---- the headline: recovered rows ---- */
    rule("-");
    line("1. FILAS RECUPERADAS - subcontratistas que el pipeline antiguo descartaba en silencio");
    rule("-");
    if (r.etapas.filas.recuperadas === 0) {
        line("  ninguna. (Eso NO significa que el pipeline antiguo no descarte nada: significa");
        line("  que ninguna fila solo-en-nuevo pertenece a una empresa ausente del libro antiguo.)");
    } else {
        line(`  ${r.etapas.filas.recuperadas} filas, de ${r.recuperadasPorEmpresa.length} empresa(s) que NO aparecen`);
        line("  en ninguna fila del libro antiguo.");
        line("  Esto es lo mas valioso que este diff puede mostrar (05 §4.4 item 1).");
        line();
        line("     filas  subcontratista");
        for (const e of r.recuperadasPorEmpresa.slice(0, 25)) {
            line(`    ${String(e.filas).padStart(6)}  ${e.empresa || "?"} [${e.ruc || "sin RUC"}]`);
        }
        if (r.recuperadasPorEmpresa.length > 25) {
            line(`    ... y ${r.recuperadasPorEmpresa.length - 25} empresa(s) mas (usa --json para la lista completa)`);
        }
    }
    line();

    /* ---- stage summaries ---- */
    rule("-");
    line("2. ETAPAS (05 §4.4)");
    rule("-");
    const f = r.etapas.filas;
    line(`  1 filas       : ${f.emparejadas} emparejadas | ${f.soloAntiguo} solo-antiguo | ${f.soloNuevo} solo-nuevo`);
    line(`                  fantasma: ${f.fantasmaAntiguo} antiguo / ${f.fantasmaNuevo} nuevo`);
    line(`  2 celdas A:R  : ${r.etapas.celdas.comparadas} comparadas, ${r.etapas.celdas.divergentes} divergentes (valor Y tipo, nunca confundidos)`);
    line(`  3 comput. S:AI: ${r.etapas.computadas.comparadas} comparadas, ${r.etapas.computadas.divergentes} divergentes`);
    line(`                  ${r.etapas.computadas.sinValorCacheado} celdas sin valor cacheado en NINGUN lado -> no comparables`);
    const p = r.etapas.pivotes;
    if (p.ejecutado) {
        line(`  4 pivotes     : EJECUTADO. El libro antiguo fue actualizado manualmente en Excel`);
        line(`                  (refreshedDate=${p.veredictoCache ? p.veredictoCache.refresco : "?"}, refreshedBy=${p.veredictoCache ? (p.veredictoCache.refreshedBy || "?") : "?"});`);
        line(`                  el lado nuevo sale del side-car de metricas, sin sesion de Excel.`);
        line(`                  ${p.bloques.length} bloques comparados, ${p.noComparables.length} no comparables.`);
    } else {
        line("  4 pivotes     : *** NO EJECUTADO ***");
        for (const l of wrap(p.motivo || "sin motivo registrado", 74)) line(`                  ${l}`);
    }
    const c = r.etapas.conteos;
    line(`  5 conteos     : antiguo escritas=${fmt(c.antiguo.escritas)} leidas=${fmt(c.antiguo.leidas)} rechazadas=${fmt(c.antiguo.rechazadas)} colapsadas=${fmt(c.antiguo.colapsadas)}`);
    line(`                  nuevo   escritas=${fmt(c.nuevo.escritas)} leidas=${fmt(c.nuevo.leidas)} rechazadas=${fmt(c.nuevo.rechazadas)} colapsadas=${fmt(c.nuevo.colapsadas)}`);
    line(`                  fuente antiguo: ${c.antiguo.fuente}`);
    line(`                  reconciliacion del diff (${c.reconciliacion.formula}): ${c.reconciliacion.ok ? "OK" : `FALLA (esperado ${c.reconciliacion.esperado}, real ${c.reconciliacion.real})`}`);
    line();

    if (p.noComparables.length) {
        rule("-");
        line("   BLOQUES DE PIVOTE NO COMPARABLES (declarados, nunca inventados)");
        rule("-");
        for (const nc of p.noComparables) {
            line(`   ${nc.id} (${nc.hoja} ${nc.referencia})`);
            for (const l of wrap(nc.motivo, 70)) line(`      ${l}`);
            if (nc.valoresAntiguos) line(`      valor(es) en el libro antiguo: ${nc.valoresAntiguos.join(" / ")}`);
        }
        line();
    }

    /* ---- classes ---- */
    rule("-");
    line("3. DIVERGENCIAS POR CLASE");
    rule("-");
    if (r.clases.length === 0) {
        line("  ninguna divergencia.");
    }
    for (const clase of r.clases) {
        const marca = clase.id === "INESPERADA" ? "!!!" : (clase.extension ? " * " : "   ");
        line(`${marca} [${clase.id}] ${clase.titulo}`);
        line(`      ${clase.total} divergencia(s)  ${Object.entries(clase.porEtapa).map(([k, v]) => `${k}:${v}`).join(" ")}`);
        if (clase.fuente) line(`      fuente: ${clase.fuente}${clase.extension ? "  (EXTENSION de la lista de §4.5)" : ""}`);
        for (const d of clase.ejemplos.slice(0, ejemplos)) line(`        - ${describeDivergence(d)}`);
        if (clase.total > clase.ejemplos.length) {
            line(`        ... y ${clase.total - clase.ejemplos.length} mas`);
        }
        line();
    }

    /* ---- the gate ---- */
    rule();
    if (r.totalInesperadas > 0) {
        line(`RESULTADO: ${r.totalInesperadas} DIVERGENCIA(S) INESPERADA(S) - EL CUTOVER QUEDA BLOQUEADO.`);
        line("05 §4.5: \"Anything not on this list blocks cutover - not 'is investigated', blocks.\"");
        line("La respuesta correcta es encontrar la causa y añadir un fixture que la hubiera");
        line("cazado offline (05 §7 step 4), NO ampliar la lista despues de haber leido el diff.");
    } else if (!r.etapas.pivotes.ejecutado) {
        line("RESULTADO: sin divergencias inesperadas en las etapas que corrieron.");
        line("ATENCION: la etapa 4 (totales de pivote) NO se ejecuto - el mes paralelo no esta");
        line("completo hasta que alguien abra el libro ANTIGUO en Excel, lo actualice y vuelva a");
        line("correr esto con --refreshed.");
    } else {
        line("RESULTADO: todas las divergencias estan en la lista esperada. Las 5 etapas corrieron.");
    }
    line(`total de divergencias: ${r.totalDivergencias}  |  inesperadas: ${r.totalInesperadas}  |  exit ${r.exitCode}`);
    rule();

    return L.join("\n") + "\n";
}

function describeDivergence(d) {
    const donde = d.celda
        ? [d.celda.antiguo ? `ant ${d.hoja}!${d.celda.antiguo}` : null, d.celda.nuevo ? `nue ${d.hoja}!${d.celda.nuevo}` : null].filter(Boolean).join(" / ")
        : d.hoja;
    const col = d.columna ? `${d.columna} ${d.nombre || ""}`.trim() : (d.nombre || d.id || "");
    const val = (side) => {
        const v = d[side];
        if (v === null || v === undefined) return "-";
        if (typeof v === "object") {
            if ("t" in v) return `${JSON.stringify(v.v)}${v.f ? ` <f>${truncate(v.f, 28)}` : ""} [${v.t}]`;
            if ("fila" in v) return `fila ${v.fila} ${v.empresa || v.ruc || ""}`.trim();
            return JSON.stringify(v);
        }
        return JSON.stringify(v);
    };
    return [
        `${d.etapa}/${d.tipo}`,
        col || null,
        `@ ${donde}`,
        d.clave ? `[${truncate(d.clave, 46)}]` : null,
    ].filter(Boolean).join(" ") + `: ${val("antiguo")} -> ${val("nuevo")}`;
}

function truncate(s, n) {
    const t = String(s);
    return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function fmt(v) {
    return v === null || v === undefined ? "NO DISPONIBLE" : String(v);
}

function wrap(text, width) {
    const words = String(text).split(/\s+/);
    const out = [];
    let cur = "";
    for (const w of words) {
        if (cur === "") cur = w;
        else if (cur.length + 1 + w.length <= width) cur += ` ${w}`;
        else { out.push(cur); cur = w; }
    }
    if (cur !== "") out.push(cur);
    return out;
}

/* ================================================================== *
 * 10. Self-test (05 Phase 0 task 5)
 * ================================================================== *
 *
 * "Self-test it: diffing a file against a copy of itself must report zero differences,
 * and diffing two different months must report a large one."
 *
 * WHAT THIS IS NOT. This exercises THE SCRIPT. It is NOT a correctness gate on the
 * pipeline, and NEITHER FILE IS A BASELINE - there is no baseline and there never will
 * be one (05 §4.6). A file compared against a copy of itself proves that the multiset
 * keying, the cell comparison and the classifier are stable under identity; two
 * genuinely different workbooks prove the tool is not silently reporting "no changes"
 * because it read nothing. Both are properties of this file, not of the report.
 */
async function selfTest(fileA, fileB, opciones = {}) {
    // A LITERAL copy, not the same path twice: the copy goes through the whole read path
    // a second time from different bytes on disk, which is what "a file against a copy of
    // itself" means.
    const copia = path.join(
        await fs.promises.mkdtemp(path.join(require("node:os").tmpdir(), "diff-autoprueba-")),
        path.basename(fileA)
    );
    await fs.promises.copyFile(fileA, copia);
    let identidad;
    try {
        identidad = await diffReports(fileA, copia, Object.assign({}, opciones, { refreshed: false, requirePivots: false }));
    } finally {
        await fs.promises.rm(path.dirname(copia), { recursive: true, force: true });
    }
    const distinto = fileB ? await diffReports(fileA, fileB, Object.assign({}, opciones, { refreshed: false, requirePivots: false })) : null;

    const okIdentidad = identidad.totalDivergencias === 0;
    const okDistinto = distinto === null ? null : distinto.totalDivergencias > 0;

    return {
        tipo: "autoprueba",
        identidad: {
            archivo: fileA,
            divergencias: identidad.totalDivergencias,
            ok: okIdentidad,
            esperado: "0 divergencias contra una copia de si mismo",
        },
        distinto: distinto === null ? null : {
            archivos: [fileA, fileB],
            divergencias: distinto.totalDivergencias,
            ok: okDistinto,
            esperado: "> 0 divergencias entre dos libros genuinamente distintos",
        },
        ok: okIdentidad && (okDistinto === null || okDistinto === true),
        nota:
            "Esto ejercita el SCRIPT. No es una prueba de correccion del pipeline y ninguno " +
            "de los dos archivos es una linea base (05 §4.6).",
    };
}

/* ================================================================== *
 * 11. CLI
 * ================================================================== */

function parseArgv(argv) {
    const out = {
        antiguo: null, nuevo: null, json: null, sidecar: null, sidecarAntiguo: null,
        period: null, refreshed: false, requirePivots: false, ejemplos: 5,
        selfTest: false, quiet: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--json") out.json = argv[++i];
        else if (a === "--sidecar") out.sidecar = argv[++i];
        else if (a === "--sidecar-antiguo" || a === "--sidecar-old") out.sidecarAntiguo = argv[++i];
        else if (a === "--period" || a === "--periodo") out.period = argv[++i];
        else if (a === "--refreshed" || a === "--actualizado") out.refreshed = true;
        else if (a === "--require-pivots") out.requirePivots = true;
        else if (a === "--examples" || a === "--ejemplos") out.ejemplos = Number(argv[++i]);
        else if (a === "--self-test" || a === "--autoprueba") out.selfTest = true;
        else if (a === "--quiet") out.quiet = true;
        else if (a === "-h" || a === "--help") out.help = true;
        else if (a.startsWith("--")) throw new DiffError(`opcion desconocida ${a}`);
        else if (!out.antiguo) out.antiguo = a;
        else if (!out.nuevo) out.nuevo = a;
        else throw new DiffError(`argumento inesperado ${a}`);
    }
    return out;
}

const USAGE = `
uso: node tools/diff-reports.js <antiguo.xlsx> <nuevo.xlsx> [opciones]

  --json <archivo>            escribe el resultado clasificado completo como JSON
  --sidecar <archivo>         side-car de metricas del pipeline NUEVO (lado nuevo de la etapa 4)
  --sidecar-antiguo <archivo> side-car del lado antiguo, si alguna vez existe
  --period YYYY-MM            periodo del reporte, si ningun side-car lo trae
  --refreshed                 el libro ANTIGUO fue actualizado a mano en Excel (BUG-14).
                              Sin esto la etapa 4 NO corre.
  --require-pivots            una etapa 4 que no corrio es fallo (exit 3)
  --examples N                ejemplos por clase (por defecto 5)
  --self-test                 autoprueba de Phase 0 task 5 sobre los dos archivos
  --quiet                     solo el resumen

salidas: 0 limpio | 1 divergencia INESPERADA (bloquea el cutover) | 2 error de uso/IO |
         3 una etapa requerida no corrio
`.trim();

async function main(argv) {
    let opts;
    try {
        opts = parseArgv(argv);
    } catch (err) {
        process.stderr.write(`${err.message}\n\n${USAGE}\n`);
        return EXIT.USO;
    }
    if (opts.help || !opts.antiguo || (!opts.nuevo && !opts.selfTest)) {
        process.stdout.write(`${USAGE}\n`);
        return opts.help ? EXIT.OK : EXIT.USO;
    }

    try {
        if (opts.selfTest) {
            const res = await selfTest(opts.antiguo, opts.nuevo, { ejemplos: opts.ejemplos });
            process.stdout.write(formatSelfTest(res));
            if (opts.json) await fs.promises.writeFile(opts.json, `${JSON.stringify(res, null, 2)}\n`);
            return res.ok ? EXIT.OK : EXIT.INESPERADA;
        }

        const res = await diffReports(opts.antiguo, opts.nuevo, {
            sidecar: opts.sidecar,
            sidecarAntiguo: opts.sidecarAntiguo,
            period: opts.period,
            refreshed: opts.refreshed,
            requirePivots: opts.requirePivots,
            ejemplos: opts.ejemplos,
        });
        if (opts.json) await fs.promises.writeFile(opts.json, `${JSON.stringify(res, null, 2)}\n`);
        process.stdout.write(opts.quiet ? summaryLine(res) : formatReport(res, { ejemplos: opts.ejemplos }));
        return res.exitCode;
    } catch (err) {
        if (err instanceof DiffError) {
            process.stderr.write(`diff-reports: ${err.message}\n`);
            return EXIT.USO;
        }
        process.stderr.write(`diff-reports: fallo inesperado: ${err && err.stack ? err.stack : err}\n`);
        return EXIT.USO;
    }
}

function summaryLine(r) {
    return `divergencias=${r.totalDivergencias} inesperadas=${r.totalInesperadas} ` +
        `recuperadas=${r.etapas.filas.recuperadas} pivotes=${r.etapas.pivotes.ejecutado ? "ejecutado" : "NO EJECUTADO"} ` +
        `exit=${r.exitCode}\n`;
}

function formatSelfTest(res) {
    const L = [];
    L.push("AUTOPRUEBA de tools/diff-reports.js (05 Phase 0 task 5)");
    L.push(res.nota);
    L.push("");
    L.push(`  identidad : ${res.identidad.archivo}`);
    L.push(`              ${res.identidad.divergencias} divergencias, esperado ${res.identidad.esperado} -> ${res.identidad.ok ? "OK" : "FALLA"}`);
    if (res.distinto) {
        L.push(`  distinto  : ${res.distinto.archivos.join(" vs ")}`);
        L.push(`              ${res.distinto.divergencias} divergencias, esperado ${res.distinto.esperado} -> ${res.distinto.ok ? "OK" : "FALLA"}`);
    }
    L.push("");
    L.push(res.ok ? "AUTOPRUEBA OK" : "AUTOPRUEBA FALLA");
    return `${L.join("\n")}\n`;
}

/* ================================================================== */

module.exports = {
    // the API run.js's shadow mode calls (05 Phase 5 task 8)
    diffReports,
    formatReport,
    selfTest,
    classify,
    main,

    // the reviewable data
    EXPECTED_DIVERGENCES,
    PIVOT_BLOCKS,
    PIVOT_FILTERS,
    COMPUTED_COLUMNS_AI,
    KEY_COLUMNS,
    ETAPA,
    KIND,
    EXIT,
    TIPO,
    VERSION,
    DiffError,

    // exported for the tests and for anyone auditing one step in isolation
    readReport,
    readCuadro,
    rowKey,
    dateKey,
    keyRows,
    matchRows,
    compareCells,
    equalNumbers,
    pivotEqual,
    isSentinelText,
    looksLikeTextDate,
    sameScalar,
    normalizeFormula,
    sameAfterNormalization,
    judgeRefresh,
    findLabel,
    readMatrixBlock,
    readTotalRow,
    readDetailCount,
    colLetter,
    colIndex,
};

if (require.main === module) {
    main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

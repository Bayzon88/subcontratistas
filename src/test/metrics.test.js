"use strict";
/**
 * Tests for `src/output/metrics.js` - the metrics side-car (03 §7.4, 05 Phase 3 task 6).
 *
 * THE FIXTURE IS THE POINT. `WORKERS` below is eight hand-built records whose every
 * aggregate was computed on paper before a line of this file ran, and `EXPECTED` states
 * them. Nothing here is snapshot-asserted against the module's own output, because a
 * snapshot of a wrong number is a wrong number with a test around it.
 *
 * The four things the brief names, and where they live:
 *   - the 0.5 + 0.5 weighting              -> "Trabajadores Unicos ..." block
 *   - zone and EPC defaults                -> "defaults" block
 *   - the name-vs-DNI headcount gap        -> "headcount" block
 *   - determinism under two mocked clocks  -> "determinismo" block
 */

const test = require("node:test");
const { mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const metrics = require("../output/metrics.js");
const {
    computeMetrics,
    serialize,
    metricsFilename,
    METRIC_NAMES,
    VERSION,
    ESTADO_ACTIVO,
    trabajadoresUnicos,
    trabajadoresUnicosZona,
    periodFlag,
    inZone,
} = metrics;

const config = require("../config.js");
const { parsePeriod, toExcelSerial } = require("../pipeline/period.js");
const { LookupTable, readLookups, ZONA_DEFAULT, EPC_DEFAULT } = require("../pipeline/lookups.js");
const { IssueList, SEVERITY, CODE } = require("../pipeline/issues.js");
const { CANONICAL } = require("../pipeline/columns.js");
const { LITERALS } = require("../output/computed.js");
const { dedupe } = require("../pipeline/dedupe.js");

/* ------------------------------------------------------------------ *
 * Fixture
 * ------------------------------------------------------------------ */

const FEB = parsePeriod("2026-02");   // 2026-02-01..2026-02-28, serials 46054..46081

/** Hand-built stand-ins for `Hoja1!A2:B61` and `Hoja1!L5:M9`. Small on purpose: the
 *  default paths ("No" / "CJV") are what the delivered numbers hinge on, and a three-row
 *  table makes "unmatched" unambiguous. The real geometry is exercised separately, in
 *  "las tablas reales de la plantilla". */
function makeLookups() {
    return {
        zonaByDistrito: new LookupTable("zona", [
            { fila: 2, clave: "ATE", valor: "ATE" },
            { fila: 3, clave: "CALLAO", valor: "CALLAO" },
            { fila: 4, clave: "SANTA ANITA", valor: "SANTA ANITA" },
        ], ZONA_DEFAULT),
        epcByContratista: new LookupTable("epc", [
            { fila: 6, clave: "EPC UNO", valor: "EPC" },
        ], EPC_DEFAULT),
    };
}

const RUC_OK = "20100047218";   // passes the SUNAT mod-11 check digit

function worker(o) {
    const { subcontratista, archivo, fila, ...fields } = o;
    return {
        "RUC": RUC_OK,
        "EMPRESA": "EMPRESA X",
        "CONTRATISTA PRNCIPAL": "CJV UNO",
        "Nro. DNI / CE": "10000000",
        "APELLIDOS Y NOMBRES": "SIN NOMBRE",
        "FECHA NACIMIENTO": toExcelSerial(1986, 1, 15),
        "TIPO TRABAJADOR": 1,
        "TITULO DE PUESTO/CARGO": "OPERARIO",
        "NOMBRE DE OBRA DONDE ESTA ASIGNADO DURANTE EL MES REPORTADO": "OBRA",
        "DOMICILIO DE TRABAJADOR": "CALLE 1",
        "DISTRITO SEGÚN DNI": "ATE",
        "GENERO": "masculino",
        "FECHA CESE/BAJA": null,
        "NACIONALIDAD": "PERUANA",
        "FECHA INICIO DE LABORES EN OBRA": null,
        "ESTADO": 1,
        "TIPO DE CONTRATO LABORAL": 1,
        "HPT": 0,
        ...fields,
        provenance: {
            subcontratista: subcontratista ?? "S1",
            archivo: archivo ?? "a.xlsx",
            hoja: "Cuadro",
            filaOrigen: fila ?? 2,
        },
    };
}

/**
 * Eight rows, six people. Laid out so that every quirk the module reproduces fires at
 * least once and none of them fires twice by accident:
 *
 *  W1/W2  one worker under TWO subcontratistas, both in-zone -> 0.5 + 0.5, and the two
 *         halves land on OPPOSITE sides of the CJV/EPC split, so the split is fractional.
 *  W3     unknown district -> the "No" default; joined inside the period -> the only Alta.
 *  W4     ceased inside the period -> the only Baja; ESTADO 2, so out of the active split.
 *  W5     ceased BEFORE the period -> BajasAntiguas "Si", excluded from every headcount.
 *  W6     no birth date -> "Sin Fecha"; unrecognised GENERO -> sinGenero; no HPT, no DNI.
 *  W7/W8  one worker, one subcontratista, ONE row in-zone and one out -> the AD
 *         double-count quirk, and two different DNIs under one name -> the Q3 gap.
 */
const WORKERS = Object.freeze([
    worker({ // W1
        subcontratista: "S1", archivo: "a.xlsx", fila: 2,
        "APELLIDOS Y NOMBRES": "PEREZ JUAN", "Nro. DNI / CE": "10000001",
        "DISTRITO SEGÚN DNI": "ATE", "GENERO": "masculino",
        "CONTRATISTA PRNCIPAL": "CJV UNO", "ESTADO": 1, "HPT": 100,
        "FECHA NACIMIENTO": toExcelSerial(1986, 1, 15),
    }),
    worker({ // W2 - same person, second subcontratista, EPC side
        subcontratista: "S2", archivo: "b.xlsx", fila: 2,
        "APELLIDOS Y NOMBRES": "PEREZ JUAN", "Nro. DNI / CE": "10000001",
        "DISTRITO SEGÚN DNI": "ATE", "GENERO": "masculino",
        "CONTRATISTA PRNCIPAL": "EPC UNO", "ESTADO": 1, "HPT": 60,
        "FECHA NACIMIENTO": toExcelSerial(1986, 1, 15),
    }),
    worker({ // W3 - unknown district, Alta of the period
        subcontratista: "S1", archivo: "a.xlsx", fila: 3,
        "APELLIDOS Y NOMBRES": "GOMEZ ANA", "Nro. DNI / CE": "10000002",
        "DISTRITO SEGÚN DNI": "MIRAFLORES", "GENERO": "femenino",
        "CONTRATISTA PRNCIPAL": "CJV UNO", "ESTADO": 1, "HPT": 40,
        "FECHA NACIMIENTO": toExcelSerial(1996, 1, 15),
        "FECHA INICIO DE LABORES EN OBRA": 46056,
    }),
    worker({ // W4 - Baja of the period, ESTADO 2
        subcontratista: "S3", archivo: "c.xlsx", fila: 2,
        "APELLIDOS Y NOMBRES": "LOPEZ MARIA", "Nro. DNI / CE": "10000003",
        "DISTRITO SEGÚN DNI": "CALLAO", "GENERO": "femenino",
        "CONTRATISTA PRNCIPAL": "CJV DOS", "ESTADO": 2, "HPT": 20,
        "FECHA NACIMIENTO": toExcelSerial(2000, 1, 15),
        "FECHA CESE/BAJA": 46060,
    }),
    worker({ // W5 - stale carry-over: ceased in an earlier period
        subcontratista: "S3", archivo: "c.xlsx", fila: 3,
        "APELLIDOS Y NOMBRES": "RUIZ CARLOS", "Nro. DNI / CE": "10000004",
        "DISTRITO SEGÚN DNI": "SANTA ANITA", "GENERO": "masculino",
        "CONTRATISTA PRNCIPAL": "CJV DOS", "ESTADO": 1, "HPT": 0,
        "FECHA NACIMIENTO": toExcelSerial(1975, 1, 15),
        "FECHA CESE/BAJA": 46000,
    }),
    worker({ // W6 - no birth date, no gender, no HPT, no DNI
        subcontratista: "S1", archivo: "a.xlsx", fila: 4,
        "APELLIDOS Y NOMBRES": "TORRES LUZ", "Nro. DNI / CE": null,
        "DISTRITO SEGÚN DNI": "ATE", "GENERO": null,
        "CONTRATISTA PRNCIPAL": "EPC UNO", "ESTADO": 1, "HPT": null,
        "FECHA NACIMIENTO": null,
    }),
    worker({ // W7 - in-zone half of the double-count pair
        subcontratista: "S4", archivo: "d.xlsx", fila: 2,
        "APELLIDOS Y NOMBRES": "VEGA SOFIA", "Nro. DNI / CE": "20000001",
        "DISTRITO SEGÚN DNI": "CALLAO", "GENERO": "femenino",
        "CONTRATISTA PRNCIPAL": "CJV UNO", "ESTADO": 1, "HPT": 10,
        "FECHA NACIMIENTO": toExcelSerial(2005, 1, 15),
    }),
    worker({ // W8 - out-of-zone half, and a SECOND DNI under the same name
        subcontratista: "S4", archivo: "d.xlsx", fila: 3,
        "APELLIDOS Y NOMBRES": "VEGA SOFIA", "Nro. DNI / CE": "20000002",
        "DISTRITO SEGÚN DNI": "PUENTE PIEDRA", "GENERO": "femenino",
        "CONTRATISTA PRNCIPAL": "CJV UNO", "ESTADO": 1, "HPT": 5,
        "FECHA NACIMIENTO": toExcelSerial(2005, 1, 15),
    }),
]);

function run(records = WORKERS, options = {}) {
    return computeMetrics(records, { period: FEB, lookups: makeLookups(), ...options });
}

/* ------------------------------------------------------------------ *
 * Contract
 * ------------------------------------------------------------------ */

test("las ocho metricas de 03 §7.4 estan presentes y en orden", () => {
    const m = run().metricas;
    assert.deepEqual(Object.keys(m), [...METRIC_NAMES]);
    assert.equal(METRIC_NAMES.length, 8);
});

test("la estructura declara version, periodo y ningun reloj", () => {
    const out = run();
    assert.equal(out.version, VERSION);
    assert.equal(out.tipo, "metricas");
    assert.equal(out.periodo.etiqueta, "2-2026");
    assert.equal(out.periodo.key, "2026-02");
    assert.equal(out.periodo.inicioSerial, 46054);
    assert.equal(out.periodo.finSerial, 46081);
    assert.equal(out.periodo.archivo, "Reporte_Subcontratistas_FEBRERO_2026.xlsx");
    // AC 26: no timestamp anywhere, at any depth.
    const flat = JSON.stringify(out);
    for (const forbidden of ["generatedAt", "generadoEn", "timestamp", "fechaGeneracion"]) {
        assert.equal(flat.includes(forbidden), false, `el side-car no debe llevar ${forbidden}`);
    }
});

test("metricsFilename comparte el sello del libro (03 §7.5)", () => {
    assert.equal(metricsFilename("2026-02"), "Reporte_Subcontratistas_FEBRERO_2026.json");
    assert.equal(metricsFilename(FEB), "Reporte_Subcontratistas_FEBRERO_2026.json");
    assert.equal(metricsFilename(parsePeriod("2025-12")), "Reporte_Subcontratistas_DICIEMBRE_2025.json");
});

/* ------------------------------------------------------------------ *
 * 1 - unique headcount, and the name-vs-DNI gap (05 §8 Q3)
 * ------------------------------------------------------------------ */

test("headcount: los dos conteos se publican lado a lado y la brecha es visible", () => {
    const h = run().metricas.headcount;

    // Six people by name: PEREZ JUAN, GOMEZ ANA, LOPEZ MARIA, RUIZ CARLOS, TORRES LUZ,
    // VEGA SOFIA - W1/W2 are one person and W7/W8 are one person.
    assert.equal(h.porNombre.distintos, 6);
    assert.equal(h.porNombre.filas, 8);
    assert.equal(h.porNombre.clavesDuplicadas, 2);
    assert.equal(h.porNombre.filasDuplicadas, 2);

    // Seven by DNI: VEGA SOFIA's two rows carry DIFFERENT documents and therefore split,
    // while TORRES LUZ has none and falls back to her name key.
    assert.equal(h.porDni.distintos, 7);
    assert.equal(h.porDni.clavesPorRespaldo, 1);

    // The number the client sees, and the size of the gap the owner is deciding on.
    assert.equal(h.clave, "name");
    assert.equal(h.entregado, 6);
    assert.equal(h.brecha, -1);
});

test("headcount: Σ Trabajadores Unicos == el conteo por nombre, por construccion", () => {
    const h = run().metricas.headcount;
    // 0.5+0.5 (PEREZ) + 1 + 1 + 1 + 1 + 0.5+0.5 (VEGA) = 6
    assert.equal(h.sumaTrabajadoresUnicos, 6);
    assert.equal(h.sumaTrabajadoresUnicos, h.porNombre.distintos);
});

test("headcount: el conteo por nombre coincide con dedupe() sobre los mismos registros", () => {
    // The one equality that keeps metrics.js and the dedupe from telling two stories.
    const h = run().metricas.headcount;
    assert.equal(h.porNombre.distintos, dedupe(WORKERS, { mode: "name" }).kept.length);
    assert.equal(h.porDni.distintos, dedupe(WORKERS, { mode: "dni" }).kept.length);
});

test("headcount: identityKey='dni' cambia el numero entregado, no los publicados", () => {
    const h = run(WORKERS, { identityKey: "dni" }).metricas.headcount;
    assert.equal(h.clave, "dni");
    assert.equal(h.entregado, 7);
    assert.equal(h.porNombre.distintos, 6);
    assert.equal(h.porDni.distintos, 7);
});

/* ------------------------------------------------------------------ *
 * The de-duplication weight - 0.5 + 0.5, never rounded
 * ------------------------------------------------------------------ */

test("Trabajadores Unicos es un peso de deduplicacion: 0.5 + 0.5, no un conteo", () => {
    assert.equal(trabajadoresUnicos(1), 1);
    assert.equal(trabajadoresUnicos(2), 0.5);
    assert.equal(trabajadoresUnicos(3), 1 / 3);
    // Three copies sum back to one person - the arithmetic behind 5096.833...
    assert.equal(trabajadoresUnicos(3) * 3, 1);
});

test("un trabajador bajo dos subcontratistas aporta 0.5 a cada lado del corte CJV/EPC", () => {
    const m = run().metricas;
    const cjv = m.cjvEpc.grupos.find(g => g.epc === "CJV");
    const epc = m.cjvEpc.grupos.find(g => g.epc === "EPC");

    // Active rows are W1,W2,W3,W6,W7,W8 - W4 is ESTADO 2 and W5 is BajasAntiguas "Si".
    // CJV: W1 0.5 + W3 1 + W7 0.5 + W8 0.5 = 2.5   EPC: W2 0.5 + W6 1 = 1.5
    assert.equal(cjv.valor, 2.5);
    assert.equal(epc.valor, 1.5);
    assert.equal(m.cjvEpc.total, 4);
    assert.equal(m.cjvEpc.filas, 6);

    // Fractional totals are CORRECT (03 §9 criterion 29.11) and must survive the round trip.
    const back = JSON.parse(serialize(run()));
    assert.equal(back.metricas.cjvEpc.grupos.find(g => g.epc === "CJV").valor, 2.5);
});

test("los decimales no se redondean ni se recortan al serializar", () => {
    // Three copies of one worker: the sum is 1 but each row carries 0.3333333333333333.
    const three = [
        worker({ subcontratista: "S1", archivo: "a.xlsx", fila: 2, "APELLIDOS Y NOMBRES": "TRES UNO" }),
        worker({ subcontratista: "S2", archivo: "b.xlsx", fila: 2, "APELLIDOS Y NOMBRES": "TRES UNO" }),
        worker({ subcontratista: "S3", archivo: "c.xlsx", fila: 2, "APELLIDOS Y NOMBRES": "TRES UNO" }),
        worker({ subcontratista: "S1", archivo: "a.xlsx", fila: 3, "APELLIDOS Y NOMBRES": "SOLO UNO" }),
    ];
    const m = run(three).metricas;
    assert.equal(m.headcount.porNombre.distintos, 2);
    assert.equal(m.headcount.sumaTrabajadoresUnicos, 2);
    // The zone matrix carries the thirds explicitly - ATE for all four rows.
    const ate = m.porZonaGenero.zonas.find(z => z.zona === "ATE");
    assert.equal(ate.filas, 4);
    assert.equal(ate.total, 2);
});

/* ------------------------------------------------------------------ *
 * 2 - headcount by zone x gender
 * ------------------------------------------------------------------ */

test("porZonaGenero reproduce pivotTable1: AD por zona x genero, filtrado BajasAntiguas='No'", () => {
    const z = run().metricas.porZonaGenero;

    assert.equal(z.medida, "Trabajdores Unicos Zona Influencia");
    assert.deepEqual(z.filtro, { BajasAntiguas: "No" });
    // W5 is the only stale carry-over, and SANTA ANITA is his zone alone - so the zone
    // disappears from the matrix entirely rather than showing a zero.
    assert.deepEqual(z.zonas.map(r => r.zona), ["ATE", "CALLAO", "No"]);
    assert.equal(z.excluidasBajasAntiguas, 1);

    const ate = z.zonas.find(r => r.zona === "ATE");
    assert.deepEqual(
        { femenino: ate.femenino, masculino: ate.masculino, sinGenero: ate.sinGenero, total: ate.total, filas: ate.filas },
        { femenino: 0, masculino: 1, sinGenero: 1, total: 2, filas: 3 });

    const callao = z.zonas.find(r => r.zona === "CALLAO");
    assert.equal(callao.femenino, 2);
    assert.equal(callao.total, 2);

    // The out-of-zone row: W3 scores 0 (nobody of that name is in-zone) and W8 scores 1
    // because W7 is - the double count, reproduced deliberately.
    const fuera = z.zonas.find(r => r.zona === "No");
    assert.equal(fuera.femenino, 1);
    assert.equal(fuera.filas, 2);

    assert.deepEqual(z.totales, { femenino: 3, masculino: 1, sinGenero: 1 });
    assert.equal(z.total, 5);
    assert.equal(z.enZona, 4);
    assert.equal(z.fueraDeZona, 1);
});

test("el doble conteo de AD se cuenta en vez de corregirse en silencio", () => {
    const z = run().metricas.porZonaGenero;
    assert.equal(z.dobleConteo, 1);              // W8
    assert.equal(z.sumaSinFiltro, 6);            // Σ AD sobre toda la tabla

    // The formula itself, at the boundary.
    assert.equal(trabajadoresUnicosZona(1, "ATE", 1), 1);    // single row, in zone
    assert.equal(trabajadoresUnicosZona(1, "No", 0), 0);     // single row, out of zone -> 0
    assert.equal(trabajadoresUnicosZona(2, "ATE", 2), 0.5);  // both rows in zone
    assert.equal(trabajadoresUnicosZona(2, "ATE", 1), 1);    // only this row in zone
    assert.equal(trabajadoresUnicosZona(2, "No", 1), 1);     // the quirk: else -> enZona
});

test("el eje de genero es cerrado: un GENERO desconocido cuenta como sinGenero, no como columna nueva", () => {
    // The OCTUBRE_2025 regression was a THIRD gender item appearing in the pivot.
    const records = [worker({ "APELLIDOS Y NOMBRES": "RARO UNO", "GENERO": "undefined" })];
    const z = run(records).metricas.porZonaGenero;
    const ate = z.zonas.find(r => r.zona === "ATE");
    assert.deepEqual(Object.keys(ate), ["zona", "femenino", "masculino", "sinGenero", "total", "filas"]);
    assert.equal(ate.sinGenero, 1);
    assert.equal(run(records).metricas.excepciones.listas.genero.sinGenero, 1);
});

/* ------------------------------------------------------------------ *
 * 3 and 4 - Altas and Bajas
 * ------------------------------------------------------------------ */

test("altas reproduce pivotTable7: filtrado por PeriodoEtiqueta", () => {
    const a = run().metricas.altas;
    assert.deepEqual(a.filtro, { Altas: "2-2026" });
    assert.equal(a.etiqueta, "2-2026");
    assert.equal(a.enPeriodo, 1);         // W3 only
    assert.equal(a.total, 1);
    assert.equal(a.revisar, 0);
    assert.deepEqual(a.zonas.map(r => r.zona), ["No"]);
    assert.equal(a.zonas[0].femenino, 1);
    assert.equal(a.sumaSinFiltro, 1);
});

test("bajas reproduce pivotTable4: filtrado BajasAntiguas='No', no por etiqueta", () => {
    const b = run().metricas.bajas;
    assert.deepEqual(b.filtro, { BajasAntiguas: "No" });
    assert.equal(b.enPeriodo, 1);         // W4
    assert.equal(b.borrar, 1);            // W5 ceased in an earlier period
    assert.equal(b.bajasAntiguas, 1);     // ...and is therefore excluded from the pivot
    assert.equal(b.total, 1);
    assert.deepEqual(b.zonas.map(r => r.zona), ["CALLAO"]);
    assert.equal(b.zonas[0].femenino, 1);
});

test("'Revisar' (BUG-08) es visible en ambos totales en vez de desaparecer", () => {
    // A cese cell that held something unreadable: the record's serial is null, and only
    // the issue stream still knows the cell was not empty.
    const records = [
        worker({ "APELLIDOS Y NOMBRES": "REVISAR UNO", "FECHA CESE/BAJA": null }),
        worker({ "APELLIDOS Y NOMBRES": "REVISAR DOS", "FECHA INICIO DE LABORES EN OBRA": null, fila: 3 }),
    ];
    const out = run(records, {
        unparseableDates: [new Set(["FECHA CESE/BAJA"]), new Set(["FECHA INICIO DE LABORES EN OBRA"])],
    });
    const listas = out.metricas.excepciones.listas;
    assert.equal(listas.fechasRevisar.bajas2, 1);
    assert.equal(listas.fechasRevisar.altas, 1);
    assert.equal(listas.fechasRevisar.total, 2);
    assert.equal(listas.fechasRevisar.senalDisponible, true);

    // And the consequence that must not be hidden: AF counts a "Revisar" cese as a Baja,
    // because AE/AF stay Excel formulas that only exclude "No Aplica" and "borrar".
    assert.equal(out.metricas.bajas.revisar, 1);
    assert.equal(out.metricas.bajas.total, 1);
    assert.equal(out.metricas.bajas.enPeriodo, 0);
    // Altas is page-filtered on the etiqueta, so a "Revisar" alta is counted but not shown.
    assert.equal(out.metricas.altas.revisar, 1);
    assert.equal(out.metricas.altas.total, 0);
    assert.equal(out.metricas.altas.sumaSinFiltro, 1);
});

test("sin la senal de fechas ilegibles el estado 'Revisar' no puede aparecer", () => {
    const out = run();
    assert.equal(out.metricas.excepciones.listas.fechasRevisar.senalDisponible, false);
    assert.equal(out.metricas.excepciones.listas.fechasRevisar.total, 0);
});

test("periodFlag colapsa AE/AF (BUG-30) con la comparacion insensible a mayusculas", () => {
    assert.equal(periodFlag(LITERALS.NO_APLICA), 0);
    assert.equal(periodFlag("No aplica"), 0);
    assert.equal(periodFlag(LITERALS.BORRAR), 0);
    assert.equal(periodFlag("borrar"), 0);       // the formula's lowercase spelling
    assert.equal(periodFlag("2-2026"), 1);
    assert.equal(periodFlag(LITERALS.REVISAR), 1);
});

/* ------------------------------------------------------------------ *
 * 5 and 6 - the CJV/EPC split and its hours
 * ------------------------------------------------------------------ */

test("cjvEpc y horas reproducen pivotTable8: ESTADO=1 y BajasAntiguas='No'", () => {
    const m = run().metricas;

    assert.deepEqual(m.cjvEpc.filtro, { ESTADO: ESTADO_ACTIVO, BajasAntiguas: LITERALS.NO });
    assert.equal(m.cjvEpc.medida, "Trabajadores Unicos");
    assert.equal(m.horas.medida, "HPT");
    assert.deepEqual(m.horas.filtro, { ESTADO: ESTADO_ACTIVO, BajasAntiguas: LITERALS.NO });

    // Hours follow the same filter: W4 (ESTADO 2, 20 h) and W5 (stale, 0 h) are out.
    const cjv = m.horas.grupos.find(g => g.epc === "CJV");
    const epc = m.horas.grupos.find(g => g.epc === "EPC");
    assert.equal(cjv.valor, 155);        // 100 + 40 + 10 + 5
    assert.equal(epc.valor, 60);
    assert.equal(m.horas.total, 215);
    // W6 has no HPT at all - whole-table count, so an absent column never reads as zero.
    assert.equal(m.horas.sinHpt, 1);
});

test("las dos filas del corte existen siempre, aunque una quede vacia", () => {
    const m = run([worker({ "APELLIDOS Y NOMBRES": "SOLO CJV" })]).metricas;
    assert.deepEqual(m.cjvEpc.grupos.map(g => g.epc), ["CJV", "EPC"]);
    assert.equal(m.cjvEpc.grupos.find(g => g.epc === "EPC").valor, 0);
    assert.equal(m.cjvEpc.grupos.find(g => g.epc === "EPC").filas, 0);
});

/* ------------------------------------------------------------------ *
 * Defaults for unknown values
 * ------------------------------------------------------------------ */

test("defaults: un distrito desconocido resuelve a 'No' y un contratista desconocido a 'CJV'", () => {
    const records = [
        worker({ "APELLIDOS Y NOMBRES": "DESC UNO", "DISTRITO SEGÚN DNI": "PUENTE PIEDRA", "CONTRATISTA PRNCIPAL": "NO REGISTRADA SAC" }),
        worker({ "APELLIDOS Y NOMBRES": "DESC DOS", "DISTRITO SEGÚN DNI": null, "CONTRATISTA PRNCIPAL": null, fila: 3 }),
    ];
    const m = run(records).metricas;

    // Both rows land in the "No" zone: the template's IFERROR sentinel, not an error.
    assert.deepEqual(m.porZonaGenero.zonas.map(z => z.zona), [ZONA_DEFAULT]);
    // Both land on the CJV side: EPC_DEFAULT, not a third group.
    assert.deepEqual(m.cjvEpc.grupos.map(g => g.epc), [EPC_DEFAULT, "EPC"]);
    assert.equal(m.cjvEpc.grupos.find(g => g.epc === EPC_DEFAULT).filas, 2);

    // An unrecognised district and an absent one are different facts - 03 §8.2 needs the
    // first list to grow Hoja1!A2:B61 and must not have the second mixed into it.
    const d = m.excepciones.listas.distritosSinZona;
    assert.equal(d.filas, 2);
    assert.equal(d.sinDistrito, 1);
    assert.deepEqual(d.distritos, [{ distrito: "PUENTE PIEDRA", filas: 1 }]);
    assert.equal(m.contratistas.sinContratista, 1);
});

test("defaults: los distritos que resuelven a 'No' se agrupan y cuentan", () => {
    const d = run().metricas.excepciones.listas.distritosSinZona;
    assert.deepEqual(d.distritos, [
        { distrito: "MIRAFLORES", filas: 1 },
        { distrito: "PUENTE PIEDRA", filas: 1 },
    ]);
    assert.equal(d.filas, 2);
    assert.equal(d.sinDistrito, 0);
});

test("inZone usa la comparacion de Excel (insensible a mayusculas) contra 'No'", () => {
    assert.equal(inZone("ATE"), true);
    assert.equal(inZone("No"), false);
    assert.equal(inZone("NO"), false);   // <> in Excel is case-insensitive
    assert.equal(inZone("no"), false);
});

test("las tablas reales de la plantilla resuelven la misma geometria", () => {
    // Guards against the small hand-built tables above hiding a real-file problem.
    const lookups = readLookups(config.TEMPLATE);
    const m = computeMetrics(
        [worker({ "APELLIDOS Y NOMBRES": "REAL UNO", "DISTRITO SEGÚN DNI": "ATE" })],
        { period: FEB, lookups });
    assert.deepEqual(m.metricas.porZonaGenero.zonas.map(z => z.zona), ["ATE"]);
    assert.equal(m.metricas.cjvEpc.grupos.find(g => g.epc === EPC_DEFAULT).filas, 1);
});

/* ------------------------------------------------------------------ *
 * 7 - distinct contratistas
 * ------------------------------------------------------------------ */

test("contratistas es 1/COUNTIF y por lo tanto suma el numero de distintos", () => {
    const c = run().metricas.contratistas;
    // "CJV UNO" x4, "EPC UNO" x2, "CJV DOS" x2 -> 4*(1/4) + 2*(1/2) + 2*(1/2) = 3
    assert.equal(c.distintos, 3);
    assert.equal(c.suma, 3);
    assert.equal(c.distintosNoVacios, 3);
    assert.equal(c.sinContratista, 0);
    assert.deepEqual(c.lista, [
        { contratista: "CJV DOS", filas: 2 },
        { contratista: "CJV UNO", filas: 4 },
        { contratista: "EPC UNO", filas: 2 },
    ]);
});

test("un CONTRATISTA PRNCIPAL vacio forma su propio grupo COUNTIF, como en la plantilla", () => {
    const records = [
        worker({ "APELLIDOS Y NOMBRES": "CON UNO", "CONTRATISTA PRNCIPAL": "CJV UNO" }),
        worker({ "APELLIDOS Y NOMBRES": "SIN UNO", "CONTRATISTA PRNCIPAL": null, fila: 3 }),
        worker({ "APELLIDOS Y NOMBRES": "SIN DOS", "CONTRATISTA PRNCIPAL": "   ", fila: 4 }),
    ];
    const c = run(records).metricas.contratistas;
    assert.equal(c.distintos, 2);            // "CJV UNO" + the blank group
    assert.equal(c.distintosNoVacios, 1);
    assert.equal(c.sinContratista, 2);
    // Nulls sort LAST everywhere in this module, so the blank group never displaces a
    // named one at the top of a list an operator reads.
    assert.deepEqual(c.lista, [
        { contratista: "CJV UNO", filas: 1 },
        { contratista: null, filas: 2 },
    ]);
});

/* ------------------------------------------------------------------ *
 * 8 - the exception list
 * ------------------------------------------------------------------ */

test("excepciones: la lista de incidencias es completa, ordenada y encabezada por los FALLOS", () => {
    const issues = new IssueList();
    issues.info({ code: CODE.HEADER_ALIAS_ACCEPTED, message: "alias", subcontratista: "S1" });
    issues.failed({ code: CODE.SHEET_NOT_FOUND, message: "sin Cuadro", subcontratista: "S9", archivo: "z.xlsx" });
    issues.warning({ code: CODE.RUC_CHECK_DIGIT, message: "ruc", subcontratista: "S1", fila: 7 });
    issues.error({ code: CODE.ROW_NUMERIC_NAME, message: "nombre numerico", subcontratista: "S2", fila: 3 });

    const e = run(WORKERS, { issues }).metricas.excepciones;
    assert.equal(e.totales.incidencias, 4);
    assert.equal(e.totales.fallos, 1);
    assert.deepEqual(e.porSeveridad, { INFO: 1, WARNING: 1, ERROR: 1, FAILED: 1 });
    assert.deepEqual(e.porCodigo, {
        HEADER_ALIAS_ACCEPTED: 1, ROW_NUMERIC_NAME: 1, RUC_CHECK_DIGIT: 1, SHEET_NOT_FOUND: 1,
    });
    assert.deepEqual(e.fallos, [{
        subcontratista: "S9", archivo: "z.xlsx", hoja: null,
        codigo: "SHEET_NOT_FOUND", motivo: "sin Cuadro",
    }]);

    const out = run(WORKERS, { issues });
    assert.deepEqual(out.incidencias.map(i => i.severidad), ["FAILED", "ERROR", "WARNING", "INFO"]);
    assert.equal(out.incidenciasOmitidas, 0);
});

test("excepciones: un subcontratista fallido nunca se suprime aunque no haya nada mas", () => {
    const issues = new IssueList();
    issues.failed({ code: CODE.ANCHOR_NOT_FOUND, message: "sin ancla", subcontratista: "S7", archivo: "y.xlsx" });
    const e = run([], { issues }).metricas.excepciones;
    assert.equal(e.totales.fallos, 1);
    assert.equal(e.fallos[0].subcontratista, "S7");
});

test("excepciones: el truncamiento solo puede descartar INFO", () => {
    const issues = new IssueList();
    for (let i = 0; i < 5; i++) issues.info({ code: CODE.TEXT_NORMALIZED, message: `info ${i}` });
    issues.failed({ code: CODE.SHEET_NOT_FOUND, message: "fallo", subcontratista: "SZ" });
    const out = run(WORKERS, { issues, maxIncidencias: 2 });
    assert.equal(out.incidencias.length, 2);
    assert.equal(out.incidencias[0].severidad, SEVERITY.FAILED);
    assert.equal(out.incidenciasOmitidas, 4);
    // The COUNTS are never capped - only the row dump is.
    assert.equal(out.metricas.excepciones.totales.incidencias, 6);
    assert.equal(out.metricas.excepciones.porSeveridad.INFO, 5);
});

test("excepciones: acepta un arreglo plano de incidencias igual que un IssueList", () => {
    const issues = new IssueList();
    issues.warning({ code: CODE.DNI_LENGTH, message: "dni", subcontratista: "S1" });
    const fromList = run(WORKERS, { issues });
    const fromArray = run(WORKERS, { issues: issues.items });
    assert.deepEqual(fromArray.metricas.excepciones, fromList.metricas.excepciones);
    assert.deepEqual(fromArray.incidencias, fromList.incidencias);
});

test("excepciones: la distribucion de Rango Edades incluye 'Sin Fecha' y las seis cubetas (AC 17)", () => {
    const edad = run().metricas.excepciones.listas.edad;
    assert.equal(edad.sinFecha, 1);      // W6
    assert.equal(edad.corregir, 0);
    assert.deepEqual(edad.rangos, [
        { rango: "18 - 23", filas: 2 },   // W7, W8 (21)
        { rango: "24 - 31", filas: 2 },   // W3 (30), W4 (26)
        { rango: "32 - 40", filas: 2 },   // W1, W2 (40)
        { rango: "41 - 49", filas: 0 },
        { rango: "50 - 58", filas: 1 },   // W5 (51)
        { rango: "59 +", filas: 0 },
        { rango: "Sin Fecha", filas: 1 }, // W6 - a NAMED bucket, not #VALUE!
    ]);
    // AC 17: the #VALUE! bucket cannot exist, because no error value is ever emitted.
    assert.equal(JSON.stringify(edad).includes("#VALUE!"), false);
});

test("excepciones: la poblacion de ValidarDNI es la del formulario corregido (AC 18)", () => {
    const ids = run().metricas.excepciones.listas.identificadores;
    assert.equal(ids.sinDni, 1);                 // W6
    assert.equal(ids.validarDniCorregir, 1);     // empty OR shorter than 8
    assert.equal(ids.sinRuc, 0);
    assert.equal(ids.rucInvalido, 0);

    const bad = [
        worker({ "APELLIDOS Y NOMBRES": "CORTO UNO", "Nro. DNI / CE": "1234567" }),       // 7 chars
        worker({ "APELLIDOS Y NOMBRES": "LARGO UNO", "Nro. DNI / CE": "001079894", fila: 3 }), // 9 = CE, OK
        worker({ "APELLIDOS Y NOMBRES": "RUC MALO", "RUC": "20504039123", fila: 4 }),     // fails mod-11
        worker({ "APELLIDOS Y NOMBRES": "RUC NULO", "RUC": null, fila: 5 }),
    ];
    const b = run(bad).metricas.excepciones.listas.identificadores;
    assert.equal(b.validarDniCorregir, 1);       // only the 7-character one
    assert.equal(b.rucInvalido, 1);
    assert.equal(b.sinRuc, 1);
});

test("excepciones: la poblacion 'Dos Subcontratas por Mes' incluye los casos de 3 copias", () => {
    // Derived from the records when the caller passes no stats.
    const derived = run().metricas.excepciones.listas.dosSubcontratistas;
    assert.equal(derived.fuente, "registros");
    assert.equal(derived.grupos, 1);            // PEREZ JUAN only - VEGA SOFIA is one company
    assert.equal(derived.filas, 2);
    assert.deepEqual(derived.porCopias, [{ copias: 2, grupos: 1 }]);

    // From dedupe(), which is the only source that survives a scope:"all" collapse.
    const d = dedupe(WORKERS, { mode: "name" });
    const fromStats = run(d.kept, { stats: { crossSubcontratista: d.crossSubcontratista } })
        .metricas.excepciones.listas.dosSubcontratistas;
    assert.equal(fromStats.fuente, "dedupe");
    assert.equal(fromStats.grupos, 1);
    assert.equal(fromStats.filas, 2);
});

test("excepciones: ESTADO y GENERO se tabulan sobre dominios cerrados", () => {
    const listas = run().metricas.excepciones.listas;
    assert.deepEqual(listas.genero, { femenino: 4, masculino: 3, sinGenero: 1 });
    assert.deepEqual(listas.estado, [{ estado: 1, filas: 7 }, { estado: 2, filas: 1 }]);
    assert.deepEqual(listas.empresa, { sinEmpresa: 0 });
});

/* ------------------------------------------------------------------ *
 * proceso / conservation
 * ------------------------------------------------------------------ */

test("proceso: la conservacion cuadra cuando el llamador aporta los terminos", () => {
    const p = run(WORKERS, { stats: { read: 12, rejected: 2, collapsed: 2 } }).proceso;
    assert.deepEqual(p.filas, { leidas: 12, rechazadas: 2, colapsadas: 2, escritas: 8 });
    assert.equal(p.conservacion.ok, true);
    assert.equal(p.conservacion.esperadas, 8);
    assert.equal(p.conservacion.verificable, true);
    assert.equal(p.conservacion.motivo, null);
});

test("proceso: la conservacion rota se dice, no se calla", () => {
    const p = run(WORKERS, { stats: { read: 12, rejected: 0, collapsed: 0 } }).proceso;
    assert.equal(p.conservacion.ok, false);
    assert.equal(p.conservacion.esperadas, 12);
    assert.equal(p.conservacion.escritas, 8);
    assert.match(p.conservacion.motivo, /conservacion rota/);
});

test("proceso: sin terminos la conservacion es NO VERIFICABLE, no un aprobado silencioso", () => {
    const p = run().proceso;
    assert.equal(p.conservacion.ok, false);
    assert.equal(p.conservacion.verificable, false);
    assert.equal(p.filas.leidas, null);
    assert.equal(p.filas.rechazadas, null, "un rechazadas ausente no puede leerse como 0");
    assert.equal(p.filas.escritas, 8);
});

test("proceso: acepta el resultado de dedupe() tal cual", () => {
    const d = dedupe(WORKERS, { mode: "name" });
    const p = run(d.kept, { stats: { read: 8, rejected: 0, dedupe: d } }).proceso;
    assert.equal(p.filas.colapsadas, d.stats.rowsCollapsed);
    assert.equal(p.filas.escritas, d.kept.length);
    assert.equal(p.conservacion.ok, true);
});

test("proceso: read acepta la forma por-libro de conservationCheck", () => {
    const p = run(WORKERS, {
        stats: {
            read: [
                { subcontratista: "S1", archivo: "a.xlsx", filas: 4 },
                { subcontratista: "S2", archivo: "b.xlsx", filas: 4 },
            ],
            rejected: 0, collapsed: 0,
        },
    }).proceso;
    assert.equal(p.filas.leidas, 8);
    assert.equal(p.conservacion.ok, true);
});

/* ------------------------------------------------------------------ *
 * Hygiene
 * ------------------------------------------------------------------ */

test("ningun numero es NaN y ninguna cadena es 'undefined' (AC 11, AC 12)", () => {
    const messy = [
        worker({ "APELLIDOS Y NOMBRES": "MESS UNO", "HPT": null, "ESTADO": null, "GENERO": undefined, "DISTRITO SEGÚN DNI": undefined }),
        worker({ "APELLIDOS Y NOMBRES": "", "Nro. DNI / CE": "", "CONTRATISTA PRNCIPAL": "", fila: 3 }),
        worker({ "APELLIDOS Y NOMBRES": "MESS TRES", "FECHA NACIMIENTO": null, "FECHA CESE/BAJA": null, fila: 4 }),
    ];
    const json = serialize(run(messy));
    assert.equal(json.includes("NaN"), false);
    assert.equal(json.includes('"undefined"'), false);
    assert.equal(json.includes("undefined"), false);
    assert.equal(json.includes("Infinity"), false);
    // And it really is valid JSON.
    const back = JSON.parse(json);
    walkNumbers(back, (n, at) => assert.equal(Number.isFinite(n), true, `${at} = ${n}`));
});

test("un juego vacio produce una estructura completa y cero por todas partes", () => {
    const out = run([]);
    assert.deepEqual(Object.keys(out.metricas), [...METRIC_NAMES]);
    assert.equal(out.metricas.headcount.porNombre.distintos, 0);
    assert.equal(out.metricas.headcount.sumaTrabajadoresUnicos, 0);
    assert.equal(out.metricas.porZonaGenero.total, 0);
    assert.deepEqual(out.metricas.porZonaGenero.zonas, []);
    assert.equal(out.metricas.altas.total, 0);
    assert.equal(out.metricas.bajas.total, 0);
    assert.equal(out.metricas.cjvEpc.total, 0);
    assert.equal(out.metricas.horas.total, 0);
    assert.equal(out.metricas.contratistas.distintos, 0);
    assert.equal(JSON.parse(serialize(out)).proceso.filas.escritas, 0);
});

test("los 18 campos canonicos se leen por nombre: invertir el orden de las claves no mueve nada", () => {
    // The BUG-13 posture, applied here: nothing may depend on JS enumeration order.
    const reversed = WORKERS.map(r => {
        const out = {};
        for (const k of [...CANONICAL].reverse()) out[k] = r[k];
        out.provenance = r.provenance;
        return out;
    });
    assert.equal(serialize(run(reversed)), serialize(run(WORKERS)));
});

/* ------------------------------------------------------------------ *
 * Caller errors throw; data problems never do
 * ------------------------------------------------------------------ */

test("un periodo ausente o malformado es un error de cableado y lanza", () => {
    const lookups = makeLookups();
    assert.throws(() => computeMetrics(WORKERS, { lookups }), TypeError);
    assert.throws(() => computeMetrics(WORKERS, { period: null, lookups }), TypeError);
    assert.throws(() => computeMetrics(WORKERS, { period: {}, lookups }), TypeError);
    assert.throws(() => computeMetrics(WORKERS, { period: "2026-13", lookups }));
    // ...and a "YYYY-MM" string is accepted and parsed.
    assert.equal(computeMetrics(WORKERS, { period: "2026-02", lookups }).periodo.etiqueta, "2-2026");
});

test("unas tablas de lookup ausentes lanzan en vez de reportar todo como 'No'/'CJV'", () => {
    assert.throws(() => computeMetrics(WORKERS, { period: FEB }), TypeError);
    assert.throws(() => computeMetrics(WORKERS, { period: FEB, lookups: {} }), TypeError);
    assert.throws(() => computeMetrics(WORKERS, { period: FEB, lookups: { zonaByDistrito: new LookupTable("z", [], "No") } }), TypeError);
});

test("otros errores de cableado lanzan; ningun problema de datos lo hace", () => {
    assert.throws(() => computeMetrics(null, { period: FEB, lookups: makeLookups() }), TypeError);
    assert.throws(() => computeMetrics(WORKERS, { period: FEB, lookups: makeLookups(), identityKey: "ruc" }), TypeError);
    // Data problems: junk in every field, and still no throw.
    assert.doesNotThrow(() => run([{}, { "APELLIDOS Y NOMBRES": 12345 }, null]));
});

/* ------------------------------------------------------------------ *
 * Determinism - AC 26
 * ------------------------------------------------------------------ */

test("determinismo: dos relojes distintos producen JSON byte-identico", () => {
    const runs = [];
    for (const iso of ["1999-06-15T03:04:05.000Z", "2026-08-03T23:59:59.000Z", "2031-01-01T00:00:00.000Z"]) {
        mock.timers.enable({ apis: ["Date"], now: new Date(iso).getTime() });
        try {
            // Prove the mock really took, so a green test cannot come from a no-op mock.
            assert.equal(new Date().toISOString(), iso);
            runs.push(serialize(run(WORKERS, { stats: { read: 8, rejected: 0, collapsed: 0 } })));
        } finally {
            mock.timers.reset();
        }
    }
    assert.equal(runs[0], runs[1]);
    assert.equal(runs[1], runs[2]);
    // ...and the numbers really are in there, so an empty-string match cannot pass this.
    assert.match(runs[0], /"sumaTrabajadoresUnicos": 6/);
});

test("determinismo: dos llamadas identicas sobre los mismos registros son byte-identicas", () => {
    const a = serialize(run());
    const b = serialize(run());
    assert.equal(a, b);
});

test("determinismo: el modulo no contiene reloj alguno", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "output", "metrics.js"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.equal(/new\s+Date\s*\(/.test(code), false, "new Date() en metrics.js");
    assert.equal(/Date\s*\.\s*now\s*\(/.test(code), false, "Date.now() en metrics.js");
    assert.equal(/TODAY\s*\(/.test(code), false, "TODAY() en metrics.js");
    assert.equal(/process\s*\.\s*hrtime/.test(code), false, "hrtime en metrics.js");
    assert.equal(/Math\s*\.\s*random/.test(code), false, "Math.random en metrics.js");
});

test("determinismo: cada agrupacion sale ordenada, no en orden de llegada", () => {
    // Same records, shuffled. Every emitted array is sorted, so the JSON must not move -
    // this is what makes the AC 26 `diff` and the parallel-run diff readable.
    const shuffled = [WORKERS[7], WORKERS[3], WORKERS[0], WORKERS[6], WORKERS[5], WORKERS[2], WORKERS[4], WORKERS[1]];
    const a = run(WORKERS);
    const b = run(shuffled);
    assert.deepEqual(b.metricas.porZonaGenero.zonas, a.metricas.porZonaGenero.zonas);
    assert.deepEqual(b.metricas.contratistas.lista, a.metricas.contratistas.lista);
    assert.deepEqual(b.metricas.excepciones.listas.distritosSinZona, a.metricas.excepciones.listas.distritosSinZona);
    assert.deepEqual(b.metricas.excepciones.listas.edad, a.metricas.excepciones.listas.edad);
    assert.equal(b.metricas.headcount.sumaTrabajadoresUnicos, a.metricas.headcount.sumaTrabajadoresUnicos);
    assert.equal(b.metricas.cjvEpc.total, a.metricas.cjvEpc.total);
});

test("determinismo: los codigos de incidencia se ordenan por codigo, no por frecuencia", () => {
    const issues = new IssueList();
    issues.info({ code: CODE.TEXT_NORMALIZED, message: "a" });
    issues.info({ code: CODE.TEXT_NORMALIZED, message: "b" });
    issues.info({ code: CODE.HEADER_ALIAS_ACCEPTED, message: "c" });
    const codigos = run(WORKERS, { issues }).metricas.excepciones.porCodigo;
    // A frequency-ordered object reorders itself the moment one count changes.
    assert.deepEqual(Object.keys(codigos), ["HEADER_ALIAS_ACCEPTED", "TEXT_NORMALIZED"]);
});

test("serialize produce JSON indentado con salto final", () => {
    const s = serialize(run());
    assert.equal(s.endsWith("\n"), true);
    assert.equal(s.startsWith("{\n  \"version\""), true);
    assert.deepEqual(JSON.parse(s).metricas.headcount.entregado, 6);
});

/* ------------------------------------------------------------------ *
 * options.computed
 * ------------------------------------------------------------------ */

test("options.computed se usa tal cual, para que template.js y metrics.js no diverjan", () => {
    // A deliberately wrong precomputed row: if it is ignored, this assertion fails.
    const forced = WORKERS.map(() => ({
        "Edad": 30, "Rango Edades": "24 - 31",
        "BajasAntiguas": "No", "Bajas2": "No Aplica", "Altas": FEB.etiqueta,
    }));
    const m = run(WORKERS, { computed: forced }).metricas;
    assert.equal(m.altas.enPeriodo, 8);
    assert.equal(m.bajas.total, 0);
    assert.deepEqual(m.excepciones.listas.edad.rangos.find(r => r.rango === "24 - 31"), { rango: "24 - 31", filas: 8 });
});

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function walkNumbers(value, fn, at = "$") {
    if (typeof value === "number") { fn(value, at); return; }
    if (Array.isArray(value)) { value.forEach((v, i) => walkNumbers(v, fn, `${at}[${i}]`)); return; }
    if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) walkNumbers(v, fn, `${at}.${k}`);
    }
}

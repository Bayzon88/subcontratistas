"use strict";
/**
 * src/pipeline/schema.js - the canonical row schema.
 *
 * The case table (src/test/cases/schema.json) is whole ROWS, not cells: the point of this
 * module is composition, and the defects that matter are the ones that only appear when a
 * date, a code, an identifier and a text field are parsed together - one bad cell not
 * discarding the other seventeen, a cese that is only wrong relative to its start date,
 * a required column that is absent from the file rather than blank in the row.
 *
 * Every case marked `source: "ReporteConsolidado"` is a row lifted verbatim out of the
 * last real run.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const schema = require("../pipeline/schema");
const { IssueList, SEVERITY, CODE } = require("../pipeline/issues");
const { CANONICAL } = require("../pipeline/columns");
const { parsePeriod } = require("../pipeline/period");

const TABLE = JSON.parse(
    fs.readFileSync(path.join(__dirname, "cases", "schema.json"), "utf8")
);
const PERIOD = parsePeriod(TABLE.period);

/** A row with every canonical key present, so a case can name only what it cares about. */
function row(partial) {
    const out = {};
    for (const canonical of CANONICAL) out[canonical] = null;
    return Object.assign(out, partial);
}

function makeCtx(over) {
    return Object.assign(
        {
            period: PERIOD,
            issues: new IssueList(),
            provenance: {
                subcontratista: "SUBCONTRATA X",
                archivo: "reporte.xlsx",
                hoja: "Cuadro",
                filaOrigen: 2,
            },
        },
        over
    );
}

/** canonical -> {col}, mirroring what workbook.js hands back for a full 18-column sheet. */
function fullHeaderMap(skip = []) {
    const map = {};
    CANONICAL.forEach((name, i) => {
        if (!skip.includes(name)) map[name] = { col: i, celda: `${String.fromCharCode(65 + i)}1` };
    });
    return map;
}

function summarize(issues) {
    return issues.map(i => ({ severity: i.severity, code: i.code, columna: i.columna }));
}

/* ------------------------------------------------------------------ *
 * The case table
 * ------------------------------------------------------------------ */

test("case table: every row produces the expected record", () => {
    for (const c of TABLE.cases) {
        const ctx = makeCtx();
        const result = schema.parseRow(row(c.input), ctx);

        assert.equal(result.ok, c.expectedOk, `${c.id}: ok`);

        if (c.expectedOk === false) {
            assert.equal(result.record, null, `${c.id}: a rejected row emits no record`);
            assert.equal(result.rejected, true, `${c.id}: rejected`);
            if (c.expectedReason) assert.equal(result.reason, c.expectedReason, `${c.id}: reason`);
            continue;
        }

        if (c.expected) {
            const actual = {};
            for (const canonical of CANONICAL) actual[canonical] = result.record[canonical];
            assert.deepEqual(actual, c.expected, `${c.id}: record`);
        }
        if (c.expectedField) {
            for (const [k, v] of Object.entries(c.expectedField)) {
                assert.deepEqual(result.record[k], v, `${c.id}: field ${k}`);
            }
        }
    }
});

test("case table: every row produces the expected issue list", () => {
    for (const c of TABLE.cases) {
        const ctx = makeCtx();
        const result = schema.parseRow(row(c.input), ctx);

        // The row's issues are also on the shared IssueList, in the same order.
        assert.deepEqual(result.issues, ctx.issues.items, `${c.id}: result.issues is the row's slice`);

        if (c.expectedIssues) {
            const got = result.issues.map(i => ({
                severity: i.severity,
                code: i.code,
                columna: i.columna,
                valor: i.valor,
            }));
            const want = c.expectedIssues.map(i => ({
                severity: i.severity,
                code: i.code,
                columna: i.columna ?? null,
                valor: "valor" in i ? i.valor : null,
            }));
            assert.deepEqual(got, want, `${c.id}: exact issue list`);
        }

        for (const want of c.expectedIssuesInclude || []) {
            const hit = result.issues.find(i =>
                i.code === want.code &&
                i.severity === want.severity &&
                (want.columna === undefined || i.columna === want.columna)
            );
            assert.ok(
                hit,
                `${c.id}: expected ${want.severity}/${want.code}` +
                (want.columna ? ` on ${want.columna}` : "") +
                `, got ${JSON.stringify(summarize(result.issues))}`
            );
            if ("valor" in want) assert.deepEqual(hit.valor, want.valor, `${c.id}: ${want.code} raw value`);
        }

        if (c.expectedNormalizations) {
            const cols = result.normalizations.map(n => n.columna);
            for (const col of c.expectedNormalizations) {
                assert.ok(cols.includes(col), `${c.id}: expected a normalization on ${col}`);
            }
        }
    }
});

test("case table: the RAW value reaches every issue verbatim", () => {
    // 03 §3.4: "'~200 unparseable rows' is not a deliverable; a list of 200 cells with
    // their raw text is." This is what z.preprocess buys over z.coerce.
    for (const c of TABLE.cases) {
        const ctx = makeCtx();
        const raw = row(c.input);
        const result = schema.parseRow(raw, ctx);
        for (const issue of result.issues) {
            if (!issue.columna) continue;
            if (issue.code === CODE.REQUIRED_MISSING && raw[issue.columna] === null) continue;
            assert.deepEqual(
                issue.valor,
                raw[issue.columna],
                `${c.id}: ${issue.code} on ${issue.columna} must carry the raw cell value`
            );
        }
    }
});

/* ------------------------------------------------------------------ *
 * The rule this module exists for
 * ------------------------------------------------------------------ */

test("one bad cell never discards the other seventeen", () => {
    // Seven simultaneous defects, each from a different owner module.
    const ctx = makeCtx({ headerMap: fullHeaderMap() });
    const raw = row({
        "RUC": 71514158,                                  // format failure (a DNI in the RUC column)
        "EMPRESA": "  ACIS   PROCESS S.A.C ",             // whitespace
        "CONTRATISTA PRNCIPAL": "_x000d__x000a_MCORP SAC",// embedded CRLF
        "Nro. DNI / CE": 7648943,                         // leading zero lost
        "APELLIDOS Y NOMBRES": "OCHOA ARTEAGA CESAR JUAN",
        "FECHA NACIMIENTO": "3/5/65",                     // two-digit birth year: rejected
        "TIPO TRABAJADOR": 2,
        "TITULO DE PUESTO/CARGO": "OPERARIO ELECTRICISTA",
        "NOMBRE DE OBRA DONDE ESTA ASIGNADO DURANTE EL MES REPORTADO": "E19",
        "DOMICILIO DE TRABAJADOR": "ASOC DE VIV CHILLON",
        "DISTRITO SEGÚN DNI": "PUENTE PIEDRA",
        "GENERO": "undefined",                            // BUG-18
        "FECHA CESE/BAJA": "PUMACAYO VILCHEZ TEOFILO DINO",
        "NACIONALIDAD": "Peruano",
        "FECHA INICIO DE LABORES EN OBRA": "09/10/205",   // three-digit year
        "ESTADO": 184,                                    // out of domain
        "TIPO DE CONTRATO LABORAL": 0.03,                 // out of domain
        "HPT": 224,
    });
    const result = schema.parseRow(raw, ctx);

    assert.equal(result.ok, true, "the row survives seven bad cells");

    // Every one of the seven is reported, in ONE pass. No early bail.
    const reported = new Set(result.issues.map(i => i.columna));
    for (const col of [
        "RUC", "Nro. DNI / CE", "FECHA NACIMIENTO", "GENERO",
        "FECHA CESE/BAJA", "FECHA INICIO DE LABORES EN OBRA",
        "ESTADO", "TIPO DE CONTRATO LABORAL",
    ]) {
        assert.ok(reported.has(col), `expected an issue on ${col}`);
    }

    // And every clean field is intact.
    assert.equal(result.record["EMPRESA"], "ACIS PROCESS S.A.C");
    assert.equal(result.record["CONTRATISTA PRNCIPAL"], "MCORP SAC");
    assert.equal(result.record["APELLIDOS Y NOMBRES"], "OCHOA ARTEAGA CESAR JUAN");
    assert.equal(result.record["TIPO TRABAJADOR"], 2);
    assert.equal(result.record["TITULO DE PUESTO/CARGO"], "OPERARIO ELECTRICISTA");
    assert.equal(result.record["DISTRITO SEGÚN DNI"], "PUENTE PIEDRA");
    assert.equal(result.record["NACIONALIDAD"], "PERUANO");
    assert.equal(result.record["HPT"], 224);

    // The identifiers were repaired where a repair is defensible and kept raw where it is not.
    assert.equal(result.record["RUC"], "71514158", "a RUC is never zero-padded");
    assert.equal(result.record["Nro. DNI / CE"], "07648943", "a short DNI is zero-padded");

    // The bad cells are null - never NaN, never "", never the raw text.
    for (const col of ["FECHA NACIMIENTO", "GENERO", "FECHA CESE/BAJA",
        "FECHA INICIO DE LABORES EN OBRA", "ESTADO", "TIPO DE CONTRATO LABORAL"]) {
        assert.equal(result.record[col], null, `${col} must be null`);
    }
});

test("each bad cell is reported exactly once", () => {
    // The two-pass repair re-reads the memo rather than re-running the normalizers. If it
    // ever stops doing that, the Errores sheet doubles and criterion 7 stops reconciling.
    const ctx = makeCtx();
    const result = schema.parseRow(
        row({ "APELLIDOS Y NOMBRES": "X Y", "ESTADO": 184, "HPT": -8, "GENERO": "undefined" }),
        ctx
    );
    for (const col of ["ESTADO", "HPT", "GENERO"]) {
        const n = result.issues.filter(i => i.columna === col).length;
        assert.equal(n, 1, `${col} reported ${n} times, expected 1`);
    }
});

/* ------------------------------------------------------------------ *
 * Output contract
 * ------------------------------------------------------------------ */

test("the record carries the 18 canonical keys in order, then provenance", () => {
    const ctx = makeCtx();
    const result = schema.parseRow(row({ "APELLIDOS Y NOMBRES": "X Y" }), ctx);
    assert.deepEqual(Object.keys(result.record), [...CANONICAL, "provenance"]);
});

test("provenance survives from the row, and beats the ctx default", () => {
    const ctx = makeCtx();
    const result = schema.parseRow(
        Object.assign(row({ "APELLIDOS Y NOMBRES": "X Y" }), {
            provenance: {
                subcontratista: "COBRA PERU S.A",
                archivo: "cobra.xlsx",
                hoja: "Cuadro",
                filaOrigen: 646,
                celdaAncla: "A1",
            },
        }),
        ctx
    );
    assert.deepEqual(result.record.provenance, {
        subcontratista: "COBRA PERU S.A",
        archivo: "cobra.xlsx",
        hoja: "Cuadro",
        filaOrigen: 646,
        celdaAncla: "A1",
    });
    assert.deepEqual(result.provenance, result.record.provenance);
});

test("issues carry the real source cell address when a headerMap is supplied", () => {
    // 03 §2: filaOrigen/celdaOrigen are what turn "unparseable date" into
    // "cell F1743 of SUBCONTRATA X/reporte.xlsx".
    const ctx = makeCtx({ headerMap: fullHeaderMap() });
    const raw = Object.assign(row({ "APELLIDOS Y NOMBRES": "X Y", "FECHA NACIMIENTO": "09/10/205", "ESTADO": 184 }), {
        provenance: { subcontratista: "S", archivo: "a.xlsx", hoja: "Cuadro", filaOrigen: 1743 },
    });
    const result = schema.parseRow(raw, ctx);
    const fecha = result.issues.find(i => i.columna === "FECHA NACIMIENTO");
    const estado = result.issues.find(i => i.columna === "ESTADO");
    assert.equal(fecha.celda, "F1743");
    assert.equal(estado.celda, "P1743");
    assert.equal(fecha.archivo, "a.xlsx");
    assert.equal(fecha.subcontratista, "S");
});

test("without a headerMap the column and row are still reported, celda is null", () => {
    // Never invent the template's own letter: the value did not come from there.
    const ctx = makeCtx();
    const result = schema.parseRow(row({ "APELLIDOS Y NOMBRES": "X Y", "ESTADO": 160 }), ctx);
    const issue = result.issues.find(i => i.columna === "ESTADO");
    assert.equal(issue.celda, null);
    assert.equal(issue.fila, 2);
    assert.equal(issue.columna, "ESTADO");
});

/* ------------------------------------------------------------------ *
 * Requiredness
 * ------------------------------------------------------------------ */

test("a column absent from the whole workbook is not re-reported per row", () => {
    // BUG-55: the older input format stops at TIPO DE CONTRATO LABORAL. workbook.js
    // already recorded one COLUMN_MISSING warning for the file; 5,065 more would bury it.
    const ctx = makeCtx({ headerMap: fullHeaderMap(["HPT"]) });
    const result = schema.parseRow(row({ "APELLIDOS Y NOMBRES": "X Y" }), ctx);
    assert.equal(result.record["HPT"], null);
    assert.equal(result.issues.filter(i => i.columna === "HPT").length, 0);

    // ... but a blank cell in a column that DOES exist is reported.
    const ctx2 = makeCtx({ headerMap: fullHeaderMap() });
    const r2 = schema.parseRow(row({ "APELLIDOS Y NOMBRES": "X Y" }), ctx2);
    assert.equal(r2.issues.filter(i => i.columna === "HPT" && i.code === CODE.REQUIRED_MISSING).length, 1);
});

test("missingColumns is accepted instead of a headerMap", () => {
    const ctx = makeCtx({ missingColumns: ["HPT"] });
    const result = schema.parseRow(row({ "APELLIDOS Y NOMBRES": "X Y" }), ctx);
    assert.equal(result.issues.filter(i => i.columna === "HPT").length, 0);
});

test("a required field is reported once, by whichever module has something to say", () => {
    // ESTADO = 184 is out of domain AND ends up null. codes.js already explained it;
    // adding REQUIRED_MISSING on top would double-count the same cell.
    const ctx = makeCtx({ headerMap: fullHeaderMap() });
    const result = schema.parseRow(row({ "APELLIDOS Y NOMBRES": "X Y", "ESTADO": 184 }), ctx);
    const estado = result.issues.filter(i => i.columna === "ESTADO");
    assert.equal(estado.length, 1);
    assert.equal(estado[0].code, CODE.CODE_OUT_OF_DOMAIN);
});

test("optional columns never raise REQUIRED_MISSING when blank", () => {
    const ctx = makeCtx({ headerMap: fullHeaderMap() });
    const result = schema.parseRow(row({ "APELLIDOS Y NOMBRES": "X Y" }), ctx);
    const complained = new Set(
        result.issues.filter(i => i.code === CODE.REQUIRED_MISSING).map(i => i.columna)
    );
    for (const optional of [
        "TIPO TRABAJADOR",
        "NOMBRE DE OBRA DONDE ESTA ASIGNADO DURANTE EL MES REPORTADO",
        "DOMICILIO DE TRABAJADOR",
        "FECHA CESE/BAJA",
        "TIPO DE CONTRATO LABORAL",
    ]) {
        assert.ok(!complained.has(optional), `${optional} is optional and must not raise REQUIRED_MISSING`);
    }
    // ... and the required ones do, exactly once each.
    for (const required of schema.REQUIRED_COLUMNS) {
        if (required === "APELLIDOS Y NOMBRES") continue;  // supplied
        assert.ok(complained.has(required), `${required} is required and must raise REQUIRED_MISSING`);
    }
});

test("REQUIRED_COLUMNS is 03 §2's Required column, and FECHA CESE/BAJA is not in it", () => {
    // Its emptiness IS the "still employed" signal - 3,802 of 5,065 rows in the last run.
    assert.ok(!schema.REQUIRED_COLUMNS.includes("FECHA CESE/BAJA"));
    assert.deepEqual(schema.ROW_REQUIRED, ["APELLIDOS Y NOMBRES"]);
});

/* ------------------------------------------------------------------ *
 * The zod layer itself
 * ------------------------------------------------------------------ */

test("the validators reject every value the acceptance criteria forbid", () => {
    const V = schema.VALIDATORS;
    // criterion 11: zero NaN, ESTADO in {1,2,3}, TIPO DE CONTRATO LABORAL in {1,2,3,4}.
    for (const bad of [184, 160, 0, 0.03, 5, 10, 11, 14, NaN, "1"]) {
        assert.equal(V["ESTADO"].safeParse(bad).success, false, `ESTADO must reject ${String(bad)}`);
    }
    for (const bad of [0, 0.03, 5, 10, 11, 14, NaN]) {
        assert.equal(V["TIPO DE CONTRATO LABORAL"].safeParse(bad).success, false);
    }
    // criterion 12: the literal string "undefined" is unrepresentable.
    for (const bad of ["undefined", "MASCULINO", "M", 1, "", "masculino "]) {
        assert.equal(V["GENERO"].safeParse(bad).success, false, `GENERO must reject ${JSON.stringify(bad)}`);
    }
    assert.equal(V["GENERO"].safeParse("masculino").success, true);
    assert.equal(V["GENERO"].safeParse(null).success, true);
    // criterion 9: a date is an integer serial or empty - never text, never fractional.
    for (const bad of ["34519", 34519.5, NaN, Infinity, ""]) {
        assert.equal(V["FECHA NACIMIENTO"].safeParse(bad).success, false);
    }
    assert.equal(V["FECHA NACIMIENTO"].safeParse(34519).success, true);
    // criterion 15: no empty strings inside Tabla2.
    for (const name of ["EMPRESA", "CONTRATISTA PRNCIPAL", "RUC", "Nro. DNI / CE"]) {
        assert.equal(V[name].safeParse("").success, false, `${name} must reject ""`);
    }
    // §2 row 18: HPT >= 0, finite.
    for (const bad of [-1, NaN, Infinity, "8"]) {
        assert.equal(V["HPT"].safeParse(bad).success, false);
    }
    assert.equal(V["HPT"].safeParse(0).success, true, "0 hours is a real value, not an absence");
    // The one non-nullable field.
    assert.equal(V["APELLIDOS Y NOMBRES"].safeParse(null).success, false);
});

test("a validator rejection nulls the field and says so - the second gate", () => {
    // HPT = -8 passes prepareNumber (it is a finite number) and is caught by
    // z.number().nonnegative(). This is the repair path, exercised end to end.
    const ctx = makeCtx({ headerMap: fullHeaderMap() });
    const result = schema.parseRow(
        row({ "APELLIDOS Y NOMBRES": "X Y", "HPT": -8, "EMPRESA": "REAL SAC" }),
        ctx
    );
    assert.equal(result.ok, true);
    assert.equal(result.record["HPT"], null);
    assert.equal(result.record["EMPRESA"], "REAL SAC", "the repair pass keeps the other fields");
    const hpt = result.issues.find(i => i.columna === "HPT");
    assert.equal(hpt.severity, SEVERITY.WARNING);
    assert.match(hpt.message, /no cumple el esquema/);
    assert.equal(hpt.valor, -8);
});

test("every validator is a zod schema and every canonical column has one", () => {
    assert.deepEqual(Object.keys(schema.VALIDATORS), [...CANONICAL]);
    assert.deepEqual(Object.keys(schema.COLUMN_KIND), [...CANONICAL]);
    for (const name of CANONICAL) {
        assert.equal(typeof schema.VALIDATORS[name].safeParse, "function", name);
    }
});

test("buildRowSchema produces a zod object whose keys are the canonical columns", () => {
    const s = schema.buildRowSchema(makeCtx());
    assert.deepEqual(Object.keys(s.shape), [...CANONICAL]);
    // The `provenance` key workbook.js stamps is stripped, not carried into the shape.
    assert.ok(!("provenance" in s.shape));
});

/* ------------------------------------------------------------------ *
 * Cross-field and period
 * ------------------------------------------------------------------ */

test("a cese before the start date nulls the cese, not the start", () => {
    const ctx = makeCtx();
    const result = schema.parseRow(
        row({
            "APELLIDOS Y NOMBRES": "X Y",
            "FECHA INICIO DE LABORES EN OBRA": 45971,
            "FECHA CESE/BAJA": 45900,
        }),
        ctx
    );
    assert.equal(result.record["FECHA INICIO DE LABORES EN OBRA"], 45971);
    assert.equal(result.record["FECHA CESE/BAJA"], null);
    const issue = result.issues.find(i => i.code === CODE.DATE_IMPLAUSIBLE);
    assert.equal(issue.columna, "FECHA CESE/BAJA");
    assert.deepEqual(issue.detalle.ceseSerial, 45900);
    assert.deepEqual(issue.detalle.inicioSerial, 45971);
});

test("a cese on the start date is legal", () => {
    const ctx = makeCtx();
    const result = schema.parseRow(
        row({
            "APELLIDOS Y NOMBRES": "X Y",
            "FECHA INICIO DE LABORES EN OBRA": 45971,
            "FECHA CESE/BAJA": 45971,
        }),
        ctx
    );
    assert.equal(result.record["FECHA CESE/BAJA"], 45971);
    assert.equal(result.issues.filter(i => i.code === CODE.DATE_IMPLAUSIBLE).length, 0);
});

test("plausibility is evaluated against the report period, never the wall clock", () => {
    // The same raw start date is in range for a FEBRERO 2026 run and out of range for a
    // FEBRERO 2025 one. If this ever stopped depending on ctx.period, criterion 26
    // ("same inputs + same period => same numbers, whenever the run happens") would fail.
    const raw = row({ "APELLIDOS Y NOMBRES": "X Y", "FECHA INICIO DE LABORES EN OBRA": 46052 });

    const near = schema.parseRow(raw, makeCtx({ period: parsePeriod("2026-02") }));
    assert.equal(near.record["FECHA INICIO DE LABORES EN OBRA"], 46052);

    const far = schema.parseRow(raw, makeCtx({ period: parsePeriod("2025-02") }));
    assert.equal(far.record["FECHA INICIO DE LABORES EN OBRA"], null);
    assert.equal(far.issues.some(i => i.code === CODE.DATE_IMPLAUSIBLE), true);
});

test("a missing period is a wiring error and throws", () => {
    assert.throws(() => schema.parseRow(row({}), { issues: new IssueList() }), /ctx\.period is required/);
    assert.throws(() => schema.buildRowSchema(undefined), TypeError);
});

test("a 1904 workbook refuses its dates rather than shifting them 1,462 days", () => {
    const ctx = makeCtx({ date1904: true, headerMap: fullHeaderMap() });
    const result = schema.parseRow(
        row({ "APELLIDOS Y NOMBRES": "X Y", "FECHA NACIMIENTO": 34519 }),
        ctx
    );
    assert.equal(result.record["FECHA NACIMIENTO"], null);
    assert.equal(result.issues.some(i => i.code === CODE.DATE_SYSTEM_1904), true);
});

/* ------------------------------------------------------------------ *
 * Whole-record invariants over the entire table
 * ------------------------------------------------------------------ */

test("no record ever contains NaN, undefined, or an empty string", () => {
    // Acceptance criteria 11, 12 and 15, asserted structurally rather than per case.
    for (const c of TABLE.cases) {
        const result = schema.parseRow(row(c.input), makeCtx());
        if (!result.record) continue;
        for (const canonical of CANONICAL) {
            const v = result.record[canonical];
            assert.ok(v !== undefined, `${c.id}/${canonical}: undefined`);
            assert.ok(!(typeof v === "number" && Number.isNaN(v)), `${c.id}/${canonical}: NaN`);
            assert.ok(v !== "", `${c.id}/${canonical}: empty string`);
            assert.ok(v !== "undefined", `${c.id}/${canonical}: the literal "undefined"`);
        }
    }
});

test("identifiers stay text and dates stay integers, over the whole table", () => {
    for (const c of TABLE.cases) {
        const result = schema.parseRow(row(c.input), makeCtx());
        if (!result.record) continue;
        for (const id of ["RUC", "Nro. DNI / CE"]) {
            const v = result.record[id];
            assert.ok(v === null || typeof v === "string", `${c.id}/${id}: must be text (criterion 13)`);
        }
        for (const d of ["FECHA NACIMIENTO", "FECHA CESE/BAJA", "FECHA INICIO DE LABORES EN OBRA"]) {
            const v = result.record[d];
            assert.ok(
                v === null || Number.isInteger(v),
                `${c.id}/${d}: must be an integer serial or empty (criterion 9)`
            );
        }
    }
});

test("parsing is deterministic: the same row twice gives the same record and issues", () => {
    for (const c of TABLE.cases) {
        const a = schema.parseRow(row(c.input), makeCtx());
        const b = schema.parseRow(row(c.input), makeCtx());
        assert.deepEqual(a.record, b.record, `${c.id}: record`);
        assert.deepEqual(summarize(a.issues), summarize(b.issues), `${c.id}: issues`);
    }
});

test("one ctx parses many rows without leaking state between them", () => {
    // The schema is compiled once and the per-row scratch space is reused; a leak here
    // would show up as one row inheriting the previous row's memoized cells.
    const ctx = makeCtx({ headerMap: fullHeaderMap() });
    const dirty = schema.parseRow(row({ "APELLIDOS Y NOMBRES": "A B", "ESTADO": 184, "HPT": 100 }), ctx);
    const clean = schema.parseRow(row({ "APELLIDOS Y NOMBRES": "C D", "ESTADO": 2, "HPT": 200 }), ctx);
    assert.equal(dirty.record["ESTADO"], null);
    assert.equal(clean.record["ESTADO"], 2);
    assert.equal(clean.record["APELLIDOS Y NOMBRES"], "C D");
    assert.equal(clean.record["HPT"], 200);
    assert.equal(clean.issues.some(i => i.valor === 184), false, "no issue leaked from the previous row");
    assert.equal(ctx.issues.length, dirty.issues.length + clean.issues.length);
});

test("createRowParser compiles once and behaves identically", () => {
    const parser = schema.createRowParser(makeCtx({ headerMap: fullHeaderMap() }));
    const a = parser.parseRow(row({ "APELLIDOS Y NOMBRES": "A B", "ESTADO": 184 }));
    const b = schema.parseRow(row({ "APELLIDOS Y NOMBRES": "A B", "ESTADO": 184 }), makeCtx({ headerMap: fullHeaderMap() }));
    assert.deepEqual(a.record, b.record);
    assert.deepEqual(summarize(a.issues), summarize(b.issues));
    assert.equal(parser.issues.length, a.issues.length);
});

/* ------------------------------------------------------------------ *
 * Purity and performance
 * ------------------------------------------------------------------ */

test("the module reads no clock", () => {
    // Determinism is the point of this rework (criteria 26-27). A wall-clock read here
    // would make the plausibility windows drift between two runs of the same period.
    const src = fs.readFileSync(path.join(__dirname, "..", "pipeline", "schema.js"), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
    for (const banned of ["new Date(", "Date.now(", "toLocaleString", "Intl.", "Math.random"]) {
        assert.ok(!src.includes(banned), `schema.js must not use ${banned}`);
    }
});

test("5,000 rows parse well under a second", () => {
    // 05 §3 Phase 2 verification: safeParse over 5,065 synthetic rows was measured at
    // 11.9 ms in the research, so there is no performance argument for bailing early on
    // the first bad cell.
    const templates = TABLE.cases.filter(c => c.expectedOk !== false).map(c => row(c.input));
    const rows = [];
    for (let i = 0; i < 5000; i++) {
        const base = templates[i % templates.length];
        rows.push(Object.assign({}, base, {
            "APELLIDOS Y NOMBRES": `TRABAJADOR NUMERO ${i}`,
            provenance: { subcontratista: `S${i % 120}`, archivo: "r.xlsx", hoja: "Cuadro", filaOrigen: i + 2 },
        }));
    }

    const ctx = makeCtx({ headerMap: fullHeaderMap() });
    const parser = schema.createRowParser(ctx);
    const t0 = process.hrtime.bigint();
    let accepted = 0;
    for (const r of rows) if (parser.parseRow(r).ok) accepted++;
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    assert.equal(accepted, 5000, "every synthetic row is accepted");
    assert.ok(ms < 1000, `5,000 rows took ${ms.toFixed(1)} ms, expected well under 1000`);
});

test("5,000 rows produce zero NaN and zero \"undefined\" in the output", () => {
    const templates = TABLE.cases.map(c => row(c.input));
    const ctx = makeCtx({ headerMap: fullHeaderMap() });
    const parser = schema.createRowParser(ctx);
    let written = 0;
    let rejected = 0;
    for (let i = 0; i < 5000; i++) {
        const r = parser.parseRow(Object.assign({}, templates[i % templates.length], {
            provenance: { subcontratista: "S", archivo: "r.xlsx", hoja: "Cuadro", filaOrigen: i + 2 },
        }));
        if (!r.ok) { rejected++; continue; }
        written++;
        for (const canonical of CANONICAL) {
            const v = r.record[canonical];
            assert.ok(!(typeof v === "number" && Number.isNaN(v)));
            assert.ok(v !== "undefined" && v !== undefined && v !== "");
        }
    }
    // criterion 7: found - rejected = accepted, with nothing lost or invented.
    assert.equal(written + rejected, 5000);
    assert.ok(rejected > 0, "the table contains rejected rows, so the arithmetic is not vacuous");
});

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

test("rowIsEmpty ignores whitespace and the provenance key", () => {
    assert.equal(schema.rowIsEmpty({}), true);
    assert.equal(schema.rowIsEmpty(null), true);
    assert.equal(schema.rowIsEmpty(row({})), true);
    assert.equal(schema.rowIsEmpty(row({ "EMPRESA": "   " })), true);
    assert.equal(schema.rowIsEmpty({ provenance: { archivo: "a.xlsx" } }), true);
    assert.equal(schema.rowIsEmpty(row({ "HPT": 0 })), false, "0 is a value");
    assert.equal(schema.rowIsEmpty(row({ "GENERO": "undefined" })), false);
});

test("isNumericName matches workbook.js on every value a cell can hold", () => {
    // Two implementations of the 643-row header-shift rule that disagreed would be worse
    // than one, so parity is asserted rather than assumed.
    const workbook = require("../pipeline/workbook");
    for (const v of [20101155588, "20101155588", " 20101155588 ", "09994533", 0, "1234567",
        "123456789012", "OCHOA ARTEAGA", "20101155588 X", null, undefined, true, false, ""]) {
        assert.equal(
            schema.isNumericName(v),
            workbook.isNumericName(v),
            `isNumericName disagreed on ${JSON.stringify(v)} (${typeof v})`
        );
    }

    // The one deliberate divergence: workbook.js calls any `typeof "number"` a numeric
    // name, which makes NaN one. NaN is not eight-to-eleven digits, and reporting it as
    // "the columns are shifted" would send the operator hunting for a shift that is not
    // there - the honest reason is that the cell holds no name at all. Both paths reject
    // the row; only the code in the Errores sheet differs.
    assert.equal(schema.isNumericName(NaN), false);
    const result = schema.parseRow({ "APELLIDOS Y NOMBRES": NaN, "EMPRESA": "X SAC" }, makeCtx());
    assert.equal(result.ok, false);
    assert.equal(result.reason, CODE.REQUIRED_MISSING);
});

test("emptyRecord is 18 nulls in canonical order", () => {
    const r = schema.emptyRecord();
    assert.deepEqual(Object.keys(r), [...CANONICAL]);
    assert.ok(Object.values(r).every(v => v === null));
});

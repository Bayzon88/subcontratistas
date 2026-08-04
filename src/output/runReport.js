"use strict";
/**
 * The operator-facing run report (03-expected-output.md §8, 05-implementation-plan.md
 * Phase 1 task 9 and Phase 2 task 8).
 *
 * WHY THIS MODULE EXISTS. The single most damaging defect in the current app is not a
 * wrong number, it is a missing one: `catch { console.log("Error with: " + directory) }`
 * at `src/excelConsolidation.js:74-77`, printed to a terminal that `console.clear()` at
 * line 284 has already wiped. A whole subcontratista's workforce disappears into an
 * output that still looks complete, and nothing anywhere says so. 05 §1 principle 4 is
 * the answer - "fail loudly, once, with the subcontratista's name attached" - and this
 * file is where that happens.
 *
 * Hence the two rules the layout is built around:
 *
 *  1. THE FAILED COUNT LEADS. It is row 1 of the sheet, it is never zero-suppressed, and
 *     every subcontratista whose workbook could not be read is NAMED in the first rows -
 *     not on line 3,900 under four thousand INFO lines.
 *  2. THE ACTIONABLE READS FIRST. Issues sort FAILED -> ERROR -> WARNING -> INFO and,
 *     inside a severity, group by subcontratista. The truncation cap, if it ever fires,
 *     therefore drops INFO lines and never a FAILED one.
 *
 * WHAT THIS MODULE DOES NOT DO: it writes nothing. `buildErroresSheet` returns an
 * array-of-arrays for `output/template.js` to append as the `Errores` worksheet (and to
 * serialize as the standalone CSV of 03 §8.1 if it wants one - same array), and
 * `buildRunLog` returns the plain object `run.js` writes as run.json. Pure in, pure out,
 * fully testable without an Excel round-trip.
 *
 * DETERMINISM (05 §1 principle 3). No clock. There is deliberately NO timestamp in
 * run.json: two runs of the same inputs for the same period must produce byte-comparable
 * output (AC 26), and a `generatedAt` would break that for no operational gain. If a run
 * ever needs one, `run.js` passes it in explicitly as `stats.ejecucion`.
 *
 * THE FOLDER-NAME CHECK (05 §8 Q8) lives here too. `src/discrepancias.js` was meant to
 * compare the company name inside each workbook against the folder it arrived in and
 * never finished the job; the file is gone and the idea is `checkFolderNames()` below,
 * reported as CODE.FOLDER_NAME_MISMATCH at WARNING.
 */

const { SEVERITY, CODE, IssueList } = require("../pipeline/issues");
const { normalizeText } = require("../pipeline/text");
const { conservationCheck } = require("../pipeline/dedupe");
const { parsePeriod } = require("../pipeline/period");

/** The worksheet `output/template.js` appends this array-of-arrays as. */
const SHEET_NAME = "Errores";

/**
 * Issue-table columns. The first nine are 03 §8.1's list, verbatim and in its order -
 * that list is the acceptance contract, so it is not reordered for taste. `codigo` and
 * `detalle` are appended: the code is what `countsByCode()` groups on and what a bug
 * report can be filed against, and `detalle` carries the structured payload (matched
 * date format, accepted alias, duplicate sources) that would otherwise only exist in
 * run.json - which the operator working in Excel never opens.
 */
const ERRORES_COLUMNS = Object.freeze([
    "subcontratista", "archivo", "hoja", "fila", "celda", "columna",
    "valor crudo", "motivo", "severidad", "codigo", "detalle",
]);

/**
 * Reading order, most alarming first. This is the REVERSE of issues.js SEVERITY_ORDER,
 * which is ascending by design (it is the order counts are reported in); here the
 * operator's eye starts at the top and must land on what stops the report being
 * trustworthy.
 */
const DISPLAY_SEVERITY_ORDER = Object.freeze([
    SEVERITY.FAILED, SEVERITY.ERROR, SEVERITY.WARNING, SEVERITY.INFO,
]);

const SEVERITY_RANK = new Map(DISPLAY_SEVERITY_ORDER.map((s, i) => [s, i]));

/** Canonical columns compared against the folder name. The typo in C is load-bearing. */
const EMPRESA_COLUMN = "EMPRESA";
const CONTRATISTA_COLUMN = "CONTRATISTA PRNCIPAL";

/**
 * Cell text cap. Excel's own limit is 32,767 characters, but a `detalle` carrying the
 * 643 sources of a pathological duplicate group would make the column unreadable long
 * before that. Truncated text is marked, never silently shortened.
 */
const MAX_CELL_TEXT = 900;

/**
 * Issue rows written into the sheet. 4,894 text dates in one real month means the INFO
 * tail is genuinely thousands of lines; this is a guard against a pathological run
 * producing a sheet nobody can open, not an expected code path. Because the rows are
 * sorted FAILED-first, truncation can only ever discard INFO.
 */
const MAX_ISSUE_ROWS = 20000;

/** Distinct values named inline in a summary cell before "+N mas". */
const MAX_LISTED = 8;

// ---------------------------------------------------------------------------
// Deterministic comparators
//
// localeCompare is never used anywhere in this pipeline: a sort whose result depends on
// the host's ICU data is exactly the non-determinism the rework removes (dedupe.js says
// the same thing at more length). Code-unit order, nulls last.
// ---------------------------------------------------------------------------

function compareText(a, b) {
    const an = a === null || a === undefined || a === "";
    const bn = b === null || b === undefined || b === "";
    if (an && bn) return 0;
    if (an) return 1;
    if (bn) return -1;
    return a < b ? -1 : a > b ? 1 : 0;
}

function compareNumber(a, b) {
    const an = typeof a !== "number" || !Number.isFinite(a);
    const bn = typeof b !== "number" || !Number.isFinite(b);
    if (an && bn) return 0;
    if (an) return 1;
    if (bn) return -1;
    return a - b;
}

/** Display rank of a severity; anything unknown sorts after INFO rather than throwing. */
function severityRank(severity) {
    const r = SEVERITY_RANK.get(severity);
    return r === undefined ? DISPLAY_SEVERITY_ORDER.length : r;
}

// ---------------------------------------------------------------------------
// Cell rendering
//
// Three rules from 05 §1 principle 5, enforced here rather than trusted: never write
// NaN, never write the literal string "undefined", never write "" where a reader would
// mistake it for "no finding".
// ---------------------------------------------------------------------------

function truncate(text) {
    if (typeof text !== "string" || text.length <= MAX_CELL_TEXT) return text;
    return `${text.slice(0, MAX_CELL_TEXT)}... (+${text.length - MAX_CELL_TEXT} caracteres)`;
}

/**
 * A general cell value. `undefined` becomes null and NEVER the string "undefined" (AC 12
 * greps the whole workbook for that token). A non-finite number becomes the parenthesised
 * marker "(NaN)" rather than the bare token, so the evidence survives without tripping
 * the structural NaN assertion of 05 Phase 0 task 4(f).
 */
function cellValue(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : `(${String(raw)})`;
    if (typeof raw === "string") return truncate(raw);
    if (typeof raw === "boolean" || typeof raw === "bigint") return String(raw);
    if (raw instanceof Date) {
        // toISOString, never toString: the latter is timezone- and locale-dependent.
        return Number.isNaN(raw.getTime()) ? "(fecha invalida)" : raw.toISOString().slice(0, 10);
    }
    return jsonCell(raw);
}

/**
 * The `valor crudo` column. Same rules, plus: an empty or whitespace-only string is
 * rendered as a marker instead of an empty cell. "the sentinel was an empty string" and
 * "there is no raw value for this issue" are different findings and an empty cell cannot
 * tell them apart - which matters for the FECHA CESE/BAJA sentinels (03 AC 10), where
 * `""` x3,801 and `" "` x1 are the actual data.
 */
function rawCell(raw) {
    if (typeof raw === "string") {
        if (raw === "") return "(vacio)";
        if (raw.trim() === "") return `(solo espacios: ${raw.length})`;
    }
    return cellValue(raw);
}

/** `detalle` as compact JSON. Never throws: a cyclic payload is reported, not fatal. */
function jsonCell(value) {
    if (value === null || value === undefined) return null;
    try {
        const text = JSON.stringify(value);
        return text === undefined ? null : truncate(text);
    } catch (err) {
        return `(detalle no serializable: ${err.message})`;
    }
}

/** "a, b, c (+4 mas)" - one cell, bounded, deterministic. */
function joinList(values, limit = MAX_LISTED) {
    const list = (values || []).filter(v => v !== null && v !== undefined && v !== "");
    if (list.length === 0) return null;
    const shown = list.slice(0, limit).map(String);
    const rest = list.length - shown.length;
    return truncate(rest > 0 ? `${shown.join(", ")} (+${rest} mas)` : shown.join(", "));
}

// ---------------------------------------------------------------------------
// Inputs, defensively read
// ---------------------------------------------------------------------------

/** Accepts an IssueList, a plain array of issues, or nothing at all. */
function itemsOf(issues) {
    if (!issues) return [];
    if (Array.isArray(issues)) return issues;
    if (Array.isArray(issues.items)) return issues.items;
    return [];
}

function severityCounts(issues, items) {
    if (issues && typeof issues.counts === "function") return issues.counts();
    const out = {};
    // issues.js reports ascending; mirror it exactly so the two paths are interchangeable.
    for (const s of [SEVERITY.INFO, SEVERITY.WARNING, SEVERITY.ERROR, SEVERITY.FAILED]) out[s] = 0;
    for (const i of items) out[i.severity] = (out[i.severity] || 0) + 1;
    return out;
}

function codeCounts(issues, items) {
    if (issues && typeof issues.countsByCode === "function") return issues.countsByCode();
    const m = new Map();
    for (const i of items) m.set(i.code, (m.get(i.code) || 0) + 1);
    // Descending, ties left in first-seen order - byte-for-byte what IssueList
    // countsByCode() does, so an array input and an IssueList input are interchangeable.
    return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
}

/**
 * The period, as a descriptor. A "YYYY-MM" string is parsed (parsePeriod throws
 * PeriodError on a malformed one - that is a caller bug, not a data problem, so it is
 * not swallowed into an issue). Absent, the report is still well-formed and says so.
 */
function resolvePeriod(period) {
    if (period === null || period === undefined) return null;
    if (typeof period === "string") return parsePeriod(period);
    return period;
}

function periodLabel(p) {
    return p && p.etiqueta ? p.etiqueta : "(sin periodo)";
}

/** number|null from anything; never NaN. */
function num(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function firstNum(...values) {
    for (const v of values) {
        const n = num(v);
        if (n !== null) return n;
    }
    return null;
}

/**
 * One workbook's numbers, read out of whatever shape the caller had to hand.
 *
 * `readWorkbook()` returns `{ok, provenance, headerMap, anchor, missingColumns, stats}`,
 * so `{...readWorkbook(...), subcontratista, archivo}` passes through unchanged; a
 * hand-built `{subcontratista, rowsFound, rowsRejected, rowsWritten}` also works. Both
 * spellings are accepted because a run report that only works when it is fed perfectly
 * is a run report nobody wires up.
 */
function readWorkbookStat(stat) {
    const s = stat && typeof stat === "object" ? stat : {};
    const inner = s.stats && typeof s.stats === "object" ? s.stats : {};
    const prov = s.provenance && typeof s.provenance === "object" ? s.provenance : {};
    const anchor = s.anchor && typeof s.anchor === "object" ? s.anchor : null;
    return {
        subcontratista: s.subcontratista ?? prov.subcontratista ?? prov.carpetaSubcontratista ?? null,
        archivo: s.archivo ?? prov.archivo ?? null,
        hoja: s.hoja ?? prov.hoja ?? null,
        ok: s.ok === undefined ? null : Boolean(s.ok),
        bytes: firstNum(s.bytes, s.size, prov.bytes),
        ancla: typeof s.anchor === "string" ? s.anchor : (anchor ? anchor.celda : (prov.celdaAncla ?? null)),
        filaEncabezado: anchor ? firstNum(anchor.fila) : null,
        rangoEncabezados: anchor ? (anchor.rangoEncabezados ?? null) : null,
        headerMap: s.headerMap && typeof s.headerMap === "object" ? s.headerMap : null,
        missingColumns: Array.isArray(s.missingColumns) ? s.missingColumns : [],
        filasLeidas: firstNum(inner.rowsFound, s.rowsFound, s.filasLeidas),
        filasRechazadas: firstNum(inner.rowsRejected, s.rowsRejected, s.filasRechazadas),
        filasAceptadas: firstNum(inner.rowsReturned, s.rowsReturned, s.rowsWritten, s.filasAceptadas,
            Array.isArray(s.rows) ? s.rows.length : null),
        filasVacias: firstNum(inner.blankRows, s.blankRows),
    };
}

/** The per-workbook array, under either spelling. */
function workbookStatsOf(stats) {
    const s = stats && typeof stats === "object" ? stats : {};
    const list = Array.isArray(s.workbooks) ? s.workbooks
        : Array.isArray(s.archivos) ? s.archivos
            : [];
    return list.map(readWorkbookStat);
}

/**
 * The dedupe half of `stats`. Accepts `dedupe: result` (the whole `dedupe()` return) or
 * `dedupe: result.stats`, plus explicit `collapsed` / `written` overrides.
 */
function dedupeInfoOf(stats) {
    const s = stats && typeof stats === "object" ? stats : {};
    const whole = s.dedupe && Array.isArray(s.dedupe.kept) ? s.dedupe : null;
    const dstats = whole ? whole.stats : (s.dedupe && typeof s.dedupe === "object" ? s.dedupe : null);
    const groups = Array.isArray(s.collapsed) ? s.collapsed
        : whole && Array.isArray(whole.collapsed) ? whole.collapsed
            : null;
    const cross = Array.isArray(s.crossSubcontratista) ? s.crossSubcontratista
        : whole && Array.isArray(whole.crossSubcontratista) ? whole.crossSubcontratista
            : [];
    let collapsed = num(s.collapsed);
    if (collapsed === null && dstats) collapsed = num(dstats.rowsCollapsed);
    if (collapsed === null && groups) {
        collapsed = 0;
        for (const g of groups) collapsed += num(g && g.removed) ?? 0;
    }
    let written = firstNum(s.written, s.escritas);
    if (written === null && whole) written = whole.kept.length;
    if (written === null && dstats) written = num(dstats.rowsOut);
    return { stats: dstats, groups, cross, collapsed, written };
}

/**
 * Rows collapsed, attributed to the subcontratista whose copy was DISCARDED - not to the
 * winner. That is what makes the per-subcontratista arithmetic add up: the row left the
 * discarded copy's rollup, not the survivor's.
 */
function collapsedBySubcontratista(groups) {
    const out = new Map();
    if (!Array.isArray(groups)) return out;
    for (const g of groups) {
        const discarded = g && Array.isArray(g.discarded) ? g.discarded : [];
        for (const d of discarded) {
            const key = d && d.subcontratista ? d.subcontratista : null;
            out.set(key, (out.get(key) || 0) + 1);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// The folder-name check (05 §8 Q8; 03 §8.2 "contratista/empresa spellings that differ
// from a known value only by whitespace or punctuation")
// ---------------------------------------------------------------------------

/**
 * Comparison key, tier 2 of 3: text.js's normalizer (collapse whitespace runs, trim)
 * plus upper-casing, plus NFC.
 *
 * The NFC step is not decoration. A zip produced on macOS carries folder names in NFD,
 * so "CONSTRUCCIÓN" as a folder name is U+0301-decomposed while the same word typed into
 * the workbook is precomposed - byte-different, visually identical, and it would fire a
 * mismatch on every accented company in the run.
 */
function normalizedKey(value) {
    const r = normalizeText(value, { uppercase: true });
    return r.value === null ? "" : r.value.normalize("NFC");
}

/**
 * Comparison key, tier 3: additionally accent-folded and stripped of everything that is
 * not a letter or a digit, so "CLJ CONTRUCTORA S.A.C." and "CLJ CONTRUCTORA SAC" land on
 * one key.
 *
 * Folding here is safe in a way it would never be in text.js: this key is used ONLY to
 * decide whether to raise a warning. No delivered value is ever derived from it, so
 * BREÑA stays BREÑA in the Cuadro.
 */
function simplifiedKey(value) {
    return normalizedKey(value)
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^A-Z0-9 ]+/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * How closely two names agree. Only "ninguno" is reported: whitespace, case, accent form
 * and punctuation differences are exactly the trivia that would turn this check into
 * noise the operator learns to ignore (352 spellings for ~84 companies, 03 §2.1).
 *
 * @returns {"exacto"|"normalizado"|"simplificado"|"ninguno"}
 */
function agreementLevel(a, b) {
    if (typeof a === "string" && typeof b === "string" && a === b) return "exacto";
    const na = normalizedKey(a);
    const nb = normalizedKey(b);
    if (na === "" || nb === "") return "ninguno";
    if (na === nb) return "normalizado";
    const sa = simplifiedKey(a);
    const sb = simplifiedKey(b);
    if (sa !== "" && sa === sb) return "simplificado";
    return "ninguno";
}

const AGREEMENT_RANK = { exacto: 0, normalizado: 1, simplificado: 2, ninguno: 3 };

/** Distinct populated values of one canonical column, with a row count each. */
function tallyColumn(records, column) {
    const m = new Map();
    for (const r of records) {
        const raw = r ? r[column] : null;
        if (raw === null || raw === undefined) continue;
        const text = typeof raw === "string" ? raw : String(raw);
        if (text.trim() === "") continue;
        m.set(text, (m.get(text) || 0) + 1);
    }
    return [...m.entries()]
        .sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))
        .map(([valor, filas]) => ({ valor, filas }));
}

/**
 * Compare the EMPRESA / CONTRATISTA PRNCIPAL values found INSIDE each workbook against
 * the folder name they arrived in, and raise CODE.FOLDER_NAME_MISMATCH at WARNING when
 * they disagree (05 §8 Q8 - what src/discrepancias.js was for).
 *
 * A match on EITHER column is agreement: the folder is normally named after the
 * subcontratista (EMPRESA), but flat drops name it after the principal contractor, and
 * neither spelling is wrong. Which column matched is recorded, so "the folder is named
 * after the EPC" stays visible without being an error.
 *
 * WARNING, not ERROR: a folder named "CLJ" holding CLJ CONTRUCTORA SAC's real workers is
 * a labelling problem, and dropping a company's workforce over one is precisely the
 * behaviour this rework exists to delete (05 §8 Q7 makes the same call for RUCs).
 *
 * @param {Array<object>} records canonical records carrying `provenance`
 * @param {IssueList} [issues]    collector; a fresh one is used when omitted
 * @returns {{carpetas: Array<object>, issues: IssueList}}
 */
function checkFolderNames(records, issues) {
    const list = Array.isArray(records) ? records : [];
    const collector = issues || new IssueList();

    // Group by (folder, archivo): one workbook per folder is the rule zip.js enforces,
    // but a flat drop puts several files in the root folder and each must be judged on
    // its own contents.
    const groups = new Map();
    for (const r of list) {
        if (!r || typeof r !== "object") continue;
        const prov = r.provenance && typeof r.provenance === "object" ? r.provenance : r;
        const subcontratista = prov.subcontratista ?? prov.carpetaSubcontratista ?? null;
        if (subcontratista === null || String(subcontratista).trim() === "") continue;
        const archivo = prov.archivo ?? null;
        const key = `${subcontratista}\u0000${archivo === null ? "" : archivo}`;
        const bucket = groups.get(key);
        if (bucket) bucket.records.push(r);
        else groups.set(key, { subcontratista, archivo, hoja: prov.hoja ?? null, records: [r] });
    }

    const carpetas = [];
    for (const g of groups.values()) {
        const empresas = tallyColumn(g.records, EMPRESA_COLUMN);
        const contratistas = tallyColumn(g.records, CONTRATISTA_COLUMN);

        let best = { nivel: "ninguno", columna: null, valor: null };
        for (const { column, values } of [
            { column: EMPRESA_COLUMN, values: empresas },
            { column: CONTRATISTA_COLUMN, values: contratistas },
        ]) {
            for (const v of values) {
                const nivel = agreementLevel(g.subcontratista, v.valor);
                if (AGREEMENT_RANK[nivel] < AGREEMENT_RANK[best.nivel]) {
                    best = { nivel, columna: column, valor: v.valor };
                }
            }
        }

        const result = {
            subcontratista: g.subcontratista,
            archivo: g.archivo,
            hoja: g.hoja,
            filas: g.records.length,
            coincide: best.nivel !== "ninguno",
            nivel: best.nivel,
            columna: best.columna,
            valor: best.valor,
            empresas,
            contratistas,
        };
        carpetas.push(result);

        if (result.coincide) continue;

        const found = empresas.length > 0 ? empresas : contratistas;
        const columna = empresas.length > 0 ? EMPRESA_COLUMN : CONTRATISTA_COLUMN;
        const shown = joinList(found.map(v => `"${v.valor}" (${v.filas})`));
        collector.warning({
            code: CODE.FOLDER_NAME_MISMATCH,
            message: found.length === 0
                ? `la carpeta "${g.subcontratista}" no declara ${EMPRESA_COLUMN} ni ${CONTRATISTA_COLUMN} en "${g.archivo ?? "(sin archivo)"}" - no se puede confirmar de quien es el archivo`
                : `la carpeta "${g.subcontratista}" no coincide con ningun ${columna} declarado en "${g.archivo ?? "(sin archivo)"}": ${shown}`,
            subcontratista: g.subcontratista,
            archivo: g.archivo,
            hoja: g.hoja,
            columna,
            valor: g.subcontratista,
            detalle: {
                carpeta: g.subcontratista,
                empresas: empresas.slice(0, MAX_LISTED),
                contratistas: contratistas.slice(0, MAX_LISTED),
                filas: g.records.length,
                comparacion: "normalizado (espacios, mayusculas, acentos) y simplificado (sin puntuacion)",
            },
        });
    }

    carpetas.sort((a, b) => compareText(a.subcontratista, b.subcontratista)
        || compareText(a.archivo, b.archivo));
    return { carpetas, issues: collector };
}

// ---------------------------------------------------------------------------
// The model both artifacts are built from
//
// One summarize(), two renderers. The Errores sheet and run.json cannot disagree about
// how many subcontratistas failed, because neither of them counts.
// ---------------------------------------------------------------------------

/** Sorted issues: FAILED -> ERROR -> WARNING -> INFO, then grouped by subcontratista. */
function sortIssues(items) {
    return items
        .map((issue, index) => ({ issue, index }))
        .sort((a, b) =>
            severityRank(a.issue.severity) - severityRank(b.issue.severity)
            || compareText(a.issue.subcontratista, b.issue.subcontratista)
            || compareText(a.issue.archivo, b.issue.archivo)
            || compareNumber(a.issue.fila, b.issue.fila)
            || compareText(a.issue.celda, b.issue.celda)
            || compareText(a.issue.code, b.issue.code)
            // Original arrival order is the last tiebreak, so the sort is stable in the
            // strict sense and two runs over the same IssueList emit identical rows.
            || a.index - b.index)
        .map(e => e.issue);
}

/** Header aliases accepted for one subcontratista, as "CANONICO <- 'lo que decia'". */
function aliasesFor(stats, issueList) {
    const set = new Set();
    for (const s of stats) {
        if (!s.headerMap) continue;
        for (const [canonical, h] of Object.entries(s.headerMap)) {
            if (h && h.via === "alias") set.add(`${canonical} <- "${h.raw}"`);
        }
    }
    for (const i of issueList) {
        if (i.code !== CODE.HEADER_ALIAS_ACCEPTED) continue;
        if (i.columna) set.add(`${i.columna} <- "${i.valor}"`);
    }
    return [...set].sort(compareText);
}

/**
 * Per-subcontratista rollup: files seen / parsed / failed, rows in / rejected /
 * collapsed / written, the anchor cell that was used and the header aliases accepted.
 *
 * The anchor is on this row for one reason: a workbook whose header row was found in the
 * wrong place still reads, still produces rows, and still looks fine everywhere else. An
 * anchor of "A1" on seventeen folders and "C12" on the eighteenth is a wrong anchor
 * visible at a glance (05 Phase 1 task 2).
 *
 * A subcontratista that appears ONLY in the IssueList - the folder that failed before
 * anything could be read, which is the whole point of this report - still gets a row,
 * with null counts rather than zeros. Zero rows read and "we never got far enough to
 * read a row" are different facts and the sheet must not conflate them.
 */
function buildRollup(items, workbookStats, collapsedBySub) {
    const byName = new Map();
    const ensure = (name) => {
        const key = name === undefined ? null : name;
        let r = byName.get(key);
        if (!r) {
            r = {
                subcontratista: key,
                archivos: new Set(),
                archivosFallidos: new Set(),
                stats: [],
                issues: [],
                fallado: false,
            };
            byName.set(key, r);
        }
        return r;
    };

    for (const s of workbookStats) {
        const r = ensure(s.subcontratista);
        r.stats.push(s);
        if (s.archivo) r.archivos.add(s.archivo);
        if (s.ok === false) {
            r.fallado = true;
            if (s.archivo) r.archivosFallidos.add(s.archivo);
        }
    }
    for (const i of items) {
        if (i.subcontratista === null || i.subcontratista === undefined) continue;
        const r = ensure(i.subcontratista);
        r.issues.push(i);
        if (i.archivo) r.archivos.add(i.archivo);
        if (i.severity === SEVERITY.FAILED) {
            r.fallado = true;
            if (i.archivo) r.archivosFallidos.add(i.archivo);
        }
    }

    const rows = [];
    for (const r of byName.values()) {
        const hasStats = r.stats.length > 0;
        const sum = (field) => {
            let total = null;
            for (const s of r.stats) {
                const v = s[field];
                if (v === null) continue;
                total = (total === null ? 0 : total) + v;
            }
            return total;
        };
        // "we never read a row" is not "we read zero rows", and the difference is the
        // whole subject of this module. A workbook that FAILED carries no row counts at
        // all, so its rollup shows nulls; only a stat that actually reported one of the
        // three row figures makes the other two default to 0.
        const anyRows = r.stats.some(s =>
            s.filasLeidas !== null || s.filasRechazadas !== null || s.filasAceptadas !== null);
        const filasLeidas = anyRows ? (sum("filasLeidas") ?? 0) : null;
        const filasRechazadas = anyRows ? (sum("filasRechazadas") ?? 0) : null;
        const filasAceptadas = anyRows ? (sum("filasAceptadas") ?? 0) : null;
        const filasColapsadas = collapsedBySub.get(r.subcontratista) ?? (anyRows ? 0 : null);
        const filasEscritas = filasAceptadas === null || filasColapsadas === null
            ? null
            : filasAceptadas - filasColapsadas;

        const counts = severityCounts(null, r.issues);
        const severidades = DISPLAY_SEVERITY_ORDER.filter(s => counts[s] > 0);

        const anclas = [...new Set(r.stats.map(s => s.ancla).filter(v => v))].sort(compareText);
        const ausentes = [...new Set(r.stats.flatMap(s => s.missingColumns))].sort(compareText);
        const archivosProcesados = hasStats
            ? r.stats.filter(s => s.ok !== false).length
            : Math.max(r.archivos.size - r.archivosFallidos.size, 0);

        rows.push({
            subcontratista: r.subcontratista,
            fallado: r.fallado,
            archivosVistos: Math.max(r.archivos.size, r.stats.length),
            archivosProcesados,
            archivosFallidos: r.archivosFallidos.size,
            archivos: [...r.archivos].sort(compareText),
            filasLeidas,
            filasRechazadas,
            filasAceptadas,
            filasColapsadas,
            filasEscritas,
            // The per-row restatement of the conservation identity. null when the terms
            // are unknown - which is NOT the same as "conserved" and is not rendered as
            // if it were.
            conserva: filasLeidas === null || filasEscritas === null
                ? null
                : filasLeidas - filasRechazadas - filasColapsadas === filasEscritas,
            ancla: anclas.length > 0 ? anclas.join(", ") : null,
            hoja: [...new Set(r.stats.map(s => s.hoja).filter(v => v))].sort(compareText).join(", ") || null,
            aliases: aliasesFor(r.stats, r.issues),
            columnasAusentes: ausentes,
            incidencias: counts,
            severidadMaxima: severidades.length > 0 ? severidades[0] : null,
            motivosFallo: r.issues
                .filter(i => i.severity === SEVERITY.FAILED)
                .map(i => ({ codigo: i.code, motivo: i.message, archivo: i.archivo ?? null })),
        });
    }

    // Failures first, then alphabetically: the operator's eye lands on the broken ones
    // even in the per-subcontratista table.
    rows.sort((a, b) => (a.fallado === b.fallado ? 0 : a.fallado ? -1 : 1)
        || compareText(a.subcontratista, b.subcontratista));
    return rows;
}

/**
 * Everything both artifacts need, computed once.
 *
 * @param {IssueList|Array} issues
 * @param {object} [stats]
 * @param {object|string} [period]
 */
function summarize(issues, stats, period) {
    const items = itemsOf(issues);
    const s = stats && typeof stats === "object" ? stats : {};
    const periodo = resolvePeriod(period);
    const workbookStats = workbookStatsOf(s);
    const dedupeInfo = dedupeInfoOf(s);
    const collapsedBySub = collapsedBySubcontratista(dedupeInfo.groups);
    const sorted = sortIssues(items);
    const subcontratistas = buildRollup(items, workbookStats, collapsedBySub);

    const fallos = sorted.filter(i => i.severity === SEVERITY.FAILED);
    const fallidos = subcontratistas.filter(r => r.fallado);
    const nombresFallidos = [...new Set(fallidos.map(r => r.subcontratista).filter(v => v))].sort(compareText);

    const sumRollup = (field) => {
        let total = null;
        for (const r of subcontratistas) {
            if (r[field] === null) continue;
            total = (total === null ? 0 : total) + r[field];
        }
        return total;
    };

    const filasLeidas = firstNum(s.read, s.leidas, sumRollup("filasLeidas")) ?? (workbookStats.length === 0 ? 0 : null);
    const filasRechazadas = firstNum(s.rejected, s.rechazadas, sumRollup("filasRechazadas")) ?? (workbookStats.length === 0 ? 0 : null);
    const filasColapsadas = dedupeInfo.collapsed ?? (workbookStats.length === 0 ? 0 : null);
    // `escritas` is NEVER derived from the other three. Deriving it would make the
    // conservation check tautological, and a check that cannot fail is worse than none:
    // it would print "OK" on the exact run this module exists to catch.
    const filasEscritas = dedupeInfo.written ?? (workbookStats.length === 0 && filasLeidas === 0 ? 0 : null);

    const conservacion = conservationCheck({
        read: filasLeidas,
        rejected: filasRechazadas,
        collapsed: filasColapsadas,
        written: filasEscritas,
    });
    // Three states, not two: OK, ROTA (the terms are known and do not add up) and NO
    // VERIFICABLE (a term is missing). Reporting the third as "ROTA" would cry wolf;
    // reporting it as "OK" is the silence this whole module is a reaction to.
    const estadoConservacion = conservacion.ok
        ? "OK"
        : conservacion.expected === null ? "NO VERIFICABLE" : "ROTA";

    const esperados = firstNum(
        s.expected, s.esperados,
        s.walk && typeof s.walk === "object"
            ? (num(s.walk.topLevelFolders) ?? 0) + (num(s.walk.looseFiles) ?? 0)
            : null,
    ) ?? subcontratistas.length;

    const carpetas = Array.isArray(s.carpetas) ? s.carpetas : [];

    return {
        periodo,
        ok: fallos.length === 0 && fallidos.length === 0,
        severidades: severityCounts(issues, items),
        codigos: codeCounts(issues, items),
        fallos,
        nombresFallidos,
        subcontratistas,
        totales: {
            subcontratistasEsperados: esperados,
            subcontratistasLeidos: Math.max(subcontratistas.length - fallidos.length, 0),
            subcontratistasFallidos: fallidos.length,
            archivosVistos: subcontratistas.reduce((n, r) => n + r.archivosVistos, 0),
            archivosProcesados: subcontratistas.reduce((n, r) => n + r.archivosProcesados, 0),
            archivosFallidos: subcontratistas.reduce((n, r) => n + r.archivosFallidos, 0),
            filasLeidas,
            filasRechazadas,
            filasColapsadas,
            filasEscritas,
            incidencias: items.length,
        },
        conservacion: {
            estado: estadoConservacion,
            ok: conservacion.ok,
            formula: conservacion.detail.formula,
            leidas: conservacion.detail.read,
            rechazadas: conservacion.detail.rejected,
            colapsadas: conservacion.detail.collapsed,
            escritas: conservacion.detail.written,
            esperado: conservacion.expected,
            diferencia: conservacion.detail.difference,
            motivo: conservacion.detail.motivo,
        },
        dedupe: dedupeInfo.stats,
        crossSubcontratista: dedupeInfo.cross,
        carpetas,
        incidencias: sorted,
        walk: s.walk && typeof s.walk === "object" ? s.walk : null,
    };
}

// ---------------------------------------------------------------------------
// The Errores sheet
// ---------------------------------------------------------------------------

function conservationLine(c) {
    if (c.motivo) return c.motivo;
    return `${c.leidas} leidas - ${c.rechazadas} rechazadas - ${c.colapsadas} colapsadas = ${c.escritas} escritas`;
}

/**
 * The `Errores` worksheet, as an array-of-arrays ready for `XLSX.utils.aoa_to_sheet` /
 * xlsx-populate. 03 §8.1 - the REQUIRED artifact, because it travels inside the workbook
 * the operator actually opens.
 *
 * Layout, in the order the operator reads it:
 *
 *   1. ESTADO + the failed count + one named row per failed subcontratista.
 *   2. The period.
 *   3. The run summary, including the conservation arithmetic.
 *   4. Counts by severity, then by issue code.
 *   5. The per-subcontratista rollup.
 *   6. Every issue, FAILED first.
 *
 * @param {IssueList|Array<object>} issues
 * @param {object} [stats]   see summarize(); every field is optional
 * @param {object|string} [period]  a parsePeriod() descriptor or "YYYY-MM"
 * @param {{maxRows?: number}} [options]
 * @returns {Array<Array<*>>}
 */
function buildErroresSheet(issues, stats, period, options = {}) {
    const model = summarize(issues, stats, period);
    const maxRows = num(options.maxRows) ?? MAX_ISSUE_ROWS;
    const t = model.totales;
    const rows = [];

    // --- 1. the failure banner, first, always -------------------------------
    rows.push(["REPORTE DE INCIDENCIAS", `Periodo ${periodLabel(model.periodo)}`]);
    rows.push([
        "ESTADO",
        t.subcontratistasFallidos > 0 ? "INCOMPLETO" : "OK",
        t.subcontratistasFallidos > 0
            ? `${t.subcontratistasFallidos} subcontratista(s) NO se procesaron - este reporte NO incluye a su personal`
            : "todos los subcontratistas se procesaron",
    ]);
    // Never zero-suppressed (03 §8.2): "0" is the sentence the operator needs to read.
    rows.push(["Subcontratistas fallidos", t.subcontratistasFallidos,
        joinList(model.nombresFallidos)]);

    if (model.fallos.length > 0) {
        rows.push([]);
        rows.push(["FALLOS", "subcontratista", "archivo", "codigo", "motivo"]);
        for (const f of model.fallos) {
            rows.push([
                "FALLO",
                cellValue(f.subcontratista),
                cellValue(f.archivo),
                cellValue(f.code),
                cellValue(f.message),
            ]);
        }
    }

    // --- 2. period ----------------------------------------------------------
    rows.push([]);
    rows.push(["PERIODO", "Valor"]);
    rows.push(["PeriodoEtiqueta", model.periodo ? cellValue(model.periodo.etiqueta) : null]);
    rows.push(["PeriodoInicio", model.periodo ? cellValue(model.periodo.inicio) : null]);
    rows.push(["PeriodoFin", model.periodo ? cellValue(model.periodo.fin) : null]);

    // --- 3. run summary -----------------------------------------------------
    rows.push([]);
    rows.push(["RESUMEN", "Valor", "Detalle"]);
    rows.push(["Subcontratistas esperados", t.subcontratistasEsperados, null]);
    rows.push(["Subcontratistas leidos", t.subcontratistasLeidos, null]);
    rows.push(["Subcontratistas fallidos", t.subcontratistasFallidos, joinList(model.nombresFallidos)]);
    rows.push(["Archivos vistos", t.archivosVistos, null]);
    rows.push(["Archivos procesados", t.archivosProcesados, null]);
    rows.push(["Archivos fallidos", t.archivosFallidos, null]);
    rows.push(["Filas leidas", t.filasLeidas, null]);
    rows.push(["Filas rechazadas", t.filasRechazadas, null]);
    rows.push(["Filas colapsadas (duplicados)", t.filasColapsadas, null]);
    rows.push(["Filas escritas en Cuadro", t.filasEscritas, null]);
    rows.push([
        "Conservacion",
        model.conservacion.estado,
        conservationLine(model.conservacion),
    ]);
    if (model.conservacion.estado === "ROTA") {
        // Loud, on its own row, in the summary block - not a silent inconsistency
        // between two numbers nobody subtracts (05 Phase 3 task 8, AC 7).
        rows.push([
            "*** CONSERVACION ROTA ***",
            model.conservacion.diferencia,
            `${model.conservacion.formula}: se esperaban ${model.conservacion.esperado} filas y se escribieron ${model.conservacion.escritas}`,
        ]);
    }
    if (model.crossSubcontratista.length > 0) {
        // 03 §8.2: the `Dos Subcontratas por Mes` population, INCLUDING the Trabajador=3
        // cases that pivot hides because only item "2" is visible in it.
        rows.push(["Trabajadores en 2+ subcontratistas", model.crossSubcontratista.length,
            joinList(model.crossSubcontratista.map(g => g.key))]);
    }

    // --- 4. counts ----------------------------------------------------------
    rows.push([]);
    rows.push(["SEVERIDAD", "Total"]);
    for (const sev of DISPLAY_SEVERITY_ORDER) rows.push([sev, model.severidades[sev] || 0]);

    rows.push([]);
    rows.push(["CODIGO", "Total"]);
    const codes = Object.entries(model.codigos);
    if (codes.length === 0) rows.push(["(sin incidencias)", 0]);
    for (const [code, n] of codes) rows.push([code, n]);

    // --- 5. per-subcontratista rollup ---------------------------------------
    rows.push([]);
    rows.push([
        "POR SUBCONTRATISTA", "estado", "archivos vistos", "archivos procesados",
        "archivos fallidos", "filas leidas", "filas rechazadas", "filas colapsadas",
        "filas escritas", "conserva", "ancla", "hoja", "alias aceptados",
        "columnas ausentes", "FAILED", "ERROR", "WARNING", "INFO",
    ]);
    if (model.subcontratistas.length === 0) rows.push(["(ningun subcontratista procesado)"]);
    for (const r of model.subcontratistas) {
        rows.push([
            cellValue(r.subcontratista),
            r.fallado ? "FALLADO" : "ok",
            r.archivosVistos,
            r.archivosProcesados,
            r.archivosFallidos,
            r.filasLeidas,
            r.filasRechazadas,
            r.filasColapsadas,
            r.filasEscritas,
            r.conserva === null ? null : (r.conserva ? "si" : "NO"),
            cellValue(r.ancla),
            cellValue(r.hoja),
            joinList(r.aliases),
            joinList(r.columnasAusentes),
            r.incidencias[SEVERITY.FAILED] || 0,
            r.incidencias[SEVERITY.ERROR] || 0,
            r.incidencias[SEVERITY.WARNING] || 0,
            r.incidencias[SEVERITY.INFO] || 0,
        ]);
    }

    // --- 6. the issue table -------------------------------------------------
    rows.push([]);
    rows.push(["INCIDENCIAS", model.incidencias.length]);
    rows.push([...ERRORES_COLUMNS]);
    if (model.incidencias.length === 0) {
        rows.push(["(sin incidencias)"]);
    }
    const shown = model.incidencias.slice(0, maxRows);
    for (const i of shown) {
        rows.push([
            cellValue(i.subcontratista),
            cellValue(i.archivo),
            cellValue(i.hoja),
            num(i.fila),
            cellValue(i.celda),
            cellValue(i.columna),
            rawCell(i.valor),
            cellValue(i.message),
            cellValue(i.severity),
            cellValue(i.code),
            jsonCell(i.detalle),
        ]);
    }
    if (model.incidencias.length > shown.length) {
        rows.push([`(+${model.incidencias.length - shown.length} incidencias omitidas por limite de ${maxRows} filas; run.json las lleva todas)`]);
    }

    return rows;
}

// ---------------------------------------------------------------------------
// run.json
// ---------------------------------------------------------------------------

/**
 * The run log `run.js` writes as run.json. Same model as the sheet, structured rather
 * than laid out: `resumen.subcontratistas.fallidos` and `fallos[]` are the two fields a
 * monitor would alert on.
 *
 * NO TIMESTAMP, deliberately - see the module header.
 *
 * @param {IssueList|Array<object>} issues
 * @param {object} [stats]
 * @param {object|string} [period]
 * @param {{maxIssues?: number}} [options]
 * @returns {object}
 */
function buildRunLog(issues, stats, period, options = {}) {
    const model = summarize(issues, stats, period);
    const maxIssues = num(options.maxIssues);
    const t = model.totales;
    const incidencias = maxIssues === null ? model.incidencias : model.incidencias.slice(0, maxIssues);

    return {
        version: 1,
        // `ok` is false whenever ANY subcontratista failed, however healthy the rest of
        // the run looked. A report missing a company is not a successful run.
        ok: model.ok,
        periodo: model.periodo
            ? {
                key: model.periodo.key ?? null,
                etiqueta: model.periodo.etiqueta ?? null,
                inicio: model.periodo.inicio ?? null,
                fin: model.periodo.fin ?? null,
                anio: model.periodo.year ?? null,
                mes: model.periodo.month ?? null,
                mesNombre: model.periodo.mesNombre ?? null,
                archivo: model.periodo.filename ?? null,
            }
            : null,
        resumen: {
            subcontratistas: {
                esperados: t.subcontratistasEsperados,
                leidos: t.subcontratistasLeidos,
                fallidos: t.subcontratistasFallidos,
                nombresFallidos: model.nombresFallidos,
            },
            archivos: {
                vistos: t.archivosVistos,
                procesados: t.archivosProcesados,
                fallidos: t.archivosFallidos,
            },
            filas: {
                leidas: t.filasLeidas,
                rechazadas: t.filasRechazadas,
                colapsadas: t.filasColapsadas,
                escritas: t.filasEscritas,
            },
            conservacion: model.conservacion,
            severidades: model.severidades,
            codigos: model.codigos,
            incidencias: t.incidencias,
        },
        // First-class, at the top level, not buried inside `incidencias`: this is the
        // list 05 §1 principle 4 exists for.
        fallos: model.fallos.map(f => ({
            subcontratista: f.subcontratista,
            archivo: f.archivo,
            hoja: f.hoja,
            codigo: f.code,
            motivo: f.message,
            celda: f.celda,
            columna: f.columna,
            detalle: f.detalle,
        })),
        subcontratistas: model.subcontratistas,
        carpetas: model.carpetas,
        dedupe: model.dedupe,
        crossSubcontratista: model.crossSubcontratista,
        contenedor: model.walk,
        incidencias: incidencias.map(i => ({
            severidad: i.severity,
            codigo: i.code,
            subcontratista: i.subcontratista,
            archivo: i.archivo,
            hoja: i.hoja,
            fila: i.fila,
            celda: i.celda,
            columna: i.columna,
            valor: i.valor,
            motivo: i.message,
            detalle: i.detalle,
        })),
        incidenciasOmitidas: model.incidencias.length - incidencias.length,
    };
}

module.exports = {
    SHEET_NAME,
    ERRORES_COLUMNS,
    DISPLAY_SEVERITY_ORDER,
    MAX_ISSUE_ROWS,
    buildErroresSheet,
    buildRunLog,
    checkFolderNames,
    // Exported for the tests and for anything that needs the same model without a
    // renderer. Pure, no state.
    summarize,
    sortIssues,
    agreementLevel,
    normalizedKey,
    simplifiedKey,
};

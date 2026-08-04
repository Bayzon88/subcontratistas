"use strict";
/**
 * De-duplication on the canonical person key (05 §3 Phase 3 task 7, 03 §2).
 *
 * WHAT THIS REPLACES (BUG-21). `src/excelConsolidation.js:88` does:
 *
 *     new Set(combinedArray.map(JSON.stringify))
 *
 * `JSON.stringify` serializes keys in INSERTION order, and insertion order follows each
 * source workbook's column order - so two byte-identical workers coming from two
 * differently-ordered workbooks produce different strings and are not deduped. It also
 * makes *every field* part of the identity (one trailing space in DOMICILIO = two
 * people), and it runs twenty lines BEFORE `orderHeadersAndData` canonicalizes anything,
 * so the one step that would have made stringification a valid identity function has not
 * happened yet.
 *
 * Here the key is `identity.js personKey()` computed AFTER normalization, never a
 * serialization of the whole record. `config.IDENTITY_KEY` picks the mode ("name" by
 * default, 05 §8 Q3), and `countDistinct` publishes both modes side by side so the size
 * of the gap is visible before anyone changes the delivered headcount.
 *
 * THREE DECISIONS THAT ARE NOT OBVIOUS, ALL DELIBERATE:
 *
 * 1. WHICH COPY WINS - the most complete one. Ranked by the number of populated
 *    canonical fields, so a collapse can never lose a value that only the discarded copy
 *    carried; ties break on subcontratista, archivo, hoja, fila and finally on the field
 *    values themselves, which is a total order over CONTENT and therefore independent of
 *    the order the records arrived in. Whatever the winner still lacks is reported as
 *    `fieldsLost`, and any field where two copies disagree is reported as `conflicts`.
 *    Copies are NOT merged: a merged row is a row no subcontratista ever submitted, and
 *    its provenance would be a fiction. We pick, we say what picking cost, we move on.
 *
 * 2. OUTPUT ORDER IS SORTED, not first-seen. `kept` comes back ordered by
 *    (subcontratista, archivo, hoja, fila, content), which is exactly the order
 *    `zip.js walkInput` already produces, so in the real pipeline this is a no-op - but
 *    it makes the whole function a deterministic map from the input SET to the output,
 *    which is what makes the parallel-run diff (05 §4.4) readable.
 *
 * 3. A WORKER UNDER TWO SUBCONTRATISTAS IS A BUSINESS FACT, not noise. The
 *    `Dos Subcontratas por Mes` pivot sheet exists for exactly this population, and 03
 *    §8.2 requires the run report to list it ("including Trabajador = 3 cases, which that
 *    pivot hides"). So every such group is reported at WARNING severity with all of its
 *    sources named, and it is returned separately as `crossSubcontratista` regardless of
 *    whether it was collapsed. `scope: "subcontratista"` collapses only within one
 *    subcontratista and leaves the cross-company copies in `Cuadro` for that pivot to
 *    find; `scope: "all"` (the default, and what the old pipeline attempted) collapses
 *    them and the pivot goes quiet - which is why the itemisation is not optional.
 *
 * Pure: no I/O, no clock, no mutation of the caller's records. `kept` holds the SAME
 * object references that came in.
 */

const config = require("../config");
const { CANONICAL } = require("./columns");
const { CODE, SEVERITY, IssueList } = require("./issues");
const { IDENTITY_MODES, DNI_COLUMN, NAME_COLUMN, personKeyDetail } = require("./identity");

/** Collapse scopes. See decision 3 above. */
const SCOPES = Object.freeze(["all", "subcontratista"]);
const DEFAULT_SCOPE = "all";

/** The canonical column each mode keys on - stamped on the issue as `columna`. */
const KEY_COLUMN_BY_MODE = Object.freeze({ name: NAME_COLUMN, dni: DNI_COLUMN });

/** How many sources to name inline in the human message before "+N mas". The full list
 *  is always in `detalle.sources`; this only keeps the Errores sheet cell readable when
 *  a pathological group appears (the 643-row header-shift block of 03 §2.3 is one key). */
const MESSAGE_SOURCE_LIMIT = 6;

/** Distinct values kept per conflicting column. Group sizes are 2-4 in practice. */
const CONFLICT_VALUE_LIMIT = 10;

// ---------------------------------------------------------------------------
// Record inspection
// ---------------------------------------------------------------------------

/**
 * Is this cell populated, for completeness scoring?
 *
 * `0` counts as populated - HPT = 0 hours is a real answer, not a gap. A whitespace-only
 * string does not: text.js already turns those into null, and a record that skipped
 * normalization must not out-rank one that went through it. NaN never counts; nothing in
 * this pipeline may treat it as data (BUG-20).
 */
function isPopulated(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === "string") return value.trim() !== "";
    if (typeof value === "number") return Number.isFinite(value);
    return true;
}

/** Number of the 18 canonical columns that carry a value. Provenance is not counted. */
function completeness(record) {
    if (!record || typeof record !== "object") return 0;
    let n = 0;
    for (const column of CANONICAL) if (isPopulated(record[column])) n++;
    return n;
}

function firstString(...values) {
    for (const v of values) {
        if (typeof v === "string" && v !== "") return v;
    }
    return null;
}

function firstNumber(...values) {
    for (const v of values) {
        if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return null;
}

/**
 * The source coordinates of one record.
 *
 * Reads three shapes, because the provenance key is spelled two ways in the plan and a
 * hand-built test record has none at all: `workbook.js`'s
 * `{subcontratista, archivo, hoja, filaOrigen, celdaAncla}`, 03 §2's
 * `{carpetaSubcontratista, archivo, hoja, filaOrigen, celdaOrigen}`, and bare fields on
 * the record itself. Missing coordinates are null, never undefined and never "".
 */
function sourceOf(record) {
    const r = record && typeof record === "object" ? record : {};
    const p = r.provenance && typeof r.provenance === "object" ? r.provenance : r;
    return {
        subcontratista: firstString(p.subcontratista, p.carpetaSubcontratista, r.subcontratista),
        archivo: firstString(p.archivo, r.archivo),
        hoja: firstString(p.hoja, r.hoja),
        fila: firstNumber(p.filaOrigen, p.fila, r.filaOrigen, r.fila),
        celda: firstString(p.celdaOrigen, p.celdaAncla, r.celdaOrigen),
    };
}

// ---------------------------------------------------------------------------
// Deterministic comparators
//
// `localeCompare` is never used: it is locale-dependent, and a sort whose result depends
// on the host's ICU data is exactly the kind of non-determinism this rework removes.
// Code-unit order it is. Nulls sort LAST everywhere, so a record with no provenance can
// never displace one that has it.
// ---------------------------------------------------------------------------

function compareText(a, b) {
    const an = a === null || a === undefined;
    const bn = b === null || b === undefined;
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
    return a < b ? -1 : a > b ? 1 : 0;
}

/** Mixed-type scalar order: numbers numerically, everything else by its string form. */
function compareScalar(a, b) {
    const an = a === null || a === undefined;
    const bn = b === null || b === undefined;
    if (an && bn) return 0;
    if (an) return 1;
    if (bn) return -1;
    if (typeof a === "number" && typeof b === "number") return compareNumber(a, b);
    return compareText(String(a), String(b));
}

/** (subcontratista, archivo, hoja, fila) - the natural walk order of the pipeline. */
function compareSource(a, b) {
    return compareText(a.subcontratista, b.subcontratista)
        || compareText(a.archivo, b.archivo)
        || compareText(a.hoja, b.hoja)
        || compareNumber(a.fila, b.fila);
}

/** The 18 canonical fields in output order. The final, content-derived tiebreak. */
function compareContent(a, b) {
    const ra = a && typeof a === "object" ? a : {};
    const rb = b && typeof b === "object" ? b : {};
    for (const column of CANONICAL) {
        const c = compareScalar(ra[column], rb[column]);
        if (c !== 0) return c;
    }
    return 0;
}

/**
 * Winner ranking inside one duplicate group: most complete first, then source order,
 * then content. Total over content, so shuffling the input cannot change the winner.
 */
function compareCandidates(a, b) {
    if (a.completeness !== b.completeness) return b.completeness - a.completeness;
    return compareSource(a.source, b.source) || compareContent(a.record, b.record);
}

/** Output ordering of the surviving records. Completeness plays no part here. */
function compareForOutput(a, b) {
    return compareSource(a.source, b.source) || compareContent(a.record, b.record);
}

// ---------------------------------------------------------------------------
// Keying
// ---------------------------------------------------------------------------

function resolveMode(mode) {
    const m = mode === undefined || mode === null ? config.IDENTITY_KEY : mode;
    if (!IDENTITY_MODES.includes(m)) {
        // A configuration error, not a data error: fail loudly rather than pick a default
        // and silently key the whole run on the wrong notion of a person.
        throw new TypeError(`unknown identity key mode "${m}", expected one of ${IDENTITY_MODES.join(", ")}`);
    }
    return m;
}

function resolveScope(scope) {
    const s = scope === undefined || scope === null ? DEFAULT_SCOPE : scope;
    if (!SCOPES.includes(s)) {
        throw new TypeError(`unknown dedupe scope "${s}", expected one of ${SCOPES.join(", ")}`);
    }
    return s;
}

/** Decorate every record with its key, its source and its completeness. One pass. */
function describe(records, mode) {
    const list = Array.isArray(records) ? records : [];
    const out = new Array(list.length);
    for (let i = 0; i < list.length; i++) {
        const record = list[i];
        const detail = personKeyDetail(record, mode);
        out[i] = {
            record,
            index: i,
            key: detail.key,
            basis: detail.basis,
            fallback: detail.fallback,
            source: sourceOf(record),
            completeness: completeness(record),
        };
    }
    return out;
}

/** Group by identity key. Records with an empty key are NEVER grouped (identity.js §7). */
function groupByIdentity(entries) {
    const byIdentity = new Map();
    const withoutIdentity = [];
    for (const e of entries) {
        if (e.key === "") {
            withoutIdentity.push(e);
            continue;
        }
        const bucket = byIdentity.get(e.key);
        if (bucket) bucket.push(e);
        else byIdentity.set(e.key, [e]);
    }
    return { byIdentity, withoutIdentity };
}

/** Distinct non-null subcontratistas in a group, in code-unit order. */
function subcontratistasOf(group) {
    const set = new Set();
    for (const e of group) if (e.source.subcontratista !== null) set.add(e.source.subcontratista);
    return [...set].sort(compareText);
}

/** Split one identity group by subcontratista, for `scope: "subcontratista"`. */
function splitBySubcontratista(group) {
    const buckets = new Map();
    for (const e of group) {
        const k = e.source.subcontratista === null ? " sin-subcontratista" : e.source.subcontratista;
        const bucket = buckets.get(k);
        if (bucket) bucket.push(e);
        else buckets.set(k, [e]);
    }
    return [...buckets.values()];
}

// ---------------------------------------------------------------------------
// What a collapse costs
// ---------------------------------------------------------------------------

/** Canonical columns populated in a discarded copy but null in the winner. */
function fieldsLost(winner, discarded) {
    const lost = [];
    for (const column of CANONICAL) {
        if (isPopulated(winner.record[column])) continue;
        for (const d of discarded) {
            if (isPopulated(d.record[column])) { lost.push(column); break; }
        }
    }
    return lost;
}

/**
 * Columns where two copies carry DIFFERENT populated values.
 *
 * This is the honest cost of picking one row over another, and it is the interesting
 * half of the cross-subcontratista case: the same worker reported by two companies
 * disagrees on EMPRESA and CONTRATISTA PRNCIPAL by construction, which is precisely what
 * the operator needs to see.
 */
function conflictsIn(group) {
    const out = [];
    for (const column of CANONICAL) {
        const seen = new Map();
        for (const e of group) {
            const v = e.record ? e.record[column] : null;
            if (!isPopulated(v)) continue;
            const k = typeof v === "string" ? v : String(v);
            if (!seen.has(k)) seen.set(k, v);
        }
        if (seen.size < 2) continue;
        const values = [...seen.values()].sort(compareScalar);
        out.push({
            columna: column,
            valores: values.slice(0, CONFLICT_VALUE_LIMIT),
            truncado: values.length > CONFLICT_VALUE_LIMIT ? values.length - CONFLICT_VALUE_LIMIT : 0,
        });
    }
    return out;
}

function sourceRef(entry) {
    return {
        subcontratista: entry.source.subcontratista,
        archivo: entry.source.archivo,
        hoja: entry.source.hoja,
        fila: entry.source.fila,
        celda: entry.source.celda,
        campos: entry.completeness,
    };
}

function describeSource(entry) {
    const s = entry.source;
    const sub = s.subcontratista === null ? "(sin subcontratista)" : s.subcontratista;
    const file = s.archivo === null ? "(sin archivo)" : s.archivo;
    const row = s.fila === null ? "?" : String(s.fila);
    return `${sub}/${file}:${row}`;
}

// ---------------------------------------------------------------------------
// dedupe
// ---------------------------------------------------------------------------

/**
 * Collapse duplicate workers on the canonical person key.
 *
 * @param {Array<object>} records canonical records, ALREADY normalized (that ordering is
 *                                the whole point - BUG-21 ran the dedupe first)
 * @param {object}   [options]
 * @param {"name"|"dni"} [options.mode]  identity mode; defaults to config.IDENTITY_KEY
 * @param {IssueList}    [options.issues] collector; a fresh one is used when omitted, so
 *                                        a caller that only wants the arrays never throws
 * @param {"all"|"subcontratista"} [options.scope] see decision 3 in the file header
 * @returns {{kept: Array<object>, collapsed: Array<object>, stats: object,
 *            crossSubcontratista: Array<object>, issues: IssueList}}
 */
function dedupe(records, options = {}) {
    const opts = options || {};
    const mode = resolveMode(opts.mode);
    const scope = resolveScope(opts.scope);
    const issues = opts.issues || new IssueList();

    const entries = describe(records, mode);
    const { byIdentity, withoutIdentity } = groupByIdentity(entries);

    const kept = [...withoutIdentity];
    const collapsed = [];
    const crossSubcontratista = [];
    let fallbackKeys = 0;
    for (const e of entries) if (e.fallback) fallbackKeys++;

    for (const [key, group] of byIdentity) {
        const subs = subcontratistasOf(group);
        const cross = subs.length > 1;
        if (cross) {
            // Reported whether or not it is collapsed: this is the `Dos Subcontratas por
            // Mes` population of 03 §8.2, and it must be visible either way.
            crossSubcontratista.push({
                key,
                mode,
                copies: group.length,
                subcontratistas: subs,
                sources: [...group].sort((a, b) => compareSource(a.source, b.source)).map(sourceRef),
                collapsed: scope === "all",
            });
        }

        const buckets = scope === "all" ? [group] : splitBySubcontratista(group);
        for (const bucket of buckets) {
            if (bucket.length === 1) {
                kept.push(bucket[0]);
                continue;
            }
            const ranked = [...bucket].sort(compareCandidates);
            const winner = ranked[0];
            const discarded = ranked.slice(1);
            kept.push(winner);
            collapsed.push({
                key,
                mode,
                scope,
                copies: bucket.length,
                removed: discarded.length,
                crossSubcontratista: subcontratistasOf(bucket).length > 1,
                subcontratistas: subcontratistasOf(bucket),
                winner: sourceRef(winner),
                discarded: discarded.map(sourceRef),
                sources: ranked.map(sourceRef),
                fieldsLost: fieldsLost(winner, discarded),
                conflicts: conflictsIn(bucket),
            });
        }
    }

    // Map iteration order follows insertion, which follows input order - so both output
    // arrays are sorted before anything is returned or reported. This, plus the
    // content-total comparators above, is what makes the whole function shuffle-invariant.
    kept.sort(compareForOutput);
    collapsed.sort((a, b) =>
        compareText(a.key, b.key)
        || compareText(a.winner.subcontratista, b.winner.subcontratista)
        || compareText(a.winner.archivo, b.winner.archivo)
        || compareNumber(a.winner.fila, b.winner.fila));
    crossSubcontratista.sort((a, b) => compareText(a.key, b.key));

    for (const group of collapsed) reportCollapse(group, issues);

    let rowsCollapsed = 0;
    for (const g of collapsed) rowsCollapsed += g.removed;

    const stats = {
        mode,
        scope,
        rowsIn: entries.length,
        rowsOut: kept.length,
        rowsCollapsed,
        groups: collapsed.length,
        crossSubcontratistaGroups: crossSubcontratista.length,
        crossSubcontratistaRows: crossSubcontratista.reduce((n, g) => n + g.copies, 0),
        distinctKeys: byIdentity.size,
        withoutIdentity: withoutIdentity.length,
        fallbackKeys,
        // Local restatement of the Phase 3 task 8 identity, so a caller that never wires
        // conservationCheck still cannot ship a silently lossy dedupe.
        conserved: entries.length - rowsCollapsed === kept.length,
    };

    return { kept: kept.map(e => e.record), collapsed, stats, crossSubcontratista, issues };
}

/**
 * One DUPLICATE_COLLAPSED issue per group, naming the person, the key and every source.
 *
 * Severity (03 §8.3): INFO when every copy came from one subcontratista - that is a
 * literal duplicate and collapsing it is pure normalization. WARNING when the copies span
 * two or more subcontratistas, because a fact the report is specifically built to show
 * has just been compressed into one row, and the operator must see it rather than have
 * one of the two companies quietly picked.
 */
function reportCollapse(group, issues) {
    const shown = group.sources.slice(0, MESSAGE_SOURCE_LIMIT).map(s => {
        const sub = s.subcontratista === null ? "(sin subcontratista)" : s.subcontratista;
        const file = s.archivo === null ? "(sin archivo)" : s.archivo;
        return `${sub}/${file}:${s.fila === null ? "?" : s.fila}`;
    });
    const rest = group.sources.length - shown.length;
    const list = rest > 0 ? `${shown.join(", ")} (+${rest} mas)` : shown.join(", ");
    const winner = group.winner;
    const winnerRef = `${winner.subcontratista === null ? "(sin subcontratista)" : winner.subcontratista}`
        + `/${winner.archivo === null ? "(sin archivo)" : winner.archivo}`
        + `:${winner.fila === null ? "?" : winner.fila}`;
    const crossNote = group.crossSubcontratista
        ? ` - reportado por ${group.subcontratistas.length} subcontratistas (${group.subcontratistas.join(", ")})`
        : "";

    issues.add({
        severity: group.crossSubcontratista ? SEVERITY.WARNING : SEVERITY.INFO,
        code: CODE.DUPLICATE_COLLAPSED,
        message: `${group.copies} filas comparten la identidad "${group.key}" (clave: ${group.mode})`
            + `${crossNote}; se conserva ${winnerRef} (${winner.campos}/${CANONICAL.length} campos) `
            + `y se descartan ${group.removed}. Fuentes: ${list}`,
        subcontratista: winner.subcontratista,
        archivo: winner.archivo,
        hoja: winner.hoja,
        fila: winner.fila,
        celda: winner.celda,
        columna: KEY_COLUMN_BY_MODE[group.mode] || null,
        valor: group.key,
        detalle: {
            clave: group.key,
            modo: group.mode,
            scope: group.scope,
            copias: group.copies,
            descartadas: group.removed,
            cruzado: group.crossSubcontratista,
            subcontratistas: group.subcontratistas,
            ganador: group.winner,
            descartados: group.discarded,
            fuentes: group.sources,
            camposPerdidos: group.fieldsLost,
            conflictos: group.conflicts,
        },
    });
}

// ---------------------------------------------------------------------------
// Headcount helpers (05 §8 Q3)
// ---------------------------------------------------------------------------

/**
 * The census behind both headcounts, so metrics.js never re-implements the keying.
 *
 * `distinct` counts distinct non-empty keys PLUS one for every record with no identity at
 * all - because those must not be collapsed onto each other (identity.js §7), each one is
 * its own person. That makes `countDistinct(records, mode)` exactly equal to
 * `dedupe(records, {mode}).kept.length`, which is asserted in the tests.
 *
 * @param {Array<object>} records
 * @param {"name"|"dni"} [mode]
 * @returns {{mode: string, distinct: number, total: number, withIdentity: number,
 *            withoutIdentity: number, fallbackKeys: number, duplicateKeys: number,
 *            duplicateRows: number, counts: Map<string, number>}}
 */
function keyCensus(records, mode) {
    const m = resolveMode(mode);
    const entries = describe(records, m);
    const counts = new Map();
    let withoutIdentity = 0;
    let fallbackKeys = 0;
    for (const e of entries) {
        if (e.fallback) fallbackKeys++;
        if (e.key === "") { withoutIdentity++; continue; }
        counts.set(e.key, (counts.get(e.key) || 0) + 1);
    }
    let duplicateKeys = 0;
    let duplicateRows = 0;
    for (const n of counts.values()) {
        if (n > 1) { duplicateKeys++; duplicateRows += n - 1; }
    }
    return {
        mode: m,
        distinct: counts.size + withoutIdentity,
        total: entries.length,
        withIdentity: entries.length - withoutIdentity,
        withoutIdentity,
        fallbackKeys,
        duplicateKeys,
        duplicateRows,
        counts,
    };
}

/**
 * Distinct people under one identity mode. Call it twice to publish the name-keyed and
 * the DNI-keyed headcount side by side (05 §8 Q3) without duplicating the keying logic.
 *
 * @param {Array<object>} records
 * @param {"name"|"dni"} [mode] defaults to config.IDENTITY_KEY
 * @returns {number}
 */
function countDistinct(records, mode) {
    return keyCensus(records, mode).distinct;
}

// ---------------------------------------------------------------------------
// Conservation (05 §3 Phase 3 task 8)
// ---------------------------------------------------------------------------

/** number | array -> a count. `null` when the value is unusable. */
function coerceCount(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? value : null;
    if (Array.isArray(value)) return value.length;
    return null;
}

/**
 * `read` -> {total, perWorkbook}. Accepts a plain total, an array of numbers, or an array
 * of per-workbook descriptors ({subcontratista, archivo, filas|rowsRead|rowsFound|rows}),
 * which is what "Σ(rows read per workbook)" means in the plan and what the run report
 * prints per subcontratista (03 §8.2).
 */
function coerceRead(value) {
    if (typeof value === "number") {
        return Number.isInteger(value) && value >= 0
            ? { total: value, perWorkbook: [] }
            : { total: null, perWorkbook: [] };
    }
    if (!Array.isArray(value)) return { total: null, perWorkbook: [] };
    let total = 0;
    const perWorkbook = [];
    for (const item of value) {
        if (typeof item === "number") {
            if (!Number.isInteger(item) || item < 0) return { total: null, perWorkbook: [] };
            total += item;
            perWorkbook.push({ subcontratista: null, archivo: null, filas: item });
            continue;
        }
        if (!item || typeof item !== "object") return { total: null, perWorkbook: [] };
        const filas = firstNumber(item.filas, item.rowsRead, item.rowsFound, item.rows, item.leidas);
        if (filas === null || !Number.isInteger(filas) || filas < 0) return { total: null, perWorkbook: [] };
        total += filas;
        perWorkbook.push({
            subcontratista: firstString(item.subcontratista, item.carpetaSubcontratista),
            archivo: firstString(item.archivo),
            filas,
        });
    }
    return { total, perWorkbook };
}

/** A count, or dedupe()'s `collapsed` array (in which case rows removed = Σ copies-1). */
function coerceCollapsed(value) {
    if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? value : null;
    if (!Array.isArray(value)) return null;
    let n = 0;
    for (const g of value) {
        if (g && typeof g === "object" && typeof g.removed === "number") n += g.removed;
        else if (g && typeof g === "object" && typeof g.copies === "number") n += g.copies - 1;
        else return null;
    }
    return n;
}

/**
 * The Phase 3 task 8 assertion:
 *
 *     Σ(rows read per workbook) - rows rejected - rows collapsed = rows written
 *
 * `rejected` defaults to 0, so the two-term form in the brief works unchanged; pass it to
 * get the full reconciliation 03 §8.2 asks the run report to print
 * (`found - rejected = accepted`, `written = accepted - deduplicated`).
 *
 * Never throws and never returns NaN: unusable input comes back `ok:false` with
 * `detail.motivo` saying which term could not be read.
 *
 * @param {object} input
 * @param {number|Array} input.read      rows read, per workbook or as a total
 * @param {number|Array} [input.rejected] rows rejected before the dedupe (default 0)
 * @param {number|Array} [input.collapsed] a count, or dedupe()'s `collapsed` array
 * @param {number|Array} [input.written]   a count, or dedupe()'s `kept` array
 * @param {object}       [input.result]    a dedupe() result; supplies collapsed + written
 * @returns {{ok: boolean, expected: number|null, actual: number|null, detail: object}}
 */
function conservationCheck(input = {}) {
    const o = input || {};
    const { total: read, perWorkbook } = coerceRead(o.read);
    const rejected = o.rejected === undefined || o.rejected === null ? 0 : coerceCount(o.rejected);
    const result = o.result && typeof o.result === "object" ? o.result : null;

    let collapsed = o.collapsed !== undefined && o.collapsed !== null ? coerceCollapsed(o.collapsed) : null;
    if (collapsed === null && result) {
        collapsed = result.stats && typeof result.stats.rowsCollapsed === "number"
            ? result.stats.rowsCollapsed
            : coerceCollapsed(result.collapsed);
    }

    let written = o.written !== undefined && o.written !== null ? coerceCount(o.written) : null;
    if (written === null && result) written = coerceCount(result.kept);

    const detail = {
        formula: "leidas - rechazadas - colapsadas = escritas",
        read,
        rejected,
        collapsed,
        written,
        perWorkbook,
        workbooks: perWorkbook.length,
        difference: null,
        motivo: null,
    };

    const missing = [];
    if (read === null) missing.push("read");
    if (rejected === null) missing.push("rejected");
    if (collapsed === null) missing.push("collapsed");
    if (written === null) missing.push("written");
    if (missing.length > 0) {
        detail.motivo = `terminos no interpretables: ${missing.join(", ")}`;
        return { ok: false, expected: null, actual: null, detail };
    }

    const expected = read - rejected - collapsed;
    const actual = written;
    detail.difference = actual - expected;
    if (expected !== actual) {
        detail.motivo = `conservacion rota: ${read} leidas - ${rejected} rechazadas - ${collapsed} colapsadas `
            + `= ${expected}, pero se escribieron ${actual} (diferencia ${detail.difference})`;
    }
    return { ok: expected === actual, expected, actual, detail };
}

module.exports = {
    SCOPES,
    DEFAULT_SCOPE,
    KEY_COLUMN_BY_MODE,
    dedupe,
    countDistinct,
    keyCensus,
    conservationCheck,
    // exported for metrics.js / runReport.js and for the tests; pure, no state
    completeness,
    isPopulated,
    sourceOf,
    compareSource,
    compareContent,
};

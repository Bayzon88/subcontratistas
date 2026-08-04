"use strict";
/**
 * The 18 canonical columns, in output order (A..R), plus the header alias table.
 *
 * The canonical spelling of column C is the TYPO "CONTRATISTA PRNCIPAL". It is the
 * name of the column inside the template's Excel Table `Tabla2`, so every structured
 * formula reference (`Tabla2[[#This Row],[CONTRATISTA PRNCIPAL]]`) depends on it.
 * Do not "fix" it here - the correctly-spelled input variant is handled by ALIASES.
 */

/** Canonical header text, index = column offset from A. */
const CANONICAL = [
    "RUC",                                                          // A
    "EMPRESA",                                                      // B
    "CONTRATISTA PRNCIPAL",                                         // C  (sic)
    "Nro. DNI / CE",                                                // D
    "APELLIDOS Y NOMBRES",                                          // E
    "FECHA NACIMIENTO",                                             // F  date
    "TIPO TRABAJADOR",                                              // G
    "TITULO DE PUESTO/CARGO",                                       // H
    "NOMBRE DE OBRA DONDE ESTA ASIGNADO DURANTE EL MES REPORTADO",  // I
    "DOMICILIO DE TRABAJADOR",                                      // J
    "DISTRITO SEGÚN DNI",                                           // K
    "GENERO",                                                       // L
    "FECHA CESE/BAJA",                                              // M  date
    "NACIONALIDAD",                                                 // N
    "FECHA INICIO DE LABORES EN OBRA",                              // O  date
    "ESTADO",                                                       // P
    "TIPO DE CONTRATO LABORAL",                                     // Q
    "HPT",                                                          // R
];

/** The three date columns, by canonical name. */
const DATE_COLUMNS = [
    "FECHA NACIMIENTO",
    "FECHA CESE/BAJA",
    "FECHA INICIO DE LABORES EN OBRA",
];

/** Identifier columns that must be emitted as TEXT so leading zeros survive
 *  ("09994533" must not become 9994533). */
const TEXT_ID_COLUMNS = ["RUC", "Nro. DNI / CE"];

/** Free-text columns: trim -> collapse internal whitespace -> strip CR/LF. */
const TEXT_COLUMNS = [
    "EMPRESA",
    "CONTRATISTA PRNCIPAL",
    "APELLIDOS Y NOMBRES",
    "TITULO DE PUESTO/CARGO",
    "DISTRITO SEGÚN DNI",
    "NOMBRE DE OBRA DONDE ESTA ASIGNADO DURANTE EL MES REPORTADO",
    "DOMICILIO DE TRABAJADOR",
];

/** Text columns that are additionally upper-cased. */
const UPPERCASE_COLUMNS = ["APELLIDOS Y NOMBRES", "NACIONALIDAD"];

/** Closed coded domains. */
const CODED_COLUMNS = [
    "TIPO TRABAJADOR",
    "GENERO",
    "ESTADO",
    "TIPO DE CONTRATO LABORAL",
];

/**
 * Normalize a header cell for matching: NFD-decompose, strip combining accents,
 * collapse whitespace runs, trim, upper-case.
 *
 * Collapses "DISTRITO SEGUN DNI", "Distrito segun DNI ", "DISTRITO SEGÚN DNI" and
 * "  distrito  según   dni" onto one key, and "RUC " / "Ruc" onto "RUC".
 */
function normalizeHeader(value) {
    if (value === null || value === undefined) return "";
    return String(value)
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toUpperCase();
}

/**
 * Explicit alias table for genuine spelling differences that normalization cannot
 * bridge. Keys are NORMALIZED forms; values are canonical header text.
 *
 * Every hit is logged as "accepted alias X as Y" in the run report, so this table is
 * greppable and its use is visible - unlike a fuzzy matcher, which would resolve the
 * same cases silently and could resolve the wrong one.
 */
const ALIAS_SOURCE = {
    // The correctly-spelled variant of the canonical typo. This is the single alias
    // the original app had, and the only one it had.
    "CONTRATISTA PRINCIPAL": "CONTRATISTA PRNCIPAL",
    "CONTRATISTA PRINCIPAL ": "CONTRATISTA PRNCIPAL",

    // Identifier columns.
    "NRO DNI / CE": "Nro. DNI / CE",
    "NRO. DNI/CE": "Nro. DNI / CE",
    "NRO DNI/CE": "Nro. DNI / CE",
    "N° DNI / CE": "Nro. DNI / CE",
    "NO. DNI / CE": "Nro. DNI / CE",
    "DNI": "Nro. DNI / CE",
    "DNI / CE": "Nro. DNI / CE",
    "DNI/CE": "Nro. DNI / CE",
    "R.U.C.": "RUC",
    "R.U.C": "RUC",
    "RUC EMPRESA": "RUC",

    // Dates.
    "FECHA DE NACIMIENTO": "FECHA NACIMIENTO",
    "F. NACIMIENTO": "FECHA NACIMIENTO",
    "FEC. NACIMIENTO": "FECHA NACIMIENTO",
    "FECHA CESE": "FECHA CESE/BAJA",
    "FECHA DE CESE": "FECHA CESE/BAJA",
    "FECHA CESE / BAJA": "FECHA CESE/BAJA",
    "FECHA DE CESE/BAJA": "FECHA CESE/BAJA",
    "FECHA BAJA": "FECHA CESE/BAJA",
    "FECHA INICIO DE LABORES": "FECHA INICIO DE LABORES EN OBRA",
    "FECHA DE INICIO DE LABORES EN OBRA": "FECHA INICIO DE LABORES EN OBRA",
    "FECHA INICIO LABORES EN OBRA": "FECHA INICIO DE LABORES EN OBRA",
    "FECHA DE INICIO": "FECHA INICIO DE LABORES EN OBRA",
    "FECHA INGRESO": "FECHA INICIO DE LABORES EN OBRA",

    // People / place.
    "APELLIDOS Y NOMBRE": "APELLIDOS Y NOMBRES",
    "NOMBRES Y APELLIDOS": "APELLIDOS Y NOMBRES",
    "TRABAJADOR": "APELLIDOS Y NOMBRES",
    "DISTRITO SEGUN DNI": "DISTRITO SEGÚN DNI",   // redundant post-normalization; explicit on purpose
    "DISTRITO": "DISTRITO SEGÚN DNI",
    "DISTRITO DE RESIDENCIA": "DISTRITO SEGÚN DNI",
    "DOMICILIO DEL TRABAJADOR": "DOMICILIO DE TRABAJADOR",
    "DOMICILIO": "DOMICILIO DE TRABAJADOR",
    "GENERO / SEXO": "GENERO",
    "SEXO": "GENERO",

    // Role / assignment.
    "TITULO DE PUESTO / CARGO": "TITULO DE PUESTO/CARGO",
    "PUESTO/CARGO": "TITULO DE PUESTO/CARGO",
    "CARGO": "TITULO DE PUESTO/CARGO",
    "PUESTO": "TITULO DE PUESTO/CARGO",
    "NOMBRE DE OBRA": "NOMBRE DE OBRA DONDE ESTA ASIGNADO DURANTE EL MES REPORTADO",
    "OBRA": "NOMBRE DE OBRA DONDE ESTA ASIGNADO DURANTE EL MES REPORTADO",
    "NOMBRE DE OBRA DONDE ESTA ASIGNADO": "NOMBRE DE OBRA DONDE ESTA ASIGNADO DURANTE EL MES REPORTADO",

    // Codes.
    "TIPO DE TRABAJADOR": "TIPO TRABAJADOR",
    "TIPO CONTRATO LABORAL": "TIPO DE CONTRATO LABORAL",
    "TIPO DE CONTRATO": "TIPO DE CONTRATO LABORAL",
    "ESTADO DEL TRABAJADOR": "ESTADO",
    "H.P.T.": "HPT",
    "H.P.T": "HPT",
    "HORAS": "HPT",
    "HORAS HOMBRE": "HPT",
    "HH": "HPT",
};

/** Normalized-alias -> canonical. Built once; keys are normalized so lookups are exact. */
const ALIASES = new Map();
for (const [raw, canonical] of Object.entries(ALIAS_SOURCE)) {
    ALIASES.set(normalizeHeader(raw), canonical);
}

/** Normalized canonical name -> canonical name. Identity mapping, checked first. */
const CANONICAL_BY_NORMALIZED = new Map();
for (const name of CANONICAL) {
    CANONICAL_BY_NORMALIZED.set(normalizeHeader(name), name);
}

/**
 * Resolve one raw header cell to a canonical column name.
 * @returns {{canonical: string|null, via: "canonical"|"alias"|null, normalized: string}}
 */
function resolveHeader(value) {
    const normalized = normalizeHeader(value);
    if (!normalized) return { canonical: null, via: null, normalized };
    const direct = CANONICAL_BY_NORMALIZED.get(normalized);
    if (direct) return { canonical: direct, via: "canonical", normalized };
    const alias = ALIASES.get(normalized);
    if (alias) return { canonical: alias, via: "alias", normalized };
    return { canonical: null, via: null, normalized };
}

/** Canonical name -> 0-based column offset (RUC = 0 ... HPT = 17). */
const INDEX_BY_CANONICAL = new Map(CANONICAL.map((n, i) => [n, i]));

module.exports = {
    CANONICAL,
    DATE_COLUMNS,
    TEXT_ID_COLUMNS,
    TEXT_COLUMNS,
    UPPERCASE_COLUMNS,
    CODED_COLUMNS,
    ALIAS_SOURCE,
    ALIASES,
    INDEX_BY_CANONICAL,
    normalizeHeader,
    resolveHeader,
};

"use strict";
/**
 * The only place environment variables are read, and the only place paths and
 * limits are defined. Everything else imports from here.
 *
 * Rationale (05-implementation-plan.md §2.1): the current app reads process.env
 * in two files, half-honours DATAFOLDER_URL (BUG-39), and hard-codes "template.xlsx"
 * and "reportes" as string literals in excelReporting.js.
 */
if (process.env.NODE_ENV !== "production") {
    require("dotenv").config();
}
const path = require("path");
const os = require("os");

const SRC = __dirname;
const ROOT = path.join(SRC, "..");

module.exports = {
    ROOT,
    SRC,

    /** Where the report template lives. template-v2.xlsx is the Phase 4 (deterministic)
     *  template; template.xlsx is the original and stays until cutover. */
    TEMPLATE: path.join(SRC, "template-v2.xlsx"),
    TEMPLATE_LEGACY: path.join(SRC, "template.xlsx"),

    /** Generated reports land here. Not retained by the pipeline - the operator
     *  downloads them; nothing in the pipeline reads them back. */
    REPORTES_DIR: path.join(SRC, "reportes"),

    /** Root for per-run temp directories. Each run gets a fresh subdirectory that a
     *  `finally` removes on every path, success or failure (05 §7 step 9). Nothing
     *  is retained: no archivo/, no input corpus, no run history on disk. */
    TMP_ROOT: process.env.TMP_ROOT || path.join(os.tmpdir(), "subcontratistas"),

    PORT: Number(process.env.PORT) || 50001,

    /** The sheet the worker table lives on, matched case/accent-insensitively. */
    SHEET_NAME: "Cuadro",

    /** Anchor search window. A title cell containing the word "RUC" must not win,
     *  so the search is bounded and gated on ANCHOR_MIN_HEADERS.
     *  (05 §3 Phase 1 task 3; 03-expected-output.md §1.2 step 6 / §1.4 rule 5.) */
    ANCHOR_MAX_ROWS: 50,
    ANCHOR_MAX_COLS: 30,
    ANCHOR_MIN_HEADERS: 8,

    /** Stop widening the header span after this many consecutive empty header cells. */
    HEADER_EDGE_GAP: 2,

    /** Stop reading data after this many consecutive fully-empty rows. */
    DATA_END_GAP: 20,

    /** Upload and extraction caps. adm-zip 0.6.0 fixes GHSA-xcpc-8h2w-3j85 (a crafted
     *  zip triggering a 4 GB allocation); these are the guards it still will not add. */
    MAX_UPLOAD_BYTES: 512 * 1024 * 1024,
    /** /review takes one subcontratista's workbook, not the month's zip, and answers
     *  inside the request. A cap far below MAX_UPLOAD_BYTES keeps that promise true. */
    MAX_REVIEW_BYTES: Number(process.env.MAX_REVIEW_BYTES) || 32 * 1024 * 1024,
    MAX_ENTRIES: 5000,
    MAX_UNCOMPRESSED_BYTES: 2 * 1024 * 1024 * 1024,
    MAX_COMPRESSION_RATIO: 200,

    /** The template round-trip peaks near 944 MB RSS, so runs are single-flight. */
    ALLOW_CONCURRENT_RUNS: false,

    /** Plausibility windows (05 §3 Phase 2 task 2). Ages mirror the template's own
     *  <18 / >80 "Corregir" bounds. */
    MIN_AGE_YEARS: 16,
    MAX_AGE_YEARS: 80,
    EARLIEST_OBRA_DATE: "2015-01-01",

    /** Two-digit years: rejected for FECHA NACIMIENTO, expanded past-only for the two
     *  obra dates (05 §8 Q1 recommendation). Flip REJECT_TWO_DIGIT_BIRTH_YEARS to false
     *  to expand everywhere. */
    REJECT_TWO_DIGIT_BIRTH_YEARS: true,

    /** Identity key for dedupe. "name" preserves the numbers the client has already
     *  seen (the template counts people with COUNTIF over APELLIDOS Y NOMBRES);
     *  "dni" is the technically-better key and moves the headline headcount.
     *  Owner decision, 05 §8 Q3 - recommendation is "name", with a DNI-keyed count
     *  published alongside it in the metrics side-car. */
    IDENTITY_KEY: process.env.IDENTITY_KEY || "name",
};

"use strict";
/**
 * Safe extraction and container walking.
 *
 * Two responsibilities, both of them things the current app does not do at all:
 *
 *  1. extractZip() - unpack the operator's upload with the guards adm-zip will never
 *     add for us: containment (zip-slip, BUG-34), an entry-count cap, an uncompressed-size
 *     cap and a compression-ratio cap. adm-zip 0.5.10 carried GHSA-xcpc-8h2w-3j85
 *     (a crafted zip triggering a 4 GB allocation); we are on 0.6.0, but the template
 *     round-trip already peaks near 944 MB RSS on this box, so an unbounded extract is
 *     still an OOM, not a theoretical DoS.
 *
 *  2. walkInput() - turn a directory into an ORDERED list of subcontratistas to read,
 *     implementing every container tolerance of 03-expected-output.md §1.1 as an
 *     explicit, individually-tested check (05 §3 Phase 1 task 7), never a try/catch.
 *
 * Two failure classes, deliberately different:
 *
 *  - Container-level REFUSAL (traversal, caps). Nothing can be processed, so the issue
 *    is recorded as FAILED and a ZipRefusedError is thrown: the whole run aborts.
 *  - Per-subcontratista FAILURE (two .xlsx in a folder, zero .xlsx in a folder). Recorded
 *    as FAILED, that subcontratista is skipped, and the walk CONTINUES so the operator
 *    sees every broken folder at once rather than one per re-run. walkInput never throws
 *    for a data problem.
 *
 * The folder rules are the point of this module. Today readdirSync's order silently
 * decides which of two workbooks wins (src/app.js:73 also passes that ARRAY straight
 * into a path template - BUG-33), and a folder with no workbook is indistinguishable
 * from "this subcontratista has no workers this month", which is the exact failure mode
 * the whole rework exists to eliminate (03 §1.1).
 */

const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const config = require("../config");
const { CODE } = require("./issues");

/**
 * Entries this small cannot OOM anything, and a small, highly-compressible file
 * (an empty sheet, a text file of spaces) legitimately exceeds the ratio cap. Only
 * apply MAX_COMPRESSION_RATIO once an entry is big enough for the ratio to mean
 * "bomb" rather than "compresses well".
 */
const RATIO_MIN_BYTES = 1024 * 1024;

/** How deep walkInput recurses inside one subcontratista folder before giving up. */
const MAX_FOLDER_DEPTH = 8;

/** How many wrapper folders walkInput will descend through. */
const MAX_WRAPPER_DEPTH = 4;

/** How many skipped names are carried in the aggregated __MACOSX/ issue's detalle. */
const MACOSX_SAMPLE = 10;

/** What one container entry (zip entry or on-disk dirent) is, for skip decisions. */
const ENTRY_KIND = Object.freeze({
    UNSAFE: "unsafe",        // absolute, parent-segment, or escapes the destination
    MACOSX: "macosx",        // __MACOSX/ anywhere in the path, or a ._ resource fork
    LOCKFILE: "lockfile",    // ~$... - Excel's lock file. Skipped BY NAME, never opened
    DIRECTORY: "directory",
    XLSX: "xlsx",
    OTHER: "other",          // .xls, .pdf, .csv, images, .DS_Store, ...
});

/** Default caps. config.js is the only source; options override them in tests. */
const DEFAULT_LIMITS = Object.freeze({
    maxEntries: config.MAX_ENTRIES,
    maxUncompressedBytes: config.MAX_UNCOMPRESSED_BYTES,
    maxCompressionRatio: config.MAX_COMPRESSION_RATIO,
});

/** Thrown when the container itself is refused. Carries the issue that was recorded. */
class ZipRefusedError extends Error {
    constructor(code, message, issueRecord) {
        super(message);
        this.name = "ZipRefusedError";
        this.code = code;
        this.issue = issueRecord;
    }
}

/* ------------------------------------------------------------------ *
 * Name classification - pure, and the table the case file drives.
 * ------------------------------------------------------------------ */

/** Zip entry names use "/" by spec, but Windows producers emit "\". */
function toPosix(name) {
    return String(name === null || name === undefined ? "" : name).replace(/\\/g, "/");
}

/** "a/b/c.xlsx" -> "c.xlsx"; "a/b/" -> "b". */
function baseOf(posixName) {
    const trimmed = posixName.replace(/\/+$/, "");
    return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/**
 * Classify one entry name. Order matters and is part of the contract:
 * a resource fork named "._lista.xlsx" is MACOSX, not XLSX, and "~$lista.xlsx" is
 * LOCKFILE, not XLSX - so neither is ever opened and neither can make a folder look
 * like it holds two workbooks.
 *
 * @param {string} rawName    entry name as the container reports it
 * @param {boolean} [isDirectory]  defaults to "ends with /"
 * @returns {{kind: string, name: string, base: string, reason: string|null}}
 */
function classifyEntry(rawName, isDirectory) {
    const raw = toPosix(rawName);
    const isDir = isDirectory === undefined ? /\/$/.test(raw) : Boolean(isDirectory);
    // "./" segments are legitimate ("zip -r archive.zip ." emits them) and carry no
    // meaning, so they are dropped before anything is judged. ".." never is.
    const segments = raw.split("/").filter(s => s.length > 0 && s !== ".");
    const name = segments.join("/") + (isDir && segments.length > 0 ? "/" : "");
    const base = baseOf(name);

    if (/\0/.test(raw)) {
        return { kind: ENTRY_KIND.UNSAFE, name, base, reason: "null byte in entry name" };
    }
    // An entry that normalizes to nothing is the archive root marker ("./"), not a file.
    if (segments.length === 0) {
        return isDir
            ? { kind: ENTRY_KIND.DIRECTORY, name: "", base: "", reason: null }
            : { kind: ENTRY_KIND.UNSAFE, name, base, reason: "empty entry name" };
    }
    // Absolute paths: POSIX root, UNC, and Windows drive letters.
    if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
        return { kind: ENTRY_KIND.UNSAFE, name, base, reason: "absolute path" };
    }
    // Any ".." segment, wherever it sits. "a/../b" is harmless in isolation but there
    // is no legitimate producer of it, so it is refused rather than normalized away.
    if (segments.some(s => s === "..")) {
        return { kind: ENTRY_KIND.UNSAFE, name, base, reason: "parent-directory segment" };
    }
    if (segments.some(s => s === "__MACOSX") || base.startsWith("._")) {
        return { kind: ENTRY_KIND.MACOSX, name, base, reason: null };
    }
    if (base.startsWith("~$")) {
        return { kind: ENTRY_KIND.LOCKFILE, name, base, reason: null };
    }
    if (isDir) {
        return { kind: ENTRY_KIND.DIRECTORY, name, base, reason: null };
    }
    if (base.toLowerCase().endsWith(".xlsx")) {
        return { kind: ENTRY_KIND.XLSX, name, base, reason: null };
    }
    return { kind: ENTRY_KIND.OTHER, name, base, reason: null };
}

/**
 * Resolve an entry against the destination and refuse anything that escapes it.
 * This is the containment half of BUG-34: adm-zip's own sanitizer rewrites hostile
 * names, we reject them, because a rewritten name is a file landing somewhere the
 * operator did not expect under a name they did not choose.
 *
 * @returns {string|null} absolute target, or null if it escapes destAbs
 */
function resolveWithin(destAbs, posixName) {
    const target = path.resolve(destAbs, posixName);
    if (target === destAbs) return null;             // the entry IS the root
    if (!target.startsWith(destAbs + path.sep)) return null;
    return target;
}

/* ------------------------------------------------------------------ *
 * extractZip
 * ------------------------------------------------------------------ */

/**
 * Extract `zipPath` into `destDir`, applying every guard above.
 *
 * Header validation runs to completion BEFORE a single byte is written, so a hostile
 * or merely enormous archive is refused without having touched the disk.
 *
 * @param {string} zipPath
 * @param {string} destDir      created if absent
 * @param {IssueList} issues
 * @param {object} [options]    { maxEntries, maxUncompressedBytes, maxCompressionRatio }
 * @returns {{destDir:string, entries:number, extracted:number, directories:number,
 *           bytes:number, skipped:{macosx:number, lockfile:number, nonXlsx:number},
 *           nonXlsxNames:string[]}}
 * @throws {ZipRefusedError} on traversal or any cap - after recording a FAILED issue
 */
function extractZip(zipPath, destDir, issues, options = {}) {
    const limits = { ...DEFAULT_LIMITS, ...options };
    const destAbs = path.resolve(destDir);
    fs.mkdirSync(destAbs, { recursive: true });

    const refuse = (code, message, detalle) => {
        const record = issues.failed({ code, message, archivo: path.basename(zipPath), detalle: detalle ?? null });
        throw new ZipRefusedError(code, message, record);
    };

    let zip;
    try {
        zip = new AdmZip(zipPath);
    } catch (err) {
        // Not a data problem inside the run: there is no container at all. There is no
        // issue CODE for it and nothing to continue with, so this propagates.
        throw new Error(`unreadable zip ${zipPath}: ${err.message}`, { cause: err });
    }
    const entries = zip.getEntries();

    /* ---- pass 1: headers only, nothing written ---- */
    if (entries.length > limits.maxEntries) {
        refuse(
            CODE.ZIP_ENTRY_CAP,
            `zip has ${entries.length} entries, over the cap of ${limits.maxEntries}`,
            { entries: entries.length, cap: limits.maxEntries },
        );
    }

    const plan = [];
    let plannedBytes = 0;
    for (const entry of entries) {
        const c = classifyEntry(entry.entryName, entry.isDirectory);
        if (c.kind === ENTRY_KIND.UNSAFE) {
            refuse(
                CODE.ZIP_TRAVERSAL,
                `zip entry "${c.name}" refused: ${c.reason}`,
                { entryName: c.name, reason: c.reason },
            );
        }
        // c.name === "" is the archive root marker ("./"); it resolves to destDir itself.
        const target = c.name === "" ? destAbs : resolveWithin(destAbs, c.name);
        if (target === null) {
            refuse(
                CODE.ZIP_TRAVERSAL,
                `zip entry "${c.name}" resolves outside the extraction root`,
                { entryName: c.name, destDir: destAbs },
            );
        }

        // Caps are measured over what we will actually write. A bomb hidden in an entry
        // we skip by name is never inflated, so it cannot cost us anything.
        if (c.kind === ENTRY_KIND.XLSX) {
            const size = Number(entry.header.size) || 0;
            const packed = Number(entry.header.compressedSize) || 0;
            plannedBytes += size;
            if (plannedBytes > limits.maxUncompressedBytes) {
                refuse(
                    CODE.ZIP_SIZE_CAP,
                    `zip expands to at least ${plannedBytes} bytes, over the cap of ${limits.maxUncompressedBytes}`,
                    { bytes: plannedBytes, cap: limits.maxUncompressedBytes, entryName: c.name },
                );
            }
            if (size >= RATIO_MIN_BYTES && packed > 0 && size / packed > limits.maxCompressionRatio) {
                refuse(
                    CODE.ZIP_SIZE_CAP,
                    `zip entry "${c.name}" has a compression ratio of ${Math.round(size / packed)}:1, over the cap of ${limits.maxCompressionRatio}:1`,
                    { entryName: c.name, size, compressedSize: packed, cap: limits.maxCompressionRatio },
                );
            }
        }
        plan.push({ entry, target, ...c });
    }

    /* ---- pass 2: write ---- */
    const summary = {
        destDir: destAbs,
        entries: entries.length,
        extracted: 0,
        directories: 0,
        bytes: 0,
        skipped: { macosx: 0, lockfile: 0, nonXlsx: 0 },
        nonXlsxNames: [],
    };
    const macosxNames = [];

    for (const item of plan) {
        switch (item.kind) {
            case ENTRY_KIND.MACOSX:
                // Never materialized: recreating __MACOSX/ on disk would hand walkInput a
                // top-level folder with zero .xlsx, i.e. a fake FAILED subcontratista.
                summary.skipped.macosx++;
                macosxNames.push(item.name);
                break;

            case ENTRY_KIND.DIRECTORY:
                fs.mkdirSync(item.target, { recursive: true });
                summary.directories++;
                break;

            case ENTRY_KIND.LOCKFILE:
                // Skipped by NAME - getData() is never called on it.
                fs.mkdirSync(path.dirname(item.target), { recursive: true });
                summary.skipped.lockfile++;
                issues.info({
                    code: CODE.SKIPPED_LOCKFILE,
                    message: `skipped Excel lock file "${item.base}" - not opened`,
                    subcontratista: subcontratistaOf(item.name),
                    archivo: item.base,
                    detalle: { entryName: item.name },
                });
                break;

            case ENTRY_KIND.OTHER:
                // The parent folder is still created: a folder holding only a .pdf must
                // survive extraction so walkInput can raise FOLDER_NO_XLSX for it rather
                // than let the subcontratista vanish.
                fs.mkdirSync(path.dirname(item.target), { recursive: true });
                summary.skipped.nonXlsx++;
                summary.nonXlsxNames.push(item.name);
                issues.info({
                    code: CODE.SKIPPED_NON_XLSX,
                    message: `skipped non-.xlsx entry "${item.name}"`,
                    subcontratista: subcontratistaOf(item.name),
                    archivo: item.base,
                    detalle: { entryName: item.name },
                });
                break;

            case ENTRY_KIND.XLSX: {
                fs.mkdirSync(path.dirname(item.target), { recursive: true });
                const data = item.entry.getData();
                summary.bytes += data.length;
                // Belt and braces: the central-directory size is attacker-controlled, so
                // the cap is re-checked against what actually came out (GHSA-xcpc-8h2w-3j85).
                if (summary.bytes > limits.maxUncompressedBytes) {
                    refuse(
                        CODE.ZIP_SIZE_CAP,
                        `zip expanded past the cap of ${limits.maxUncompressedBytes} bytes while extracting "${item.name}"`,
                        { bytes: summary.bytes, cap: limits.maxUncompressedBytes, entryName: item.name },
                    );
                }
                fs.writeFileSync(item.target, data);
                summary.extracted++;
                break;
            }
        }
    }

    if (summary.skipped.macosx > 0) {
        // Aggregated on purpose: a macOS zip carries one __MACOSX entry per file, and
        // 150 identical INFO lines would drown the Errores sheet.
        issues.info({
            code: CODE.SKIPPED_MACOSX,
            message: `skipped ${summary.skipped.macosx} __MACOSX/ or ._ resource-fork entries`,
            detalle: { count: summary.skipped.macosx, ejemplos: macosxNames.slice(0, MACOSX_SAMPLE) },
        });
    }

    return summary;
}

/** Best-effort owner of an entry, for issue provenance: the first path segment. */
function subcontratistaOf(posixName) {
    const segments = posixName.split("/").filter(s => s.length > 0);
    return segments.length > 1 ? segments[0] : null;
}

/* ------------------------------------------------------------------ *
 * walkInput
 * ------------------------------------------------------------------ */

/**
 * One directory listing, classified and ORDERED.
 *
 * readdirSync's order is filesystem-dependent and is exactly what decides today which
 * of two workbooks wins. Everything downstream of here is sorted by code-unit order so
 * two runs over the same input produce the same list.
 */
function listDir(dirAbs) {
    const out = { dirs: [], files: [], macosx: [], lockfiles: [], others: [] };
    const dirents = fs.readdirSync(dirAbs, { withFileTypes: true });
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of dirents) {
        // Symlinks are never followed: a link is not a workbook, and following one
        // would reintroduce the escape that resolveWithin exists to prevent.
        const isDir = dirent.isDirectory();
        const isFile = dirent.isFile();
        const c = classifyEntry(dirent.name, isDir);
        const full = path.join(dirAbs, dirent.name);
        const item = { ...c, full, name: dirent.name };
        if (c.kind === ENTRY_KIND.MACOSX) out.macosx.push(item);
        else if (c.kind === ENTRY_KIND.UNSAFE) out.others.push(item);
        else if (isDir) out.dirs.push(item);
        else if (!isFile) out.others.push(item);           // symlink, socket, fifo
        else if (c.kind === ENTRY_KIND.LOCKFILE) out.lockfiles.push(item);
        else if (c.kind === ENTRY_KIND.XLSX) out.files.push(item);
        else out.others.push(item);
    }
    return out;
}

/**
 * Detect the operator's extra wrapper folder rather than assuming it (src/app.js
 * extracts into src/subcontratistas/ and then readdirSyncs it, so today's real zips
 * have one, and hand-made ones do not).
 *
 * Descend only when the level holds exactly one visible directory, no .xlsx of its own,
 * AND that directory itself contains a directory. That last clause is what keeps a
 * legitimate single-subcontratista zip (`Empresa A/lista.xlsx`) from being descended
 * into, which would lose "Empresa A" as the subcontratista's identity.
 *
 * One shape stays genuinely ambiguous: a lone `X/` holding only subfolders is either a
 * wrapper or a subcontratista who nested their workbooks. It resolves to "wrapper",
 * because that is the shape the operator's tooling actually produces; the alternative
 * would report the whole month as one subcontratista named X.
 */
function resolveRoot(rootAbs) {
    let current = rootAbs;
    let depth = 0;
    while (depth < MAX_WRAPPER_DEPTH) {
        const level = listDir(current);
        if (level.dirs.length !== 1 || level.files.length !== 0) break;
        const child = level.dirs[0];
        const inner = listDir(child.full);
        if (inner.dirs.length === 0) break;
        current = child.full;
        depth++;
    }
    return { root: current, wrapperDepth: depth };
}

/** Collect every .xlsx under one subcontratista folder, ordered, reporting what it skips. */
function collectWorkbooks(folderAbs, subcontratista, issues, tally, depth = 0) {
    const level = listDir(folderAbs);
    const found = [];

    tally.macosx += level.macosx.length;
    for (const m of level.macosx) tally.macosxNames.push(path.relative(tally.root, m.full));

    for (const lock of level.lockfiles) {
        tally.lockfile++;
        issues.info({
            code: CODE.SKIPPED_LOCKFILE,
            message: `skipped Excel lock file "${lock.name}" - not opened`,
            subcontratista,
            archivo: lock.name,
        });
    }
    for (const other of level.others) {
        tally.nonXlsx++;
        issues.info({
            code: CODE.SKIPPED_NON_XLSX,
            message: `skipped non-.xlsx file "${other.name}"`,
            subcontratista,
            archivo: other.name,
        });
    }
    for (const file of level.files) found.push(file.full);

    if (depth + 1 <= MAX_FOLDER_DEPTH) {
        // Nested one level deeper is a common Windows re-zip (Empresa/Empresa/x.xlsx);
        // everything found below still belongs to this subcontratista, so two workbooks
        // in two subfolders are still ambiguous and still FAILED.
        for (const sub of level.dirs) {
            found.push(...collectWorkbooks(sub.full, subcontratista, issues, tally, depth + 1));
        }
    }
    return found;
}

/**
 * Turn an extracted directory into the ordered list of workbooks to read.
 *
 * @param {string} dirPath   extraction root, or a plain --input folder
 * @param {IssueList} issues
 * @returns {Array<{subcontratista:string, folder:string, file:string, archivo:string}>}
 *          `folder` and `file` are absolute; `archivo` is the file's basename and
 *          `subcontratista` the folder's, both for issue provenance.
 *          The array carries a non-enumerable `.summary` (counts, wrapper detection,
 *          top-level folder count) - non-enumerable so deepEqual against a plain
 *          array of records still holds.
 */
function walkInput(dirPath, issues) {
    const given = path.resolve(dirPath);
    if (!fs.existsSync(given) || !fs.statSync(given).isDirectory()) {
        // A missing input directory is a caller bug, not a data problem - there is no
        // partial result to report and no issue CODE that would describe it.
        throw new Error(`input directory not found: ${given}`);
    }

    const { root, wrapperDepth } = resolveRoot(given);
    const tally = { root, macosx: 0, macosxNames: [], lockfile: 0, nonXlsx: 0 };
    const level = listDir(root);

    tally.macosx += level.macosx.length;
    for (const m of level.macosx) tally.macosxNames.push(path.relative(root, m.full));
    for (const lock of level.lockfiles) {
        tally.lockfile++;
        issues.info({
            code: CODE.SKIPPED_LOCKFILE,
            message: `skipped Excel lock file "${lock.name}" - not opened`,
            archivo: lock.name,
        });
    }
    for (const other of level.others) {
        tally.nonXlsx++;
        issues.info({
            code: CODE.SKIPPED_NON_XLSX,
            message: `skipped non-.xlsx file "${other.name}"`,
            archivo: other.name,
        });
    }

    const records = [];
    let foldersFailed = 0;

    for (const folder of level.dirs) {
        const subcontratista = folder.name;
        const workbooks = collectWorkbooks(folder.full, subcontratista, issues, tally);
        workbooks.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

        if (workbooks.length === 0) {
            // NOT "no workers this month". 03 §1.1: today this is indistinguishable from
            // an empty contribution, which is the failure mode §1's governing principle
            // exists to eliminate. FAILED, named, and the walk continues.
            foldersFailed++;
            issues.failed({
                code: CODE.FOLDER_NO_XLSX,
                message: `folder "${subcontratista}" contains no .xlsx - subcontratista skipped, this is NOT "no workers this month"`,
                subcontratista,
                detalle: { folder: folder.full },
            });
            continue;
        }
        if (workbooks.length > 1) {
            // Today readdirSync's order picks one of them silently.
            const names = workbooks.map(f => path.relative(folder.full, f));
            foldersFailed++;
            issues.failed({
                code: CODE.FOLDER_MULTIPLE_XLSX,
                message: `folder "${subcontratista}" contains ${workbooks.length} .xlsx files (${names.join(", ")}) - cannot choose, subcontratista skipped`,
                subcontratista,
                detalle: { folder: folder.full, archivos: names },
            });
            continue;
        }

        records.push({
            subcontratista,
            folder: folder.full,
            file: workbooks[0],
            archivo: path.basename(workbooks[0]),
        });
    }

    // Loose .xlsx sitting directly in the root: a flat drop with no folder per company.
    // The file's stem is then the only identity available, and it is used rather than
    // dropping the file - a workbook nobody mentions is the failure this module exists
    // to prevent. Counted separately in the summary so the shape is visible.
    for (const file of level.files) {
        records.push({
            subcontratista: file.base.replace(/\.xlsx$/i, ""),
            folder: root,
            file: file.full,
            archivo: file.base,
        });
    }

    if (tally.macosx > 0) {
        issues.info({
            code: CODE.SKIPPED_MACOSX,
            message: `skipped ${tally.macosx} __MACOSX/ or ._ resource-fork paths`,
            detalle: { count: tally.macosx, ejemplos: tally.macosxNames.slice(0, MACOSX_SAMPLE) },
        });
    }

    Object.defineProperty(records, "summary", {
        enumerable: false,
        value: {
            root,
            wrapper: wrapperDepth > 0,
            wrapperDepth,
            topLevelFolders: level.dirs.length,
            foldersOk: level.dirs.length - foldersFailed,
            foldersFailed,
            looseFiles: level.files.length,
            skipped: { macosx: tally.macosx, lockfile: tally.lockfile, nonXlsx: tally.nonXlsx },
        },
    });
    return records;
}

/* ------------------------------------------------------------------ *
 * Per-run temp directory
 * ------------------------------------------------------------------ */

/**
 * Create a fresh per-run directory under config.TMP_ROOT.
 *
 * mkdtemp rather than a timestamp: it is atomic, collision-free, and keeps the wall
 * clock out of the module. Nothing is retained - the caller removes this in a `finally`
 * on every path, success or failure (05 §7 step 9, BUG-43/BUG-44).
 *
 * @param {string} [prefix]
 * @returns {string} absolute path
 */
function makeRunDir(prefix = "run-") {
    fs.mkdirSync(config.TMP_ROOT, { recursive: true });
    return fs.mkdtempSync(path.join(config.TMP_ROOT, prefix));
}

/**
 * Remove a per-run directory. Idempotent, and refuses to delete anything that is not
 * under config.TMP_ROOT - a recursive rm driven by a path from elsewhere in the app is
 * one bad join away from deleting src/.
 */
function removeRunDir(dirPath) {
    const target = path.resolve(dirPath);
    const rootAbs = path.resolve(config.TMP_ROOT);
    if (target === rootAbs || !target.startsWith(rootAbs + path.sep)) {
        throw new Error(`refusing to remove ${target}: outside TMP_ROOT ${rootAbs}`);
    }
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
}

module.exports = {
    extractZip,
    walkInput,
    makeRunDir,
    removeRunDir,
    classifyEntry,
    resolveWithin,
    ZipRefusedError,
    ENTRY_KIND,
    DEFAULT_LIMITS,
    RATIO_MIN_BYTES,
};

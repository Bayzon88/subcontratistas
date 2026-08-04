"use strict";
/**
 * Container fixtures are built programmatically here rather than committed as binary
 * blobs: the pathologies (a __MACOSX/ twin, a ~$ lock file, two workbooks in one folder,
 * a traversal entry, an entry-count bomb) are all name-level, so a generated zip is an
 * exact reproduction and stays greppable.
 *
 * jszip is used for the traversal fixtures because adm-zip's addFile SANITIZES the name
 * on the way in ("../evil.xlsx" is stored as "evil.xlsx"), so a hostile archive cannot
 * be built with it. jszip stores the name verbatim, which is what a hostile producer does.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const JSZip = require("jszip");

const config = require("../config");
const { CODE, SEVERITY, IssueList } = require("../pipeline/issues");
const {
    extractZip,
    walkInput,
    makeRunDir,
    removeRunDir,
    classifyEntry,
    ZipRefusedError,
    ENTRY_KIND,
    DEFAULT_LIMITS,
} = require("../pipeline/zip");

const CASES = require("./cases/zip.json");

/** One sandbox for the whole file; every fixture gets a subdirectory of it. */
let SANDBOX;
let seq = 0;

before(() => { SANDBOX = makeRunDir("zip-test-"); });
after(() => { removeRunDir(SANDBOX); });

function scratch(name) {
    const dir = path.join(SANDBOX, `${String(seq++).padStart(3, "0")}-${name}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * A payload that behaves like a real .xlsx: an xlsx IS a zip, so its bytes are already
 * compressed and deflate cannot shrink them. Deterministic PRNG rather than
 * crypto.randomBytes so a failing run reproduces exactly. (A patterned buffer here
 * compresses 248:1 and trips the ratio cap - that mistake is why this comment exists.)
 */
function payload(bytes = 512) {
    const buf = Buffer.alloc(bytes);
    let s = 0x9e3779b9;
    for (let i = 0; i < bytes; i++) {
        s ^= s << 13; s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5; s >>>= 0;
        buf[i] = s & 0xff;
    }
    return buf;
}

/** entries: { "path/in/zip": Buffer | null }  (null = directory entry) */
function buildZip(name, entries) {
    const zip = new AdmZip();
    for (const [entryName, data] of Object.entries(entries)) {
        if (data === null) zip.addFile(entryName.endsWith("/") ? entryName : entryName + "/", Buffer.alloc(0));
        else zip.addFile(entryName, data);
    }
    const file = path.join(scratch("zips"), `${name}.zip`);
    zip.writeZip(file);
    return file;
}

/** Same, but names are stored verbatim - the only way to produce a traversal entry. */
async function buildHostileZip(name, entries) {
    const zip = new JSZip();
    for (const [entryName, data] of Object.entries(entries)) zip.file(entryName, data);
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    const file = path.join(scratch("zips"), `${name}.zip`);
    fs.writeFileSync(file, buf);
    return file;
}

/** Materialize a directory tree: { "A/lista.xlsx": Buffer, "B/": null } */
function buildTree(name, entries) {
    const root = scratch(name);
    for (const [rel, data] of Object.entries(entries)) {
        const full = path.join(root, rel);
        if (data === null) fs.mkdirSync(full, { recursive: true });
        else {
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, data);
        }
    }
    return root;
}

/** Every path under dir, relative and sorted - so on-disk assertions are exact. */
function listTree(dir) {
    const out = [];
    const walk = (d, prefix) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const rel = prefix ? `${prefix}/${e.name}` : e.name;
            if (e.isDirectory()) { out.push(rel + "/"); walk(path.join(d, e.name), rel); }
            else out.push(rel);
        }
    };
    walk(dir, "");
    return out.sort();
}

const codes = issues => issues.items.map(i => i.code);

/* ================================================================== *
 * classifyEntry - the committed case table
 * ================================================================== */

describe("classifyEntry (case table)", () => {
    const ISSUE_FOR_KIND = {
        [ENTRY_KIND.MACOSX]: CODE.SKIPPED_MACOSX,
        [ENTRY_KIND.LOCKFILE]: CODE.SKIPPED_LOCKFILE,
        [ENTRY_KIND.OTHER]: CODE.SKIPPED_NON_XLSX,
        [ENTRY_KIND.UNSAFE]: CODE.ZIP_TRAVERSAL,
        [ENTRY_KIND.XLSX]: null,
        [ENTRY_KIND.DIRECTORY]: null,
    };

    test("every committed case classifies as expected", () => {
        assert.ok(CASES.length >= 20, "the case table should cover the measured pathologies");
        for (const c of CASES) {
            const got = classifyEntry(c.input.name, c.input.isDirectory);
            for (const [field, want] of Object.entries(c.expected)) {
                assert.equal(got[field], want, `${c.why} :: ${JSON.stringify(c.input.name)} .${field}`);
            }
            assert.equal(
                ISSUE_FOR_KIND[got.kind],
                c.expectedIssue,
                `${c.why} :: ${JSON.stringify(c.input.name)} issue code`,
            );
        }
    });

    test("every expectedIssue in the table is a real CODE", () => {
        for (const c of CASES) {
            if (c.expectedIssue !== null) assert.ok(CODE[c.expectedIssue], `unknown code ${c.expectedIssue}`);
        }
    });
});

/* ================================================================== *
 * extractZip
 * ================================================================== */

describe("extractZip", () => {
    test("limits default to config.js", () => {
        assert.deepEqual(DEFAULT_LIMITS, {
            maxEntries: config.MAX_ENTRIES,
            maxUncompressedBytes: config.MAX_UNCOMPRESSED_BYTES,
            maxCompressionRatio: config.MAX_COMPRESSION_RATIO,
        });
    });

    test("clean zip: both workbooks extracted, no issues", () => {
        const zip = buildZip("clean", {
            "CONSTRUCTORA ANDINA SAC/lista.xlsx": payload(),
            "SERVICIOS DEL SUR EIRL/lista.xlsx": payload(),
        });
        const dest = scratch("clean-dest");
        const issues = new IssueList();
        const summary = extractZip(zip, dest, issues);

        assert.equal(issues.length, 0);
        assert.equal(summary.extracted, 2);
        assert.deepEqual(listTree(dest), [
            "CONSTRUCTORA ANDINA SAC/",
            "CONSTRUCTORA ANDINA SAC/lista.xlsx",
            "SERVICIOS DEL SUR EIRL/",
            "SERVICIOS DEL SUR EIRL/lista.xlsx",
        ]);
    });

    test("__MACOSX/ and ._ forks: one aggregated INFO, nothing written (BUG-33)", () => {
        const zip = buildZip("macosx", {
            "__MACOSX/": null,
            "__MACOSX/Empresa A/._lista.xlsx": payload(64),
            "Empresa A/._lista.xlsx": payload(64),
            "Empresa A/lista.xlsx": payload(),
        });
        const dest = scratch("macosx-dest");
        const issues = new IssueList();
        const summary = extractZip(zip, dest, issues);

        assert.equal(summary.skipped.macosx, 3);
        assert.equal(summary.extracted, 1);
        // Aggregated: one INFO for the whole class, not one per entry.
        assert.equal(issues.length, 1);
        assert.equal(issues.items[0].severity, SEVERITY.INFO);
        assert.equal(issues.items[0].code, CODE.SKIPPED_MACOSX);
        assert.equal(issues.items[0].detalle.count, 3);
        // __MACOSX must not survive as a folder: walkInput would read it as a
        // subcontratista with zero workbooks and report a phantom FAILED.
        assert.deepEqual(listTree(dest), ["Empresa A/", "Empresa A/lista.xlsx"]);
    });

    test("~$ lock file: INFO by name, never opened, never written", () => {
        const zip = buildZip("lock", {
            "Empresa A/~$Reporte_Subcontratistas_FEBRERO_2025.xlsx": payload(),
            "Empresa A/lista.xlsx": payload(),
        });
        const dest = scratch("lock-dest");
        const issues = new IssueList();
        const summary = extractZip(zip, dest, issues);

        assert.equal(summary.skipped.lockfile, 1);
        assert.deepEqual(codes(issues), [CODE.SKIPPED_LOCKFILE]);
        assert.equal(issues.items[0].severity, SEVERITY.INFO);
        assert.match(issues.items[0].message, /~\$Reporte_Subcontratistas_FEBRERO_2025\.xlsx/);
        assert.equal(issues.items[0].subcontratista, "Empresa A");
        assert.deepEqual(listTree(dest), ["Empresa A/", "Empresa A/lista.xlsx"]);
    });

    test("non-.xlsx entries: one INFO each, listed by name, folder still created", () => {
        const zip = buildZip("mixed", {
            "Empresa A/constancia.pdf": payload(),
            "Empresa A/personal.csv": payload(),
            "Empresa A/foto.JPG": payload(),
            "Empresa A/lista.xls": payload(),
            "Empresa B/lista.xlsx": payload(),
        });
        const dest = scratch("mixed-dest");
        const issues = new IssueList();
        const summary = extractZip(zip, dest, issues);

        assert.equal(summary.skipped.nonXlsx, 4);
        assert.deepEqual(issues.byCode(CODE.SKIPPED_NON_XLSX).map(i => i.archivo).sort(), [
            "constancia.pdf", "foto.JPG", "lista.xls", "personal.csv",
        ]);
        for (const i of issues.items) assert.equal(i.severity, SEVERITY.INFO);
        assert.deepEqual(summary.nonXlsxNames.sort(), [
            "Empresa A/constancia.pdf", "Empresa A/foto.JPG", "Empresa A/lista.xls", "Empresa A/personal.csv",
        ]);
        // "Empresa A/" exists but is empty: walkInput must be able to say so.
        assert.deepEqual(listTree(dest), ["Empresa A/", "Empresa B/", "Empresa B/lista.xlsx"]);
    });

    test("zip-slip: ../ entry raises FAILED ZIP_TRAVERSAL, aborts, writes nothing (BUG-34)", async () => {
        const zip = await buildHostileZip("slip", { "../evil.xlsx": "x", "Empresa A/lista.xlsx": "y" });
        const dest = scratch("slip-dest");
        const outside = path.dirname(dest);
        const issues = new IssueList();

        assert.throws(() => extractZip(zip, dest, issues), ZipRefusedError);
        assert.deepEqual(codes(issues), [CODE.ZIP_TRAVERSAL]);
        assert.equal(issues.items[0].severity, SEVERITY.FAILED);
        // jszip materializes the implied "../" directory entry first, so that is the
        // entry named in the refusal - the run aborts on the FIRST escape it sees.
        assert.match(issues.items[0].message, /"\.\.\//);
        assert.equal(issues.items[0].detalle.reason, "parent-directory segment");
        assert.equal(fs.existsSync(path.join(outside, "evil.xlsx")), false);
        assert.deepEqual(listTree(dest), [], "header validation runs before any write");
    });

    test("zip-slip: absolute entry raises FAILED ZIP_TRAVERSAL", async () => {
        const zip = await buildHostileZip("abs", { "/tmp/evil.xlsx": "x" });
        const dest = scratch("abs-dest");
        const issues = new IssueList();

        assert.throws(() => extractZip(zip, dest, issues), /absolute path/);
        assert.deepEqual(codes(issues), [CODE.ZIP_TRAVERSAL]);
        assert.equal(issues.items[0].severity, SEVERITY.FAILED);
    });

    test("entry cap (config.MAX_ENTRIES + 1): FAILED ZIP_ENTRY_CAP, nothing extracted", () => {
        const entries = {};
        for (let i = 0; i <= config.MAX_ENTRIES; i++) entries[`Empresa ${i}/lista.xlsx`] = Buffer.from("x");
        const zip = buildZip("entrybomb", entries);
        const dest = scratch("entrybomb-dest");
        const issues = new IssueList();

        assert.throws(() => extractZip(zip, dest, issues), ZipRefusedError);
        assert.deepEqual(codes(issues), [CODE.ZIP_ENTRY_CAP]);
        assert.equal(issues.items[0].severity, SEVERITY.FAILED);
        assert.equal(issues.items[0].detalle.cap, config.MAX_ENTRIES);
        assert.deepEqual(listTree(dest), []);
    });

    test("entry cap is enforced from the injected limit too", () => {
        const zip = buildZip("entrybomb-small", {
            "A/lista.xlsx": payload(), "B/lista.xlsx": payload(), "C/lista.xlsx": payload(),
        });
        const dest = scratch("entrybomb-small-dest");
        const issues = new IssueList();
        assert.throws(() => extractZip(zip, dest, issues, { maxEntries: 2 }), ZipRefusedError);
        assert.deepEqual(codes(issues), [CODE.ZIP_ENTRY_CAP]);
    });

    test("uncompressed-size cap: FAILED ZIP_SIZE_CAP before anything is written", () => {
        const zip = buildZip("sizebomb", { "Empresa A/lista.xlsx": payload(4096) });
        const dest = scratch("sizebomb-dest");
        const issues = new IssueList();

        assert.throws(() => extractZip(zip, dest, issues, { maxUncompressedBytes: 1024 }), ZipRefusedError);
        assert.deepEqual(codes(issues), [CODE.ZIP_SIZE_CAP]);
        assert.equal(issues.items[0].severity, SEVERITY.FAILED);
        assert.deepEqual(listTree(dest), []);
    });

    test("compression-ratio cap fires on a real bomb under the CONFIG limits (GHSA-xcpc-8h2w-3j85)", () => {
        // 2 MB of zeros deflates to ~2 KB: a ~1000:1 ratio, over MAX_COMPRESSION_RATIO.
        const zip = buildZip("ratiobomb", { "Empresa A/lista.xlsx": Buffer.alloc(2 * 1024 * 1024) });
        const dest = scratch("ratiobomb-dest");
        const issues = new IssueList();

        assert.throws(() => extractZip(zip, dest, issues), ZipRefusedError);
        assert.deepEqual(codes(issues), [CODE.ZIP_SIZE_CAP]);
        assert.equal(issues.items[0].severity, SEVERITY.FAILED);
        assert.match(issues.items[0].message, /compression ratio/);
        assert.deepEqual(listTree(dest), []);
    });

    test("a real 2 MB workbook-shaped payload does NOT trip the ratio cap", () => {
        const zip = buildZip("bigreal", { "Empresa A/lista.xlsx": payload(2 * 1024 * 1024) });
        const dest = scratch("bigreal-dest");
        const issues = new IssueList();
        const summary = extractZip(zip, dest, issues);
        assert.equal(summary.extracted, 1);
        assert.equal(issues.length, 0);
    });
});

/* ================================================================== *
 * walkInput
 * ================================================================== */

describe("walkInput", () => {
    test("flat shape: one folder per subcontratista, ordered deterministically", () => {
        const root = buildTree("flat", {
            "ZETA SAC/lista.xlsx": payload(),
            "ANDINA SAC/lista.xlsx": payload(),
            "MEDIA SRL/lista.xlsx": payload(),
        });
        const issues = new IssueList();
        const got = walkInput(root, issues);

        assert.deepEqual(got.map(r => r.subcontratista), ["ANDINA SAC", "MEDIA SRL", "ZETA SAC"]);
        assert.equal(issues.length, 0);
        assert.equal(got[0].file, path.join(root, "ANDINA SAC", "lista.xlsx"));
        assert.equal(got[0].folder, path.join(root, "ANDINA SAC"));
        assert.equal(got[0].archivo, "lista.xlsx");
        assert.equal(got.summary.wrapper, false);
        assert.equal(got.summary.topLevelFolders, 3);
    });

    test("more than one top-level folder: each processed, count reported", () => {
        const root = buildTree("many", {
            "A/lista.xlsx": payload(), "B/lista.xlsx": payload(),
            "C/lista.xlsx": payload(), "D/lista.xlsx": payload(),
        });
        const got = walkInput(root, new IssueList());
        assert.equal(got.length, 4);
        assert.equal(got.summary.topLevelFolders, 4);
        assert.equal(got.summary.foldersOk, 4);
        assert.equal(got.summary.foldersFailed, 0);
    });

    test("wrapper folder is DETECTED and descended (the shape the operator produces)", () => {
        const root = buildTree("wrapper", {
            "Febrero-2026/ANDINA SAC/lista.xlsx": payload(),
            "Febrero-2026/SUR EIRL/lista.xlsx": payload(),
        });
        const got = walkInput(root, new IssueList());
        assert.deepEqual(got.map(r => r.subcontratista), ["ANDINA SAC", "SUR EIRL"]);
        assert.equal(got.summary.wrapper, true);
        assert.equal(got.summary.wrapperDepth, 1);
        assert.equal(got.summary.root, path.join(root, "Febrero-2026"));
    });

    test("a single subcontratista folder is NOT mistaken for a wrapper", () => {
        // The regression this guards: descending here would rename the subcontratista
        // from its folder to the workbook's file stem.
        const root = buildTree("single", { "ANDINA SAC/lista.xlsx": payload() });
        const got = walkInput(root, new IssueList());
        assert.deepEqual(got.map(r => r.subcontratista), ["ANDINA SAC"]);
        assert.equal(got.summary.wrapper, false);
    });

    test("wrapper holding exactly one subcontratista still resolves to the folder name", () => {
        const root = buildTree("wrapper-single", { "Febrero-2026/ANDINA SAC/lista.xlsx": payload() });
        const got = walkInput(root, new IssueList());
        assert.deepEqual(got.map(r => r.subcontratista), ["ANDINA SAC"]);
        assert.equal(got.summary.wrapperDepth, 1);
    });

    test("two .xlsx in one folder: FAILED naming the folder AND BOTH files, does not throw", () => {
        const root = buildTree("two-books", {
            "ANDINA SAC/lista.xlsx": payload(),
            "ANDINA SAC/lista-v2.xlsx": payload(),
            "SUR EIRL/lista.xlsx": payload(),
        });
        const issues = new IssueList();
        const got = walkInput(root, issues);   // must not throw

        assert.deepEqual(got.map(r => r.subcontratista), ["SUR EIRL"], "the other folders still run");
        assert.deepEqual(codes(issues), [CODE.FOLDER_MULTIPLE_XLSX]);
        const i = issues.items[0];
        assert.equal(i.severity, SEVERITY.FAILED);
        assert.equal(i.subcontratista, "ANDINA SAC");
        assert.match(i.message, /ANDINA SAC/);
        assert.match(i.message, /lista\.xlsx/);
        assert.match(i.message, /lista-v2\.xlsx/);
        assert.deepEqual(i.detalle.archivos.sort(), ["lista-v2.xlsx", "lista.xlsx"]);
        assert.equal(got.summary.foldersFailed, 1);
    });

    test("zero .xlsx in a folder: FAILED naming the folder, never a silent empty contribution", () => {
        const root = buildTree("no-books", {
            "ANDINA SAC/constancia.pdf": payload(),
            "VACIA SRL/": null,
            "SUR EIRL/lista.xlsx": payload(),
        });
        const issues = new IssueList();
        const got = walkInput(root, issues);

        assert.deepEqual(got.map(r => r.subcontratista), ["SUR EIRL"]);
        const failed = issues.bySeverity(SEVERITY.FAILED);
        assert.deepEqual(failed.map(i => i.code), [CODE.FOLDER_NO_XLSX, CODE.FOLDER_NO_XLSX]);
        assert.deepEqual(failed.map(i => i.subcontratista), ["ANDINA SAC", "VACIA SRL"]);
        assert.match(failed[0].message, /ANDINA SAC/);
        assert.match(failed[0].message, /no workers this month/, "the message says what it is NOT");
        assert.deepEqual(issues.byCode(CODE.SKIPPED_NON_XLSX).map(i => i.archivo), ["constancia.pdf"]);
        assert.equal(got.summary.foldersFailed, 2);
    });

    test("a ~$ lock file does not count as the folder's second workbook", () => {
        const root = buildTree("lock-walk", {
            "ANDINA SAC/lista.xlsx": payload(),
            "ANDINA SAC/~$lista.xlsx": payload(),
        });
        const issues = new IssueList();
        const got = walkInput(root, issues);

        assert.equal(got.length, 1);
        assert.equal(got[0].archivo, "lista.xlsx");
        assert.deepEqual(codes(issues), [CODE.SKIPPED_LOCKFILE]);
        assert.equal(issues.items[0].severity, SEVERITY.INFO);
        assert.equal(issues.bySeverity(SEVERITY.FAILED).length, 0);
    });

    test("__MACOSX/ on disk is never a subcontratista", () => {
        const root = buildTree("macosx-walk", {
            "__MACOSX/Empresa A/._lista.xlsx": payload(),
            "Empresa A/lista.xlsx": payload(),
            "Empresa A/._lista.xlsx": payload(),
        });
        const issues = new IssueList();
        const got = walkInput(root, issues);

        assert.deepEqual(got.map(r => r.subcontratista), ["Empresa A"]);
        assert.equal(got.summary.topLevelFolders, 1);
        assert.deepEqual(codes(issues), [CODE.SKIPPED_MACOSX]);
        assert.equal(issues.items[0].detalle.count, 2, "the root fork dir plus the one beside the workbook");
        assert.equal(issues.bySeverity(SEVERITY.FAILED).length, 0);
    });

    test("a workbook nested one level deeper is still found (Windows re-zip)", () => {
        const root = buildTree("nested", {
            "ANDINA SAC/ANDINA SAC/lista.xlsx": payload(),
            "SUR EIRL/lista.xlsx": payload(),
        });
        const got = walkInput(root, new IssueList());
        assert.deepEqual(got.map(r => r.subcontratista), ["ANDINA SAC", "SUR EIRL"]);
        assert.equal(got[0].file, path.join(root, "ANDINA SAC", "ANDINA SAC", "lista.xlsx"));
    });

    test("two workbooks in two subfolders of one subcontratista are still ambiguous", () => {
        // A sibling folder is present on purpose: with ANDINA SAC alone at the root, the
        // level is indistinguishable from a wrapper and is descended into instead.
        const root = buildTree("nested-two", {
            "ANDINA SAC/enero/lista.xlsx": payload(),
            "ANDINA SAC/febrero/lista.xlsx": payload(),
            "SUR EIRL/lista.xlsx": payload(),
        });
        const issues = new IssueList();
        const got = walkInput(root, issues);
        assert.deepEqual(got.map(r => r.subcontratista), ["SUR EIRL"]);
        assert.deepEqual(codes(issues), [CODE.FOLDER_MULTIPLE_XLSX]);
        assert.deepEqual(issues.items[0].detalle.archivos.sort(), ["enero/lista.xlsx", "febrero/lista.xlsx"]);
    });

    test("loose root-level workbooks are kept, keyed by file stem", () => {
        const root = buildTree("loose", {
            "ANDINA SAC.xlsx": payload(),
            "SUR EIRL.xlsx": payload(),
        });
        const got = walkInput(root, new IssueList());
        assert.deepEqual(got.map(r => r.subcontratista), ["ANDINA SAC", "SUR EIRL"]);
        assert.equal(got.summary.looseFiles, 2);
    });

    test("summary is non-enumerable, so the result is still a plain list of records", () => {
        const root = buildTree("plain", { "A/lista.xlsx": payload() });
        const got = walkInput(root, new IssueList());
        assert.deepEqual(got, [{
            subcontratista: "A",
            folder: path.join(root, "A"),
            file: path.join(root, "A", "lista.xlsx"),
            archivo: "lista.xlsx",
        }]);
        assert.ok(Array.isArray(got));
        assert.ok(got.summary);
    });

    test("a missing input directory is a caller bug and throws", () => {
        assert.throws(() => walkInput(path.join(SANDBOX, "does-not-exist"), new IssueList()), /not found/);
    });
});

/* ================================================================== *
 * extract -> walk, on the shape the operator actually uploads
 * ================================================================== */

describe("extractZip + walkInput end to end", () => {
    test("macOS zip with a wrapper, forks, a lock file, a pdf and two broken folders", () => {
        const zip = buildZip("real-shape", {
            "__MACOSX/": null,
            "__MACOSX/Febrero-2026/._ANDINA SAC": payload(64),
            "Febrero-2026/ANDINA SAC/lista.xlsx": payload(),
            "Febrero-2026/ANDINA SAC/~$lista.xlsx": payload(),
            "Febrero-2026/SUR EIRL/lista.xlsx": payload(),
            "Febrero-2026/SUR EIRL/lista (1).xlsx": payload(),
            "Febrero-2026/NORTE SA/constancia.pdf": payload(),
            "Febrero-2026/CENTRO SAC/lista.xlsx": payload(),
        });
        const dest = scratch("real-dest");
        const issues = new IssueList();

        const summary = extractZip(zip, dest, issues);
        assert.equal(summary.extracted, 4);
        assert.equal(summary.skipped.macosx, 2);
        assert.equal(summary.skipped.lockfile, 1);
        assert.equal(summary.skipped.nonXlsx, 1);

        const got = walkInput(dest, issues);
        assert.deepEqual(got.map(r => r.subcontratista), ["ANDINA SAC", "CENTRO SAC"]);
        assert.equal(got.summary.wrapper, true);
        assert.equal(got.summary.topLevelFolders, 4);
        assert.equal(got.summary.foldersFailed, 2);

        // Exact severities: three INFO from extraction, two FAILED from the walk.
        assert.deepEqual(issues.counts(), { INFO: 3, WARNING: 0, ERROR: 0, FAILED: 2 });
        assert.deepEqual(
            issues.bySeverity(SEVERITY.FAILED).map(i => [i.code, i.subcontratista]),
            [[CODE.FOLDER_NO_XLSX, "NORTE SA"], [CODE.FOLDER_MULTIPLE_XLSX, "SUR EIRL"]],
        );
        assert.ok(issues.hasBlockingIssues());
    });
});

/* ================================================================== *
 * per-run temp directory
 * ================================================================== */

describe("makeRunDir / removeRunDir", () => {
    test("creates a fresh, unique directory under config.TMP_ROOT", () => {
        const a = makeRunDir();
        const b = makeRunDir();
        try {
            assert.notEqual(a, b);
            assert.ok(a.startsWith(path.resolve(config.TMP_ROOT) + path.sep));
            assert.ok(fs.statSync(a).isDirectory());
        } finally {
            removeRunDir(a);
            removeRunDir(b);
        }
    });

    test("removes recursively and is idempotent (the finally runs on every path)", () => {
        const dir = makeRunDir();
        fs.mkdirSync(path.join(dir, "Empresa A"), { recursive: true });
        fs.writeFileSync(path.join(dir, "Empresa A", "lista.xlsx"), payload());
        removeRunDir(dir);
        assert.equal(fs.existsSync(dir), false);
        removeRunDir(dir);   // must not throw on the second pass
    });

    test("refuses to remove anything outside TMP_ROOT", () => {
        assert.throws(() => removeRunDir(config.SRC), /outside TMP_ROOT/);
        assert.throws(() => removeRunDir(config.TMP_ROOT), /outside TMP_ROOT/);
        assert.throws(() => removeRunDir(path.join(config.TMP_ROOT, "..", "elsewhere")), /outside TMP_ROOT/);
    });
});

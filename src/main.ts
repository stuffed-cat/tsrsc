#!/usr/bin/env node
import { transpileFile, suggestOutputPath } from './transpiler';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { Worker } from 'worker_threads';

// ---- Build cache & worker pool early definitions (must appear before any potential runInPool usage) ----
interface BuildSig { size: number; mtime: number; }
const CACHE_ROOT = path.join(os.homedir(), '.tsrsc'); // ensure defined early
const BUILD_CACHE_FILE = path.join(CACHE_ROOT, 'build-cache.json');
let BUILD_CACHE: Record<string, BuildSig> = (() => { try { return JSON.parse(fs.readFileSync(BUILD_CACHE_FILE,'utf8')); } catch { return {}; } })();
let BUILD_CACHE_DIRTY = false;
function fileSig(p: string): BuildSig | undefined { try { const st = fs.statSync(p); return { size: st.size, mtime: st.mtimeMs }; } catch { return undefined; } }
function persistBuildCache() { if (BUILD_CACHE_DIRTY) { try { fs.writeFileSync(BUILD_CACHE_FILE, JSON.stringify(BUILD_CACHE), 'utf8'); BUILD_CACHE_DIRTY=false; } catch { /* ignore */ } } }
const PERSIST_WORKERS: { jobs: number; workers: Worker[]; idle: Worker[]; } = { jobs: 0, workers: [], idle: [] };
function ensureWorkers(n: number, absWorker: string) {
    if (PERSIST_WORKERS.jobs === n && PERSIST_WORKERS.workers.length === n) return;
    for (const w of PERSIST_WORKERS.workers) { try { w.terminate(); } catch {} }
    PERSIST_WORKERS.workers = []; PERSIST_WORKERS.idle = []; PERSIST_WORKERS.jobs = n;
    for (let i=0;i<n;i++){ const w = new Worker(absWorker); PERSIST_WORKERS.workers.push(w); PERSIST_WORKERS.idle.push(w);} }


// 全局缓存根目录: ~/.tsrsc (已提前定义在顶部确保 build cache 可用)
// 注意: 顶部已定义 CACHE_ROOT，若未定义则此处兜底
// 顶部补定义后此处只初始化 REPOS 目录
const CACHE_REPOS = path.join(CACHE_ROOT, 'repos');
fs.mkdirSync(CACHE_REPOS, { recursive: true });

function cacheKeyForRepo(url: string): string {
    // 规范化去掉协议中的非字母数字，保留基本结构
    return url.replace(/^git\+/, '').replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function getOrCloneRepoShallow(url: string): { path: string, reused: boolean } {
    const key = cacheKeyForRepo(url);
    const target = path.join(CACHE_REPOS, key);
    if (fs.existsSync(path.join(target, '.git'))) {
        return { path: target, reused: true };
    }
    fs.mkdirSync(target, { recursive: true });
    const res = spawnSync('git', ['clone', '--depth', '1', '--no-single-branch', url, target], { stdio: 'inherit' });
    if (res.status !== 0) {
        throw new Error(`git clone failed: ${url}`);
    }
    return { path: target, reused: false };
}

function printHelp() {
    console.log(`tsrsc - TypeScript → Rust 原型编译器

用法:
        tsrsc <input.ts> [--out <output.rs>]
            tsrsc --dir <srcDir> [--outDir <outDir>]
            tsrsc --pkg [<package.json>] [--outDir <outDir>] [--fetch] [--registry <url>] [--deps]
            tsrsc --cargo <srcDir> [--crate <crateName>] [--outDir <outDir>]
        tsrsc --bootstrap [--deps] [--fetch] [--registry <url>]  # 生成 rs-out 与 cargo-out（stub-only），可选编译依赖

示例:
    tsrsc examples/add.ts --out examples/add.rs

说明:
    - 当前为最小原型，支持的子集：
        函数声明、number 字面量、+ - * /、let 声明、return。
`);
}

function main(argv: string[]) {
    const args = argv.slice(2);
    if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
        printHelp();
        return;
    }

    const isDirMode = args[0] === '--dir';
    const isCargoMode = args[0] === '--cargo';
    const isPkgMode = args[0] === '--pkg';
    const isBootstrap = args[0] === '--bootstrap';
    const jobs = parseJobs(args);
    // 测试文件过滤控制：默认跳过 tests/__tests__ 目录；使用 --with-tests 或 --include-tests 取消过滤
    const includeTests = args.includes('--with-tests') || args.includes('--include-tests');
    // 修正：原 regex 仅匹配 _tests / __tests, 未匹配普通 tests 目录，导致 tests 未被过滤
    const testPathRegex = /(^|[\\/])(tests|__tests__|__tests)([\\/]|$)/i;
    const isTestPath = (p: string) => testPathRegex.test(p);
    const filterOutTests = <T extends string>(arr: T[]): T[] => includeTests ? arr : arr.filter(f => !isTestPath(f));
    const filterTasks = <T extends { input: string }>(arr: T[]): T[] => includeTests ? arr : arr.filter(t => !isTestPath(t.input));
    if (isDirMode) {
        const srcDir = args[1];
        if (!srcDir) { console.error('Missing <srcDir>'); return; }
        const outDirFlagIdx = args.indexOf('--outDir');
        const outDir = outDirFlagIdx >= 0 && args[outDirFlagIdx + 1] ? args[outDirFlagIdx + 1] : path.join(srcDir, '../rs-out');
        fs.mkdirSync(outDir, { recursive: true });

        const files: string[] = [];
        const exclude = new Set(['node_modules','dist','build','.git','out','rs-out']);
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.isDirectory()) { if (!exclude.has(entry.name)) walk(path.join(dir, entry.name)); continue; }
                if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(path.join(dir, entry.name));
            }
        };
    walk(srcDir);
    const finalFiles = filterOutTests(files);
    runInPool(finalFiles.map(f => ({ input: f, output: path.join(outDir, path.relative(srcDir, f).replace(/\.ts$/, '.rs')), options: { fast: true } })), jobs);
        return;
    }
    if (isPkgMode) {
        const pkgPath = args[1] && !args[1].startsWith('--') ? args[1] : 'package.json';
        if (!fs.existsSync(pkgPath)) { console.error(`package.json not found at ${pkgPath}`); return; }
        const root = path.dirname(path.resolve(pkgPath));
        const outDirFlagIdx = args.indexOf('--outDir');
        const outDir = outDirFlagIdx >= 0 && args[outDirFlagIdx + 1] ? path.resolve(args[outDirFlagIdx + 1]) : path.join(root, 'rs-out');
        const fetchRemote = args.includes('--fetch');
        const compileDeps = args.includes('--deps');
        const registryIdx = args.indexOf('--registry');
        const registryFromArg = registryIdx >= 0 && args[registryIdx + 1] ? args[registryIdx + 1] : undefined;
        const raw = fs.readFileSync(pkgPath, 'utf8');
        let pkg: any;
        try { pkg = JSON.parse(raw); } catch { console.error(`Invalid JSON: ${pkgPath}`); return; }

        // 解析注册源与仓库地址
        const registry = registryFromArg || pkg.publishConfig?.registry || process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY || 'https://registry.npmjs.org';
        const repoField = pkg.repository;
        const repositoryUrl = (() => {
            if (!repoField) return undefined;
            if (typeof repoField === 'string') return repoField;
            if (typeof repoField.url === 'string') return repoField.url;
            return undefined;
        })();
        const repoSubdir = typeof repoField === 'object' && typeof repoField.directory === 'string' ? repoField.directory : undefined;

        const scanDirs = new Set<string>();
        const tryAddDirOf = (p?: string) => {
            if (!p) return;
            const abs = path.resolve(root, p);
            const stat = fs.existsSync(abs) ? fs.statSync(abs) : undefined;
            if (stat && stat.isDirectory()) scanDirs.add(abs);
            if (stat && stat.isFile()) scanDirs.add(path.dirname(abs));
        };
        tryAddDirOf(pkg.source);
        tryAddDirOf(pkg.module);
        tryAddDirOf(pkg.main);
        tryAddDirOf('src');
        tryAddDirOf('lib');

        const exclude = new Set(['node_modules', 'dist', 'build', '.git', 'out', 'rs-out']);
        const tsFiles: string[] = [];
        const jsFiles: string[] = [];
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (exclude.has(entry.name)) continue;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) { walk(full); continue; }
                if (entry.isFile()) {
                    if (full.endsWith('.d.ts')) continue;
                    if (full.endsWith('.ts')) tsFiles.push(full);
                    else if (full.endsWith('.js')) jsFiles.push(full);
                }
            }
        };
        if (scanDirs.size === 0) scanDirs.add(root);
        for (const d of scanDirs) walk(d);

        if (tsFiles.length === 0) {
            if (jsFiles.length > 0) {
                if (!fetchRemote) {
                    console.error('Detected JavaScript-only project: no .ts files found (only .js). Add --fetch to try repository source.');
                    process.exitCode = 1;
                    return;
                }
                // 若 --fetch 指定且存在仓库地址，则尝试获取源码
                if (!repositoryUrl) {
                    console.error(`No repository field in package.json. Registry: ${registry}. Cannot fetch source.`);
                    process.exitCode = 1;
                    return;
                }
                const repoUrl = sanitizeRepoUrl(repositoryUrl);
                let repoPath: string;
                try {
                    const r = getOrCloneRepoShallow(repoUrl);
                    repoPath = repoSubdir ? path.join(r.path, repoSubdir) : r.path;
                    console.error(`[cache] repo ${r.reused ? 'reuse' : 'clone'}: ${repoUrl}`);
                } catch (e: any) {
                    console.error(String(e));
                    process.exitCode = 1;
                    return;
                }
                const scanRoot = repoPath;
                const tsRemote: string[] = [];
                const jsRemote: string[] = [];
                const walkRemote = (dir: string) => {
                    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                        if (exclude.has(entry.name)) continue;
                        const full = path.join(dir, entry.name);
                        if (entry.isDirectory()) { walkRemote(full); continue; }
                        if (entry.isFile()) {
                            if (full.endsWith('.d.ts')) continue;
                            if (full.endsWith('.ts')) tsRemote.push(full);
                            else if (full.endsWith('.js')) jsRemote.push(full);
                        }
                    }
                };
                walkRemote(scanRoot);
                const tsRemoteFiltered = filterOutTests(tsRemote);
                if (tsRemoteFiltered.length === 0) {
                    console.error('Fetched repository still has no .ts sources. Aborting.');
                    process.exitCode = 1;
                    return;
                }
        fs.mkdirSync(outDir, { recursive: true });
    runInPool(tsRemoteFiltered.map(file => ({ input: file, output: path.join(outDir, path.relative(scanRoot, file).replace(/\.ts$/, '.rs')), options: { fast: true } })), jobs);
                return;
            } else {
                console.error('No TypeScript sources found.');
                process.exitCode = 1;
                return;
            }
        }

    fs.mkdirSync(outDir, { recursive: true });
    const tsFilesFiltered = filterOutTests(tsFiles);
    runInPool(tsFilesFiltered.map(file => ({ input: file, output: path.join(outDir, path.relative(root, file).replace(/\.ts$/, '.rs')), options: { fast: true } })), jobs);

        // 编译运行时依赖
        if (compileDeps) {
            const deps = Object.assign({}, pkg.dependencies || {});
            const depNames = Object.keys(deps);
            for (const name of depNames) {
                const localPath = path.join(root, 'node_modules', name);
                const depOut = path.join(outDir, 'deps', name);
                let handled = false;
                if (fs.existsSync(localPath) && fs.existsSync(path.join(localPath, 'package.json'))) {
                    try {
                        const dPkg = JSON.parse(fs.readFileSync(path.join(localPath, 'package.json'), 'utf8'));
                        const dScanDirs = new Set<string>();
                        const tryAdd = (p?: string) => {
                            if (!p) return;
                            const abs = path.resolve(localPath, p);
                            if (fs.existsSync(abs)) {
                                const st = fs.statSync(abs);
                                if (st.isDirectory()) dScanDirs.add(abs);
                                if (st.isFile()) dScanDirs.add(path.dirname(abs));
                            }
                        };
                        tryAdd(dPkg.source); tryAdd(dPkg.module); tryAdd(dPkg.main); tryAdd('src'); tryAdd('lib');
                        const dTs: string[] = []; const dJs: string[] = [];
                        const walkD = (dir: string) => {
                            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                                if (exclude.has(entry.name)) continue;
                                const full = path.join(dir, entry.name);
                                if (entry.isDirectory()) { walkD(full); continue; }
                                if (entry.isFile()) {
                                    if (full.endsWith('.d.ts')) continue;
                                    if (full.endsWith('.ts')) dTs.push(full); else if (full.endsWith('.js')) dJs.push(full);
                                }
                            }
                        };
                        if (dScanDirs.size === 0) dScanDirs.add(localPath);
                        for (const d of dScanDirs) walkD(d);
                        const dTsFiltered = filterOutTests(dTs);
                        if (dTsFiltered.length > 0) {
                            runInPool(dTsFiltered.map(f => ({ input: f, output: path.join(depOut, path.relative(localPath, f).replace(/\.ts$/, '.rs')), options: { fast: true } })), jobs);
                            handled = true;
                        }
                    } catch { /* ignore */ }
                }
                if (!handled && fetchRemote) {
                    // 从仓库获取依赖源码
                    let dRepoUrl: string | undefined;
                    let dRepoDir: string | undefined;
                    if (fs.existsSync(path.join(localPath, 'package.json'))) {
                        try {
                            const dPkg = JSON.parse(fs.readFileSync(path.join(localPath, 'package.json'), 'utf8'));
                            const repoField = dPkg.repository;
                            dRepoUrl = typeof repoField === 'string' ? repoField : (repoField?.url as string | undefined);
                            dRepoDir = typeof repoField === 'object' ? repoField?.directory as string | undefined : undefined;
                        } catch { /* ignore */ }
                    }
                    if (!dRepoUrl) {
                        console.warn(`dep:${name} has no repository; skip fetch.`);
                        continue;
                    }
                    const repoUrl = sanitizeRepoUrl(dRepoUrl);
                    let scanRoot: string;
                    try {
                        const r = getOrCloneRepoShallow(repoUrl);
                        scanRoot = dRepoDir ? path.join(r.path, dRepoDir) : r.path;
                        console.error(`[cache] dep ${name} ${r.reused ? 'reuse' : 'clone'}: ${repoUrl}`);
                    } catch (e: any) {
                        console.error(String(e));
                        continue;
                    }
                    const dTs: string[] = [];
                    const walkD = (dir: string) => {
                        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                            if (exclude.has(entry.name)) continue;
                            const full = path.join(dir, entry.name);
                            if (entry.isDirectory()) { walkD(full); continue; }
                            if (entry.isFile()) {
                                if (full.endsWith('.d.ts')) continue;
                                if (full.endsWith('.ts')) dTs.push(full);
                            }
                        }
                    };
                    walkD(scanRoot);
                    const dTsFiltered = filterOutTests(dTs);
                    if (dTsFiltered.length === 0) {
                        console.warn(`dep:${name} fetched but no .ts found.`);
                        continue;
                    }
                    runInPool(dTsFiltered.map(f => ({ input: f, output: path.join(depOut, path.relative(scanRoot, f).replace(/\.ts$/, '.rs')), options: { fast: true } })), jobs);
                }
            }
        }
        return;
    }
    if (isCargoMode) {
        const srcDir = args[1];
        if (!srcDir) { console.error('Missing <srcDir>'); return; }
        const outDirFlagIdx = args.indexOf('--outDir');
        const crateIdx = args.indexOf('--crate');
        const outDir = outDirFlagIdx >= 0 && args[outDirFlagIdx + 1] ? args[outDirFlagIdx + 1] : path.resolve('tsrsc-out');
        const crate = crateIdx >= 0 && args[crateIdx + 1] ? args[crateIdx + 1] : 'tsrsc_out';

        const crateSrc = path.join(outDir, 'src');
        fs.mkdirSync(crateSrc, { recursive: true });
        // 写 Cargo.toml
        fs.writeFileSync(path.join(outDir, 'Cargo.toml'), `[package]\nname = "${crate}"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n`, 'utf8');
        // 收集 ts 文件（保留层级）
        const allTs: string[] = [];
        (function walk(dir: string){
            for (const e of fs.readdirSync(dir, { withFileTypes:true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) { walk(full); continue; }
                if (full.endsWith('.ts')) allTs.push(full);
            }
        })(srcDir);
        const filtered = filterOutTests(allTs);
        const sanitize = (s:string)=>s.replace(/[^a-zA-Z0-9_]/g,'_');
        // 建立 dir-> {files:Set, subdirs:Set}
        type DirInfo = { files: string[]; dirs: Set<string>; };
        const dirMap = new Map<string, DirInfo>();
        function ensureDir(p: string): DirInfo { if (!dirMap.has(p)) dirMap.set(p,{files:[],dirs:new Set()}); return dirMap.get(p)!; }
        ensureDir(srcDir);
        for (const f of filtered) {
            const rel = path.relative(srcDir,f); if (!rel) continue;
            const dir = path.dirname(f);
            ensureDir(dir).files.push(path.basename(f));
            // 记录父子关系
            let cur = dir;
            while (cur !== srcDir) {
                const parent = path.dirname(cur);
                ensureDir(parent).dirs.add(cur);
                cur = parent;
            }
        }
        // 递归生成从 srcDir
        function emit(current: string){
            const info = dirMap.get(current); if (!info) return;
            const relFromSrc = path.relative(srcDir, current); // '' 为根
            const outPathDir = relFromSrc ? path.join(crateSrc, relFromSrc.split(/[\\/]/).map(sanitize).join('/')) : crateSrc;
            fs.mkdirSync(outPathDir,{recursive:true});
            const modLines: string[] = ['// auto-generated mod'];
            // 先处理文件
            for (const file of info.files) {
                if (!file.endsWith('.ts')) continue;
                const stemRaw = file.replace(/\.ts$/,'');
                const stem = sanitize(stemRaw === 'index' ? 'index_mod' : stemRaw);
                const inputFile = path.join(current,file);
                const targetFile = path.join(outPathDir, `${stem}.rs`);
                const isRootMain = (stem === 'main' && current === srcDir);
                transpileFile(inputFile, targetFile, { emitTopLevelMain:isRootMain, stubOnly:!isRootMain, resolveImports:{ mode:'cargo', srcDir, depHierarchy:true, depsRoot:'deps' }, fast:true });
                if (isRootMain) { try { adjustRustMainFile(targetFile); } catch { /* ignore */ } }
                modLines.push(`pub mod ${stem};`);
            }
            // 再处理子目录
            for (const sub of Array.from(info.dirs).sort()) {
                emit(sub);
                const modName = sanitize(path.basename(sub));
                modLines.push(`pub mod ${modName};`);
            }
            if (current === srcDir) {
                fs.writeFileSync(path.join(outPathDir,'lib.rs'), modLines.join('\n')+'\n','utf8');
            } else {
                fs.writeFileSync(path.join(outPathDir,'mod.rs'), modLines.join('\n')+'\n','utf8');
            }
        }
        emit(srcDir);
        // debug: 列出最后三个生成的文件（帮助定位“最后3个文件无法正常处理”）
        try {
            const generated: string[] = [];
            (function scan(o:string){ for (const e of fs.readdirSync(o,{withFileTypes:true})) { const p=path.join(o,e.name); if (e.isDirectory()) scan(p); else if (p.endsWith('.rs')) generated.push(p);} })(crateSrc);
            generated.sort();
            const tail = generated.slice(-3);
            console.error('[cargo-mode] last rs files:', tail.map(t=>path.relative(crateSrc,t)).join(', '));
        } catch {}
        // 若源有顶级 main.ts 则避免覆盖它生成的 main.rs（该文件已作为入口）
        const hasMainTs = filtered.some(f=>path.basename(f)==='main.ts');
        if (!hasMainTs) {
            fs.writeFileSync(path.join(crateSrc, 'main.rs'), `fn main() { println!("tsrsc cargo project generated"); }\n`, 'utf8');
        }
        console.log(`Cargo project generated at ${outDir}`);
        return;
    }
    if (isBootstrap) {
        const compileDeps = args.includes('--deps');
        const fetchRemote = args.includes('--fetch');
        const regIdx = args.indexOf('--registry');
        const registry = regIdx >= 0 && args[regIdx + 1] ? args[regIdx + 1] : (process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY || 'https://registry.npmjs.org');

        const srcDir = path.resolve('src');
        // 1) 生成 rs-out（非 stubOnly，便于查看翻译结果）
        const rsOut = path.resolve('rs-out');
        fs.mkdirSync(rsOut, { recursive: true });
        const rsList: { input: string, output: string }[] = [];
        const excl = new Set(['node_modules','dist','build','.git','out','rs-out','target']);
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.isDirectory()) { if (!excl.has(entry.name)) walk(path.join(dir, entry.name)); continue; }
                if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
                    const full = path.join(dir, entry.name);
                    rsList.push({ input: full, output: path.join(rsOut, path.relative(srcDir, full).replace(/\.ts$/, '.rs')) });
                }
            }
        };
    walk(srcDir);
    const rsListFiltered = filterTasks(rsList);
    runInPool(rsListFiltered.map(t => ({ ...t, options: { fast: true } })), jobs);

        // 2) 生成 cargo 工程（stub-only，可编译）
        const cargoOut = path.resolve('cargo-out');
        const crate = 'tsrsc_bootstrap';
        const crateSrc = path.join(cargoOut, 'src');
        fs.mkdirSync(crateSrc, { recursive: true });
        fs.writeFileSync(path.join(cargoOut, 'Cargo.toml'), `[package]\nname = "${crate}"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n`, 'utf8');
    const libLines: string[] = ["// Auto-generated lib by tsrsc"];
    let hasMainTs = false;
    const walkCargo = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) { walkCargo(full); continue; }
                if (!full.endsWith('.ts')) continue;
                const rel = path.relative(srcDir, full);
        let stem = rel.replace(/\.ts$/, '').replace(/[^a-zA-Z0-9_]/g, '_');
        const isMain = stem === 'main';
        if (isMain) { hasMainTs = true; }
        const target = path.join(crateSrc, `${stem}.rs`);
                transpileFile(full, target, { emitTopLevelMain: isMain, stubOnly: !isMain, resolveImports: { mode: 'cargo', srcDir, depHierarchy:true, depsRoot:'deps' }, fast: true });
        if (isMain) { try { adjustRustMainFile(target); } catch { /* ignore */ } }
        if (!isMain) libLines.push(`pub mod ${stem};`);
                console.log(`Wrote ${target}`);
            }
        };
        walkCargo(srcDir);
        // 3) 依赖编译（可选，支持浅克隆）
        if (compileDeps) {
            const exclude = new Set(['node_modules', 'dist', 'build', '.git', 'out', 'rs-out', 'target']);
            const pkgPath = path.resolve('package.json');
            if (!fs.existsSync(pkgPath)) {
                console.warn('No package.json found; skip deps');
            } else {
                let pkg: any; try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { pkg = {}; }
                const deps = Object.assign({}, pkg.dependencies || {});
                const depNames = Object.keys(deps);
                const depRsTasks: { input: string; output: string; options?: any }[] = [];
                const depCargoTasks: { input: string; output: string; options?: any }[] = [];
                for (const name of depNames) {
                    const localPath = path.join(process.cwd(), 'node_modules', name);
                    type DepFile = { file: string, base: string };
                    let dTs: DepFile[] = [];
                    // 收集本地 ts
                    if (fs.existsSync(localPath) && fs.existsSync(path.join(localPath, 'package.json'))) {
                        try {
                            const dPkg = JSON.parse(fs.readFileSync(path.join(localPath, 'package.json'), 'utf8'));
                            const dScan = new Set<string>();
                            const tryAdd = (p?: string) => { if (!p) return; const abs = path.resolve(localPath, p); if (fs.existsSync(abs)) { const st = fs.statSync(abs); if (st.isDirectory()) dScan.add(abs); if (st.isFile()) dScan.add(path.dirname(abs)); } };
                            tryAdd(dPkg.source); tryAdd(dPkg.module); tryAdd(dPkg.main); tryAdd('src'); tryAdd('lib');
                            if (dScan.size === 0) dScan.add(localPath);
                            const walkD = (dir: string) => {
                                for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                                    if (exclude.has(e.name)) continue; const full = path.join(dir, e.name);
                                    if (e.isDirectory()) { walkD(full); continue; }
                                    if (e.isFile() && full.endsWith('.ts') && !full.endsWith('.d.ts')) dTs.push({ file: full, base: localPath });
                                }
                            };
                            for (const d of dScan) walkD(d);
                        } catch { /* ignore */ }
                    }
                    // 远端浅克隆
                    if (dTs.length === 0 && fetchRemote) {
                        let dRepoUrl: string | undefined; let dRepoDir: string | undefined;
                        if (fs.existsSync(path.join(localPath, 'package.json'))) {
                            try {
                                const dp = JSON.parse(fs.readFileSync(path.join(localPath, 'package.json'), 'utf8'));
                                const rf = dp.repository; dRepoUrl = typeof rf === 'string' ? rf : (rf?.url as string | undefined); dRepoDir = typeof rf === 'object' ? rf?.directory as string | undefined : undefined;
                            } catch { /* ignore */ }
                        }
                        if (dRepoUrl) {
                            try {
                                const r = getOrCloneRepoShallow(sanitizeRepoUrl(dRepoUrl));
                                const scanRoot = dRepoDir ? path.join(r.path, dRepoDir) : r.path;
                                console.error(`[cache] dep ${name} ${r.reused ? 'reuse' : 'clone'}: ${dRepoUrl}`);
                                const walkD = (dir: string) => {
                                    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                                        if (exclude.has(e.name)) continue; const full = path.join(dir, e.name);
                                        if (e.isDirectory()) { walkD(full); continue; }
                                        if (e.isFile() && full.endsWith('.ts') && !full.endsWith('.d.ts')) dTs.push({ file: full, base: scanRoot });
                                    }
                                };
                                walkD(scanRoot);
                            } catch (e: any) {
                                console.warn(`dep fetch failed: ${name} ${e}`);
                            }
                        } else {
                            console.warn(`dep has no repository: ${name}`);
                        }
                    }
                    if (dTs.length === 0) continue;
                    const rsDepOut = path.join(rsOut, 'deps', name);
                    const nameSan = name.replace(/[^a-zA-Z0-9_]/g, '_');
                    const dTsFiltered = filterOutTests(dTs.map(df=>df.file));
                    for (const df of dTs) {
                        if (!includeTests && !dTsFiltered.includes(df.file)) continue;
                        const rel = path.relative(df.base, df.file);
                        const safeRel = rel.startsWith('..') ? path.basename(df.file) : rel;
                        // rs-out 任务
                        depRsTasks.push({ input: df.file, output: path.join(rsDepOut, safeRel.replace(/\.ts$/, '.rs')), options: { fast: true } });
                        // cargo stub 任务（层级结构：src/deps/<name>/<rel>.rs）
                        let relPathNoExt = safeRel.replace(/\.ts$/, '');
                        const split = relPathNoExt.split(/[\\/]/);
                        // 去掉开头的 src/lib/source 目录前缀
                        if (split.length > 1 && (split[0]==='src'||split[0]==='lib'||split[0]==='source')) relPathNoExt = split.slice(1).join('/');
                        const outDirRel = path.join('deps', nameSan, relPathNoExt).split(/[\\/]/).map(s=>s.replace(/[^a-zA-Z0-9_]/g,'_'));
                        const fileStem = outDirRel.pop()!;
                        const dirPath = path.join(crateSrc, ...outDirRel);
                        fs.mkdirSync(dirPath, { recursive: true });
                        const outFile = path.join(dirPath, `${fileStem}.rs`);
                        depCargoTasks.push({ input: df.file, output: outFile, options: { emitTopLevelMain: false, stubOnly: true, resolveImports: { mode: 'cargo', srcDir: df.base, depHierarchy: true, depsRoot: 'deps' }, fast: true } });
                    }
                    // 生成目录 mod.rs 链接将在后面统一处理
                }
                // 批量并行
                runInPool(filterTasks(depRsTasks.concat(depCargoTasks)), jobs);
                // 为层级 deps 构建 mod.rs 树
                buildDepsModTree(crateSrc, 'deps');
                libLines.push('pub mod deps;');
            }
        }
        // 写入 lib.rs 和 main.rs（若编译依赖，lib.rs 包含依赖模块）
        fs.writeFileSync(path.join(crateSrc, 'lib.rs'), libLines.join('\n') + '\n', 'utf8');
        if (!hasMainTs) {
            fs.writeFileSync(path.join(crateSrc, 'main.rs'), `fn main() { println!("tsrsc bootstrap cargo project generated"); }\n`, 'utf8');
        }
        console.log(`Bootstrap outputs: rs-out and cargo-out ready. Registry: ${registry}`);
        return;
    }

    const input = args[0];
    let out: string | undefined;
    const outIdx = args.indexOf('--out');
    if (outIdx >= 0 && args[outIdx + 1]) {
        out = args[outIdx + 1];
    }

    if (!out) out = suggestOutputPath(input);

    const rust = transpileFile(input, out);
    console.log(`Wrote ${out}\n\nPreview:\n${rust}`);
}

main(process.argv);

function sanitizeRepoUrl(url: string): string {
    // 去掉 git+ 前缀；将 ssh 风格保持原样交给 git 处理
    if (url.startsWith('git+')) return url.slice(4);
    // npm repository 字段可能带 .git 或 #commit，git 可接受；无需修改
    return url;
}

// 并行池实现（缓存定义已提前）

function runInPool(tasks: { input: string, output?: string, options?: any }[], jobs: number) {
    if (tasks.length === 0) return;
    const absWorker = path.join(__dirname, 'worker.js');
    const maxWorkers = Math.max(1, jobs || 1);
    // 筛掉缓存命中
    const fresh: typeof tasks = [];
    for (const t of tasks) {
        if (!t.output) { fresh.push(t); continue; }
        const sig = fileSig(t.input);
        if (!sig) { fresh.push(t); continue; }
        const cached = BUILD_CACHE[t.output];
        if (!cached || cached.size !== sig.size || cached.mtime !== sig.mtime) {
            fresh.push(t);
        } else {
            console.error(`[cache] skip ${t.output}`);
        }
    }
    const total = fresh.length;
    if (total === 0) return;
    console.error(`[pool] tasks=${total} maxWorkers=${maxWorkers}`);
    if (!fs.existsSync(absWorker)) {
        let done = 0; const start = Date.now();
        for (const t of fresh) {
            const s=Date.now(); transpileFile(t.input, t.output, t.options); done++; const ms=Date.now()-s; if (t.output){ const sig=fileSig(t.input); if (sig){ BUILD_CACHE[t.output]=sig; BUILD_CACHE_DIRTY=true; } }
            console.error(`[pool] ${done}/${total} OK ${t.input}${t.output?' -> '+t.output:''} ${ms}ms`);
        }
        console.error(`[pool] all done in ${Date.now()-start}ms`); persistBuildCache(); return;
    }
    ensureWorkers(Math.min(maxWorkers, total), absWorker);
    const queue = fresh.slice();
    let done = 0; const startTs = Date.now();
    const failed: string[] = []; const fallback: string[] = [];
    const inFlightMeta = new Map<Worker,{task:any, timer:any}>();
    let inFlightCount = 0;
    const pendingInputs = new Set(fresh.map(t=>t.input));
    let lastProgress = Date.now();
    const TASK_TIMEOUT = Number(process.env.TSRSC_TASK_TIMEOUT_MS)||60000; // 60s 默认
    const STALL_MS = Number(process.env.TSRSC_STALL_MS)||15000; // 15s 无进展提示

    const finishCheck = () => {
        if (done >= total && inFlightCount === 0) {
            const dur = Date.now()-startTs;
            console.error(`[pool] all done in ${dur}ms (tasks=${total})`);
            if (failed.length) console.error(`[pool] failed (${failed.length}) e.g. ${failed.slice(0,3).join(', ')}`);
            if (fallback.length) console.error(`[pool] fallback sync (${fallback.length})`);
            if (pendingInputs.size) {
                const remain = Array.from(pendingInputs).slice(0,5);
                console.error(`[pool] WARN pendingInputs(size=${pendingInputs.size}) sample: ${remain.join(', ')}`);
            }
            clearInterval(stallTimer);
            persistBuildCache();
            // 结束后终止持久 worker，避免进程悬挂
            for (const w of PERSIST_WORKERS.workers) { try { w.terminate(); } catch {} }
            PERSIST_WORKERS.workers.length = 0; PERSIST_WORKERS.idle.length = 0;
        }
    };

    const stallTimer = setInterval(()=>{
        if (done >= total) return; // 完成不再提示
        const idleFor = Date.now()-lastProgress;
        if (idleFor >= STALL_MS) {
            const inflightTasks = Array.from(inFlightMeta.values()).map(m=>m.task.input);
            console.error(`[pool][stall] ${done}/${total} inFlight=${inFlightCount} queue=${queue.length} pending=${pendingInputs.size} stalled ${idleFor}ms`);
            if (inflightTasks.length) console.error(`[pool][stall] inFlight sample: ${inflightTasks.slice(0,3).join(', ')}`);
            lastProgress = Date.now();
        }
    }, Math.min(5000, STALL_MS));

    let aborted = false;
    const onSigInt = () => {
        if (aborted) return; aborted = true;
        console.error(`\n[pool] SIGINT abort at ${done}/${total} inFlight=${inFlightCount} queue=${queue.length} pending=${pendingInputs.size}`);
        console.error(`[pool] pending sample: ${Array.from(pendingInputs).slice(0,8).join(', ')}`);
        clearInterval(stallTimer);
        persistBuildCache();
        process.exit(130);
    };
    process.once('SIGINT', onSigInt);

    const runTaskSync = (task: any) => {
        try {
            const s=Date.now(); transpileFile(task.input, task.output, task.options); const ms=Date.now()-s; done++; fallback.push(task.input);
            if (task.output){ const sig=fileSig(task.input); if (sig){ BUILD_CACHE[task.output]=sig; BUILD_CACHE_DIRTY=true; } }
            console.error(`[pool] ${done}/${total} OK(sync) ${task.input}${task.output?' -> '+task.output:''} ${ms}ms`);
            pendingInputs.delete(task.input); lastProgress = Date.now();
        } catch(e:any){ done++; failed.push(task.input); console.error(`[pool] ${done}/${total} FAIL(sync) ${task.input}: ${e}`); pendingInputs.delete(task.input); lastProgress = Date.now(); }
    };

    const dispatch = () => {
        while (PERSIST_WORKERS.idle.length && queue.length) {
            const w = PERSIST_WORKERS.idle.pop()!;
            const task = queue.shift()!;
            const started = Date.now();
            const timer = setTimeout(() => {
                // 超时：杀掉 worker，fallback 同步处理
                try { w.terminate(); } catch {}
                const idx = PERSIST_WORKERS.workers.indexOf(w);
                if (idx>=0) {
                    const nw = new Worker(absWorker); PERSIST_WORKERS.workers[idx]=nw; PERSIST_WORKERS.idle.push(nw);
                }
                if (inFlightMeta.has(w)) { inFlightMeta.delete(w); inFlightCount--; }
                console.error(`[pool] TIMEOUT ${task.input} >${TASK_TIMEOUT}ms fallback sync`);
                runTaskSync(task);
                if (done >= total) finishCheck(); else dispatch();
            }, TASK_TIMEOUT);
            inFlightMeta.set(w,{task, timer}); inFlightCount++;
            const onMessage = (msg: any) => {
                const meta = inFlightMeta.get(w); if (meta){ clearTimeout(meta.timer); inFlightMeta.delete(w); inFlightCount--; } else { return; }
                done++; const ms = Date.now()-started;
                if (msg && msg.ok === false) { failed.push(task.input); console.error(`[pool] ${done}/${total} FAIL ${task.input} ${ms}ms: ${msg.error}`);} else {
                    console.error(`[pool] ${done}/${total} OK ${task.input}${task.output?' -> '+task.output:''} ${ms}ms`);
                    if (task.output){ const sig=fileSig(task.input); if (sig){ BUILD_CACHE[task.output]=sig; BUILD_CACHE_DIRTY=true; } }
                }
                pendingInputs.delete(task.input); lastProgress = Date.now();
                PERSIST_WORKERS.idle.push(w);
                if (done >= total) finishCheck(); else dispatch();
            };
            const onError = (err: Error) => {
                const meta = inFlightMeta.get(w); if (meta){ clearTimeout(meta.timer); inFlightMeta.delete(w); inFlightCount--; } 
                done++; failed.push(task.input); console.error(`[pool] ${done}/${total} ERR ${task.input}: ${err}`);
                pendingInputs.delete(task.input); lastProgress = Date.now();
                try { w.terminate(); } catch {}
                const idx = PERSIST_WORKERS.workers.indexOf(w);
                if (idx>=0) { const nw = new Worker(absWorker); PERSIST_WORKERS.workers[idx]=nw; PERSIST_WORKERS.idle.push(nw); }
                if (done >= total) finishCheck(); else dispatch();
            };
            w.once('message', onMessage); w.once('error', onError);
            w.postMessage(task);
        }
    };
    dispatch();
}

function parseJobs(args: string[]): number {
    const jIdx = args.indexOf('--jobs');
    const sIdx = args.indexOf('-j');
    const idx = jIdx >= 0 ? jIdx : sIdx;
    if (idx >= 0 && args[idx + 1]) {
        const n = parseInt(args[idx + 1], 10);
        if (!isNaN(n)) {
            if (n <= 0) return Math.max(1, Math.floor((require('os').cpus()?.length || 1) / 2));
            return n;
        }
    }
    // 默认用 CPU 核心数的一半，至少 1
    const cpus = Number(process.env.TSRSC_JOBS) || require('os').cpus()?.length || 1;
    return Math.max(1, Math.floor(cpus / 2));
}

// 构建层级依赖目录的 mod.rs 树: 在 crateSrc 下寻找 deps/ 子树
function buildDepsModTree(crateSrc: string, rootName: string) {
    const root = path.join(crateSrc, rootName);
    if (!fs.existsSync(root)) return;
    // 深度优先，收集目录 -> 子目录/文件 stem
    interface DirInfo { dirs: string[]; files: string[]; }
    const map = new Map<string, DirInfo>();
    const walk = (dir: string) => {
        const rel = path.relative(root, dir);
        if (!map.has(dir)) map.set(dir, { dirs: [], files: [] });
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { map.get(dir)!.dirs.push(full); walk(full); }
            else if (e.isFile() && e.name.endsWith('.rs')) {
                if (e.name === 'mod.rs') continue;
                const stem = e.name.replace(/\.rs$/, '');
                map.get(dir)!.files.push(stem);
            }
        }
    };
    walk(root);
    // 生成每个目录的 mod.rs
    for (const [dir, info] of map) {
        const lines = ['// auto-generated mod tree'];
        for (const d of info.dirs) {
            const stem = path.basename(d).replace(/[^a-zA-Z0-9_]/g,'_');
            lines.push(`pub mod ${stem};`);
        }
        for (const f of info.files) {
            lines.push(`pub mod ${f};`);
        }
        const isRoot = dir === root;
        fs.writeFileSync(path.join(dir, 'mod.rs'), lines.join('\n') + '\n', 'utf8');
    }
}

// 调整由 main.ts 生成的 main.rs：
// 1) 若存在带参数的 pub fn main(...)->...，重命名为 ts_cli_main
// 2) 若文件中没有真正的入口 fn main() { ... } 则追加一个简单入口调用 ts_cli_main()
function adjustRustMainFile(filePath: string) {
    if (!fs.existsSync(filePath)) return;
    let text = fs.readFileSync(filePath, 'utf8');
    // 跳过已经处理
    if (/fn main\(\) \{/.test(text)) return; // 已经有无参 main
    let changed = false;
    text = text.replace(/pub fn main\s*\([^)]*\)[^{]*\{/m, (m) => {
        changed = true;
        return m.replace('pub fn main', 'pub fn ts_cli_main');
    });
    if (changed) {
        text += '\nfn main() { let _ = ts_cli_main(); }\n';
        fs.writeFileSync(filePath, text, 'utf8');
    }
}
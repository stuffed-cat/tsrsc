import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';

/** 简单的 TS → Rust 类型映射（原型版） */
function mapTsTypeToRust(typeNode?: ts.TypeNode): string {
    if (!typeNode) return 'f64'; // 默认按 number 处理
    switch (typeNode.kind) {
        case ts.SyntaxKind.NumberKeyword:
            return 'f64';
        case ts.SyntaxKind.StringKeyword:
            return 'String';
        case ts.SyntaxKind.BooleanKeyword:
            return 'bool';
        default:
            return 'f64';
    }
}

function ensureF64Literal(text: string): string {
    // 简化：若是整数，不带小数点，则补上 .0
    if (/^\d+$/.test(text)) return `${text}.0`;
    return text;
}

function escapeString(s: string): string {
    return s
        .replace(/\\/g, '\\\\')
        .replace(/\"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
}

type ExpectKind = 'any' | 'bool' | 'number' | 'string';

function defaultFor(expect: ExpectKind): string {
    switch (expect) {
        case 'bool': return 'false';
        case 'string': return 'String::new()';
        case 'number': return '0.0';
        default: return '()';
    }
}

function transpileExpression(expr: ts.Expression, expect: ExpectKind = 'any'): string {
    if (ts.isNumericLiteral(expr)) {
        return ensureF64Literal(expr.text);
    }
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
        return `"${escapeString(expr.text)}".to_string()`;
    }
    if (expr.kind === ts.SyntaxKind.TrueKeyword) return 'true';
    if (expr.kind === ts.SyntaxKind.FalseKeyword) return 'false';
    if (ts.isIdentifier(expr)) {
        return expr.text;
    }
    if (ts.isParenthesizedExpression(expr)) {
        return `(${transpileExpression(expr.expression, expect)})`;
    }
    if (ts.isPrefixUnaryExpression(expr)) {
        const op = expr.operator;
        const operand = transpileExpression(expr.operand, expect);
        switch (op) {
            case ts.SyntaxKind.ExclamationToken: return `!${operand}`;
            case ts.SyntaxKind.MinusToken: return `-${operand}`;
            default: return '/* unsupported prefix op */ 0.0';
        }
    }
    if (ts.isBinaryExpression(expr)) {
        const left = transpileExpression(expr.left);
        const right = transpileExpression(expr.right);
        const op = expr.operatorToken.kind;
        const opText = (() => {
            switch (op) {
                case ts.SyntaxKind.PlusToken: return '+';
                case ts.SyntaxKind.MinusToken: return '-';
                case ts.SyntaxKind.AsteriskToken: return '*';
                case ts.SyntaxKind.SlashToken: return '/';
                case ts.SyntaxKind.LessThanToken: return '<';
                case ts.SyntaxKind.LessThanEqualsToken: return '<=';
                case ts.SyntaxKind.GreaterThanToken: return '>';
                case ts.SyntaxKind.GreaterThanEqualsToken: return '>=';
                case ts.SyntaxKind.EqualsEqualsToken:
                case ts.SyntaxKind.EqualsEqualsEqualsToken: return '==';
                case ts.SyntaxKind.ExclamationEqualsToken:
                case ts.SyntaxKind.ExclamationEqualsEqualsToken: return '!=';
                case ts.SyntaxKind.AmpersandAmpersandToken: return '&&';
                case ts.SyntaxKind.BarBarToken: return '||';
                default: return undefined;
            }
        })();
        if (opText) return `${left} ${opText} ${right}`;
        return defaultFor(expect);
    }
    if (ts.isTemplateExpression(expr)) {
        // 形如 `a ${x} b ${y}` => format!("a {} b {}", x, y)
        const head = escapeString(expr.head.text);
        let fmt = head;
        const args: string[] = [];
        expr.templateSpans.forEach(span => {
            fmt += '{}';
            args.push(transpileExpression(span.expression));
            fmt += escapeString(span.literal.text);
        });
        const call = args.length ? `format!("${fmt}", ${args.join(', ')})` : `"${fmt}".to_string()`;
        return call;
    }
    if (ts.isCallExpression(expr)) {
        // 在表达式上下文，尽量返回占位，语句上下文会专门处理 console.log
        const callee = expr.expression;
        // Node 核心模块方法映射: fs / path / os
        if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && ts.isIdentifier(callee.name)) {
            const obj = callee.expression.text;
            const method = callee.name.text;
            const argExprs = expr.arguments.map(a => transpileExpression(a));
            const first = argExprs[0];
            const second = argExprs[1];
            if (obj === 'fs') {
                switch (method) {
                    case 'readFileSync': {
                        if (first) return `std::fs::read_to_string(${first}).unwrap_or_default()`;
                        return 'String::new()';
                    }
                    case 'writeFileSync': {
                        if (first && second) return `{ let _=std::fs::write(${first}, ${second}); () }`;
                        return '()';
                    }
                    case 'existsSync': {
                        if (first) return `std::path::Path::new(${first}).exists()`;
                        return 'false';
                    }
                    case 'mkdirSync': {
                        if (first) return `{ let _=std::fs::create_dir_all(${first}); () }`;
                        return '()';
                    }
                    case 'readdirSync': {
                        if (first) return `std::fs::read_dir(${first}).ok().map(|it| it.filter_map(|e| e.ok().and_then(|d| d.file_name().into_string().ok())).collect::<Vec<String>>()).unwrap_or_default()`;
                        return 'Vec::<String>::new()';
                    }
                    case 'statSync': {
                        if (first) return `std::fs::metadata(${first}).ok()`; // Option
                        return 'None';
                    }
                }
            } else if (obj === 'path') {
                switch (method) {
                    case 'join': {
                        if (argExprs.length === 0) return 'String::new()';
                        // 简单使用 '/' 连接
                        if (argExprs.length === 1) return argExprs[0];
                        return `vec![${argExprs.join(', ')}].join("/")`;
                    }
                    case 'basename': {
                        if (first) return `std::path::Path::new(${first}).file_name().and_then(|s| s.to_str()).unwrap_or("").to_string()`;
                        return 'String::new()';
                    }
                    case 'dirname': {
                        if (first) return `std::path::Path::new(${first}).parent().and_then(|s| s.to_str()).unwrap_or("").to_string()`;
                        return 'String::new()';
                    }
                    case 'resolve': {
                        if (argExprs.length === 0) return 'String::new()';
                        return `vec![${argExprs.join(', ')}].join("/")`;
                    }
                }
            } else if (obj === 'os') {
                switch (method) {
                    case 'homedir': return 'std::env::var("HOME").unwrap_or_default()';
                    case 'tmpdir': return 'std::env::temp_dir().to_string_lossy().to_string()';
                    case 'platform': return 'std::env::consts::OS.to_string()';
                    case 'arch': return 'std::env::consts::ARCH.to_string()';
                }
            }
        }
        // 对简单函数调用，直接透传：foo(a,b)
        if (ts.isIdentifier(callee)) {
            const args = expr.arguments.map(a => transpileExpression(a)).join(', ');
            return `${callee.text}(${args})`;
        }
        return defaultFor(expect);
    }
    // 其它表达式暂不支持
    return defaultFor(expect);
}

function transpileStatement(stmt: ts.Statement, out: string[], sf: ts.SourceFile, retExpect: ExpectKind = 'any', mutated?: Set<string>): void {
    if (ts.isReturnStatement(stmt)) {
        const exp = stmt.expression ? transpileExpression(stmt.expression, retExpect) : defaultFor(retExpect);
        out.push(`    return ${exp};`);
        return;
    }
    if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
            const name = ts.isIdentifier(decl.name) ? decl.name.text : 'tmp';
            const init = decl.initializer ? transpileExpression(decl.initializer) : '0.0';
            const needMut = mutated?.has(name) ?? false;
            const kw = needMut ? 'let mut' : 'let';
            out.push(`    ${kw} ${name} = ${init};`);
        }
        return;
    }
    if (ts.isExpressionStatement(stmt)) {
        const e = stmt.expression;
        if (ts.isCallExpression(e)) {
            // console.log(...)
            if (ts.isPropertyAccessExpression(e.expression)) {
                const obj = e.expression.expression;
                const prop = ts.isIdentifier(e.expression.name) ? e.expression.name.text : 'unknown';
                if (ts.isIdentifier(obj) && obj.text === 'console' && prop === 'log') {
                    const args = e.arguments.map(a => transpileExpression(a));
                    if (args.length === 0) {
                        out.push('    println!("{}");');
                    } else if (args.length === 1) {
                        out.push(`    println!("{}", ${args[0]});`);
                    } else {
                        const fmt = new Array(args.length).fill('{}').join(" ");
                        out.push(`    println!("${fmt}", ${args.join(', ')});`);
                    }
                    return;
                }
            }
            // 其它调用：占位注释
            const calleeExpr = transpileExpression(e);
            if (/^[a-zA-Z_][a-zA-Z0-9_]*\(.*\)$/.test(calleeExpr)) {
                out.push(`    ${calleeExpr};`);
            } else {
                const raw = safeText(stmt);
                out.push(`    /* unsupported call stmt: ${raw} */`);
            }
            return;
        }
        // 赋值与复合赋值: x = ..., x += ..., ...
        if (ts.isBinaryExpression(e)) {
            const op = e.operatorToken.kind;
            const lhs = e.left;
            if (ts.isIdentifier(lhs)) {
                const rhs = transpileExpression(e.right);
                const opTxt = (() => {
                    switch (op) {
                        case ts.SyntaxKind.EqualsToken: return '=';
                        case ts.SyntaxKind.PlusEqualsToken: return '+=';
                        case ts.SyntaxKind.MinusEqualsToken: return '-=';
                        case ts.SyntaxKind.AsteriskEqualsToken: return '*=';
                        case ts.SyntaxKind.SlashEqualsToken: return '/=';
                        default: return undefined;
                    }
                })();
                if (opTxt) {
                    out.push(`    ${lhs.text} ${opTxt} ${rhs};`);
                    return;
                }
            }
        }
        // ++x, x++, --x, x-- 映射为 += 1.0 / -= 1.0
        if (ts.isPrefixUnaryExpression(e) || ts.isPostfixUnaryExpression(e)) {
            const op = (e as ts.PrefixUnaryExpression | ts.PostfixUnaryExpression).operator;
            const operand = (e as any).operand as ts.Expression;
            if (ts.isIdentifier(operand)) {
                if (op === ts.SyntaxKind.PlusPlusToken) { out.push(`    ${operand.text} += 1.0;`); return; }
                if (op === ts.SyntaxKind.MinusMinusToken) { out.push(`    ${operand.text} -= 1.0;`); return; }
            }
        }
    }
    if (ts.isIfStatement(stmt)) {
        const cond = transpileExpression(stmt.expression, 'bool');
        out.push(`    if ${cond} {`);
        transpileStatementBlockLike(stmt.thenStatement, out, sf, retExpect, mutated);
        if (stmt.elseStatement) {
            out.push('    } else {');
            transpileStatementBlockLike(stmt.elseStatement, out, sf, retExpect, mutated);
        }
        out.push('    }');
        return;
    }
    // 其它语句先忽略，输出注释以保留信息
    const raw = safeText(stmt);
    out.push(`    /* unsupported stmt: ${raw.replace(/\n/g, ' ')} */`);
}

function transpileStatementBlockLike(node: ts.Statement, out: string[], sf: ts.SourceFile, retExpect: ExpectKind, mutated?: Set<string>) {
    if (ts.isBlock(node)) {
        node.statements.forEach(s => transpileStatement(s, out, sf, retExpect, mutated));
    } else {
        transpileStatement(node, out, sf, retExpect, mutated);
    }
}

function transpileFunctionDeclaration(node: ts.FunctionDeclaration, out: string[], options: SourceTranspileOptions): void {
    const name = node.name?.text;
    if (!name) return; // 跳过匿名

    const params: string[] = [];
    const sf = node.getSourceFile();
    node.parameters.forEach((p: ts.ParameterDeclaration) => {
        const pname = ts.isIdentifier(p.name) ? p.name.text : (() => {
            try { return p.name.getText(sf); } catch { return 'arg'; }
        })();
        const pty = mapTsTypeToRust(p.type);
        params.push(`${pname}: ${pty}`);
    });

    const retTy = mapTsTypeToRust(node.type);
    out.push(`pub fn ${name}(${params.join(', ')}) -> ${retTy} {`);
    const expect: ExpectKind = retTy === 'String' ? 'string' : retTy === 'bool' ? 'bool' : retTy === 'f64' ? 'number' : 'any';
    let hasExplicitReturn = false;
    if (!options.stubOnly && node.body) {
        const mutated = collectMutatedFromStatements(node.body.statements);
        node.body.statements.forEach((s: ts.Statement) => {
            if (ts.isReturnStatement(s)) hasExplicitReturn = true;
            transpileStatement(s, out, sf, expect, mutated);
        });
    }
    if (!hasExplicitReturn) {
        const tail = (() => {
            switch (retTy) {
                case 'f64': return '0.0';
                case 'String': return 'String::new()';
                case 'bool': return 'false';
                default: return '()';
            }
        })();
        out.push(`    return ${tail};`);
    }
    out.push('}');
    out.push('');
}

interface ImportResolveOptions {
    // 模式：普通 rs 输出仅做注释；cargo 模式尽量生成可编译的 use crate::... 语句
    mode: 'rs' | 'cargo';
    // 当 mode=cargo 时，需要提供 srcDir 以计算相对模块 stem（与 cargo 生成一致）
    srcDir?: string;
    // 旧：依赖模块前缀（扁平模式）
    depPrefix?: string; // 默认 'dep_'
    // 新：层级依赖模式开关 + 根模块名称 (如 "deps")
    depHierarchy?: boolean;
    depsRoot?: string; // 默认 "deps"
}

interface SourceTranspileOptions { emitTopLevelMain?: boolean; stubOnly?: boolean; resolveImports?: ImportResolveOptions }

function transpileSourceFile(sourceFile: ts.SourceFile, options: SourceTranspileOptions = { emitTopLevelMain: true, stubOnly: false }): string {
    topLevelStmts = [];
    const lines: string[] = [];
    lines.push('// Auto-generated by tsrsc (prototype)');
    lines.push('// Supported subset: number literals, + - * /, let, return, functions');
    lines.push('');
    lines.push('// Note: unsupported declarations summarized to reduce noise.');
    lines.push('');

    let typeAliasCount = 0, interfaceCount = 0, enumCount = 0, classCount = 0, otherCount = 0;
    const samples: string[] = []; const SAMPLE_LIMIT = 5;

    sourceFile.forEachChild((node: ts.Node) => {
        if (ts.isImportDeclaration(node)) {
            const modLit = node.moduleSpecifier;
            if (ts.isStringLiteral(modLit)) {
                const spec = modLit.text;
                const useLine = resolveImportToRustUse(sourceFile, spec, options.resolveImports);
                if (useLine) lines.push(useLine); else if (samples.length < SAMPLE_LIMIT) samples.push(`import: ${truncateSafe(node)}`);
            } else if (samples.length < SAMPLE_LIMIT) samples.push(`import: ${truncateSafe(node)}`);
            return;
        }
        if (ts.isFunctionDeclaration(node)) { transpileFunctionDeclaration(node, lines, options); return; }
        if (ts.isVariableStatement(node)) { (topLevelStmts as ts.Statement[]).push(node); return; }
        if (ts.isExpressionStatement(node) || ts.isIfStatement(node)) { (topLevelStmts as ts.Statement[]).push(node); return; }
        if (ts.isTypeAliasDeclaration(node)) { typeAliasCount++; return; }
        if (ts.isInterfaceDeclaration(node)) { interfaceCount++; return; }
        if (ts.isEnumDeclaration(node)) { enumCount++; return; }
        if (ts.isClassDeclaration(node)) { classCount++; return; }
        otherCount++; if (samples.length < SAMPLE_LIMIT) samples.push(`${ts.SyntaxKind[node.kind]}: ${truncateSafe(node)}`);
    });

    if (options.emitTopLevelMain && topLevelStmts.length) {
        lines.push('pub fn main() {');
        const mutatedTop = collectMutatedFromStatements(topLevelStmts);
        topLevelStmts.forEach(stmt => transpileStatement(stmt, lines, sourceFile, 'any', mutatedTop));
        lines.push('}');
    } else if (!options.emitTopLevelMain && topLevelStmts.length) {
        lines.push('// top-level statements omitted in lib mode:');
        topLevelStmts.forEach(stmt => lines.push(`// ${truncateSafe(stmt)}`));
    }

    const stats: string[] = [];
    if (typeAliasCount) stats.push(`${typeAliasCount} type aliases`);
    if (interfaceCount) stats.push(`${interfaceCount} interfaces`);
    if (enumCount) stats.push(`${enumCount} enums`);
    if (classCount) stats.push(`${classCount} classes`);
    if (otherCount) stats.push(`${otherCount} others`);
    if (stats.length) {
        lines.push('');
        lines.push(`// omitted: ${stats.join(', ')}`);
        if (samples.length) lines.push(`// samples: ${samples.join(' | ')}`);
    }
    return lines.join('\n');
}

let topLevelStmts: ts.Statement[] = [];

function collectMutatedFromStatements(stmts: readonly ts.Statement[]): Set<string> {
    const set = new Set<string>();
    for (const s of stmts) collectMutatedInNode(s, set);
    return set;
}

function collectMutatedInNode(node: ts.Node, out: Set<string>) {
    // 赋值表达式: x = ..., x += ..., ...
    if (ts.isBinaryExpression(node)) {
        const op = node.operatorToken.kind;
        const isAssign = op === ts.SyntaxKind.EqualsToken
            || op === ts.SyntaxKind.PlusEqualsToken
            || op === ts.SyntaxKind.MinusEqualsToken
            || op === ts.SyntaxKind.AsteriskEqualsToken
            || op === ts.SyntaxKind.SlashEqualsToken
            || op === ts.SyntaxKind.PercentEqualsToken;
        if (isAssign && ts.isIdentifier(node.left)) {
            out.add(node.left.text);
        }
    }
    // 自增自减: ++x, x++, --x, x--
    if (ts.isPrefixUnaryExpression(node)) {
        if ((node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
            && ts.isIdentifier(node.operand)) {
            out.add(node.operand.text);
        }
    }
    if (ts.isPostfixUnaryExpression(node)) {
        if ((node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
            && ts.isIdentifier(node.operand)) {
            out.add(node.operand.text);
        }
    }
    ts.forEachChild(node, c => collectMutatedInNode(c, out));
}

function safeText(node: ts.Node): string {
    try { return node.getText(node.getSourceFile()).replace(/\n/g, ' '); } catch { return `[${ts.SyntaxKind[node.kind]}]`; }
}
function truncateSafe(node: ts.Node, max = 80): string { const t = safeText(node); return t.length <= max ? t : t.slice(0,max) + '...'; }

export function transpileFile(inputPath: string, outputPath?: string, options?: SourceTranspileOptions & { fast?: boolean }): string {
    let sf: ts.SourceFile | undefined;
    if (options?.fast) {
        // 轻量解析：不创建 Program，跳过类型信息构建
        const text = fs.readFileSync(inputPath, 'utf8');
        sf = ts.createSourceFile(path.resolve(inputPath), text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    } else {
        const program = ts.createProgram([inputPath], {
            target: ts.ScriptTarget.ESNext,
            module: ts.ModuleKind.CommonJS,
            strict: true,
        });
        sf = program.getSourceFile(path.resolve(inputPath));
    }
    if (!sf) throw new Error(`Cannot read source file: ${inputPath}`);
    const rust = transpileSourceFile(sf, options);
    if (outputPath) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, 'utf8') !== rust) {
            fs.writeFileSync(outputPath, rust, 'utf8');
        }
    }
    return rust;
}

export function suggestOutputPath(inputPath: string): string {
    const dir = path.dirname(inputPath);
    const base = path.basename(inputPath, path.extname(inputPath));
    return path.join(dir, `${base}.rs`);
}

// 将 TS import 的模块说明符解析为 Rust use 语句（尽力而为）。
function resolveImportToRustUse(sf: ts.SourceFile, spec: string, resolve?: ImportResolveOptions): string | undefined {
    const mode = resolve?.mode || 'rs';
    // 仅在 cargo 模式尝试生成实际 use 语句，其它模式作为注释提示
    const emitUse = mode === 'cargo';
    const depPrefix = resolve?.depPrefix || 'dep_';
    const depHier = !!resolve?.depHierarchy;
    const depsRoot = resolve?.depsRoot || 'deps';
    const fileDir = path.dirname(sf.fileName);
    const isRelative = spec.startsWith('.') || spec.startsWith('..');

    const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, '_');

    if (isRelative) {
        // 解析相对路径 -> 计算 stem
        const srcDir = resolve?.srcDir;
        // 解析到文件或目录
        let abs = path.resolve(fileDir, spec);
        // 若是目录，尝试 index.ts
        let relStem: string | undefined;
        const candidates: string[] = [];
        candidates.push(abs);
        candidates.push(abs + '.ts');
        candidates.push(path.join(abs, 'index.ts'));
        // 从 srcDir 计算相对 stem
        for (const c of candidates) {
            const withTs = c.endsWith('.ts') ? c : c + (fs.existsSync(c + '.ts') ? '.ts' : '');
            const p = withTs && fs.existsSync(withTs) ? withTs : (fs.existsSync(c) ? c : undefined);
            if (p && srcDir) {
                let rel = path.relative(srcDir, p);
                if (rel.endsWith('.ts')) rel = rel.slice(0, -3);
                relStem = sanitize(rel);
                break;
            }
        }
        if (relStem) {
            return emitUse ? `use crate::${relStem}::*;` : `// use crate::${relStem}::*;  // from ${spec}`;
        }
        // 回退：基于相对当前目录的名字
        const fallback = sanitize(path.basename(abs));
        return emitUse ? `use crate::${fallback}::*;` : `// use crate::${fallback}::*;  // from ${spec}`;
    }

    // 裸模块说明符 -> 依赖
    // new hierarchical mode
    let depName = spec;
    let subPath = '';
    if (spec.startsWith('@')) {
        const parts = spec.split('/');
        if (parts.length >= 2) {
            depName = `${parts[0].replace(/[^a-zA-Z0-9_]/g,'_')}_${parts[1].replace(/[^a-zA-Z0-9_]/g,'_')}`;
            subPath = parts.slice(2).join('/');
        }
    } else {
        const parts = spec.split('/');
        depName = parts[0];
        subPath = parts.slice(1).join('/');
    }
    const depMod = sanitize(depName);
    if (depHier) {
        const segments = [depsRoot, depMod].concat(subPath ? subPath.split('/') : [] ).filter(s=>s.length>0).map(sanitize);
        const pathStr = segments.join('::');
        return emitUse ? `use crate::${pathStr}::*;` : `// use crate::${pathStr}::*;  // from ${spec}`;
    } else {
        if (!subPath) {
            const agg = `${depPrefix}${depMod}`;
            return emitUse ? `use crate::${agg}::*;` : `// use crate::${agg}::*;  // from ${spec}`;
        }
        const pathStr = `${depPrefix}${depMod}__${sanitize(subPath)}`;
        return emitUse ? `use crate::${pathStr}::*;` : `// use crate::${pathStr}::*;  // from ${spec}`;
    }
}


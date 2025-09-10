# tsrsc

TypeScript → Rust 原型编译器（非常早期）。目标是将所有 TS 代码转换为等价的 Rust 代码。
注：不支持所有 JS 文件。

## 用法

```
tsrsc <input.ts> [--out <output.rs>]
tsrsc --dir <srcDir> [--outDir <outDir>] [-j, --jobs <N>]
tsrsc --pkg [<package.json>] [--outDir <outDir>] [--fetch] [--registry <url>] [--deps] [-j, --jobs <N>]
tsrsc --cargo <srcDir> [--crate <crateName>] [--outDir <outDir>]
tsrsc --bootstrap [--deps] [--fetch] [--registry <url>] [-j, --jobs <N>]
```

说明：
- 当前为最小原型，支持的子集：函数声明、number 字面量、+ - * /、let 声明、return、部分 if/console.log。
- import 解析：cargo/自举模式尽力生成 `use crate::...`，并为依赖生成聚合模块（`dep_*`）。
- 获取远端仓库：git clone 使用浅克隆 `--depth 1`。

并行：
- 所有批量模式支持并行转译，使用 `-j` 或 `--jobs` 指定并发 worker 数（默认=CPU核心数/2；可用 `TSRSC_JOBS` 覆盖）。

缓存:
	远端仓库浅克隆会缓存到 ~/.tsrsc/repos 下；再次编译复用并跳过未变化文件（基于 mtime）。
性能:
	批量模式默认使用 fast 解析（不创建完整 Program），大幅降低大规模依赖（例如 TypeScript 仓库测试集）单文件耗时。
示例：
```
tsrsc --bootstrap --deps -j 8
```
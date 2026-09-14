// tar.mjs — 极小的 tar.gz 读取器（纯 Node，不 spawn 外部进程）。
//
// 为什么不调用系统的 `tar`：
//
//   DSH 的文件沙箱会拦下 Node 对子进程的 spawn —— `execFileSync('tar', …)` 直接抛
//   `EPERM: spawnSync tar`（真机 2026-09-14 实测；同一时期 `node --test` 也因 spawn
//   失败而必须逐文件跑）。也就是说：凡是靠 spawn 才能工作的发布脚本，在这个环境里
//   **根本跑不起来**——而发布脚本恰恰是最需要可靠的那一类。
//
//   因此这里自己解 tar：gzip 交给 node:zlib，tar 头按 ustar 逐 512 字节块解析。
//   pax 扩展头（typeflag 'x'）也会被解析——长路径与高精度时间戳由它承载，
//   忽略它会让文件名对不上。
//
// 只实现「读」：没有写入、没有压缩。

import fs from 'node:fs';
import zlib from 'node:zlib';

const BLOCK = 512;

/** 从定长字段里取以 NUL 结尾的字符串。 */
function cstr(buf) {
  const end = buf.indexOf(0);
  return buf.subarray(0, end === -1 ? buf.length : end).toString('utf8');
}

/** 取八进制数值字段（tar 的 size/mode 用八进制 ASCII 存）。 */
function octal(buf) {
  const s = cstr(buf).trim();
  if (!s) return 0;
  const n = parseInt(s, 8);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 解析 pax 扩展头（typeflag 'x'）的内容。
 *
 * 格式是若干条 `<十进制长度> <key>=<value>\n`，长度字段包含自身。
 * 只提取 path / linkpath / size —— 其余（mtime、uid…）对本用途无意义。
 */
function parsePax(data) {
  const out = {};
  const text = data.toString('utf8');
  let i = 0;
  while (i < text.length) {
    const sp = text.indexOf(' ', i);
    if (sp === -1) break;
    const len = parseInt(text.slice(i, sp), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = text.slice(sp + 1, i + len).replace(/\n$/, '');
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

/**
 * 读一个 .tar.gz，返回普通文件条目 `{ path, data, mode, size }[]`。
 *
 * @param {string} file tarball 路径
 */
export function readTarGz(file) {
  const raw = zlib.gunzipSync(fs.readFileSync(file));
  const entries = [];
  let offset = 0;
  let pax = null;        // 待应用的 pax 覆盖值（作用于紧随其后的那一条）
  let globalPax = null;  // 'g' 类型：作用于之后所有条目

  while (offset + BLOCK <= raw.length) {
    const header = raw.subarray(offset, offset + BLOCK);
    offset += BLOCK;

    // 全零块 = 归档结束。
    let allZero = true;
    for (const b of header) { if (b !== 0) { allZero = false; break; } }
    if (allZero) break;

    const name = cstr(header.subarray(0, 100));
    const mode = octal(header.subarray(100, 108));
    const size = octal(header.subarray(124, 136));
    const typeflag = String.fromCharCode(header[156] || 0x30);
    const prefix = cstr(header.subarray(345, 500));

    const data = raw.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === 'x') { pax = parsePax(data); continue; }
    if (typeflag === 'g') { globalPax = { ...(globalPax || {}), ...parsePax(data) }; continue; }
    // 'L'/'K' 是 GNU 长名扩展，本仓库用不到。
    if (typeflag === 'L' || typeflag === 'K') continue;

    const applied = pax || globalPax;
    const full = applied?.path || (prefix ? prefix + '/' + name : name);
    pax = null;

    // '0' 与 NUL 是普通文件；目录(5)/符号链接(2) 等不产出内容。
    if (typeflag !== '0' && typeflag !== '\0') continue;
    if (!full) continue;
    entries.push({ path: full, data, mode, size: applied?.size ? Number(applied.size) : size });
  }
  return entries;
}

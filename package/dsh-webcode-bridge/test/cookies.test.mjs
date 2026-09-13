// cookies.test.mjs — Set-Cookie 两个消费方向的契约。
//
// 这些用例钉住的是 0.14.4 修掉的真机 bug（豆包「登录后右侧打开网页会掉登录」）：
// 删除指令不能被当成「设成空值」，`__Secure-` 前缀不能丢 Secure，
// 以及镜像转发上游请求时 profile 的权威登录 cookie 不能被 iframe 的旧值挤掉。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSetCookie, isDeletion, rewriteSetCookieForMirror, toPlaywrightCookie, mergeCookieHeaders,
} from '../lib/cookies.js';

const NOW = Date.UTC(2026, 8, 14, 0, 0, 0);   // 2026-09-14T00:00:00Z

// ---- parseSetCookie -------------------------------------------------------

test('parseSetCookie：非法头返回 null', () => {
  assert.equal(parseSetCookie(''), null);
  assert.equal(parseSetCookie('novalue'), null);
  assert.equal(parseSetCookie('=x'), null);
  assert.equal(parseSetCookie(null), null);
});

test('parseSetCookie：解析 name/value 与全部已知属性', () => {
  const c = parseSetCookie('sid=abc123; Domain=.Doubao.COM; Path=/chat; Secure; HttpOnly; SameSite=None; Max-Age=3600');
  assert.equal(c.name, 'sid');
  assert.equal(c.value, 'abc123');
  assert.equal(c.domain, 'doubao.com');   // 前导点去掉、大小写归一
  assert.equal(c.path, '/chat');
  assert.equal(c.secure, true);
  assert.equal(c.httpOnly, true);
  assert.equal(c.sameSite, 'None');
  assert.equal(c.maxAge, 3600);
});

test('parseSetCookie：value 里的 = 不被截断', () => {
  const c = parseSetCookie('t=a=b=c; Path=/');
  assert.equal(c.value, 'a=b=c');
});

test('parseSetCookie：Expires 解析成毫秒时间戳', () => {
  const c = parseSetCookie('sid=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  assert.equal(c.expires, 0);
});

test('parseSetCookie：未知属性被忽略而不是当成 name/value', () => {
  const c = parseSetCookie('sid=x; Priority=High; Partitioned; Path=/');
  assert.equal(c.name, 'sid');
  assert.equal(c.path, '/');
});

// ---- isDeletion -----------------------------------------------------------

test('isDeletion：Max-Age<=0 是删除', () => {
  assert.equal(isDeletion(parseSetCookie('sid=; Max-Age=0'), NOW), true);
  assert.equal(isDeletion(parseSetCookie('sid=; Max-Age=-1'), NOW), true);
});

test('isDeletion：Expires 已过是删除，未到不是', () => {
  assert.equal(isDeletion(parseSetCookie('sid=; Expires=Thu, 01 Jan 1970 00:00:00 GMT'), NOW), true);
  assert.equal(isDeletion(parseSetCookie('sid=x; Expires=Fri, 01 Jan 2100 00:00:00 GMT'), NOW), false);
});

test('isDeletion：只有空值、没有过期指令时**不是**删除（可能是合法的空串 cookie）', () => {
  assert.equal(isDeletion(parseSetCookie('sid='), NOW), false);
});

test('isDeletion：Max-Age 优先于 Expires（RFC 6265 §4.1.2.2）', () => {
  assert.equal(isDeletion(parseSetCookie('sid=x; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT'), NOW), false);
  assert.equal(isDeletion(parseSetCookie('sid=x; Max-Age=0; Expires=Fri, 01 Jan 2100 00:00:00 GMT'), NOW), true);
});

// ---- rewriteSetCookieForMirror -------------------------------------------

test('mirror：Domain 一律去掉（否则浏览器整枚丢弃）', () => {
  const out = rewriteSetCookieForMirror('sid=abc; Domain=.doubao.com; Path=/');
  assert.ok(!/domain/i.test(out), out);
  assert.ok(out.startsWith('sid=abc'), out);
  assert.ok(/Path=\//.test(out), out);
  // 必须有 SameSite（Lax 档）；否则现代浏览器对第三方上下文里的 cookie 判定不稳定。
  assert.ok(/SameSite=Lax/.test(out), out);
});

test('mirror：__Secure- 前缀必须保住 Secure —— 这是「掉登录」的直接原因', () => {
  const out = rewriteSetCookieForMirror('__Secure-session=abc; Domain=.doubao.com; Path=/; Secure; SameSite=None');
  assert.ok(/;\s*Secure(;|$)/i.test(out), 'Secure 被剥掉了：' + out);
  assert.ok(!/SameSite=None/i.test(out), 'SameSite=None 应收敛成 Lax：' + out);
  assert.ok(/SameSite=Lax/i.test(out), out);
});

test('mirror：__Host- 前缀补齐 Path=/ 且不引入 Domain', () => {
  const out = rewriteSetCookieForMirror('__Host-token=v; Secure; SameSite=Lax');
  assert.ok(/Path=\//.test(out), out);
  assert.ok(!/domain/i.test(out), out);
  assert.ok(/Secure/i.test(out), out);
});

test('mirror：删除指令原样保留过期语义（不能变成「设成空值且不过期」）', () => {
  const out = rewriteSetCookieForMirror('sid=; Max-Age=0; Path=/');
  assert.ok(/Max-Age=0/.test(out), out);
});

test('mirror：非法头原样返回而不是抛错', () => {
  assert.equal(rewriteSetCookieForMirror('garbage'), 'garbage');
});

// ---- toPlaywrightCookie ---------------------------------------------------

test('driver：删除翻译成 expires:0，而不是写一个空值', () => {
  const c = toPlaywrightCookie('sid=; Max-Age=0', 'https://www.doubao.com/', NOW);
  assert.equal(c.name, 'sid');
  assert.equal(c.expires, 0);
});

test('driver：__Secure- 前缀即使原头没写 Secure 也要补上（否则 addCookies 抛错）', () => {
  const c = toPlaywrightCookie('__Secure-session=v', 'https://www.doubao.com/', NOW);
  assert.equal(c.secure, true);
});

test('driver：Max-Age 换算成绝对过期时间戳', () => {
  const c = toPlaywrightCookie('sid=v; Max-Age=3600', 'https://www.doubao.com/', NOW);
  assert.equal(c.expires, Math.floor(NOW / 1000) + 3600);
});

test('driver：上游 Domain 保留，缺省时用源的 host', () => {
  assert.equal(toPlaywrightCookie('a=1; Domain=.doubao.com; Path=/x', 'https://www.doubao.com/', NOW).domain, 'doubao.com');
  assert.equal(toPlaywrightCookie('a=1', 'https://www.doubao.com/', NOW).domain, 'www.doubao.com');
  assert.equal(toPlaywrightCookie('a=1', 'https://www.doubao.com/', NOW).path, '/');
});

test('driver：SameSite 缺省给 Lax，非法值同样落到 Lax', () => {
  assert.equal(toPlaywrightCookie('a=1', 'https://www.doubao.com/', NOW).sameSite, 'Lax');
  assert.equal(toPlaywrightCookie('a=1; SameSite=Wat', 'https://www.doubao.com/', NOW).sameSite, 'Lax');
  assert.equal(toPlaywrightCookie('a=1; SameSite=Strict', 'https://www.doubao.com/', NOW).sameSite, 'Strict');
});

test('driver：非法头返回 null（调用方跳过这枚，不影响其它 cookie）', () => {
  assert.equal(toPlaywrightCookie('garbage', 'https://www.doubao.com/', NOW), null);
});

// ---- mergeCookieHeaders ---------------------------------------------------

test('merge：profile 的同名 cookie 优先于 iframe 带来的旧值', () => {
  const merged = mergeCookieHeaders([{ name: 'sid', value: 'fresh' }], 'sid=stale; other=1');
  assert.ok(merged.includes('sid=fresh'), merged);
  assert.ok(!merged.includes('stale'), merged);
  assert.ok(merged.includes('other=1'), merged);
});

test('merge：只有 profile 时原样发出（旧实现这里就会漏掉）', () => {
  assert.equal(mergeCookieHeaders([{ name: 'a', value: '1' }], ''), 'a=1');
});

test('merge：只有请求 cookie 时也照发', () => {
  assert.equal(mergeCookieHeaders([], 'a=1; b=2'), 'a=1; b=2');
});

test('merge：两边都空 → 空串（调用方据此不设 Cookie 头）', () => {
  assert.equal(mergeCookieHeaders([], ''), '');
  assert.equal(mergeCookieHeaders(null, undefined), '');
});

test('merge：忽略畸形片段与无名条目，不抛错', () => {
  assert.equal(mergeCookieHeaders([{ value: 'x' }, { name: '', value: 'y' }], '; junk ; =bad; ok=1'), 'ok=1');
});

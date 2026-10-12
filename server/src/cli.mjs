#!/usr/bin/env node
// =============================================================
// 拾光 · 命令行建号工具
//
// 为什么需要它：注册走的是「手机号 + 短信验证码」，而阿里云短信
// 没配好之前，注册入口是关着的——总得留一条路能把第一个号开出来。
//
// 用法（在服务器上）：
//   node server/src/cli.mjs add <手机号> <密码> [昵称]
//   node server/src/cli.mjs list
//   node server/src/cli.mjs passwd <手机号> <新密码>
//   node server/src/cli.mjs remove <手机号>          # 只从注册表移除，数据目录保留
//   node server/src/cli.mjs data <手机号>            # 看这个人的数据在哪、有多少条
//
// 数据目录跟服务一样读 SHIGUANG_DATA。
// =============================================================

import path from 'node:path';
import fsp from 'node:fs/promises';
import { Users, isPhone, maskPhone, checkPassword } from './users.mjs';
import { Store } from './store.mjs';

const DATA_DIR = process.env.SHIGUANG_DATA || path.join(process.cwd(), 'server', 'data');
const [cmd, ...args] = process.argv.slice(2);

function bye(msg, code = 0) {
  console.log(msg);
  process.exit(code);
}

function usage() {
  bye(
    [
      '拾光 · 账号管理',
      '',
      '  node server/src/cli.mjs add <手机号> <密码> [昵称]',
      '  node server/src/cli.mjs list',
      '  node server/src/cli.mjs passwd <手机号> <新密码>',
      '  node server/src/cli.mjs remove <手机号>',
      '  node server/src/cli.mjs data <手机号>',
      '',
      `数据目录：${DATA_DIR}`,
    ].join('\n'),
  );
}

const users = await new Users(DATA_DIR).init();

if (!cmd) usage();

if (cmd === 'add') {
  const [phone, password, nickname = ''] = args;
  if (!phone || !password) usage();
  if (!isPhone(phone)) bye(`手机号格式不对：${phone}`, 1);
  const bad = checkPassword(password);
  if (bad) bye(bad, 1);
  const made = await users.create(phone, password, { nickname });
  if (!made.ok) bye(made.error, 1);
  bye(
    `已创建：${maskPhone(made.user.phone)}${nickname ? `（${nickname}）` : ''}\n` +
      `数据目录：${users.dirOf(made.user)}\n\n` +
      '如果服务正在运行，记得重启一下让它重新读注册表：\n' +
      '  systemctl restart shiguang',
  );
}

if (cmd === 'list') {
  const all = users.list();
  if (!all.length) bye('还没有任何账号');
  console.log(`共 ${all.length} 个账号：\n`);
  for (const u of all) {
    const last = u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('zh-CN') : '从未登录';
    console.log(`  ${maskPhone(u.phone)}  ${u.nickname || '（没起名）'}  最后登录：${last}`);
  }
  process.exit(0);
}

if (cmd === 'passwd') {
  const [phone, password] = args;
  if (!phone || !password) usage();
  const user = users.get(phone);
  if (!user) bye('没有这个账号', 1);
  const bad = checkPassword(password);
  if (bad) bye(bad, 1);
  await users.setPassword(user, password);
  bye(
    `已改密码：${maskPhone(phone)}（这个人的其它设备需要重新登录）\n\n` +
      '服务在跑的话要重启才会生效：systemctl restart shiguang',
  );
}

if (cmd === 'remove') {
  const [phone] = args;
  if (!phone) usage();
  const user = users.get(phone);
  if (!user) bye('没有这个账号', 1);
  const dir = users.dirOf(user);
  await users.remove(phone);
  bye(`已移除账号 ${maskPhone(phone)}\n数据目录保留未删：${dir}`);
}

if (cmd === 'data') {
  const [phone] = args;
  if (!phone) usage();
  const user = users.get(phone);
  if (!user) bye('没有这个账号', 1);
  const dir = users.dirOf(user);
  const store = await new Store(dir).init();
  let bytes = 0;
  try {
    const files = await fsp.readdir(path.join(dir, 'notes'));
    for (const f of files) {
      bytes += (await fsp.stat(path.join(dir, 'notes', f))).size;
    }
  } catch {
    /* 目录还没建 */
  }
  console.log(`账号：${maskPhone(phone)}`);
  console.log(`目录：${dir}`);
  console.log(`记录：${store.active().length} 条，笔记文件 ${(bytes / 1024).toFixed(1)} KB`);
  process.exit(0);
}

usage();

#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════
 *  CSU 企业管理复试 · 搜索索引生成器
 *  build_search_index.js  v2.0
 *
 *  用法:
 *    node build_search_index.js
 *
 *  功能:
 *    1. 扫描当前目录及子目录下的所有 .html 文件
 *    2. 提取标题、正文文本、标签
 *    3. 生成 search_index.js（window.SEARCH_INDEX = [...]）
 *       同时生成 search_index.json（可选）
 *
 *  环境要求:
 *    Node.js >= 14
 *    npm install cheerio  （可选，未安装时自动回退到正则提取）
 *
 *  运行位置:
 *    将此脚本放在 index.html 同级目录下运行。
 *    示例：
 *      cd /path/to/企管复试资料_纯网页
 *      node build_search_index.js
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

const fs   = require('fs');
const path = require('path');

/* ── 配置 ──────────────────────────────────────────────────── */
const CONFIG = {
  rootDir:       process.cwd(),           // 扫描起点
  outputJS:      'search_index.js',       // 输出 JS（供 file:// 本地使用）
  outputJSON:    'search_index.json',     // 输出 JSON（供服务器使用）
  maxContent:    2000,                    // 每页最多保存的正文字符数
  excludeFiles:  ['index.html'],          // 不加入索引的文件
  excludeDirs:   ['__MACOSX', 'node_modules', '.git'],
  catMap: {                               // 路径关键词 → 分类
    '企业战略管理': { cat: 'strat', catLbl: '企业战略管理' },
    '人力资源管理': { cat: 'hr',    catLbl: '人力资源管理' },
  }
};

/* ── 工具函数 ──────────────────────────────────────────────── */

/** 判断路径是否需要排除 */
function shouldExclude(filePath) {
  for (const dir of CONFIG.excludeDirs) {
    if (filePath.includes(dir)) return true;
  }
  const base = path.basename(filePath);
  if (CONFIG.excludeFiles.includes(base)) return true;
  return false;
}

/** 递归扫描 HTML 文件 */
function scanHtmlFiles(dir, collected = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return collected; }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!CONFIG.excludeDirs.includes(entry.name)) scanHtmlFiles(full, collected);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) {
      if (!shouldExclude(full)) collected.push(full);
    }
  }
  return collected;
}

/** 从文件路径推断分类 */
function detectCat(filePath) {
  for (const [keyword, info] of Object.entries(CONFIG.catMap)) {
    if (filePath.includes(keyword)) return info;
  }
  return { cat: 'other', catLbl: '其他资料' };
}

/** 使用正则从 HTML 字符串提取文本（不依赖 cheerio）*/
function extractFallback(html) {
  // 移除 script / style / head
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#[0-9]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // 提取 <title>
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';

  return { title, text };
}

/** 尝试用 cheerio 解析（更精准）*/
function extractCheerio($, html) {
  const title = $('title').text().trim() ||
                $('h1').first().text().trim() ||
                $('[class*="hero"] h1').first().text().trim() || '';

  // 提取关键 meta 标签作为 tags
  const tags = [];
  $('h2, h3, [class*="card-title"], .ctit').each((_, el) => {
    const t = $(el).text().trim();
    if (t && t.length < 30) tags.push(t);
  });

  // 提取正文（跳过 nav / footer / script / style）
  $('script, style, nav, header, footer, #nav, #matchNav').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();

  return { title, text, tags };
}

/* ── 主逻辑 ─────────────────────────────────────────────────── */

async function main() {
  console.log('🔍 CSU 搜索索引生成器 v2.0');
  console.log(`📂 扫描目录: ${CONFIG.rootDir}\n`);

  /* 尝试加载 cheerio */
  let cheerio = null;
  try {
    cheerio = require('cheerio');
    console.log('✅ 使用 cheerio 解析（精准模式）');
  } catch (e) {
    console.log('⚠️  cheerio 未安装，使用正则回退模式（可运行 npm install cheerio 提升精度）');
  }

  const files = scanHtmlFiles(CONFIG.rootDir);
  console.log(`📄 发现 ${files.length} 个 HTML 文件\n`);

  const index = [];
  let i = 1;

  for (const filePath of files) {
    const relPath = path.relative(CONFIG.rootDir, filePath).replace(/\\/g, '/');
    process.stdout.write(`  [${String(i).padStart(3)}/${files.length}] ${relPath.padEnd(60, '.')} `);

    let html;
    try {
      html = fs.readFileSync(filePath, 'utf-8');
    } catch (e) {
      console.log('❌ 读取失败');
      i++; continue;
    }

    let title, text, tags = [];

    if (cheerio) {
      try {
        const $ = cheerio.load(html);
        ({ title, text, tags } = extractCheerio($, html));
      } catch (e) {
        ({ title, text } = extractFallback(html));
      }
    } else {
      ({ title, text } = extractFallback(html));
    }

    if (!title) title = path.basename(filePath, '.html').replace(/_/g, ' ');

    const content = text.slice(0, CONFIG.maxContent);
    const catInfo = detectCat(relPath);

    index.push({
      title,
      url:    relPath,
      cat:    catInfo.cat,
      catLbl: catInfo.catLbl,
      content,
      tags:   tags.slice(0, 20)
    });

    process.stdout.write(`✅ "${title.slice(0, 20)}"\n`);
    i++;
  }

  /* 写入 search_index.js（兼容 file:// 本地打开）*/
  const jsContent = `/**
 * CSU 企业管理复试 搜索索引
 * 生成时间: ${new Date().toLocaleString('zh-CN')}
 * 文件数量: ${index.length}
 * 由 build_search_index.js 自动生成，请勿手动修改
 */
window.SEARCH_INDEX = ${JSON.stringify(index, null, 2)};
`;

  fs.writeFileSync(path.join(CONFIG.rootDir, CONFIG.outputJS), jsContent, 'utf-8');
  console.log(`\n✅ 已生成: ${CONFIG.outputJS}  (${(jsContent.length / 1024).toFixed(1)} KB)`);

  /* 写入 search_index.json（可选，用于服务器环境）*/
  fs.writeFileSync(
    path.join(CONFIG.rootDir, CONFIG.outputJSON),
    JSON.stringify(index, null, 2),
    'utf-8'
  );
  console.log(`✅ 已生成: ${CONFIG.outputJSON}  (${(JSON.stringify(index).length / 1024).toFixed(1)} KB)`);

  /* 统计 */
  const bycat = {};
  for (const d of index) bycat[d.cat] = (bycat[d.cat] || 0) + 1;
  console.log('\n📊 索引统计:');
  console.log(`   企业战略管理: ${bycat.strat || 0} 页`);
  console.log(`   人力资源管理: ${bycat.hr    || 0} 页`);
  console.log(`   其他资料:     ${bycat.other  || 0} 页`);
  console.log(`   合计:         ${index.length} 页`);

  console.log('\n🎉 索引生成完成！');
  console.log('\n下一步：在 index.html <body> 末尾添加：');
  console.log('  <link rel="stylesheet" href="search.css">');
  console.log('  <script src="search_index.js"></script>');
  console.log('  <script src="search.js"></script>');
}

main().catch(err => {
  console.error('\n❌ 生成失败:', err.message);
  process.exit(1);
});

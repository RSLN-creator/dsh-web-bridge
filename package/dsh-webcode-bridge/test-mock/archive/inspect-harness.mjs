import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
const context = await chromium.launchPersistentContext('test-mock/.harness-ui-profile', {
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true, viewport: { width: 1440, height: 1000 },
});
try {
  const page = context.pages()[0];
  page.on('pageerror', error => console.log('PAGE_ERROR', error.message));
  await page.goto('http://127.0.0.1:3080');
  await page.waitForTimeout(2500);
  if (await page.locator('.fmh-drawer.open').count()) await page.locator('.fmh-drawer button').filter({hasText:'✕'}).first().click();
  const action = process.argv[2];
  if (action === 'resume') {
    const before = await page.locator('body').innerText();
    if (!before.includes('HARNESS_REVIEW_OK') || !before.includes('str_replace_editor')) throw new Error('持久化重载缺少输入、工具记录或最终回答');
    await page.getByPlaceholder('给智能体发消息').fill('基于上一轮已经实际读取的文件，不要再次调用工具，只回复三个模型 id，并以 PERSISTENCE_OK 结尾。');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.waitForFunction(() => (document.body.innerText.match(/PERSISTENCE_OK/g) || []).length >= 2, null, { timeout: 90000 });
    await page.reload();
    await page.waitForFunction(() => (document.body.innerText.match(/PERSISTENCE_OK/g) || []).length >= 2);
    console.log('PERSISTENCE_RELOAD_PASS');
  }
  if (action === 'settings') {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '网页桥接', exact: true }).click();
  }
  if (action === 'task') {
    await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
    await page.getByPlaceholder('描述你想要构建的内容').waitFor();
    await page.waitForTimeout(700);
    await page.getByPlaceholder('描述你想要构建的内容').fill('请实际调用本地只读工具，读取绝对路径 D:/9_Code_Workspace/dsh-webcode-bridge/package/dsh-webcode-bridge/lib/providers.js 并审查。工作区是 D:/9_Code_Workspace/dsh-webcode-bridge。必须读取文件后列出三种模型的 id 与对应中文标签，指出一项真实风险。不要搜索目录，不要联网搜索，不要修改文件。最终回答以 HARNESS_REVIEW_OK 结尾。');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    for (let i = 0; i < 100; i++) {
      await page.waitForTimeout(2000);
      const content = await page.locator('body').innerText();
      if (i % 5 === 0) console.log('TASK_PROGRESS', content.slice(-2400));
      if (i > 12 && !(await (await fetch('http://127.0.0.1:3080/__webcode/status')).json()).relay.busy) break;
      if ((content.match(/HARNESS_REVIEW_OK/g) || []).length >= 2 && !await page.getByRole('button', { name: /停止生成|停止响应/ }).count()) break;
    }
    console.log('TASK_URL', page.url());
    await fs.mkdir('output/playwright', { recursive: true });
    await fs.writeFile('output/playwright/harness-task-url.txt', page.url());
    await fs.writeFile('output/playwright/harness-task-output.txt', await page.locator('body').innerText());
  }
  if (action === 'panel' || action === 'mobile') {
    if (action === 'mobile') await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'DeepSeek 会话', exact: true }).click();
    await page.getByAltText('DeepSeek 会话', { exact: true }).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('.hwb-conversation img')].some(img => img.naturalWidth > 0));
    console.log('PREVIEW_IMAGE_PASS');
  }
  await page.waitForTimeout(1500);
  console.log(await page.locator('body').innerText());
  if (action !== 'task') console.log('CONTROLS', JSON.stringify(await page.locator('button,input,textarea').evaluateAll(nodes => nodes.filter(n=>n.getBoundingClientRect().width > 0).map(n => ({tag:n.tagName, text:n.textContent?.trim().slice(0,60), label:n.getAttribute('aria-label'), title:n.getAttribute('title'), placeholder:n.getAttribute('placeholder')})))));
  await fs.mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/harness-' + (action || 'home') + '.png' });
  if (action === 'panel') {
    await page.getByRole('button', { name: '折叠侧边栏', exact: true }).click();
    await page.getByRole('button', { name: '展开侧边栏', exact: true }).waitFor();
    console.log('RIGHT_PANEL_COLLAPSE_PASS');
  }
} finally { await context.close(); }

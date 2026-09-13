'use strict';

// Explicit local fixture QA; never connects to models, agents or production.
const { chromium } = require('playwright-core');
const fs = require('fs/promises');
const path = require('path');
const assert = require('assert/strict');

async function main() {
  const url = new URL(process.argv[2] || 'http://127.0.0.1:3196/agent-ops/');
  assert.ok(['http://127.0.0.1:3196', 'http://127.0.0.1:3197'].includes(url.origin), 'Only the local no-worker fixture is allowed');
  const output = path.resolve('output/playwright/persistent-teams');
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.TEAM_UI_BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    chromiumSandbox: true,
    headless: true,
  });
  try {
    const checks = [];
    for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
      const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(url.href);
      await page.locator('#teamExecutionState').filter({ hasText: 'Execution paused' }).waitFor();
      await page.screenshot({ path: path.join(output, `${name}-workroom.png`), fullPage: true });
      async function inspect(label) {
        const layout = await page.evaluate(() => ({ width: window.innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth,
          images: [...document.images].filter((item) => !item.complete || !item.naturalWidth).map((item) => item.getAttribute('src')),
        }));
        assert.ok(layout.documentWidth <= layout.width && layout.bodyWidth <= layout.width, `${name} ${label} overflows`);
        assert.deepEqual(layout.images, []);
        checks.push({ name, label, ...layout });
      }
      await inspect('workroom');
      for (const [button, dialog, label] of [
        ['#addTeammateButton', '#teammateDialog', 'teammate'],
        ['#configureTeamButton', '#teamExecutionDialog', 'execution'],
        ['#newGoalButton', '#teamTaskDialog', 'task'],
        ['#newTeamButton', '#teamDialog', 'team'],
      ]) {
        if (button === '#newTeamButton') await page.locator('.room-tools summary').click();
        await page.locator(button).click();
        await page.locator(dialog).waitFor({ state: 'visible' });
        const footer = await page.locator(`${dialog} footer`).boundingBox();
        assert.ok(footer && footer.y >= 0 && footer.y + footer.height <= viewport.height, `${name} ${label} footer is outside viewport`);
        await page.screenshot({ path: path.join(output, `${name}-${label}-dialog.png`), fullPage: true });
        await inspect(label);
        await page.locator(`${dialog} [data-close-dialog]`).first().click();
      }
      await page.locator('#newBoardNoteButton').click();
      await page.locator('#boardNoteDialog').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#wakeCrewInput').isVisible(), false);
      await page.screenshot({ path: path.join(output, `${name}-note-dialog.png`), fullPage: true });
      await inspect('note');
      await page.keyboard.press('Escape');
      await page.goto(url.href);
      await page.locator('#teamExecutionState').filter({ hasText: 'Execution paused' }).waitFor();
      await page.locator('.room-tools summary').click();
      await page.locator('#manageTeamButton').click();
      for (const section of ['skills', 'routines', 'memories', 'people']) {
        await page.locator(`[data-manager-tab="${section}"]`).click();
        await page.locator('#managerList [data-entry]').first().waitFor();
        const entry = page.locator('#managerList [data-entry]');
        await (section === 'skills' ? entry.filter({ hasText: 'draft' }).first() : section === 'memories' ? entry.filter({ hasText: 'private' }).first() : entry.first()).click();
        await page.screenshot({ path: path.join(output, `${name}-manage-${section}.png`), fullPage: false });
        await inspect(`manage-${section}`);
        const footer = await page.locator('#teamManagerDialog footer').boundingBox();
        assert.ok(footer && footer.y >= 0 && footer.y + footer.height <= viewport.height, `${name} manager footer outside viewport`);
        if (['skills', 'routines', 'memories'].includes(section)) {
          if (section === 'memories') await page.locator('#memoryForget summary').click();
          await page.locator(`#manager${section[0].toUpperCase() + section.slice(1)} button`).last().scrollIntoViewIfNeeded();
          await page.screenshot({ path: path.join(output, `${name}-manage-${section}-controls.png`), fullPage: false });
        }
      }
      async function command(action, perform) {
        const response = page.waitForResponse((result) => result.url().endsWith('/commands') && result.request().postDataJSON()?.action === action);
        await perform(); const result = await response; assert.ok(result.ok(), `${action} failed`);
        await page.waitForFunction(() => document.querySelector('#teamManagerDialog').getAttribute('aria-busy') === 'false');
        return (await result.json()).result;
      }
      await page.locator('[data-manager-tab="skills"]').click(); await page.locator('#managerNew').click();
      await page.locator('#managerSkills [name="name"]').fill(`${name} UI verified skill`);
      await page.locator('#managerSkills [name="instructions"]').fill('Local fixture: inspect saved outputs.');
      await page.locator('#managerSkills [name="acceptance"]').fill('The saved output is inspectable.');
      const skill = await command('save_skill', () => page.locator('#managerSkills [type="submit"]').click());
      assert.equal(skill.status, 'draft');
      await page.locator('#managerSkills [name="inspected"]').check();
      assert.equal((await command('approve_skill', () => page.locator('#managerApproveSkill').click())).status, 'approved');
      await page.locator('[data-manager-tab="routines"]').click(); await page.locator('#managerNew').click();
      await page.locator('#managerRoutines [name="title"]').fill(`${name} fixture routine`);
      await page.locator('#managerRoutines [name="skillId"]').selectOption(skill.id);
      await page.locator('#managerRoutines [name="instruction"]').fill('Local fixture only; no worker is attached.');
      const routine = await command('create_routine', () => page.locator('#managerRoutines [type="submit"]').click()); assert.equal(routine.enabled, false);
      await page.locator('#managerRoutines [name="confirmed"]').check();
      assert.equal((await command('control_routine', () => page.locator('#managerControlRoutine').click())).enabled, true);
      assert.equal((await command('control_routine', () => page.locator('#managerControlRoutine').click())).enabled, false);
      await page.locator('[data-manager-tab="memories"]').click(); await page.locator('#managerList [data-entry]').first().waitFor(); await page.locator('#managerNew').click();
      await page.locator('#managerMemories [name="content"]').fill(`${name} fixture memory`);
      await page.locator('#managerMemories [name="source"]').fill('Local browser proof');
      const memory = await command('remember', () => page.locator('#managerMemories [type="submit"]').click()); assert.equal(memory.scope, 'private');
      await page.locator('#managerMemories [name="content"]').fill(`${name} revised fixture memory`);
      await command('update_memory', () => page.locator('#managerMemories [type="submit"]').click());
      await page.locator('#memoryForget summary').click(); await page.locator('#managerMemories [name="confirmed"]').check();
      assert.equal((await command('forget', () => page.locator('#managerForgetMemory').click())).forgotten, true);
      const saved = await (await page.request.get(`${url.origin}/api/agent-teams/${url.searchParams.get('team')}/workroom`)).json();
      assert.equal(saved.execution.enabled, false); assert.equal(saved.routines.find((item) => item.id === routine.id).enabled, false);
      assert.equal(saved.skills.find((item) => item.id === skill.id).status, 'approved');
      checks.push({ name, label: 'management writes read back', skill: 'approved', routine: 'paused', privateMemory: 'created updated forgotten', executionEnabled: false });
      await page.locator('#teamManagerDialog [data-manager-close]').first().click();
      assert.equal(await page.locator('#managerMemories [name="content"]').inputValue(), '');
      assert.deepEqual(errors, [], `${name} page errors`);
      await page.close();
    }
    console.log(JSON.stringify({ sandbox: true, output, checks }, null, 2));
  } finally { await browser.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

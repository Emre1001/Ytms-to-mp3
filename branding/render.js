// Renders branding/icon.svg into every icon file the apps need.
// Usage (needs Playwright with Chromium): node branding/render.js
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
const out = (...p) => { const f = path.join(ROOT, ...p); fs.mkdirSync(path.dirname(f), { recursive: true }); return f; };

// ICO with PNG-compressed entries (Windows Vista and later).
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(([size, buf], i) => {
    const e = 6 + i * 16;
    head.writeUInt8(size >= 256 ? 0 : size, e); head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(buf.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += buf.length;
  });
  return Buffer.concat([head, ...pngs.map(p => p[1])]);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const render = async (size, inset = 0) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size - 2 * inset}px;height:${size - 2 * inset}px;margin:${inset}px}</style>${svg}`);
    return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  };

  // Desktop (electron-builder): 1024 master, Linux icon set, Windows .ico
  fs.writeFileSync(out('desktop/build/icon.png'), await render(1024));
  for (const s of [16, 24, 32, 48, 64, 128, 256, 512]) fs.writeFileSync(out(`desktop/build/icons/${s}x${s}.png`), await render(s));
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  fs.writeFileSync(out('desktop/build/icon.ico'), ico(await Promise.all(icoSizes.map(async s => [s, await render(s)]))));

  // Web app / website
  fs.copyFileSync(path.join(__dirname, 'icon.svg'), out('static/icons/icon.svg'));
  for (const s of [180, 192, 512]) fs.writeFileSync(out(`static/icons/icon-${s}.png`), await render(s));

  // Android legacy launcher icons (API < 26; newer ones use the adaptive vector icon)
  const dens = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  for (const [d, s] of Object.entries(dens)) {
    const png = await render(s, Math.round(s * 0.04));
    fs.writeFileSync(out(`android/app/src/main/res/mipmap-${d}/ic_launcher.png`), png);
  }
  // Social preview for the website (Open Graph)
  await page.setViewportSize({ width: 1200, height: 630 });
  await page.goto('file://' + path.join(__dirname, 'og.html'));
  await page.waitForTimeout(300);
  fs.writeFileSync(out('site/assets/og.png'), await page.screenshot());

  await browser.close();
  console.log('icons written');
})();

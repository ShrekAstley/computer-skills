import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDesktopEntry, parseExec, parseWmctrl, parseSwayTree, parseHyprClients, normalizeXid, parseXwininfoTree } from '../../src/platform/linux-desktop.js';
import { parseTesseractTsv, groupWords } from '../../src/screen/ocr.js';
import { searchOcr } from '../../src/ui/service.js';
import { stripJsonComments } from '../../src/install/client-config.js';
import { expandGlob } from '../../src/apps/registry.js';

test('desktop entries', () => {
  const e = parseDesktopEntry(`[Desktop Entry]\nName=Blender\nName[de]=Blender DE\nExec=blender %f\nType=Application\nStartupWMClass=Blender\n[Desktop Action new]\nName=New`);
  assert.equal(e.Name, 'Blender');
  assert.equal(e.Exec, 'blender %f');
  assert.equal(e.StartupWMClass, 'Blender');
  assert.deepEqual(parseExec('"/opt/My App/app" --flag %U'), ['/opt/My App/app', '--flag']);
  assert.deepEqual(parseExec('flatpak run --branch=stable org.gimp.GIMP %U'), ['flatpak', 'run', '--branch=stable', 'org.gimp.GIMP']);
  assert.deepEqual(parseExec('sh -c "echo \\"hi\\" 100%%"'), ['sh', '-c', 'echo "hi" 100%']);
});

test('wmctrl output', () => {
  const w = parseWmctrl('0x03a00007  0 12345  10 20  800 600 xterm.XTerm  host Some Title with  spaces\n0x01000003 -1 999 0 0 1920 30 panel.Panel host Panel');
  assert.equal(w.length, 2);
  assert.deepEqual({ id: w[0].id, title: w[0].title, app: w[0].app, pid: w[0].pid, x: w[0].x, width: w[0].width }, { id: '0x03a00007', title: 'Some Title with  spaces', app: 'XTerm', pid: 12345, x: 10, width: 800 });
  assert.equal(normalizeXid(255), '0x000000ff');
  assert.equal(normalizeXid('0x60000c'), '0x0060000c');
});

test('xwininfo tree gives absolute geometry', () => {
  const m = parseXwininfoTree('     0x60000c "root@vm: ~": ("xterm" "XTerm")  604x394+1+20  +51+70\n     0x20011f "Openbox": ("" (none))  1x1+-100+-100  +-100+-100');
  assert.deepEqual(m.get(0x60000c), { x: 51, y: 70, width: 604, height: 394 });
  assert.deepEqual(m.get(0x20011f), { x: -100, y: -100, width: 1, height: 1 });
});

test('sway and hyprland', () => {
  const tree = { type: 'root', nodes: [{ type: 'workspace', name: '1', nodes: [{ type: 'con', id: 7, pid: 5, name: 'Term', app_id: 'foot', focused: true, rect: { x: 1, y: 2, width: 3, height: 4 } }], floating_nodes: [] }] };
  assert.deepEqual(parseSwayTree(tree)[0], { id: '7', title: 'Term', app: 'foot', className: 'foot', pid: 5, x: 1, y: 2, width: 3, height: 4, focused: true, workspace: '1' });
  const h = parseHyprClients([{ address: '0xabc', title: 'T', class: 'kitty', pid: 3, at: [5, 6], size: [7, 8], focusHistoryID: 0, workspace: { name: '2' } }]);
  assert.equal(h[0].focused, true);
  assert.equal(h[0].x, 5);
});

test('tesseract TSV grouping', () => {
  const tsv = [
    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    '5\t1\t1\t1\t1\t1\t10\t10\t30\t12\t95\tFile',
    '5\t1\t2\t1\t1\t1\t60\t10\t30\t12\t91\tEdit',
    '5\t1\t3\t1\t1\t1\t10\t40\t40\t12\t90\tSave',
    '5\t1\t3\t1\t1\t2\t54\t40\t20\t12\t80\tAs...',
    '5\t1\t4\t1\t1\t1\t10\t80\t40\t12\t-1\t',
  ].join('\n');
  const lines = parseTesseractTsv(tsv);
  assert.deepEqual(lines.map((l) => l.text), ['File', 'Edit', 'Save As...']);
  assert.equal(lines[2].width, 64);
  assert.equal(groupWords([]).length, 0);
});

test('OCR phrase search prefers precise word matches', () => {
  const lines = [{ text: 'File Edit View Render', x: 0, y: 0, width: 300, height: 10, words: [
    { text: 'File', x: 0, y: 0, width: 30, height: 10 }, { text: 'Edit', x: 40, y: 0, width: 30, height: 10 },
    { text: 'View', x: 80, y: 0, width: 30, height: 10 }, { text: 'Render', x: 120, y: 0, width: 50, height: 10 }] }];
  const hits = searchOcr(lines, 'render');
  assert.equal(hits[0].text, 'Render');
  assert.equal(hits[0].box.x, 120);
  assert.equal(searchOcr(lines, 'Export').length, 0);
  assert.equal(searchOcr([{ text: 'Save As...', x: 0, y: 0, width: 10, height: 10, words: [] }], 'save as')[0].text, 'Save As...');
});

test('JSONC comment stripping keeps strings intact', () => {
  const src = '{\n // comment\n "url": "http://x//y", /* block */ "a": [1,2,],\n}';
  assert.deepEqual(JSON.parse(stripJsonComments(src)), { url: 'http://x//y', a: [1, 2] });
});

test('glob expansion of version folders', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glob-'));
  for (const v of ['Blender 3.6', 'Blender 4.2']) {
    fs.mkdirSync(path.join(root, v));
    fs.writeFileSync(path.join(root, v, 'blender.exe'), '');
  }
  const hits = expandGlob(path.join(root, 'Blender *', 'blender.exe'));
  assert.equal(hits.length, 2);
  assert.match(hits[0], /4\.2/);
});

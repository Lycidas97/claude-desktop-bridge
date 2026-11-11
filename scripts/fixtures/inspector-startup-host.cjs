// Isolated Electron main process for native-menu QA. Never loads Claude resources.
const { app, BrowserWindow, Menu, protocol } = require('electron');
const inspector = require('node:inspector');
const http = require('node:http');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const [directory, port] = process.argv.slice(2);
app.setPath('userData', directory);
app.setName('Bridge Inspector Startup Fixture');
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true } }]);
let presses = 0;
let permitted = true;
let debuggerItem;
let window;
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  protocol.handle('app', () => new Response(`<html><body>Inspector startup fixture<script>
    globalThis['claude.web'] = { LocalSessions: {
      getAll: async () => [{ sessionId: 'fixture-session', title: 'Fixture session' }],
      onOnEvent: () => () => {}, onOnToolPermissionRequest: () => () => {}
    }};
  </script></body></html>`, { headers: { 'content-type': 'text/html' } }));
  window = new BrowserWindow({ width: 400, height: 200, show: false });
  await window.loadURL('app://localhost/inspector-startup-fixture');
  window.showInactive();
  const server = http.createServer((request, response) => {
    if (request.url === '/ready') {
      const menu = Menu.buildFromTemplate([{ label: 'Developer', submenu: [{
        id: 'main-debugger', label: 'Enable Main Process Debugger', type: 'checkbox', checked: false,
        click(item) {
          presses++;
          if (permitted && !inspector.url()) inspector.open(Number(port), '127.0.0.1');
          item.checked = Boolean(inspector.url());
        },
      }] }]);
      debuggerItem = menu.getMenuItemById('main-debugger');
      Menu.setApplicationMenu(menu);
    }
    if (request.url === '/manual-close') { inspector.close(); debuggerItem.checked = false; }
    if (request.url === '/deny-policy') permitted = false;
    if (request.url === '/disable-menu') debuggerItem.enabled = false;
    if (request.url === '/quit') { response.end('{}'); server.close(); app.quit(); return; }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ pid: process.pid, presses, enabled: Boolean(inspector.url()), permitted }));
  });
  server.listen(0, '127.0.0.1', () => writeFileSync(join(directory, 'fixture.json'), JSON.stringify({ pid: process.pid, controlPort: server.address().port })));
});

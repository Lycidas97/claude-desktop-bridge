require('../recycle-cleanup.cjs');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { Packager } = require('@electron/packager/dist/packager.js');
const { LinuxApp } = require('@electron/packager/dist/linux.js');

(async () => {
  const opts = { dir: process.argv[3], name: 'Fixture', platform: 'linux', arch: 'x64', asar: false, prune: false };
  const packager = new Packager(opts);
  console.log(JSON.stringify({ role: process.argv[2], tmpdir: tmpdir(), tempBase: packager.tempBase }));
  await packager.ensureTempDir();
  if (process.argv[2] === 'create') {
    const template = await packager.buildDir('linux', 'x64');
    await fs.mkdir(join(template, 'resources'));
    await fs.writeFile(join(template, 'electron'), 'fixture');
    process.send({ template });
    await once(process, 'message');
    await new LinuxApp(opts, template).initialize();
    console.log('TEMPLATE_CONSUMED');
  }
  process.disconnect();
})().catch(error => {
  console.error(error);
  process.exit(1);
});

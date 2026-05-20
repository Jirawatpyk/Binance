const { Service } = require('node-windows');
const path = require('path');

const svc = new Service({
  name: 'BinanceTranslationBot',
  description: 'Auto-assign bot for translationtms.com (lo-LA / km-KH)',
  script: path.resolve(__dirname, '..', 'dist', 'index.js'),
  nodeOptions: ['--enable-source-maps'],
  workingDirectory: path.resolve(__dirname, '..'),
});

svc.on('install', () => {
  console.log('Service installed. Starting...');
  svc.start();
});

svc.on('start', () => console.log('Service started.'));
svc.on('error', (err) => console.error('Service error:', err));

const action = process.argv[2];
if (action === 'install') svc.install();
else if (action === 'uninstall') svc.uninstall();
else {
  console.error('Usage: node scripts/install-windows-service.js [install|uninstall]');
  process.exit(1);
}

const { Service } = require('node-windows');
const path = require('path');

// Least-privilege note: by default node-windows installs the service to run as
// LocalSystem, which is more privilege than this cookie-scraping bot needs and
// means a SYSTEM-level process handles data/cookies.json (a live session token).
// To run under a dedicated low-privilege local account instead, uncomment `user`
// below (or, post-install, run: sc config BinanceTranslationBot obj= ".\botsvc"
// password= "..."). Grant that account read/write only on this project's data/
// and logs/ folders. install-service.bat also restricts data/ ACLs.
const svc = new Service({
  name: 'BinanceTranslationBot',
  description: 'Auto-assign bot for translationtms.com (lo-LA / km-KH)',
  script: path.resolve(__dirname, '..', 'dist', 'index.js'),
  nodeOptions: ['--enable-source-maps'],
  workingDirectory: path.resolve(__dirname, '..'),
  // user: { account: '.\\botsvc', password: process.env.SVC_PASSWORD }, // least-privilege run-as
  // Auto-restart on crash / watchdog self-exit
  wait: 2,          // seconds to wait before first restart
  grow: 0.5,        // back-off growth factor between restarts
  maxRestarts: 40,  // max restarts within a 60s window before giving up
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

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const requiredFiles = [
  'index.js', 'package.json', 'render.yaml', '.node-version', '.env.example',
  'src/app.js', 'src/commands/index.js', 'src/database/index.js',
  'src/dashboard/public/index.html', 'src/dashboard/public/dashboard.html',
  'src/dashboard/public/dashboard.js', 'src/dashboard/public/style.css'
];
const missing = requiredFiles.filter(file => !fs.existsSync(path.join(root, file)));
if (missing.length) {
  console.error('Missing required project files:', missing.join(', '));
  process.exit(1);
}
const commandsSource = fs.readFileSync(path.join(root, 'src/commands/index.js'), 'utf8');
const names = [...commandsSource.matchAll(/add\('([^']+)'/g)].map(match => match[1]);
const invalid = names.filter(name => !/^[-a-z0-9]{1,32}$/.test(name));
const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
if (invalid.length || duplicates.length) {
  console.error('Invalid command names:', invalid.join(', ') || '(none)');
  console.error('Duplicate command names:', [...new Set(duplicates)].join(', ') || '(none)');
  process.exit(1);
}
if (names.length > 100) {
  console.error(`Discord command limit exceeded: ${names.length}`);
  process.exit(1);
}
const nodeVersion = fs.readFileSync(path.join(root, '.node-version'), 'utf8').trim();
if (!nodeVersion.startsWith('22.')) {
  console.error(`Expected Node.js 22 pin, found ${nodeVersion}`);
  process.exit(1);
}
console.log(`Project structure OK. ${names.length} command declarations found. Node.js ${nodeVersion} pinned.`);

const fs = require('fs');

fs.readFile('package.json', 'utf8', (err, data) => {
  if (err) {
    console.error('Error reading package.json:', err);
    return;
  }
  const packageJson = JSON.parse(data);
  console.log('Project name:', packageJson.name);
});
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, 'prototype-v2-server.js'), 'utf8');
eval(source);

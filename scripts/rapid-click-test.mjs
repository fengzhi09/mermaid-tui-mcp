// Verify view.html behavior under rapid clicks by parsing the script
import { readFileSync } from 'node:fs';
const html = readFileSync('public/view.html', 'utf-8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] || '';

// Find the applyTheme function
const applyMatch = script.match(/function applyTheme\(name\) \{([^}]+)\}/);
console.log('applyTheme source:');
console.log(applyMatch?.[0]);

import { render } from '../src/render.mjs';
const result = await render('graph TD\n  A --> B');
const varMatches = result.svg.match(/var\(--[a-z-]+\)/g) || [];
const hexMatches = result.svg.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
console.log('var count:', varMatches.length);
console.log('unique vars:', [...new Set(varMatches)]);
console.log('hex count:', hexMatches.length);
console.log('unique hex sample:', [...new Set(hexMatches)].slice(0, 10));
console.log('id:', result.id);

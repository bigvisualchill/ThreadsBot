const fs = require('fs');
const content = fs.readFileSync('threads-functions.js', 'utf8');
const lines = content.split('\n');

let tryStack = [];
let catchStack = [];
let braceStack = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const trimmed = line.trim();
  
  // Track braces
  for (const char of line) {
    if (char === '{') braceStack.push({ line: i+1, type: 'open' });
    if (char === '}') {
      if (braceStack.length > 0) {
        braceStack.pop();
      }
    }
  }
  
  // Track try-catch
  if (trimmed.includes('try') && trimmed.includes('{') && !trimmed.includes('//')) {
    tryStack.push(i+1);
  }
  
  if (trimmed.includes('} catch') && !trimmed.includes('//')) {
    catchStack.push(i+1);
  }
  
  // Show problematic area
  if (i >= 665 && i <= 675) {
    console.log(`${i+1}: ${line}`);
  }
}

console.log('\nTry blocks at lines:', tryStack);
console.log('Catch blocks at lines:', catchStack);
console.log('Remaining braces:', braceStack.length);

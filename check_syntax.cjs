const fs = require('fs');
const content = fs.readFileSync('threads-functions.js', 'utf8');
const lines = content.split('\n');

let braceCount = 0;
let tryCount = 0;
let catchCount = 0;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const trimmed = line.trim();
  
  // Count braces
  for (const char of line) {
    if (char === '{') braceCount++;
    if (char === '}') braceCount--;
  }
  
  // Count try/catch
  if (trimmed.includes('try') && trimmed.includes('{') && !trimmed.includes('//')) tryCount++;
  if (trimmed.includes('} catch') && !trimmed.includes('//')) catchCount++;
  
  // Show problematic area
  if (i >= 665 && i <= 675) {
    console.log(`${i+1}: ${line}`);
  }
}

console.log('Final brace count:', braceCount);
console.log('Try blocks:', tryCount);
console.log('Catch blocks:', catchCount);

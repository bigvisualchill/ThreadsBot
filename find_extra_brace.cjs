const fs = require('fs');
const content = fs.readFileSync('threads-functions.js', 'utf8');
const lines = content.split('\n');

let braceStack = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  
  for (let j = 0; j < line.length; j++) {
    if (line[j] === '{') {
      braceStack.push({ line: i+1, char: j+1, type: 'opening' });
    }
    if (line[j] === '}') {
      if (braceStack.length === 0) {
        console.log(`ERROR: Extra closing brace at line ${i+1}, char ${j+1}`);
      } else {
        braceStack.pop();
      }
    }
  }
}

console.log('Remaining brace stack:', braceStack.length);
if (braceStack.length > 0) {
  console.log('Unclosed braces:');
  braceStack.forEach(b => console.log(`  Line ${b.line}, char ${b.char}`));
}

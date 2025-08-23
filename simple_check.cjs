const fs = require('fs');
const content = fs.readFileSync('threads-functions.js', 'utf8');

let openBraces = 0;
let closeBraces = 0;

for (let char of content) {
  if (char === '{') openBraces++;
  if (char === '}') closeBraces++;
}

console.log('Total opening braces:', openBraces);
console.log('Total closing braces:', closeBraces);
console.log('Difference:', openBraces - closeBraces);

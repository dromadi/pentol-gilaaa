// Penguji kecil tanpa dependensi: test(nama, fn) lalu run().
const tests = [];
export function test(name, fn) { tests.push({ name, fn }); }
export function assert(condition, message) { if (!condition) throw new Error(message); }
export function equal(actual, expected, message) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(message + '\n      diharapkan: ' + b + '\n      didapat:    ' + a);
}
export async function run(title) {
  let failed = 0;
  console.log('\n' + title);
  for (const { name, fn } of tests.splice(0)) {
    try { await fn(); console.log('  ✓ ' + name); }
    catch (error) { failed++; console.log('  ✗ ' + name + '\n      ' + error.message); }
  }
  return failed;
}

// node --test scripts/parse-literal.test.mjs — proves the bundle parser converts data and refuses code.
import test from "node:test";
import assert from "node:assert/strict";
import { parseObjectLiteralAt } from "./parse-literal.mjs";

const at0 = (src) => parseObjectLiteralAt(src, 0);

test("converts minified data literals", () => {
  assert.deepEqual(
    at0('{a:"x",b:[1,-2,!0,!1,null],"c-d":{e:`t`},f:new Date(0)},g=1'),
    { a: "x", b: [1, -2, true, false, null], "c-d": { e: "t" }, f: "1970-01-01T00:00:00.000Z" },
  );
});

for (const [label, src] of [
  ["function call", '{a:globalThis.process.exit(1)}'],
  ["constructor escape", '{a:this.constructor.constructor("return process")()}'],
  ["identifier", "{a:process}"],
  ["getter", "{get a(){return 1}}"],
  ["computed key", '{[("a")]:1}'],
  ["spread", "{...x}"],
  ["template expression", "{a:`${process.exit(1)}`}"],
  ["arrow function", "{a:()=>1}"],
  ["other constructor", "{a:new Function(\"return 1\")}"],
  ["Date with non-literal", "{a:new Date(Date.now())}"],
  ["regex", "{a:/x/}"],
]) {
  test(`rejects ${label}`, () => {
    assert.throws(() => at0(src));
  });
}

/**
 * Turn a JavaScript object literal inside a downloaded bundle into data WITHOUT
 * executing it. Used by gen-api-catalogue.mjs; tested by parse-literal.test.mjs.
 *
 * Only object / array / string / number / boolean / null nodes are accepted,
 * plus the minifier forms `!0` / `!1` / `-n` and `new Date(<number>)`. Any other
 * syntax (calls, identifiers, getters, spreads, template expressions...) throws.
 */

import { parseExpressionAt } from "acorn";

/** Parse the object literal that starts at `start` in `js`. */
export function parseObjectLiteralAt(js, start) {
  // The literal sits in `const a={...},b=...`, so acorn may hand back a comma
  // (sequence) expression; the object is its first element.
  let node = parseExpressionAt(js, start, { ecmaVersion: "latest" });
  if (node.type === "SequenceExpression") node = node.expressions[0];
  if (node.type !== "ObjectExpression") throw new Error(`expected an object literal, got ${node.type}`);
  return literal(node);
}

/** Convert an acorn AST of a pure data literal to a value. Anything else is rejected. */
export function literal(node) {
  switch (node.type) {
    case "ObjectExpression": {
      const out = {};
      for (const prop of node.properties) {
        if (prop.type !== "Property" || prop.kind !== "init" || prop.computed || prop.method) {
          throw new Error(`unsupported property at ${prop.start}`);
        }
        const key = prop.key.type === "Identifier" ? prop.key.name : literal(prop.key);
        out[key] = literal(prop.value);
      }
      return out;
    }
    case "ArrayExpression":
      return node.elements.map((e) => {
        if (!e || e.type === "SpreadElement") throw new Error(`unsupported array element at ${node.start}`);
        return literal(e);
      });
    case "Literal":
      if (node.regex) throw new Error(`regex literal at ${node.start}`);
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length) throw new Error(`template with expressions at ${node.start}`);
      return node.quasis.map((q) => q.value.cooked).join("");
    case "UnaryExpression":
      // Minifiers write booleans as !0 / !1 and negatives as -n.
      if (node.operator === "!" && node.argument.type === "Literal" && typeof node.argument.value === "number") {
        return !node.argument.value;
      }
      if (node.operator === "-" && node.argument.type === "Literal" && typeof node.argument.value === "number") {
        return -node.argument.value;
      }
      throw new Error(`unsupported unary ${node.operator} at ${node.start}`);
    case "NewExpression":
      // One schema example is written as `new Date(<ms>)`. Allow exactly that
      // shape and convert it the way JSON.stringify would; nothing is executed.
      if (
        node.callee.type === "Identifier" &&
        node.callee.name === "Date" &&
        node.arguments.length === 1 &&
        node.arguments[0].type === "Literal" &&
        typeof node.arguments[0].value === "number"
      ) {
        return new Date(node.arguments[0].value).toISOString();
      }
      throw new Error(`unsupported new-expression at ${node.start}`);
    default:
      throw new Error(`unsupported ${node.type} at ${node.start}`);
  }
}


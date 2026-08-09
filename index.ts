export { tokenize, type Token, TokenType } from "./src/tokenizer.ts";
export { parse, ParseError } from "./src/parser.ts";
export type * from "./src/ast.ts";

import { tokenize } from "./src/tokenizer.ts";
import { parse } from "./src/parser.ts";
import type { ParseOptions, Script } from "./src/ast.ts";

/** Convenience: tokenize + parse in one call */
export function parseShell(source: string, options: ParseOptions = {}): Script {
  const tokens = tokenize(source, options);
  return parse(tokens, options);
}

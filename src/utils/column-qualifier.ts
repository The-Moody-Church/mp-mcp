// MP's REST layer can silently bind a bare column reference to the wrong
// column when the same column name is reachable on the queried table both
// directly AND via an FK chain back to itself. The documented case:
//
//   Participants -> Contact_ID_Table (Contacts)
//                -> Participant_Record_Table (back to Participants)
//                -> Participant_Engagement_ID
//
// MP errors on this ambiguity inside $select but NOT inside $filter, $orderby,
// or the FK-join shorthand (Foo_ID_Table.Bar). The fix is to always emit a
// table-qualified form so MP cannot pick the wrong source.
//
// qualifyFilterColumns walks the expression respecting string literals and
// bracketed identifiers, and rewrites bare identifiers to {table}.{ident}.
// Tokens that are SQL keywords, that are already qualified (preceded by `.`),
// or that are themselves the prefix of a chained reference (followed by `.`)
// are left untouched.

const SQL_KEYWORDS = new Set([
  "AND", "OR", "NOT", "NULL", "IS", "LIKE", "IN", "BETWEEN",
  "AS", "ASC", "DESC", "TRUE", "FALSE",
]);

export function qualifyFilterColumns(table: string, expr: string): string {
  let out = "";
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];

    // Single-quoted string literal — copy through, treating '' as an escaped
    // quote so we don't exit the literal on the first '.
    if (c === "'") {
      out += c;
      i++;
      while (i < expr.length) {
        const cc = expr[i];
        out += cc;
        i++;
        if (cc === "'") {
          if (expr[i] === "'") {
            out += "'";
            i++;
            continue;
          }
          break;
        }
      }
      continue;
    }

    // Bracketed identifier (e.g., [State/Region]) — already explicitly scoped
    // by the caller, so don't try to qualify the inside.
    if (c === "[") {
      while (i < expr.length && expr[i] !== "]") {
        out += expr[i];
        i++;
      }
      if (i < expr.length) {
        out += expr[i];
        i++;
      }
      continue;
    }

    // Identifier: [A-Za-z_][A-Za-z0-9_]*
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < expr.length && /[A-Za-z0-9_]/.test(expr[j])) j++;
      const token = expr.slice(i, j);

      let prevNonSpace = "";
      for (let k = out.length - 1; k >= 0; k--) {
        if (!/\s/.test(out[k])) { prevNonSpace = out[k]; break; }
      }
      const isAlreadyQualified = prevNonSpace === ".";
      const isPrefix = expr[j] === ".";
      // Skip function-call sites (e.g., GETDATE(), DATEADD(...)) — qualifying
      // them would turn a (possibly invalid) function call into a non-existent
      // column reference and obscure the real error.
      const isFunctionCall = expr[j] === "(";
      const isKeyword = SQL_KEYWORDS.has(token.toUpperCase());

      if (!isKeyword && !isAlreadyQualified && !isPrefix && !isFunctionCall) {
        out += `${table}.${token}`;
      } else {
        out += token;
      }
      i = j;
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

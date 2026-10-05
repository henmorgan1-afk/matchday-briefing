// Deterministic line checks (SPEC.md §3.1 step 4, §9, Revision 7). The pipeline runs them as a code gate
// after the model safety check, and check-p1.js asserts them on passing lines, so both use this file.
// Pure functions: no model calls, no I/O.

// Numbers are detected as digits and as these words, hyphenated forms included ("three-one" is read
// as three and one).
const NUMBER_WORDS = Object.freeze({
  nil: 0, zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20,
});

const isNumberWord = (token) => Object.prototype.hasOwnProperty.call(NUMBER_WORDS, token);
const ONE_COUNTS_BEFORE = new Set(['goal', 'goals', 'point', 'points', 'apiece']);

// A standalone "one" counts only in a score form: joined by a hyphen or en dash with no spaces to
// another number or to "all" ("one-nil", "two-one", "one-all"), or before goal(s), point(s) or apiece
// ("one goal", "one-point", "one apiece"). Idioms such as "one of", "in one game" and "no one" are
// ignored. A spaced dash is punctuation, so "matchday 5 - one of those" doesn't count it.
function oneCounts(text, tokens, i) {
  const [prev, self, next] = [tokens[i - 1], tokens[i], tokens[i + 1]];
  const joined = (a, b) => a && b && /^[-–]$/.test(text.slice(a.end, b.start));
  const isNumber = (t) => /^\d+$/.test(t.token) || isNumberWord(t.token);
  if (joined(prev, self) && isNumber(prev)) return true;
  if (joined(self, next) && (isNumber(next) || next.token === 'all')) return true;
  return Boolean(next && /^[\s-]+$/.test(text.slice(self.end, next.start)) && ONE_COUNTS_BEFORE.has(next.token));
}

// Every number in a line, as { token, value }. Words are whole tokens only, so "someone" holds no "one";
// digits are matched even inside tokens, so "2nd" holds 2.
function numbersIn(text) {
  const lower = String(text).toLowerCase();
  const tokens = [...lower.matchAll(/\d+|[a-z]+/g)].map((m) => ({ token: m[0], start: m.index, end: m.index + m[0].length }));
  const found = [];
  tokens.forEach(({ token }, i) => {
    if (/^\d+$/.test(token)) found.push({ token, value: Number(token) });
    else if (isNumberWord(token) && (token !== 'one' || oneCounts(lower, tokens, i))) found.push({ token, value: NUMBER_WORDS[token] });
  });
  return found;
}

// No line may contain these. Matched case-insensitively at the start of a word with any ending
// ("champions", "relegated", "tonight's", "last weekend"), so "comfortable" doesn't trip "table"; a space
// or hyphen counts as the gap in multi-word terms. "back in" alone must end at a word boundary, so
// "back into" and "back inside" don't trip it.
const BANNED_TERMS = Object.freeze([
  'champion', 'title', 'table', 'mid-table', 'top four', 'relegat', 'league position', 'big six',
  'today', 'tonight', 'yesterday', 'last night', 'this weekend', 'this morning', 'back in', 'last week', 'recently',
]);
const WHOLE_WORD_TERMS = new Set(['back in']);
const BANNED_PATTERN = new RegExp(
  `\\b(?:${BANNED_TERMS.map((t) => t.split(/[\s-]+/).join('[\\s-]+') + (WHOLE_WORD_TERMS.has(t) ? '\\b' : '')).join('|')})`,
  'gi',
);

function bannedTermsIn(text) {
  return [...String(text).matchAll(BANNED_PATTERN)].map((m) => m[0]);
}

// The numbers a STAT or HOT_TAKE line may contain, from one perspective's match data.
function allowedNumbers(matchData) {
  const allowed = new Set();
  const add = (v) => { if (Number.isInteger(v)) allowed.add(v); };
  add(matchData.full_time.perspective);
  add(matchData.full_time.opponent);
  if (matchData.half_time) {
    add(matchData.half_time.perspective);
    add(matchData.half_time.opponent);
  }
  add(matchData.total_goals);
  add(matchData.winning_margin);
  add(matchData.points_earned);
  add(matchData.matchday);
  const date = matchData.kickoff_date.match(/^\w+ (\d+) \w+ (\d+)$/);
  if (!date) throw new Error(`kickoff_date "${matchData.kickoff_date}" isn't in the "Sat 19 Sep 2026" form`);
  add(Number(date[1]));
  add(Number(date[2]));
  return allowed;
}

// Everything wrong with one line under the deterministic rules; an empty list means it passes.
// STAT and HOT_TAKE numbers must be in the perspective's allowed set, BANTER may hold no number at all,
// and no type may contain a banned term.
function codeGateProblems({ type, text }, matchData) {
  const problems = [];
  const allowed = type === 'BANTER' ? null : allowedNumbers(matchData);
  for (const n of numbersIn(text)) {
    if (type === 'BANTER') problems.push(`BANTER line contains a number, ${JSON.stringify(n.token)}`);
    else if (!allowed.has(n.value)) problems.push(`${type} line uses ${JSON.stringify(n.token)} (${n.value}), not in its match data`);
  }
  for (const term of bannedTermsIn(text)) problems.push(`contains banned term ${JSON.stringify(term)}`);
  return problems;
}

module.exports = { NUMBER_WORDS, BANNED_TERMS, numbersIn, bannedTermsIn, allowedNumbers, codeGateProblems };

// Deterministic line checks (SPEC.md §3.1 step 4, §3.3, §9, Revisions 7 and 9). The pipeline runs them
// as a code gate after the model safety check, and check-p1.js asserts them on passing lines, so both
// use this file. No model calls; the only I/O is reading the generation prompt once, for the copy check.
// normaliseDashes (Revision 16) isn't a check: generate-comments.js applies it to every line first.

const { GENERATION_PROMPT_FILE, loadPrompt } = require('./match-data');

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

// ---------------------------------------------------------------- player names (Revision 9)

// Accents are ignored when matching names ("Martinez" is "Martínez"); case isn't.
const foldName = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').replace(/[‘’]/g, "'");
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A player's names, as the gate looks for them: web_name, web_name without its initial
// ("Becker" for "A.Becker", "Tóth" for "Tóth.A", "Bruno" for "Bruno G."), and full name
// (known_name, otherwise first and second name).
function nameVariants(player) {
  const web = player.web_name.trim();
  const bare = web.replace(/^\p{Lu}\.\s*/u, '').replace(/\s*\.\p{Lu}$/u, '').replace(/\s+\p{Lu}\.$/u, '').trim();
  const full = player.known_name || `${player.first_name} ${player.second_name}`;
  return [...new Set([web, bare, full.trim()].filter(Boolean))];
}

// Every stored FPL player's names, for namesIn. Built once per run from the players table.
function buildNameIndex(players) {
  const owners = new Map(); // folded name -> fpl_ids of every player with that name
  for (const p of players) {
    for (const variant of nameVariants(p)) {
      const key = foldName(variant);
      owners.set(key, [...new Set([...(owners.get(key) ?? []), p.fpl_id])]);
    }
  }
  // Longest first, so "Lisandro Martinez" is read as one name rather than as "Martinez".
  const alternatives = [...owners.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).map(escapeRegExp);
  const pattern = alternatives.length
    ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}])`, 'gu')
    : null;
  return { owners, pattern };
}

// Every FPL player name in a line, as whole words, case-sensitively, ignoring accents:
// [{ name, fplIds }], where fplIds are all the players with that name.
function namesIn(text, nameIndex) {
  if (!nameIndex.pattern) return [];
  return [...foldName(text).matchAll(nameIndex.pattern)].map((m) => ({ name: m[0], fplIds: nameIndex.owners.get(m[0]) }));
}

// The name context for one perspective: the run's name index, plus that perspective's players
// (listPlayers in match-data.js, with fpl_id and under_18), or null when the match has no player data.
function nameContext(nameIndex, matchPlayers) {
  return { nameIndex, matchPlayers };
}

// SPEC.md §3.3 name rules. Every name found must belong to exactly one player in this match's
// players list (N1, N2); an under-18 player may be named only in STAT (N5); BANTER names nobody (B4).
function nameProblems({ type, text }, names) {
  const problems = [];
  const inMatch = new Map((names.matchPlayers ?? []).map((p) => [p.fpl_id, p]));
  for (const { name, fplIds } of namesIn(text, names.nameIndex)) {
    const here = fplIds.filter((id) => inMatch.has(id)).map((id) => inMatch.get(id));
    if (here.length === 0) {
      problems.push(names.matchPlayers
        ? `names ${JSON.stringify(name)}, who has no event in this match's player data`
        : `names ${JSON.stringify(name)}, but this match has no player data`);
    } else if (here.length > 1) {
      problems.push(`names ${JSON.stringify(name)}, which ${here.length} players in this match share; only a full name says which`);
    } else if (type === 'BANTER') {
      problems.push(`BANTER line names a player, ${JSON.stringify(name)}`);
    } else if (here[0].under_18 && type !== 'STAT') {
      problems.push(`${type} line names ${JSON.stringify(name)}, who was under 18 on match day; only STAT may`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------- copying the prompt (Revision 9)

// A line that repeats this many words in a row from the generation prompt is copying it.
const COPY_RUN_WORDS = 5;

// The voice reference's hedges and idioms are offered for reuse word for word, so repeating them
// isn't copying. Only these four are five words or longer.
const REUSABLE_PHRASES = Object.freeze([
  'Say what you like, but', 'second best all over the pitch', 'three points in the bank', 'a game of two halves',
]);

// Lower-cased words, ignoring punctuation; "I'm" and "City's" stay one word.
const wordsOf = (s) => String(s).toLowerCase().replace(/[‘’]/g, "'").match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? [];

function runsOf(words) {
  const runs = [];
  for (let i = 0; i + COPY_RUN_WORDS <= words.length; i += 1) runs.push(words.slice(i, i + COPY_RUN_WORDS).join(' '));
  return runs;
}

// Every run of COPY_RUN_WORDS words in a prompt template. A {{placeholder}} breaks a run, and runs
// inside REUSABLE_PHRASES are left out.
function buildPromptRuns(promptText) {
  const runs = new Set(promptText.split(/\{\{[a-z_]+\}\}/).flatMap((segment) => runsOf(wordsOf(segment))));
  for (const phrase of REUSABLE_PHRASES) for (const run of runsOf(wordsOf(phrase))) runs.delete(run);
  return runs;
}

let generationPromptRuns = null;

// The stretches of a line that repeat COPY_RUN_WORDS or more words in a row from the generation prompt.
function copiedFromPrompt(text, promptRuns = (generationPromptRuns ??= buildPromptRuns(loadPrompt(GENERATION_PROMPT_FILE)))) {
  const words = wordsOf(text);
  const stretches = [];
  let start = -1;
  let end = -1;
  runsOf(words).forEach((run, i) => {
    if (!promptRuns.has(run)) return;
    if (start >= 0 && i <= end) {
      end = i + COPY_RUN_WORDS;
    } else {
      if (start >= 0) stretches.push(words.slice(start, end).join(' '));
      [start, end] = [i, i + COPY_RUN_WORDS];
    }
  });
  if (start >= 0) stretches.push(words.slice(start, end).join(' '));
  return stretches;
}

// ---------------------------------------------------------------- variety (Revision 9)

// A line whose first three words match a line already written for either side of the match is
// dropped. The check needs the match's other lines, so the pipeline and the dry run apply it
// when lines are written, not as part of codeGateProblems.
const OPENING_WORDS = 3;

// A line's first three words, lower-cased, punctuation ignored: "Say what you like, but" -> "say what you".
const openingWords = (text) => wordsOf(text).slice(0, OPENING_WORDS).join(' ');

// ---------------------------------------------------------------- notes (Revision 9)

// Notes are read by people who don't follow football, so no note may talk about where its facts are
// stored: "match data", "data", "player list" or "players".
const NOTE_BANNED_PATTERN = /\b(?:match\s+data|data|player\s+list|players)\b/gi;

function noteProblems(note) {
  return [...String(note ?? '').matchAll(NOTE_BANNED_PATTERN)].map((m) => `note says ${JSON.stringify(m[0])}`);
}

// ---------------------------------------------------------------- dashes (Revision 16)

// A run of dashes, with any whitespace and comma just before it and any whitespace after it. Dashes
// split only by whitespace ("— —", " -- ") are one run.
const DASH_RUN = /\s*,?\s*([-–—―]+(?:\s+[-–—―]+)*)\s*/gu;
const ENDS_SENTENCE = /[.!?…]["'’”)\]]*$/u;

// Turns dashes used as punctuation into a full stop, so no line or note reaches either check with
// one. An em dash or horizontal bar is always a sentence break; a hyphen or en dash is one only with
// whitespace on at least one side, except a spaced one between two digits, which is a score
// ("5 - 3" -> "5-3"). At a break the dash, the whitespace around it and a comma just before it go,
// and ". " starts a new sentence with a capital letter; no full stop is added after . ! ? or …, a
// dash at the very end becomes a single full stop, and one at the very start is just removed.
// Unspaced hyphens and en dashes ("hat-trick", "one-nil", "3–5") are left alone, and so is text
// with no dashes.
function normaliseDashes(text) {
  const s = String(text);
  let out = '';
  let last = 0;
  let capitalise = false;
  const append = (chunk) => {
    if (capitalise && chunk) {
      chunk = chunk.replace(/^(["'‘“(]*)(\p{Ll})/u, (_, open, letter) => open + letter.toUpperCase());
      capitalise = false;
    }
    out += chunk;
  };
  for (const m of s.matchAll(DASH_RUN)) {
    const [whole, dashes] = m;
    const end = m.index + whole.length;
    if (!/[—―]/.test(dashes) && !/\s/.test(whole)) continue; // inside a word or a score
    append(s.slice(last, m.index));
    last = end;
    const score = /^[-–]$/.test(dashes) && !whole.includes(',') && /\d$/.test(out) && /^\d/.test(s.slice(end));
    if (score) {
      out += dashes;
      continue;
    }
    out = out.trimEnd();
    if (!out) continue; // a dash at the very start
    if (!ENDS_SENTENCE.test(out)) out += '.';
    if (end < s.length) {
      out += ' ';
      capitalise = true;
    }
  }
  append(s.slice(last));
  return out;
}

// ---------------------------------------------------------------- numbers

// The numbers a STAT or HOT_TAKE line may contain, from one perspective's match data, including
// each half's goals and each listed player's goal and save counts (Revision 9).
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
  for (const half of [matchData.first_half_goals, matchData.second_half_goals]) {
    if (!half) continue;
    add(half.perspective);
    add(half.opponent);
  }
  for (const p of matchData.players ?? []) {
    add(p.events.goal);
    add(p.events.saves);
  }
  return allowed;
}

// Everything wrong with one line under the deterministic rules; an empty list means it passes.
// STAT and HOT_TAKE numbers must be in the perspective's allowed set, BANTER may hold no number at all,
// no type may contain a banned term, every player name must pass the name rules, no line may repeat
// five words in a row from the generation prompt, and no note may say "data". `names` comes from
// nameContext; it's required, so the name rules can't be skipped by leaving it out.
function codeGateProblems({ type, text, note }, matchData, names) {
  if (!names?.nameIndex) throw new Error('codeGateProblems needs a name context (nameContext) for the name rules');
  const problems = [];
  const allowed = type === 'BANTER' ? null : allowedNumbers(matchData);
  for (const n of numbersIn(text)) {
    if (type === 'BANTER') problems.push(`BANTER line contains a number, ${JSON.stringify(n.token)}`);
    else if (!allowed.has(n.value)) problems.push(`${type} line uses ${JSON.stringify(n.token)} (${n.value}), not in its match data`);
  }
  for (const term of bannedTermsIn(text)) problems.push(`contains banned term ${JSON.stringify(term)}`);
  problems.push(...nameProblems({ type, text }, names));
  for (const stretch of copiedFromPrompt(text)) {
    problems.push(`repeats ${wordsOf(stretch).length} words in a row from the generation prompt, ${JSON.stringify(stretch)}`);
  }
  problems.push(...noteProblems(note));
  return problems;
}

module.exports = {
  NUMBER_WORDS,
  BANNED_TERMS,
  numbersIn,
  bannedTermsIn,
  allowedNumbers,
  nameVariants,
  buildNameIndex,
  namesIn,
  nameContext,
  REUSABLE_PHRASES,
  buildPromptRuns,
  copiedFromPrompt,
  openingWords,
  noteProblems,
  normaliseDashes,
  codeGateProblems,
};

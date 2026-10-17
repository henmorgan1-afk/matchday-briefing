// Deterministic line checks (SPEC.md §3.1 step 4, §3.3, §9, Revisions 7 and 9). The pipeline runs them
// as a code gate after the model safety check, and check-p1.js asserts them on passing lines, so both
// use this file. No model calls; the only I/O is reading the generation prompt once, for the copy check.
// normaliseDashes (Revision 16) isn't a check: generate-comments.js applies it to every line first.

const { GENERATION_PROMPT_FILE, loadPrompt, playersIn } = require('./match-data');

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
// [{ name, fplIds, index }], where fplIds are all the players with that name and index is where the
// name starts in the accent-folded text.
function namesIn(text, nameIndex) {
  if (!nameIndex.pattern) return [];
  return [...foldName(text).matchAll(nameIndex.pattern)].map((m) => ({ name: m[0], fplIds: nameIndex.owners.get(m[0]), index: m.index }));
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

// ---------------------------------------------------------------- team mix-ups (Revision 19)

// "our" straight before an opposition player's name ("our Martinez") claims their player for us, in a
// line or its note. Only that exact pairing is checked. An opposition player named near "we", "us" or
// "our" is usually right ("Martinez kept us out", "Henderson's brace sank us", "too good for us"), and
// telling those apart from a mix-up takes reading the meaning, which the model checker does.
function teamMixUps(text, names) {
  const inMatch = new Map((names.matchPlayers ?? []).map((p) => [p.fpl_id, p]));
  const folded = foldName(text);
  const problems = [];
  for (const { name, fplIds, index } of namesIn(text, names.nameIndex)) {
    const here = fplIds.filter((id) => inMatch.has(id)).map((id) => inMatch.get(id));
    if (here.length !== 1 || here[0].side !== 'opponent') continue;
    if (/(?<![\p{L}\p{N}])our\s+$/iu.test(folded.slice(0, index))) problems.push(`says "our ${name}", but ${name} plays for the opposition`);
  }
  return problems;
}

// ---------------------------------------------------------------- wording rules (Revision 20)

// A pattern matching any of the phrases as whole words, case-insensitively, longest first. Words may
// be split by spaces or hyphens (`gap`); `plural` also matches an "s" or "es" ending.
function phrasePattern(phrases, { gap = '[\\s-]+', plural = false } = {}) {
  const alternatives = [...phrases].sort((a, b) => b.length - a.length)
    .map((p) => p.split(/[\s-]+/).map(escapeRegExp).join(gap) + (plural ? '(?:e?s)?' : ''));
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
}

// The tails the generation prompt names in "Never add a tail after a comma (...)". They fail anywhere
// in a line or note, since the prompt also says never to borrow a reaction from it. promptTailProblems
// keeps this list and the prompt in step.
const PROMPT_TAILS = Object.freeze([
  'win or lose', 'bless them', 'rough one', 'no sugar coating it', 'proper travelling support', 'whatever happens on the pitch',
]);
// Tails seen in dry runs that the prompt doesn't name. The prompt's general rule is "never add a tail
// after a comma", so these fail only there (", rain or shine"), not as a sentence of their own.
const EXTRA_TAILS = Object.freeze(['rain or shine', 'no contest']);
const PROMPT_TAIL_PATTERN = phrasePattern(PROMPT_TAILS);
const EXTRA_TAIL_PATTERN = new RegExp(`,\\s*(?:${phrasePattern(EXTRA_TAILS).source})`, 'giu');

// The tails a prompt names, lower-cased, or null when it no longer has the list.
function promptTails(template) {
  const list = template.match(/Never add a tail after a comma\s*\(([^)]*)\)/);
  return list ? [...list[1].matchAll(/"([^"]+)"/g)].map((q) => q[1].replace(/\s+/g, ' ').trim().toLowerCase()) : null;
}

// Startup check, like generate-comments.js's promptMixProblems: PROMPT_TAILS must be exactly the
// tails the generation prompt names, so editing one without the other fails loudly.
function promptTailProblems(template = loadPrompt(GENERATION_PROMPT_FILE)) {
  const named = promptTails(template);
  if (!named) return ['the prompt has no "Never add a tail after a comma (...)" list'];
  return [
    ...named.filter((t) => !PROMPT_TAILS.includes(t)).map((t) => `the prompt names the tail "${t}", which PROMPT_TAILS lacks`),
    ...PROMPT_TAILS.filter((t) => !named.includes(t)).map((t) => `PROMPT_TAILS has "${t}", which the prompt doesn't name`),
  ];
}

// Words that compare with other matches (checker rule E3: "other matches this season or in past
// seasons ... trends that imply other matches", e.g. "finally clicking"). Only words that almost always
// mean that. Left out: "all season", "this season" and "in a long while", because E3 passes a personal
// superlative ("worst first half I've seen from us all season"); "again", because a second goal in the
// same match is "again"; and "starting to", which also opens plain opinions ("Starting to think...").
// BANTER is exempt: it may say how a club's fans habitually behave (B3).
// "typical" (Revision 25): Man United published "Typical." twice, implying form.
const OTHER_MATCH_TERMS = Object.freeze([
  'finally', 'at last', 'for once', 'as usual', 'as always', 'as ever', 'once again', 'yet again',
  'unbeaten', 'winning run', 'losing run', 'winning streak', 'losing streak', 'typical',
]);
const OTHER_MATCH_PATTERN = phrasePattern(OTHER_MATCH_TERMS);

// Words for a player's position (checker rule E9: "says what position a player plays", since
// positions aren't in the match data). Only words for a person: a team unit ("our defence", "their
// midfield") isn't a player's position. E9's own examples, "up top" and "at the back", are left out
// because they describe a whole team just as often ("solid at the back").
const POSITION_TERMS = Object.freeze([
  'keeper', 'goalkeeper', 'goalie', 'defender', 'striker', 'midfielder', 'winger', 'full-back', 'centre-back',
  'center-back', 'left-back', 'right-back', 'wing-back', 'centre-forward', 'centre-half', 'centre-halves',
]);
const POSITION_PATTERN = phrasePattern(POSITION_TERMS, { gap: '[\\s-]?', plural: true });

const matchesOf = (pattern, text) => [...String(text ?? '').matchAll(pattern)].map((m) => m[0]);

// Revision 20's wording rules for one line and its note: banned tails (every type), other-match words
// (STAT and HOT_TAKE) and position words (every type).
function wordingProblems({ type, text, note }) {
  const problems = [];
  for (const [where, s] of [['', text], ['note ', note]]) {
    for (const t of [...matchesOf(PROMPT_TAIL_PATTERN, s), ...matchesOf(EXTRA_TAIL_PATTERN, s)]) {
      problems.push(`${where}uses a banned tail, ${JSON.stringify(t.replace(/^,\s*/, ''))}`);
    }
    if (type !== 'BANTER') {
      for (const t of matchesOf(OTHER_MATCH_PATTERN, s)) problems.push(`${where}compares with other matches (E3), ${JSON.stringify(t)}`);
    }
    for (const t of matchesOf(POSITION_PATTERN, s)) problems.push(`${where}names a player's position (E9), ${JSON.stringify(t)}`);
  }
  return problems;
}

// ---------------------------------------------------------------- results and sides (Revision 25)

// Both checkers passed Tottenham's "Kinsky's reflexes saved us from a bigger defeat." after a 1-1 draw,
// and Man United's "Bentancur's red card cost us a win." about a Spurs player (Revision 24). These two
// rules catch that kind of error in code. Both apply to a line and its note, in every type, and work
// sentence by sentence on accent-folded, lower-cased text.

const DASHES = '\\-‐‑‒–—';
const lowerFold = (s) => foldName(s).toLowerCase();

// The sentences of a text, split after . ! or ?, as { text, start }.
function sentencesOf(text) {
  return [...String(text).matchAll(/[^.!?]+[.!?]*/g)].filter((m) => m[0].trim()).map((m) => ({ text: m[0], start: m.index }));
}

// A sentence's words as { word, start, end }, apostrophes kept ("didn't", "we've").
function tokensOf(s) {
  return [...s.matchAll(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu)].map((m) => ({ word: m[0], start: m.index, end: m.index + m[0].length }));
}

// A word that turns what follows into a hypothetical, a denial or a might-have-been ("should have won",
// "deserved to win", "can win", "no defeat", "didn't cost us", "cost us a win", "a possible win"), so it
// states no result. Narrowed by the false-positive scan (Revision 25): "can", "will", "cost", "denied",
// "robbed", "possible" and "potential" were added.
const HEDGE_WORDS = new Set([
  'could', 'should', 'would', 'might', 'must', "could've", "should've", "would've", "might've", "must've",
  'can', 'cannot', 'will', "'ll", 'deserved', 'deserve', 'deserves', 'deserving', 'nearly', 'almost',
  'cost', 'costs', 'costing', 'denied', 'robbed', 'possible', 'potential',
  'no', 'not', 'never', 'nobody', 'neither', 'nothing', 'without',
]);
const isHedge = (word) => HEDGE_WORDS.has(word) || /n't$/.test(word) || /'ll$/.test(word);
// Whether one of the `n` words before position `at` hedges it.
const hedged = (tokens, at, n) => tokens.filter((t) => t.end <= at).slice(-n).some((t) => isHedge(t.word));

// Rule 1: result words must fit the result. The words that fail after each result, as the project
// owner listed them. "beaten" is checked only after a draw: after a win or a loss it's as often about
// the other team ("we've beaten them") as about us, and "defeated" isn't checked for the same reason.
// Plurals aren't checked: the scan found them only about matches in general ("turning draws like that
// into wins", "Draws on the final score").
const WRONG_RESULT_WORDS = Object.freeze({
  drew: Object.freeze(['defeat', 'lost', 'loss', 'beaten', 'won', 'win', 'victory']),
  won: Object.freeze(['defeat', 'lost', 'loss', 'draw', 'drew']),
  lost: Object.freeze(['won', 'win', 'victory', 'draw', 'drew']),
});
const RESULT_WORDS = new Set(Object.values(WRONG_RESULT_WORDS).flat());
const FLIP_RESULT = Object.freeze({ won: 'lost', lost: 'won', drew: 'drew' });

// Phrases blanked out before the check: they name results without stating this match's ("win, lose or
// draw", "win or lose", "the difference between a draw and a defeat").
const RESULT_IDIOMS = /\bwin,?\s+lose,?\s+or\s+draw\b|\bwin\s+or\s+lose\b|\blose\s+or\s+draw\b|\bbetween\s+(?:a\s+|the\s+)?\w+\s+and\s+(?:a\s+|the\s+)?\w+/g;
// What may follow a result word when it isn't about the match result ("won the ball", "lost the
// plot", "lost composure", "at a loss for words", "drew level", "a draw at the break").
const RESULT_IDIOM_AFTER = new RegExp(`^\\s+(?:the\\s+ball|ball|back|possession|a\\s+corner|corners|a\\s+free[\\s${DASHES}]kick|free[\\s${DASHES}]kicks|a\\s+penalty|penalties|the\\s+battle|battles|duels?|headers?|the\\s+toss|count|track|touch|the\\s+plot|for\\s+words|(?:our|their|his)\\s+(?:heads?|shape|way|nerve|cool)|focus|composure|control|discipline|momentum|the\\s+lead|of|level|at\\s+the\\s+break|at\\s+half[\\s${DASHES}]?time)\\b`);
const DRAW_IDIOM_AFTER = /^\s+(?:on|from|upon)\b/; // "draws on the final score"
// What may come before one: "at a loss", and a half rather than the match ("a first-half draw",
// "half-time scoreless draw").
const RESULT_IDIOM_BEFORE = new RegExp(`\\bat\\s+a\\s+$|\\b(?:first|second)[\\s${DASHES}]*half\\s+(?:\\w+\\s+)?$|\\bhalf[\\s${DASHES}]*time\\s+(?:\\w+\\s+)?$|\\bat\\s+the\\s+break\\s+$`);
// A team named after one of these is the object, not the subject ("away at City, lost 5-3").
const OBJECT_BEFORE = /\b(?:at|to|against|by|over|from|than|with|v|vs|beat|beating|past)\s+$/;

// Every reference to a team in a text, as { who, at, end }: "we", "us" and "our" mean us; "they",
// "them" and "their" mean them; so does each team's name, or any word of it over 3 letters that the
// other team's name doesn't share ("United" for "Man United"); and so does a listed player's name, for
// that player's team ("Walton made four. Still lost.").
function teamReferences(s, raw, md, names) {
  const nameForms = (name, other) => {
    const full = lowerFold(name);
    const otherWords = lowerFold(other).split(/\s+/);
    return [full, ...full.split(/\s+/).filter((w) => full.includes(' ') && w.length > 3 && !otherWords.includes(w))].map(escapeRegExp);
  };
  const pattern = (words) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join('|')})(?:'s)?(?![\\p{L}\\p{N}])`, 'gu');
  const found = [];
  for (const [who, words] of [
    ['us', ['we', "we're", "we've", "we'd", 'us', 'our', 'ours', ...nameForms(md.perspective_team, md.opponent)]],
    ['them', ['they', "they're", "they've", "they'd", 'them', 'their', 'theirs', ...nameForms(md.opponent, md.perspective_team)]],
  ]) {
    for (const m of s.matchAll(pattern(words))) found.push({ who, at: m.index, end: m.index + m[0].length });
  }
  const inMatch = new Map((names?.matchPlayers ?? []).map((p) => [p.fpl_id, p]));
  if (names?.nameIndex) {
    for (const { name, fplIds, index } of namesIn(raw, names.nameIndex)) {
      const here = fplIds.filter((id) => inMatch.has(id));
      if (here.length === 1) found.push({ who: inMatch.get(here[0]).side === 'perspective' ? 'us' : 'them', at: index, end: index + name.length });
    }
  }
  return found.filter((r) => !OBJECT_BEFORE.test(s.slice(0, r.at))).sort((a, b) => a.at - b.at);
}

// Whose result a result word at [start, end) in the sentence starting at `from` is about: "for them"
// or "for Chelsea" straight after it; otherwise the nearest team reference before it in its sentence,
// then in an earlier sentence; otherwise us (lines are written from our side: "Lost 5-1 away.").
function resultSubject(s, start, end, from, refs) {
  const after = s.slice(end).match(/^\s+for\s+/);
  if (after) {
    const next = refs.find((r) => r.at === end + after[0].length);
    if (next) return next.who;
  }
  const before = refs.filter((r) => r.end <= start);
  return (before.filter((r) => r.at >= from).pop() ?? before.pop())?.who ?? 'us';
}

function resultWordProblems(text, md, where, names = null) {
  const raw = String(text);
  const s = lowerFold(raw).replace(/[‘’]/g, "'").replace(RESULT_IDIOMS, (m) => ' '.repeat(m.length));
  const refs = md.result === 'drew' ? [] : teamReferences(s, raw, md, names);
  const problems = [];
  for (const sentence of sentencesOf(s)) {
    const tokens = tokensOf(sentence.text).map((t) => ({ ...t, start: t.start + sentence.start, end: t.end + sentence.start }));
    tokens.forEach((t, i) => {
      if (!RESULT_WORDS.has(t.word)) return;
      if (RESULT_IDIOM_AFTER.test(s.slice(t.end)) || RESULT_IDIOM_BEFORE.test(s.slice(0, t.start))) return;
      if (['draw', 'drew'].includes(t.word) && DRAW_IDIOM_AFTER.test(s.slice(t.end))) return;
      // "to win" is an aim, not a result ("their divine right to win", "a game you expect to win").
      if (['win', 'draw'].includes(t.word) && tokens[i - 1]?.word === 'to') return;
      if (hedged(tokens, t.start, 3)) return;
      const subject = md.result === 'drew' ? 'us' : resultSubject(s, t.start, t.end, sentence.start, refs);
      const result = subject === 'us' ? md.result : FLIP_RESULT[md.result];
      if (!WRONG_RESULT_WORDS[result].includes(t.word)) return;
      const fact = md.result === 'drew' ? 'the match was a draw' : `${subject === 'us' ? md.perspective_team : md.opponent} ${result}`;
      problems.push(`${where}says ${JSON.stringify(t.word)}, but ${fact}`);
    });
  }
  return problems;
}

// Rule 2: a player's event can't help or hurt the wrong side. Mentions of each event in a sentence,
// in this order: each match is blanked out before the next pattern runs, so "own goal" isn't also a
// goal and "saved a penalty" isn't also a save.
const EVENT_MENTIONS = Object.freeze([
  ['own_goal', new RegExp(`own[\\s${DASHES}]*(?:goals?|net)`, 'g')],
  ['pen_missed', new RegExp(`\\b(?:miss\\w*|blaz\\w*|sk(?:y|ied|ies))\\s+(?:\\w+\\s+)?(?:penalty|penalties|pen|spot[\\s${DASHES}]*kick)|\\b(?:penalty|pen)\\s+miss\\w*`, 'g')],
  ['pen_saved', new RegExp(`\\bsav\\w*\\s+(?:\\w+\\s+)?(?:penalty|penalties|pen|spot[\\s${DASHES}]*kick)|\\b(?:penalty|pen)\\s+sav\\w*`, 'g')],
  ['red_card', /\bred\b|\bsent\s+off\b|\bsending\s+off\b|\bdismiss\w*/g],
  ['saves', /\bsav(?:e|es|ed|ing)\b|\breflex\w*|\bstops?\b/g],
  ['goal', new RegExp(`\\bgoals?\\b|\\bscor\\w*|\\bbrace\\b|\\bhat[\\s${DASHES}]*trick|\\bfinish\\w*|\\bstrike\\b|\\bnetted\\b|\\bequali[sz]er\\b|\\bwinner\\b`, 'g')],
]);
// Whether an event helps the team of the player who has it.
const HELPS_OWN_TEAM = Object.freeze({ goal: true, saves: true, pen_saved: true, red_card: false, own_goal: false, pen_missed: false });
const EVENT_WORDS = Object.freeze({ goal: 'goal', saves: 'saves', pen_saved: 'penalty save', red_card: 'red card', own_goal: 'own goal', pen_missed: 'penalty miss' });

function eventsMentioned(s) {
  let rest = s;
  const found = new Set();
  for (const [event, pattern] of EVENT_MENTIONS) {
    rest = rest.replace(pattern, (m) => { found.add(event); return ' '.repeat(m.length); });
  }
  return found;
}

// "Bad for us" and "good for us" phrases. A phrase straight after a hedge ("didn't cost us") isn't
// judged. "for us" after "too <word>" or a word for something bad ("too good for us", "a long night
// for us", and since the scan "a two-nil loss for us") isn't good for us, and nor is "gift" handed to
// them ("gifted them") or "kept us" out.
const HURTS_US = /\b(?:cost|costs|costing|hurt|hurts|hurting|punish(?:ed|es|ing)?|kill(?:ed|s|ing)?|scare[sd]?|scaring)\s+us\b|\bwe\s+fear\b/g;
const HELPS_US = /\bfor\s+us\b|\bgave\s+us\b|\bgift\w*|\bhelped\s+us\b|\bsaved\s+us\b|\bkept\s+us\b/g;
const NOT_HELP_BEFORE = /(?:\btoo\s+\S+|\b(?:bad|worse|worst|tough|hard|difficult|nightmare|grim|horrible|awful|disaster|disastrous|painful|bleak|long|miserable|sad|gutting|frustrating|cruel|loss|defeat|blow|setback|beating|hammering|thrashing))\s+(?:\w+\s+)?$/;
const NOT_HELP_AFTER = /^\w*\s+(?:them|their|it\s+to\s+them)\b|^\s+(?:out|quiet|at\s+bay|in\s+check)\b/;

function playerSideProblems(text, md, names, where) {
  const inMatch = new Map((names.matchPlayers ?? []).map((p) => [p.fpl_id, p]));
  if (!inMatch.size) return [];
  const problems = [];
  for (const { text: raw } of sentencesOf(text)) {
    const s = lowerFold(raw).replace(/[‘’]/g, "'");
    const tokens = tokensOf(s);
    // The match's players named in the sentence, in order; a name shared by two of them is skipped.
    const named = namesIn(raw, names.nameIndex)
      .map(({ name, fplIds, index }) => ({ name, index, players: fplIds.filter((id) => inMatch.has(id)).map((id) => inMatch.get(id)) }))
      .filter((n) => n.players.length === 1)
      .map((n) => ({ name: n.name, index: n.index, player: n.players[0] }));
    if (!named.length) continue;
    const mentioned = eventsMentioned(s);
    for (const [pattern, hurts] of [[HURTS_US, true], [HELPS_US, false]]) {
      for (const m of s.matchAll(pattern)) {
        if (hedged(tokens, m.index, 2)) continue;
        if (!hurts && (NOT_HELP_BEFORE.test(s.slice(0, m.index)) || NOT_HELP_AFTER.test(s.slice(m.index + m[0].length)))) continue;
        // The player the phrase is about: the nearest one named before it, or the first after it.
        const tied = named.filter((n) => n.index < m.index).pop() ?? named[0];
        const { player } = tied;
        const has = Object.keys(player.events).filter((e) => player.events[e] > 0 && e in HELPS_OWN_TEAM);
        const events = has.filter((e) => mentioned.has(e)).length ? has.filter((e) => mentioned.has(e)) : has;
        if (!events.length) continue;
        const ours = player.side === 'perspective';
        const goodForUs = (e) => HELPS_OWN_TEAM[e] === ours;
        if (hurts ? !events.every(goodForUs) : events.some(goodForUs)) continue;
        const team = ours ? md.perspective_team : md.opponent;
        const what = events.map((e) => EVENT_WORDS[e]).join(' and ');
        problems.push(`${where}${JSON.stringify(m[0])} ties ${tied.name} to the wrong side: ${tied.name} plays for ${team}, so the ${what} ${hurts ? 'helped' : 'hurt'} ${md.perspective_team}`);
      }
    }
  }
  return problems;
}

// Revision 25's two rules for one line and its note.
function resultAndSideProblems({ text, note }, matchData, names) {
  const problems = [];
  for (const [where, s] of [['', text], ['note ', note ?? '']]) {
    problems.push(...resultWordProblems(s, matchData, where, names), ...playerSideProblems(s, matchData, names, where));
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
  for (const p of playersIn(matchData)) {
    add(p.events.goal);
    add(p.events.saves);
  }
  return allowed;
}

// Everything wrong with one line under the deterministic rules; an empty list means it passes.
// STAT numbers must be in the perspective's allowed set; since Revision 21 (idea 3) HOT_TAKE and
// BANTER may hold no number at all, in the line or in its note (BANTER's line rule is Revision 5's),
// no type may contain a banned term, every player name must pass the name rules, neither the line nor
// its note may say "our" before an opposition player's name, use a banned tail, a position word, or
// (STAT and HOT_TAKE) an other-match word, neither may use a result word that doesn't fit the result
// or tie a player's event to the wrong side (Revision 25), no line may repeat five words in a row from
// the generation prompt, and no note may say "data". `names` comes from nameContext; it's
// required, so the name rules can't be skipped by leaving it out.
function codeGateProblems({ type, text, note }, matchData, names) {
  if (!names?.nameIndex) throw new Error('codeGateProblems needs a name context (nameContext) for the name rules');
  const problems = [];
  const allowed = type === 'STAT' ? allowedNumbers(matchData) : null;
  for (const n of numbersIn(text)) {
    if (type !== 'STAT') problems.push(`${type} line contains a number, ${JSON.stringify(n.token)}; numbers belong in STAT lines`);
    else if (!allowed.has(n.value)) problems.push(`${type} line uses ${JSON.stringify(n.token)} (${n.value}), not in its match data`);
  }
  if (type !== 'STAT') {
    for (const n of numbersIn(note ?? '')) problems.push(`${type} note contains a number, ${JSON.stringify(n.token)}; numbers belong in STAT lines`);
  }
  for (const term of bannedTermsIn(text)) problems.push(`contains banned term ${JSON.stringify(term)}`);
  problems.push(...nameProblems({ type, text }, names));
  problems.push(...teamMixUps(text, names), ...teamMixUps(note ?? '', names).map((p) => `note ${p}`));
  problems.push(...wordingProblems({ type, text, note }));
  problems.push(...resultAndSideProblems({ text, note }, matchData, names));
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
  teamMixUps,
  PROMPT_TAILS,
  EXTRA_TAILS,
  OTHER_MATCH_TERMS,
  POSITION_TERMS,
  promptTailProblems,
  wordingProblems,
  WRONG_RESULT_WORDS,
  resultWordProblems,
  playerSideProblems,
  resultAndSideProblems,
  REUSABLE_PHRASES,
  buildPromptRuns,
  copiedFromPrompt,
  openingWords,
  noteProblems,
  normaliseDashes,
  codeGateProblems,
};

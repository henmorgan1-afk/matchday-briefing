// Keep the best 4-5 (SPEC.md §3.1, Revision 21 idea 5). The model writes 8 lines a side; a line is
// publishable only if it passed every step, and a perspective has at most
// MAX_PUBLISHED_PER_PERSPECTIVE live lines. When more are publishable than there are places left,
// types take turns: HOT_TAKE, STAT, BANTER, then round again, so a side gets at least one STAT and one
// HOT_TAKE where possible. Within a type, the line with the fewest checked claims comes first, then
// the order the model wrote them. With the claim check off (Revision 24, CLAIM_CHECK_ENABLED) no line
// has a count, so the order written decides. Lines already live count towards the turns, so a second
// attempt fills only the places left and keeps the spread.

const TURN_ORDER = Object.freeze(['HOT_TAKE', 'STAT', 'BANTER']);

// `publishable`: [{ type, claims_checked, ... }] in the order the model wrote them; `claims_checked`
// is the line's count of checked claims (claim-check.js), undefined when the claim check is off.
// `places`: how many may still go live. `liveTypes`: the types of the perspective's live lines.
// Returns the chosen lines, in the order they were chosen.
function selectLines(publishable, places, liveTypes = []) {
  if (places <= 0) return [];
  if (publishable.length <= places) return [...publishable];
  const queues = new Map(TURN_ORDER.map((t) => [t, []]));
  publishable.forEach((line, order) => {
    if (!queues.has(line.type)) queues.set(line.type, []);
    queues.get(line.type).push({ line, order });
  });
  for (const q of queues.values()) q.sort((a, b) => (a.line.claims_checked ?? 0) - (b.line.claims_checked ?? 0) || a.order - b.order);
  const taken = new Map([...queues.keys()].map((t) => [t, liveTypes.filter((x) => x === t).length]));
  const typeRank = (t) => (TURN_ORDER.includes(t) ? TURN_ORDER.indexOf(t) : TURN_ORDER.length);

  const chosen = [];
  while (chosen.length < places) {
    // The type with a line left that has had the fewest turns so far, live lines included; ties go
    // in turn order.
    const next = [...queues.keys()]
      .filter((t) => queues.get(t).length)
      .sort((a, b) => taken.get(a) - taken.get(b) || typeRank(a) - typeRank(b))[0];
    if (!next) break;
    chosen.push(queues.get(next).shift().line);
    taken.set(next, taken.get(next) + 1);
  }
  return chosen;
}

module.exports = { selectLines, TURN_ORDER };

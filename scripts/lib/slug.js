// Team slug rule (SPEC.md §2.1). Slugs are assigned once, on first insert, and never changed.

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function baseSlug(shortName) {
  return String(shortName)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// takenSlugs: Map of slug -> team id for every slug already assigned.
function assignSlug(team, takenSlugs) {
  const base = baseSlug(team.short_name);
  const owner = takenSlugs.get(base);
  if (base && (owner === undefined || owner === team.id)) return base;

  const withTla = base ? `${base}-${team.tla.toLowerCase()}` : team.tla.toLowerCase();
  const tlaOwner = takenSlugs.get(withTla);
  if (tlaOwner === undefined || tlaOwner === team.id) return withTla;

  // The spec defines no third fallback; fail loudly rather than invent a slug.
  throw new Error(`Cannot assign a unique slug to team ${team.id} (${team.short_name}): "${base}" and "${withTla}" are both taken`);
}

module.exports = { SLUG_PATTERN, baseSlug, assignSlug };

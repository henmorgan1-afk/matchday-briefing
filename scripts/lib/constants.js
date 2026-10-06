// Shared constants for the pipeline and check scripts (SPEC.md §2.2, §2.3, §3.1, §3.2).

const COMPETITION_CODE = 'PL';

const COMMENT_TYPES = ['STAT', 'BANTER', 'HOT_TAKE'];

// football-data.org API status -> stored matches.status (SPEC.md §2.2).
// Anything not listed here also maps to 'other' and is logged as a warning.
const STATUS_MAP = Object.freeze({
  SCHEDULED: 'scheduled',
  TIMED: 'scheduled',
  IN_PLAY: 'in_play',
  PAUSED: 'in_play',
  EXTRA_TIME: 'in_play',
  PENALTY_SHOOTOUT: 'in_play',
  FINISHED: 'finished',
  POSTPONED: 'postponed',
  CANCELLED: 'cancelled',
  SUSPENDED: 'other',
  AWARDED: 'other',
});

function mapStatus(apiStatus) {
  return Object.prototype.hasOwnProperty.call(STATUS_MAP, apiStatus) ? STATUS_MAP[apiStatus] : 'other';
}

// Per perspective, per match (SPEC.md §3.2).
const TARGET_MIX = Object.freeze({ STAT: 2, BANTER: 3, HOT_TAKE: 3 });

const MIN_PASSING_COUNT = 4;
const MAX_COMMENTS_PER_PERSPECTIVE = 8;
const MAX_GENERATION_ATTEMPTS = 2;

// fetch-matches.js window, relative to today (SPEC.md §1).
const FETCH_DAYS_BACK = 14;
const FETCH_DAYS_AHEAD = 7;

// FPL team mapping (SPEC.md §2.3): FPL short_name -> our tla, for teams whose codes differ.
// Checked only after the three-letter codes; there's no name matching.
const FPL_TEAM_ALIASES = Object.freeze({ NFO: 'NOT' });

// Hours a finished match may wait for FPL's data before it gets team-level lines (SPEC.md §2.3).
// null turns the cap off: a match waits for as long as it takes.
const FPL_WAIT_HOURS = null;

// player_data values that let a finished match be generated (SPEC.md §3.1, the generation gate).
const PLAYER_DATA_READY = Object.freeze(['ok', 'mismatch', 'unavailable']);

module.exports = {
  COMPETITION_CODE,
  COMMENT_TYPES,
  STATUS_MAP,
  mapStatus,
  TARGET_MIX,
  MIN_PASSING_COUNT,
  MAX_COMMENTS_PER_PERSPECTIVE,
  MAX_GENERATION_ATTEMPTS,
  FETCH_DAYS_BACK,
  FETCH_DAYS_AHEAD,
  FPL_TEAM_ALIASES,
  FPL_WAIT_HOURS,
  PLAYER_DATA_READY,
};

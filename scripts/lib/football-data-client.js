// football-data.org v4 API wrapper. Free tier allows 10 requests per minute;
// requests are spaced client-side so a run never exceeds that.

const BASE_URL = 'https://api.football-data.org/v4';
const MAX_REQUESTS_PER_MINUTE = 10;
const WINDOW_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FootballDataClient {
  constructor(apiKey = process.env.FOOTBALL_DATA_API_KEY) {
    if (!apiKey) throw new Error('FOOTBALL_DATA_API_KEY is not set');
    this.apiKey = apiKey;
    this.requestTimes = [];
  }

  async throttle() {
    for (;;) {
      const now = Date.now();
      this.requestTimes = this.requestTimes.filter((t) => now - t < WINDOW_MS);
      if (this.requestTimes.length < MAX_REQUESTS_PER_MINUTE) break;
      await sleep(WINDOW_MS - (now - this.requestTimes[0]) + 50);
    }
    this.requestTimes.push(Date.now());
  }

  async get(path, params = {}, retried = false) {
    await this.throttle();
    const url = new URL(BASE_URL + path);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    const res = await fetch(url, { headers: { 'X-Auth-Token': this.apiKey } });
    if (res.status === 429 && !retried) {
      // The API tells us how many seconds until the minute counter resets.
      const resetSeconds = Number(res.headers.get('x-requestcounter-reset')) || 60;
      console.warn(`football-data.org rate limit hit; waiting ${resetSeconds}s`);
      await sleep(resetSeconds * 1000 + 250);
      return this.get(path, params, true);
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`football-data.org ${res.status} for ${url.pathname}${url.search}: ${body}`);
    }
    return res.json();
  }

  getCompetitionTeams(code) {
    return this.get(`/competitions/${code}/teams`);
  }

  // dateFrom/dateTo are YYYY-MM-DD strings.
  getCompetitionMatches(code, { dateFrom, dateTo } = {}) {
    const params = {};
    if (dateFrom) params.dateFrom = dateFrom;
    if (dateTo) params.dateTo = dateTo;
    return this.get(`/competitions/${code}/matches`, params);
  }
}

// YYYY-MM-DD in UTC, offset by whole days from `from`.
function isoDate(offsetDays = 0, from = new Date()) {
  return new Date(from.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

module.exports = { FootballDataClient, isoDate };

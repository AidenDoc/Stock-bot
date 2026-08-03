// ============================================================
// MARKET CALENDAR — ET clock, NYSE holidays, completed-bar check
// The cron schedules are pinned to America/New_York, but the
// process itself may run in any timezone — every "what day/time
// is it for the market" question must go through here, never
// through the server's local clock.
// ============================================================

// NYSE full-day closures. Observed dates (e.g. July 4 on a weekend
// shifts to the adjacent weekday). Extend before 2029.
const NYSE_HOLIDAYS: Record<string, string> = {
  '2026-01-01': "New Year's Day",
  '2026-01-19': 'MLK Day',
  '2026-02-16': "Presidents' Day",
  '2026-04-03': 'Good Friday',
  '2026-05-25': 'Memorial Day',
  '2026-06-19': 'Juneteenth',
  '2026-07-03': 'Independence Day (observed)',
  '2026-09-07': 'Labor Day',
  '2026-11-26': 'Thanksgiving',
  '2026-12-25': 'Christmas',
  '2027-01-01': "New Year's Day",
  '2027-01-18': 'MLK Day',
  '2027-02-15': "Presidents' Day",
  '2027-03-26': 'Good Friday',
  '2027-05-31': 'Memorial Day',
  '2027-06-18': 'Juneteenth (observed)',
  '2027-07-05': 'Independence Day (observed)',
  '2027-09-06': 'Labor Day',
  '2027-11-25': 'Thanksgiving',
  '2027-12-24': 'Christmas (observed)',
  // 2028 — Jan 1 falls on a Saturday; NYSE does not observe it.
  '2028-01-17': 'MLK Day',
  '2028-02-21': "Presidents' Day",
  '2028-04-14': 'Good Friday',
  '2028-05-29': 'Memorial Day',
  '2028-06-19': 'Juneteenth',
  '2028-07-04': 'Independence Day',
  '2028-09-04': 'Labor Day',
  '2028-11-23': 'Thanksgiving',
  '2028-12-25': 'Christmas',
};

// Current date and minutes-since-midnight in America/New_York.
export function etNow(): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00';
  const hour = get('hour') === '24' ? 0 : parseInt(get('hour'), 10); // some ICU builds emit 24:xx at midnight
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: hour * 60 + parseInt(get('minute'), 10),
  };
}

// Holiday name if the given ET date (default: today) is a full-day
// NYSE closure, else null.
export function nyseHoliday(date?: string): string | null {
  return NYSE_HOLIDAYS[date ?? etNow().date] ?? null;
}

// Next NYSE trading day strictly after the given ET date (YYYY-MM-DD):
// skips weekends and full-day holidays. Used for T+1 settlement dates.
export function nextTradingDay(date: string): string {
  let d = new Date(`${date}T12:00:00Z`); // noon UTC — immune to DST edge cases
  for (let i = 0; i < 10; i++) {         // bounded: never more than a few skips
    d = new Date(d.getTime() + 24 * 60 * 60 * 1000);
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;      // weekend
    if (NYSE_HOLIDAYS[iso]) continue;          // full-day closure
    return iso;
  }
  // Unreachable with a sane calendar; fall back to the raw next day.
  return d.toISOString().slice(0, 10);
}

// The NYSE trading day `n` trading days strictly after `date`
// (YYYY-MM-DD). Used to stamp a V2 position's expiryDate at entry.
export function addTradingDays(date: string, n: number): string {
  let d = date;
  for (let i = 0; i < n; i++) d = nextTradingDay(d);
  return d;
}

// Trading days strictly after `from` up to and including `to`
// (both YYYY-MM-DD). 0 when `to` is on/before `from`. Used for
// "days remaining" displays against a position's expiryDate.
export function tradingDaysBetween(from: string, to: string): number {
  let d = from;
  let n = 0;
  while (n < 400) {              // bounded — horizons are ≤ ~20 days
    d = nextTradingDay(d);
    if (d > to) break;
    n++;
  }
  return n;
}

// Whether a daily bar dated `barDate` (YYYY-MM-DD) is final. Today's
// bar is still forming until the 4:00pm ET close — an intraday scan
// must not feed it into indicators or volume ratios. Half-days close
// at 1:00pm; treating their bar as in-progress until 4:00pm only
// delays inclusion, never admits a partial bar.
export function isBarComplete(barDate: string): boolean {
  const { date, minutes } = etNow();
  if (barDate < date) return true;
  if (barDate > date) return false; // clock skew / bad data — never trust a future bar
  return minutes >= 16 * 60;
}

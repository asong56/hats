// accent.js — a soft accent gradient that drifts with the local time of
// day, standing in for actual sunlight without needing geolocation.
//
// Model (deliberately simple, no astronomy library):
//   - Treat 24h as a hue/lightness cycle.
//   - Deep night (00:00–05:00): cool, dim, low-saturation blues/violets.
//   - Dawn (05:00–08:00): warm pink/orange rising.
//   - Day (08:00–17:00): warm gold to sky blue, brightest at noon.
//   - Dusk (17:00–20:00): orange/red fading down.
//   - Night (20:00–24:00): cooling back toward blues/violets.
//
// The gradient is deliberately WEAK (moderate saturation, mid lightness) so
// it reads as a subtle accent, not a loud theme — it colors the "primary
// action" affordances (favorite-active, submit buttons), nothing else.

function hsl(h, s, l) {
  return `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`;
}

/**
 * Returns { color1, color2 } for the given fractional hour (0–24).
 */
export function accentForHour(hourFraction) {
  const h = ((hourFraction % 24) + 24) % 24;

  // A smooth day/night curve: 1 at solar noon (12:00), 0 at midnight.
  const daylight = (Math.cos(((h - 12) / 24) * 2 * Math.PI) + 1) / 2;

  // Hue drifts from cool (~250, indigo) at night to warm (~30, amber) at
  // midday, then back. We interpolate hue by daylight amount.
  const nightHue = 250; // indigo
  const dayHue = 32; // warm amber
  const hue1 = nightHue + (dayHue - nightHue) * daylight;

  // Second color trails behind the first by roughly a "quarter day" in hue
  // terms, giving the two-stop gradient some internal contrast (e.g. warm
  // amber -> sky blue at midday; indigo -> violet at night).
  const hue2 = (hue1 + 70) % 360;

  // Keep saturation moderate and lightness mid-range so it stays a *weak*
  // accent rather than a loud banner; slightly brighter at midday.
  const saturation = 45 + daylight * 15; // 45–60%
  const lightness1 = 55 + daylight * 8; // 55–63%
  const lightness2 = 60 + daylight * 10; // 60–70%

  return {
    color1: hsl(hue1, saturation, lightness1),
    color2: hsl(hue2, saturation, lightness2),
  };
}

let timerId = null;

export function startAccentClock() {
  const apply = () => {
    const now = new Date();
    const hourFraction = now.getHours() + now.getMinutes() / 60;
    const { color1, color2 } = accentForHour(hourFraction);
    document.documentElement.style.setProperty("--accent-1", color1);
    document.documentElement.style.setProperty("--accent-2", color2);
  };

  apply();
  if (timerId) clearInterval(timerId);
  // Every minute is plenty granular for something meant to feel ambient,
  // not to be watched like a clock.
  timerId = setInterval(apply, 60 * 1000);
}

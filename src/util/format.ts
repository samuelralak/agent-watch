// Durations, counts and clock times as short text.

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);

  if (h) {
    return `${h}h ${m}m ${s % 60}s`;
  }

  if (m) {
    return `${m}m ${s % 60}s`;
  }

  return `${s}s`;
}

/** One unit of precision: 45s, 12m, 3h 5m. */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));

  if (s < 60) {
    return `${s}s`;
  }

  if (s < 3600) {
    return `${Math.floor(s / 60)}m`;
  }

  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** A count with its thousands set apart: 4,312. */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

export function formatTokens(n: number): string {
  if (!n) {
    return '0';
  }

  if (n < 1000) {
    return String(n);
  }

  if (n < 1e6) {
    return `${(n / 1000).toFixed(1)}k`;
  }

  return `${(n / 1e6).toFixed(2)}M`;
}

export function clock(at: number): string {
  return new Date(at).toTimeString().slice(0, 8);
}

const BARS = '▁▂▃▄▅▆▇█';

/** One bar per value, scaled to the largest; zero is a gap. */
export function sparkline(series: readonly number[]): string {
  const max = Math.max(1, ...series);

  return series.map((n) => (n ? BARS[Math.min(7, Math.ceil((n / max) * 8) - 1)] : ' ')).join('');
}

import type { Analysis } from './types.js';

/** Single-position quarter Kelly avoids treating correlated contracts as independent. */
export function recommend(
  analysis: Analysis,
  budget: number,
  expenseRate: number,
  safety: number,
  now = Date.now(),
) {
  if (!Number.isFinite(expenseRate) || expenseRate < 0 || !Number.isFinite(safety) || safety < 0)
    return null;
  if (!Number.isFinite(budget) || budget <= 0 || !analysis.event || !analysis.fresh) return null;
  let best: {
    label: string;
    side: string;
    total: number;
    expectedProfit: number;
    score: number;
  } | null = null;
  for (const position of analysis.positions) {
    if (!position.signal) continue;
    if (
      analysis.dataset !== 'demo' &&
      (!position.book_fetched_at ||
        !Number.isFinite(Date.parse(position.book_fetched_at)) ||
        Math.abs(now - Date.parse(position.book_fetched_at)) > 120000)
    )
      continue;
    const market = analysis.event.markets.find((m) => m.id === position.market_id);
    if (!market?.active) continue;
    const asks = [...(market.books[position.side === 'YES' ? 'yes' : 'no']?.asks ?? [])]
      .filter((l) => l.price > 0 && l.price < 1 && l.size > 0 && Number.isFinite(l.size))
      .sort((a, b) => a.price - b.price);
    const price = asks[0]?.price;
    if (!price) continue;
    const q = Math.max(0, position.probability - safety);
    const costPerShare = price * (1 + expenseRate);
    if (costPerShare >= 1 || q <= costPerShare) continue;
    const fraction = Math.min(0.25, (0.25 * (q - costPerShare)) / (1 - costPerShare));
    let remaining = budget * fraction,
      total = 0,
      shares = 0;
    for (const level of asks) {
      const unit = level.price * (1 + expenseRate);
      if (unit >= q) break;
      const quantity = Math.min(level.size, remaining / unit);
      shares += quantity;
      total += quantity * unit;
      remaining -= quantity * unit;
      if (remaining < 1e-9) break;
    }
    if (total < 0.01) continue;
    const score =
      q * Math.log((budget - total + shares) / budget) +
      (1 - q) * Math.log((budget - total) / budget);
    if (score > 0 && (!best || score > best.score))
      best = {
        label: position.label,
        side: position.side,
        total,
        expectedProfit: position.probability * shares - total,
        score,
      };
  }
  return best;
}

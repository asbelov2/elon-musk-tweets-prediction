import type { Fill, Level, MarketEvent, Position, Side } from '../shared/types.js';
import { parseTime } from './time.js';

export function fillOrder(asks: Level[], budget: number, expenseRate: number): Fill {
  let remaining = budget / (1 + expenseRate),
    shares = 0,
    cost = 0;
  for (const { price, size } of [...asks].sort((a, b) => a.price - b.price)) {
    if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || price >= 1 || size <= 0)
      continue;
    const quantity = Math.min(size, remaining / price),
      spent = quantity * price;
    shares += quantity;
    cost += spent;
    remaining -= spent;
    if (remaining < 1e-9) break;
  }
  const total = cost * (1 + expenseRate);
  return {
    shares,
    cost,
    expenses: cost * expenseRate,
    total,
    vwap: shares ? cost / shares : null,
    filled_fraction: budget ? total / budget : 0,
  };
}

export function evaluate(
  draws: Float64Array,
  event: MarketEvent,
  budget: number,
  expenseBps: number,
  safetyPp: number,
  eligible = true,
  now = Date.now(),
): Position[] {
  const rows: Position[] = [];
  for (const market of event.markets) {
    let hits = 0;
    for (const d of draws)
      if (d >= market.lower && (market.upper === null || d <= market.upper)) hits++;
    const probability = hits / draws.length;
    for (const side of ['yes', 'no'] as Side[]) {
      const p = side === 'yes' ? probability : 1 - probability,
        book = market.books[side],
        fill = fillOrder(book?.asks ?? [], budget, expenseBps / 10000);
      const reasons: string[] = [];
      if (!eligible) reasons.push('Не подтверждены правила или свежесть истории');
      if (!market.active) reasons.push('Рынок не принимает ордера');
      if (!book?.fetched_at || Math.abs(now - parseTime(book.fetched_at)) > 120_000)
        reasons.push('Стакан старше 120 секунд или недоступен');
      if (!fill.shares) reasons.push('Нет предложений продажи');
      if (fill.filled_fraction < 0.95) reasons.push('Глубины стакана не хватает на 95% бюджета');
      const cost = fill.total,
        payout = p * fill.shares,
        conservativeProfit = Math.max(0, p - safetyPp / 100) * fill.shares - cost;
      rows.push({
        market_id: market.id,
        label: market.label,
        side: side === 'yes' ? 'YES' : 'NO',
        probability: p,
        book_fetched_at: book?.fetched_at ?? null,
        mc_standard_error: Math.sqrt((p * (1 - p)) / draws.length),
        token_id: market.tokens[side] ?? null,
        ...fill,
        expected_profit: cost ? payout - cost : null,
        roi: cost ? payout / cost - 1 : null,
        conservative_profit: cost ? conservativeProfit : null,
        edge: fill.shares ? p - cost / fill.shares : null,
        signal: !reasons.length && conservativeProfit > 0,
        reasons,
        fees_enabled: market.fees_enabled,
      });
    }
  }
  return rows.sort(
    (a, b) => Number(b.signal) - Number(a.signal) || (b.roi ?? -1e10) - (a.roi ?? -1e10),
  );
}

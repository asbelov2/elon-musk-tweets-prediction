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

export interface BankAllocation {
  rows: {
    marketId: string;
    label: string;
    side: 'YES' | 'NO';
    total: number;
    shares: number;
    expectedProfit: number;
  }[];
  invested: number;
  cash: number;
  expectedProfit: number;
  worstProfit: number;
  lossProbability: number;
  warnings: string[];
}

/**
 * Conditional full-bank scenario, separate from the cash/Kelly recommendation.
 * Greedily improves E[payout / bank] - Var[payout / bank] in ~0.5% steps.
 * All contracts share the same mutually exclusive resolution scenarios. This is
 * a bounded heuristic, not a globally optimal portfolio or an execution engine.
 */
export function allocateBank(
  analysis: Analysis,
  budget: number,
  expenseRate: number,
  now = Date.now(),
): BankAllocation {
  const plan: BankAllocation = {
    rows: [],
    invested: 0,
    cash: Number.isFinite(budget) ? Math.max(0, budget) : 0,
    expectedProfit: 0,
    worstProfit: 0,
    lossProbability: 0,
    warnings: [],
  };
  if (
    !Number.isFinite(budget) ||
    budget < 0.01 ||
    budget > 1_000_000 ||
    !Number.isFinite(expenseRate) ||
    expenseRate < 0 ||
    expenseRate > 0.5
  )
    return plan;
  const markets = [...(analysis.event?.markets ?? [])].sort((a, b) => a.lower - b.lower);
  if (!markets.length) {
    plan.warnings.push('Для распределения банка выберите рынок с котировками.');
    return plan;
  }
  const probabilities: number[] = [];
  let previousEnd = -1,
    hasGap = false;
  for (const market of markets) {
    const p = analysis.positions.find(
      (row) => row.market_id === market.id && row.side === 'YES',
    )?.probability;
    if (
      !Number.isInteger(market.lower) ||
      market.lower < 0 ||
      (market.upper !== null && (!Number.isInteger(market.upper) || market.upper < market.lower)) ||
      market.lower <= previousEnd ||
      p === undefined ||
      !Number.isFinite(p) ||
      p < 0 ||
      p > 1
    ) {
      plan.warnings.push(
        'Не удалось построить совместные исходы: проверьте диапазоны и вероятности рынка.',
      );
      return plan;
    }
    if (market.lower > previousEnd + 1) hasGap = true;
    previousEnd = market.upper ?? Infinity;
    probabilities.push(p);
  }
  const mass = probabilities.reduce((sum, p) => sum + p, 0);
  if (mass > 1 + 1e-9 || (!hasGap && previousEnd === Infinity && Math.abs(mass - 1) > 1e-9)) {
    plan.warnings.push('Вероятности исходов не согласованы: обновите прогноз.');
    return plan;
  }
  // Unlisted ranges are a shared scenario: all listed YES lose and all NO win.
  if (hasGap || previousEnd !== Infinity) probabilities.push(Math.max(0, 1 - mass));
  const norm = probabilities.reduce((sum, p) => sum + p, 0);
  if (norm <= 0) return plan;
  for (let i = 0; i < probabilities.length; i++) probabilities[i] /= norm;
  if (!analysis.fresh)
    plan.warnings.push(
      'История или источник не прошли проверку свежести. План показан только как условный расчёт.',
    );
  const candidates = markets.flatMap((market, index) => {
    if (!market.active) return [];
    return (['YES', 'NO'] as const).flatMap((side) => {
      const book = market.books[side === 'YES' ? 'yes' : 'no'];
      const levels = (book?.asks ?? [])
        .filter(
          (level) =>
            Number.isFinite(level.price) &&
            level.price > 0 &&
            level.price < 1 &&
            Number.isFinite(level.size) &&
            level.size > 0,
        )
        .map((level) => ({ unit: level.price * (1 + expenseRate), size: level.size }))
        .sort((a, b) => a.unit - b.unit);
      if (!levels.length) return [];
      return [
        {
          market,
          index,
          side,
          levels,
          cursor: 0,
          cents: 0,
          shares: 0,
          probability: side === 'YES' ? probabilities[index] : 1 - probabilities[index],
          stale:
            analysis.dataset !== 'demo' &&
            (!book?.fetched_at ||
              !Number.isFinite(Date.parse(book.fetched_at)) ||
              Math.abs(now - Date.parse(book.fetched_at)) > 120000),
        },
      ];
    });
  });
  const bankCents = Math.floor(budget * 100 + 1e-6);
  const stepCents = Math.max(1, Math.floor(bankCents / 200));
  let remaining = bankCents;
  const payouts = probabilities.map(() => 0);
  for (let iteration = 0; remaining > 0 && iteration < 2000; iteration++) {
    const mean = payouts.reduce((sum, value, i) => sum + value * probabilities[i], 0) / budget;
    let best: { candidate: (typeof candidates)[number]; cents: number; score: number } | undefined;
    for (const candidate of candidates) {
      while (
        candidate.cursor < candidate.levels.length &&
        Math.floor(
          candidate.levels[candidate.cursor].size * candidate.levels[candidate.cursor].unit * 100 +
            1e-7,
        ) < 1
      )
        candidate.cursor++;
      const level = candidate.levels[candidate.cursor];
      if (!level) continue;
      const cents = Math.min(
        stepCents,
        remaining,
        Math.floor(level.size * level.unit * 100 + 1e-7),
      );
      const p = candidate.probability;
      const expected = p / level.unit;
      const yesMoment = (probabilities[candidate.index] * payouts[candidate.index]) / budget;
      const covariance =
        (candidate.side === 'YES' ? yesMoment : mean - yesMoment) / level.unit - mean * expected;
      const variance = (p * (1 - p)) / level.unit ** 2;
      const score = expected - 2 * covariance - (cents / 100 / budget) * variance;
      if (!best || score > best.score) best = { candidate, cents, score };
    }
    if (!best) break;
    const { candidate, cents } = best;
    const level = candidate.levels[candidate.cursor];
    const shares = cents / 100 / level.unit;
    level.size = Math.max(0, level.size - shares);
    candidate.cents += cents;
    candidate.shares += shares;
    remaining -= cents;
    for (let i = 0; i < payouts.length; i++)
      if (candidate.side === 'YES' ? i === candidate.index : i !== candidate.index)
        payouts[i] += shares;
  }
  for (const candidate of candidates) {
    if (!candidate.cents) continue;
    plan.rows.push({
      marketId: candidate.market.id,
      label: candidate.market.label,
      side: candidate.side,
      total: candidate.cents / 100,
      shares: candidate.shares,
      expectedProfit: candidate.probability * candidate.shares - candidate.cents / 100,
    });
  }
  plan.rows.sort((a, b) => b.total - a.total);
  plan.invested = (bankCents - remaining) / 100;
  plan.cash = Math.max(0, budget - plan.invested);
  plan.expectedProfit =
    payouts.reduce((sum, value, i) => sum + value * probabilities[i], 0) - plan.invested;
  plan.worstProfit = Math.min(...payouts) - plan.invested;
  plan.lossProbability = payouts.reduce(
    (sum, value, i) => sum + (value < plan.invested - 1e-8 ? probabilities[i] : 0),
    0,
  );
  if (candidates.some((candidate) => candidate.cents && candidate.stale))
    plan.warnings.push(
      'Использованы котировки старше 120 секунд или без времени снимка. Обновите рынок перед покупкой.',
    );
  if (remaining > 0)
    plan.warnings.push(
      plan.rows.length
        ? 'Часть банка осталась в деньгах: ограничение глубины стакана, округления или лимита расчёта.'
        : 'Нет доступных предложений продажи на открытых рынках. Банк остаётся в деньгах.',
    );
  return plan;
}

/**
 * Debt Simplification Algorithm (Greedy Minimum-Transactions approach)
 *
 * Given a list of individual debts (who owes whom, how much),
 * computes the smallest possible set of transfers that settles all balances.
 *
 * Example:
 *   Input:  A owes B $10, B owes C $10
 *   Output: A owes C $10  (B is cut out — saves one transaction)
 */

export interface Debt {
  from: string; // uniqueId of the payer
  to: string;   // uniqueId of the payee
  amount: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function simplifyDebts(debts: Debt[]): Debt[] {
  // Build net balance for each person
  // Positive balance  → person is owed money (creditor)
  // Negative balance  → person owes money (debtor)
  const balance = new Map<string, number>();

  for (const debt of debts) {
    if (!debt.from || !debt.to || debt.amount <= 0) continue;
    if (debt.from === debt.to) continue; // self-debt is meaningless
    balance.set(debt.from, round2((balance.get(debt.from) ?? 0) - debt.amount));
    balance.set(debt.to,   round2((balance.get(debt.to)   ?? 0) + debt.amount));
  }

  // Separate into creditors (positive) and debtors (negative)
  const creditors: Array<{ id: string; amount: number }> = [];
  const debtors:   Array<{ id: string; amount: number }> = [];

  for (const [id, bal] of balance.entries()) {
    if (bal > 0.01)  creditors.push({ id, amount: bal });
    else if (bal < -0.01) debtors.push({ id, amount: -bal });
  }

  // Sort descending so we always settle the largest debt first
  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort((a, b)   => b.amount - a.amount);

  const result: Debt[] = [];
  let ci = 0, di = 0;

  while (ci < creditors.length && di < debtors.length) {
    const creditor = creditors[ci]!;
    const debtor   = debtors[di]!;
    const amount   = round2(Math.min(creditor.amount, debtor.amount));

    if (amount > 0.01) {
      result.push({ from: debtor.id, to: creditor.id, amount });
    }

    creditor.amount = round2(creditor.amount - amount);
    debtor.amount   = round2(debtor.amount   - amount);

    if (creditor.amount < 0.01) ci++;
    if (debtor.amount   < 0.01) di++;
  }

  return result;
}

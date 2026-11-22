// ─── Finora AI Hub — Financial Context Builder ─────────────────
//
// Reads the verified user's real financial data from Supabase (server-side,
// scoped by user ID from auth.getUser()) and runs the existing Financial
// Engine to produce the context handed to the AI.
//
// CORE RULE: data that has not been provided is NEVER represented as zero.
// Unavailable sources are flagged with available: false and rendered as
// "not_provided" — the AI is instructed to ask questions instead of
// concluding. Rp 0 appears only when a value was actually recorded as zero.
//
// Reuses the existing, pure calculation engines:
//   - financialCalculations.ts (assessment metrics)
//   - goalCalculations.ts (goal progress and required contributions)

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { calculateAllMetrics } from "./financialCalculations.ts";
import { calculateGoalMetrics } from "./goalCalculations.ts";
import type {
  FinancialContext,
  TransactionsContext,
  BudgetsContext,
  DebtsContext,
  GoalsContext,
  DataSufficiency,
} from "./types.ts";

interface AssessmentRow {
  monthly_income: number | string;
  essential_expenses: number | string;
  non_essential_expenses: number | string;
  debt_balances: number | string;
  monthly_installments: number | string;
  savings: number | string;
  financial_dependents: number | string;
  emergency_fund: number | string;
  created_at: string;
}

interface TransactionRow {
  type: string;
  category: string;
  amount: number | string;
  transaction_date: string;
}

interface BudgetRow {
  category: string;
  limit_amount: number | string;
}

interface DebtRow {
  name: string;
  principal: number | string;
  interest_rate: number | string;
  monthly_installment: number | string;
  is_paid_off: boolean;
}

interface GoalRow {
  name: string;
  category: string;
  target_amount: number | string;
  current_savings: number | string;
  deadline: string;
  is_achieved: boolean;
}

function num(v: number | string): number {
  return Number(v);
}

function monthKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Categories the app treats as needs. Everything else (except "Cicilan",
// which is debt-related and covered by the debts source) is discretionary.
const ESSENTIAL_CATEGORIES = new Set([
  "Makanan",
  "Tagihan",
  "Transportasi",
  "Kesehatan",
  "Pendidikan",
  "Komunikasi",
]);

export async function buildFinancialContext(
  adminClient: SupabaseClient,
  userId: string
): Promise<FinancialContext> {
  const now = new Date();
  const currentMonthKey = monthKeyOf(now);

  const [assessmentRes, txRes, budgetRes, debtRes, goalRes] = await Promise.all([
    adminClient
      .from("financial_assessments")
      .select(
        "monthly_income, essential_expenses, non_essential_expenses, debt_balances, monthly_installments, savings, financial_dependents, emergency_fund, created_at"
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1),
    adminClient
      .from("transactions")
      .select("type, category, amount, transaction_date")
      .eq("user_id", userId)
      .gte("transaction_date", `${currentMonthKey}-01`)
      .order("transaction_date", { ascending: false })
      .limit(500),
    adminClient
      .from("budgets")
      .select("category, limit_amount")
      .eq("user_id", userId)
      .eq("month", currentMonthKey),
    adminClient
      .from("debts")
      .select("name, principal, interest_rate, monthly_installment, is_paid_off")
      .eq("user_id", userId),
    adminClient
      .from("goals")
      .select("name, category, target_amount, current_savings, deadline, is_achieved")
      .eq("user_id", userId),
  ]);

  if (assessmentRes.error) throw new Error(assessmentRes.error.message);
  if (txRes.error) throw new Error(txRes.error.message);
  if (budgetRes.error) throw new Error(budgetRes.error.message);
  if (debtRes.error) throw new Error(debtRes.error.message);
  if (goalRes.error) throw new Error(goalRes.error.message);

  // ─── Assessment: engine metrics computed from the latest recorded input ───
  const assessmentRow = (assessmentRes.data ?? [])[0] as AssessmentRow | undefined;
  const assessment = assessmentRow
    ? (() => {
        const input = {
          monthlyIncome: num(assessmentRow.monthly_income),
          essentialExpenses: num(assessmentRow.essential_expenses),
          nonEssentialExpenses: num(assessmentRow.non_essential_expenses),
          debtBalances: num(assessmentRow.debt_balances),
          monthlyInstallments: num(assessmentRow.monthly_installments),
          savings: num(assessmentRow.savings),
          financialDependents: num(assessmentRow.financial_dependents),
          emergencyFund: num(assessmentRow.emergency_fund),
        };
        return {
          available: true,
          capturedAt: assessmentRow.created_at,
          input,
          metrics: calculateAllMetrics(input),
        };
      })()
    : { available: false, capturedAt: null, input: null, metrics: null };

  // ─── Transactions: recorded facts for the current month ────
  const txRows = (txRes.data ?? []) as TransactionRow[];
  let income = 0;
  let expenses = 0;
  const byCategory = new Map<string, number>();
  for (const tx of txRows) {
    const amount = num(tx.amount);
    if (tx.type === "income") {
      income += amount;
      continue;
    }
    expenses += amount;
    byCategory.set(tx.category, (byCategory.get(tx.category) ?? 0) + amount);
  }
  const transactions: TransactionsContext = {
    available: txRows.length > 0,
    monthKey: currentMonthKey,
    transactionCount: txRows.length,
    income,
    expenses,
    cashFlow: income - expenses,
    topExpenseCategories: Array.from(byCategory.entries())
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5),
  };

  // ─── Budgets: recorded limits for the current month ────────
  const budgetItems = ((budgetRes.data ?? []) as BudgetRow[]).map((b) => {
    const limitAmount = num(b.limit_amount);
    const spent = byCategory.get(b.category) ?? 0;
    return {
      category: b.category,
      limitAmount,
      spent,
      percentage: limitAmount > 0 ? Math.round((spent / limitAmount) * 100) : 0,
    };
  });
  const budgets: BudgetsContext = {
    available: budgetItems.length > 0,
    monthKey: currentMonthKey,
    items: budgetItems.sort((a, b) => b.percentage - a.percentage),
  };

  // ─── Debts: current state ──────────────────────────────────
  const debtRows = (debtRes.data ?? []) as DebtRow[];
  const activeDebts = debtRows.filter((d) => !d.is_paid_off);
  const debts: DebtsContext = {
    available: debtRows.length > 0,
    activeCount: activeDebts.length,
    paidOffCount: debtRows.length - activeDebts.length,
    totalPrincipal: activeDebts.reduce((s, d) => s + num(d.principal), 0),
    monthlyInstallments: activeDebts.reduce((s, d) => s + num(d.monthly_installment), 0),
    items: activeDebts.map((d) => ({
      name: d.name,
      principal: num(d.principal),
      interestRate: num(d.interest_rate),
      monthlyInstallment: num(d.monthly_installment),
    })),
  };

  // ─── Goals: engine metrics per goal ────────────────────────
  const goalRows = (goalRes.data ?? []) as GoalRow[];
  const goalItems = goalRows.map((g) => {
    const metrics = calculateGoalMetrics(
      {
        id: g.name,
        target_amount: num(g.target_amount),
        current_savings: num(g.current_savings),
        deadline: g.deadline,
        is_achieved: g.is_achieved,
      },
      now
    );
    return {
      name: g.name,
      category: g.category,
      targetAmount: num(g.target_amount),
      currentSavings: num(g.current_savings),
      progressPercentage: metrics.progressPercentage,
      deadline: g.deadline,
      isOverdue: metrics.isOverdue,
      requiredMonthlyContribution: metrics.requiredMonthlyContribution,
    };
  });
  const goals: GoalsContext = {
    available: goalItems.length > 0,
    totalCount: goalItems.length,
    achievedCount: goalItems.filter((g) => g.currentSavings >= g.targetAmount).length,
    totalTarget: goalItems.reduce((s, g) => s + g.targetAmount, 0),
    totalSaved: goalItems.reduce((s, g) => s + g.currentSavings, 0),
    items: goalItems,
  };

  const sufficiency: DataSufficiency =
    assessment.available || transactions.available
      ? "sufficient"
      : debts.available || goals.available || budgets.available
        ? "partial"
        : "insufficient";

  return { assessment, transactions, budgets, debts, goals, sufficiency };
}

// ─── Rendering: context → Indonesian text block for the AI ────

const NOT_PROVIDED = "BELUM TERSEDIO (not_provided)";

function rp(value: number): string {
  return `Rp ${value.toLocaleString("id-ID")}`;
}

export function formatFinancialContext(ctx: FinancialContext): string {
  const lines: string[] = [];

  lines.push("DATA KEUANGAN PENGGUNA (dibaca langsung dari database Finora, terverifikasi):");
  lines.push(`Kelengkapan data: ${ctx.sufficiency.toUpperCase()}`);
  lines.push("");

  lines.push("1) ASSESMEN KEUANGAN:");
  if (ctx.assessment.available && ctx.assessment.input && ctx.assessment.metrics) {
    const i = ctx.assessment.input;
    const m = ctx.assessment.metrics;
    lines.push(`   Terakhir diisi: ${ctx.assessment.capturedAt?.slice(0, 10) ?? "tidak diketahui"}`);
    lines.push(`   - Pendapatan bulanan (tercatat): ${rp(i.monthlyIncome)}`);
    lines.push(`   - Pengeluaran wajib (tercatat): ${rp(i.essentialExpenses)}`);
    lines.push(`   - Pengeluaran non-wajib (tercatat): ${rp(i.nonEssentialExpenses)}`);
    lines.push(`   - Saldo utang (tercatat): ${rp(i.debtBalances)}`);
    lines.push(`   - Cicilan bulanan (tercatat): ${rp(i.monthlyInstallments)}`);
    lines.push(`   - Total tabungan (tercatat): ${rp(i.savings)}`);
    lines.push(`   - Tanggungan (tercatat): ${i.financialDependents} orang`);
    lines.push(`   - Dana darurat (tercatat): ${rp(i.emergencyFund)}`);
    lines.push("   Hasil Financial Engine (JANGAN hitung ulang):");
    lines.push(`   - Arus kas bersih: ${rp(m.netCashFlow.value)} — ${m.netCashFlow.interpretation}`);
    lines.push(`   - ${m.savingsRatio.label}: ${m.savingsRatio.value}% — ${m.savingsRatio.interpretation}`);
    lines.push(`   - ${m.debtToIncomeRatio.label}: ${m.debtToIncomeRatio.value}% — ${m.debtToIncomeRatio.interpretation}`);
    lines.push(`   - ${m.essentialExpenseRatio.label}: ${m.essentialExpenseRatio.value}% — ${m.essentialExpenseRatio.interpretation}`);
    lines.push(`   - ${m.nonEssentialExpenseRatio.label}: ${m.nonEssentialExpenseRatio.value}% — ${m.nonEssentialExpenseRatio.interpretation}`);
    lines.push(`   - ${m.totalExpenseRatio.label}: ${m.totalExpenseRatio.value}% — ${m.totalExpenseRatio.interpretation}`);
    lines.push(`   - ${m.emergencyFundCoverage.label}: ${m.emergencyFundCoverage.value} bulan — ${m.emergencyFundCoverage.interpretation}`);
  } else {
    lines.push(`   ${NOT_PROVIDED} — pengguna belum mengisi asesmen keuangan.`);
    lines.push("   JANGAN menganggap pendapatan/pengeluaran/utang/tabungan bernilai 0.");
  }
  lines.push("");

  lines.push(`2) TRANSAKSI (${ctx.transactions.monthKey}):`);
  if (ctx.transactions.available) {
    lines.push(`   - Jumlah transaksi tercatat: ${ctx.transactions.transactionCount}`);
    lines.push(`   - Pemasukan tercatat: ${rp(ctx.transactions.income)}`);
    lines.push(`   - Pengeluaran tercatat: ${rp(ctx.transactions.expenses)}`);
    lines.push(`   - Arus kas bulan ini (tercatat): ${rp(ctx.transactions.cashFlow)}`);
    if (ctx.transactions.topExpenseCategories.length > 0) {
      lines.push("   - Kategori pengeluaran terbesar:");
      for (const c of ctx.transactions.topExpenseCategories) {
        lines.push(`     - ${c.category}: ${rp(c.amount)}`);
      }
    }
  } else {
    lines.push(`   ${NOT_PROVIDED} — belum ada transaksi tercatat pada periode ini.`);
  }
  lines.push("");

  lines.push(`3) ANGGARAN (${ctx.budgets.monthKey}):`);
  if (ctx.budgets.available) {
    for (const b of ctx.budgets.items) {
      lines.push(`   - ${b.category}: terpakai ${rp(b.spent)} dari batas ${rp(b.limitAmount)} (${b.percentage}%)`);
    }
  } else {
    lines.push(`   ${NOT_PROVIDED} — pengguna belum menetapkan anggaran.`);
  }
  lines.push("");

  lines.push("4) UTANG:");
  if (ctx.debts.available) {
    lines.push(`   - Utang aktif: ${ctx.debts.activeCount} (lunas: ${ctx.debts.paidOffCount})`);
    lines.push(`   - Total pokok utang aktif (tercatat): ${rp(ctx.debts.totalPrincipal)}`);
    lines.push(`   - Total cicilan bulanan (tercatat): ${rp(ctx.debts.monthlyInstallments)}`);
    for (const d of ctx.debts.items) {
      lines.push(`   - ${d.name}: pokok ${rp(d.principal)}, bunga ${d.interestRate}%/tahun, cicilan ${rp(d.monthlyInstallment)}/bulan`);
    }
  } else {
    lines.push(`   ${NOT_PROVIDED} — tidak ada catatan utang (belum diisi, bukan berarti bebas utang).`);
  }
  lines.push("");

  lines.push("5) TUJUAN KEUANGAN:");
  if (ctx.goals.available) {
    lines.push(`   - Total tujuan: ${ctx.goals.totalCount} (tercapai: ${ctx.goals.achievedCount})`);
    lines.push(`   - Total target: ${rp(ctx.goals.totalTarget)}, tersimpan: ${rp(ctx.goals.totalSaved)}`);
    for (const g of ctx.goals.items) {
      const contrib =
        g.requiredMonthlyContribution === null
          ? "tenggat terlewat"
          : `${rp(g.requiredMonthlyContribution)}/bulan`;
      lines.push(
        `   - ${g.name} (${g.category}): ${g.progressPercentage}% tercapai, tenggat ${g.deadline}${g.isOverdue ? " (TERLEWAT)" : ""}, perlu setoran ${contrib}`
      );
    }
  } else {
    lines.push(`   ${NOT_PROVIDED} — pengguna belum membuat tujuan keuangan.`);
  }
  lines.push("");

  return lines.join("\n");
}

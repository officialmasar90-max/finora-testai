// ─── Finora AI Hub — Financial Context Types ───────────────────
//
// Shapes for the user financial context that the backend reads directly from
// Supabase and hands to the AI. Core rule: data that is not yet available is
// NEVER represented as zero — it is marked not_provided / insufficient_data.

import type { AssessmentMetrics } from "./financialCalculations.ts";

export type DataSufficiency = "sufficient" | "partial" | "insufficient";

export interface AssessmentContext {
  /** True when the user has completed at least one financial assessment. */
  available: boolean;
  capturedAt: string | null;
  /** Raw inputs the user entered (recorded values; null when no assessment). */
  input: {
    monthlyIncome: number;
    essentialExpenses: number;
    nonEssentialExpenses: number;
    debtBalances: number;
    monthlyInstallments: number;
    savings: number;
    financialDependents: number;
    emergencyFund: number;
  } | null;
  /** Metrics produced by the existing Financial Engine (stored or recomputed). */
  metrics: AssessmentMetrics | null;
}

export interface CategoryTotal {
  category: string;
  amount: number;
}

export interface TransactionsContext {
  /** True when the user has any transaction in the analysis window. */
  available: boolean;
  monthKey: string;
  transactionCount: number;
  income: number;
  expenses: number;
  cashFlow: number;
  topExpenseCategories: CategoryTotal[];
}

export interface BudgetContextItem {
  category: string;
  limitAmount: number;
  spent: number;
  percentage: number;
}

export interface BudgetsContext {
  /** True when the user has set at least one budget. */
  available: boolean;
  monthKey: string;
  items: BudgetContextItem[];
}

export interface DebtContextItem {
  name: string;
  principal: number;
  interestRate: number;
  monthlyInstallment: number;
}

export interface DebtsContext {
  /** True when the user has any debt record (active or paid off). */
  available: boolean;
  activeCount: number;
  paidOffCount: number;
  totalPrincipal: number;
  monthlyInstallments: number;
  items: DebtContextItem[];
}

export interface GoalContextItem {
  name: string;
  category: string;
  targetAmount: number;
  currentSavings: number;
  progressPercentage: number;
  deadline: string;
  isOverdue: boolean;
  requiredMonthlyContribution: number | null;
}

export interface GoalsContext {
  /** True when the user has at least one goal. */
  available: boolean;
  totalCount: number;
  achievedCount: number;
  totalTarget: number;
  totalSaved: number;
  items: GoalContextItem[];
}

export interface FinancialContext {
  assessment: AssessmentContext;
  transactions: TransactionsContext;
  budgets: BudgetsContext;
  debts: DebtsContext;
  goals: GoalsContext;
  /**
   * sufficient: assessment exists or there is recent transaction data.
   * partial: some data exists but not enough for a full health conclusion.
   * insufficient: nothing recorded — AI must ask questions, not conclude.
   */
  sufficiency: DataSufficiency;
}

-- ======================================================
-- Migration 001: Add Margin, Short Selling, Commissions, Interest Rates
-- ======================================================

-- === ROOMS: Add new configurable parameters ===
ALTER TABLE public.rooms
  ADD COLUMN IF NOT EXISTS max_leverage NUMERIC(4,2) NOT NULL DEFAULT 2.00,
  ADD COLUMN IF NOT EXISTS commission_per_share NUMERIC(8,4) NOT NULL DEFAULT 0.0050,
  ADD COLUMN IF NOT EXISTS min_commission NUMERIC(8,2) NOT NULL DEFAULT 1.00,
  ADD COLUMN IF NOT EXISTS cash_interest_rate NUMERIC(6,4) NOT NULL DEFAULT 0.0200,
  ADD COLUMN IF NOT EXISTS margin_interest_rate NUMERIC(6,4) NOT NULL DEFAULT 0.0800,
  ADD COLUMN IF NOT EXISTS short_selling_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS maintenance_margin NUMERIC(4,2) NOT NULL DEFAULT 0.25;

-- === PARTICIPANTS: Add margin/short tracking fields ===
ALTER TABLE public.participants
  ADD COLUMN IF NOT EXISTS short_shares INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS short_avg_cost NUMERIC(12,4) NOT NULL DEFAULT 0.0000,
  ADD COLUMN IF NOT EXISTS margin_used NUMERIC(14,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS accrued_interest NUMERIC(14,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS total_commissions NUMERIC(14,2) NOT NULL DEFAULT 0.00;

-- === ORDERS: Allow SHORT side ===
-- Need to drop and re-create the constraint to add SHORT_SELL and BUY_TO_COVER
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_side_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_side_check 
  CHECK (side IN ('BUY', 'SELL', 'SHORT_SELL', 'BUY_TO_COVER'));

-- === EXECUTIONS: Same side constraint update ===
ALTER TABLE public.executions DROP CONSTRAINT IF EXISTS executions_side_check;
ALTER TABLE public.executions ADD CONSTRAINT executions_side_check 
  CHECK (side IN ('BUY', 'SELL', 'SHORT_SELL', 'BUY_TO_COVER'));

-- === SESSION METRICS: Add new fields ===
ALTER TABLE public.session_metrics
  ADD COLUMN IF NOT EXISTS total_commissions NUMERIC(14,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS total_interest_earned NUMERIC(14,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS total_margin_interest NUMERIC(14,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS max_margin_used NUMERIC(14,2) NOT NULL DEFAULT 0.00;

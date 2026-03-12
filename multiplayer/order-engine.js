/* =========================================================
   Technetos Multiplayer — Order Engine (v2)
   Supports: Long, Short, Margin, Commissions, Interest
   ========================================================= */

const OrderEngine = {
  // Session parameters (set from room config)
  sessionParams: {
    maxLeverage: 2.0,
    commissionPerShare: 0.005,
    minCommission: 1.00,
    cashInterestRate: 0.02,    // annual
    marginInterestRate: 0.08,  // annual
    shortSellingEnabled: true,
    maintenanceMargin: 0.25,
    startingCash: 100000
  },

  /** Initialize session parameters from room config */
  initParams(room) {
    this.sessionParams = {
      maxLeverage: parseFloat(room.max_leverage) || 2.0,
      commissionPerShare: parseFloat(room.commission_per_share) || 0.005,
      minCommission: parseFloat(room.min_commission) || 1.00,
      cashInterestRate: parseFloat(room.cash_interest_rate) || 0.02,
      marginInterestRate: parseFloat(room.margin_interest_rate) || 0.08,
      shortSellingEnabled: room.short_selling_enabled !== false,
      maintenanceMargin: parseFloat(room.maintenance_margin) || 0.25,
      startingCash: parseFloat(room.starting_cash) || 100000
    };
  },

  /** Calculate commission for a trade */
  calcCommission(qty) {
    const raw = qty * this.sessionParams.commissionPerShare;
    return Math.max(raw, this.sessionParams.minCommission);
  },

  /** Calculate buying power: equity * leverage */
  calcBuyingPower(portfolio, currentPrice) {
    const equity = this.calcEquity(portfolio, currentPrice);
    return equity * this.sessionParams.maxLeverage;
  },

  /** Calculate total equity = cash + longValue - shortLiability */
  calcEquity(portfolio, currentPrice) {
    const longValue = portfolio.shares * currentPrice;
    const shortLiability = portfolio.shortShares * currentPrice;
    // Equity = cash + long positions value - cost to cover shorts
    return portfolio.cash + longValue - shortLiability;
  },

  /** Calculate margin used = borrowed amount for longs + short collateral */
  calcMarginUsed(portfolio, currentPrice) {
    const longValue = portfolio.shares * currentPrice;
    // If cash < 0 it means we borrowed. If longValue > starting cash we used margin.
    const borrowedForLongs = Math.max(0, longValue - (portfolio.cash + longValue - this.calcEquity(portfolio, currentPrice)));
    const shortCollateral = portfolio.shortShares * currentPrice;
    // Simpler: margin used = max(0, total position value - equity)
    const totalPositionValue = (portfolio.shares * currentPrice) + (portfolio.shortShares * currentPrice);
    const equity = this.calcEquity(portfolio, currentPrice);
    return Math.max(0, totalPositionValue - equity);
  },

  /** Calculate maintenance margin requirement */
  calcMaintenanceReq(portfolio, currentPrice) {
    const totalPositionValue = (portfolio.shares * currentPrice) + (portfolio.shortShares * currentPrice);
    return totalPositionValue * this.sessionParams.maintenanceMargin;
  },

  /** Check if account is in margin call */
  isMarginCall(portfolio, currentPrice) {
    const equity = this.calcEquity(portfolio, currentPrice);
    const maintReq = this.calcMaintenanceReq(portfolio, currentPrice);
    return equity < maintReq && (portfolio.shares > 0 || portfolio.shortShares > 0);
  },

  /** Accrue interest (called periodically, e.g., every tick)
   *  Returns { cashInterest, marginInterest } amounts for this tick
   *  Assumes ~252 trading days/year, ticks represent seconds of a trading day
   */
  calcTickInterest(portfolio, currentPrice, ticksPerSecond) {
    // Convert annual rates to per-tick rates
    // Assume 252 trading days, 6.5 hours/day = 23400 seconds/day
    const secondsPerYear = 252 * 23400;
    const perTickRate = 1 / (secondsPerYear * (ticksPerSecond || 1));

    let cashInterest = 0;
    let marginInterest = 0;

    // Cash interest: earned on positive idle cash
    if (portfolio.cash > 0) {
      cashInterest = portfolio.cash * this.sessionParams.cashInterestRate * perTickRate;
    }

    // Margin interest: charged on borrowed money
    // Borrowed = max(0, -cash) for long margin, plus short proceeds obligation
    const borrowed = Math.max(0, -portfolio.cash) + (portfolio.shortShares * portfolio.shortAvgCost);
    if (borrowed > 0) {
      marginInterest = borrowed * this.sessionParams.marginInterestRate * perTickRate;
    }

    return { cashInterest, marginInterest };
  },

  /** Submit an order */
  async submitOrder(roomId, participantId, orderData) {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('orders')
      .insert({
        room_id: roomId,
        participant_id: participantId,
        user_id: Auth.currentUser.id,
        side: orderData.side,
        order_type: orderData.orderType,
        qty: orderData.qty,
        limit_price: orderData.limitPrice || null,
        stop_price: orderData.stopPrice || null,
        trail_amount: orderData.trailAmount || null,
        tif: orderData.tif || 'GTC'
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  /** Cancel an order */
  async cancelOrder(orderId) {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('orders')
      .update({ status: 'CANCELLED', updated_at: new Date().toISOString() })
      .eq('id', orderId)
      .eq('user_id', Auth.currentUser.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  /** Get working orders for a participant */
  async getWorkingOrders(participantId) {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('orders')
      .select('*')
      .eq('participant_id', participantId)
      .eq('status', 'WORKING')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  },

  /** Get all orders for a participant */
  async getAllOrders(participantId) {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('orders')
      .select('*')
      .eq('participant_id', participantId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  },

  /** Get executions for a participant */
  async getExecutions(participantId) {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('executions')
      .select('*')
      .eq('participant_id', participantId)
      .order('executed_at', { ascending: false });
    if (error) throw error;
    return data || [];
  },

  /**
   * Process all working orders against a new price tick.
   * Called client-side (each student checks their own orders).
   * Supports: BUY, SELL, SHORT_SELL, BUY_TO_COVER
   * Returns array of fills.
   */
  processOrders(workingOrders, tick, portfolio) {
    const fills = [];
    const bid = tick.bid;
    const ask = tick.ask;
    const last = tick.close;
    const currentPrice = last;

    for (const order of workingOrders) {
      let shouldFill = false;
      let fillPrice = 0;

      // Determine if price condition is met
      switch (order.order_type) {
        case 'MARKET':
          shouldFill = true;
          fillPrice = (order.side === 'BUY' || order.side === 'BUY_TO_COVER') ? ask : bid;
          break;

        case 'LIMIT':
          if ((order.side === 'BUY' || order.side === 'BUY_TO_COVER') && ask <= order.limit_price) {
            shouldFill = true;
            fillPrice = ask;
          } else if ((order.side === 'SELL' || order.side === 'SHORT_SELL') && bid >= order.limit_price) {
            shouldFill = true;
            fillPrice = bid;
          }
          break;

        case 'STOP':
          if ((order.side === 'BUY' || order.side === 'BUY_TO_COVER') && last >= order.stop_price) {
            shouldFill = true;
            fillPrice = ask;
          } else if ((order.side === 'SELL' || order.side === 'SHORT_SELL') && last <= order.stop_price) {
            shouldFill = true;
            fillPrice = bid;
          }
          break;

        case 'STOP_LIMIT':
          if ((order.side === 'BUY' || order.side === 'BUY_TO_COVER') && last >= order.stop_price && ask <= order.limit_price) {
            shouldFill = true;
            fillPrice = ask;
          } else if ((order.side === 'SELL' || order.side === 'SHORT_SELL') && last <= order.stop_price && bid >= order.limit_price) {
            shouldFill = true;
            fillPrice = bid;
          }
          break;

        case 'TRAILING':
          if (!order._bestPrice) {
            order._bestPrice = last;
          }
          if (order.side === 'SELL' || order.side === 'SHORT_SELL') {
            if (last > order._bestPrice) order._bestPrice = last;
            const trailStop = order._bestPrice - order.trail_amount;
            if (last <= trailStop) {
              shouldFill = true;
              fillPrice = bid;
            }
          } else {
            if (last < order._bestPrice) order._bestPrice = last;
            const trailStop = order._bestPrice + order.trail_amount;
            if (last >= trailStop) {
              shouldFill = true;
              fillPrice = ask;
            }
          }
          break;
      }

      // Validate based on side
      if (shouldFill) {
        const value = fillPrice * order.qty;
        const commission = this.calcCommission(order.qty);
        const equity = this.calcEquity(portfolio, currentPrice);
        const buyingPower = equity * this.sessionParams.maxLeverage;

        switch (order.side) {
          case 'BUY':
            // Need enough buying power (cash + margin)
            if (value + commission > buyingPower) {
              shouldFill = false; // Insufficient buying power
            }
            break;

          case 'SELL':
            // Can only sell shares you own (long)
            if (order.qty > portfolio.shares) {
              shouldFill = false; // Insufficient shares
            }
            break;

          case 'SHORT_SELL':
            // Check if short selling is enabled
            if (!this.sessionParams.shortSellingEnabled) {
              shouldFill = false;
              break;
            }
            // Need margin to cover the short: at least maintenance margin worth of equity
            const shortValue = value;
            const requiredEquity = shortValue * this.sessionParams.maintenanceMargin;
            if (equity - commission < requiredEquity) {
              shouldFill = false; // Insufficient equity for short
            }
            break;

          case 'BUY_TO_COVER':
            // Must have short position to cover
            if (order.qty > portfolio.shortShares) {
              shouldFill = false; // Can't cover more than short position
            }
            // Need cash or buying power to buy back
            if (value + commission > portfolio.cash + (equity * this.sessionParams.maxLeverage - value)) {
              shouldFill = false;
            }
            break;
        }
      }

      if (shouldFill) {
        fills.push({
          orderId: order.id,
          side: order.side,
          qty: order.qty,
          fillPrice: +fillPrice.toFixed(4),
          value: +(fillPrice * order.qty).toFixed(2),
          commission: +this.calcCommission(order.qty).toFixed(2)
        });
      }
    }

    return fills;
  },

  /** Apply a fill to the portfolio (called after processOrders) */
  applyFill(fill, portfolio) {
    const { side, qty, fillPrice, value, commission } = fill;

    // Deduct commission
    portfolio.cash -= commission;
    portfolio.totalCommissions += commission;

    switch (side) {
      case 'BUY': {
        const totalCost = portfolio.shares * portfolio.avgCost + value;
        portfolio.shares += qty;
        portfolio.avgCost = portfolio.shares > 0 ? totalCost / portfolio.shares : 0;
        portfolio.cash -= value;
        break;
      }

      case 'SELL': {
        const pnl = (fillPrice - portfolio.avgCost) * qty;
        portfolio.realizedPnl += pnl;
        portfolio.shares -= qty;
        portfolio.cash += value;
        if (portfolio.shares === 0) portfolio.avgCost = 0;
        break;
      }

      case 'SHORT_SELL': {
        // Receive cash from short sale, increase short position
        const totalShortCost = portfolio.shortShares * portfolio.shortAvgCost + value;
        portfolio.shortShares += qty;
        portfolio.shortAvgCost = portfolio.shortShares > 0 ? totalShortCost / portfolio.shortShares : 0;
        portfolio.cash += value; // receive proceeds
        break;
      }

      case 'BUY_TO_COVER': {
        // Pay cash to buy back, reduce short position
        const shortPnl = (portfolio.shortAvgCost - fillPrice) * qty;
        portfolio.realizedPnl += shortPnl;
        portfolio.shortShares -= qty;
        portfolio.cash -= value;
        if (portfolio.shortShares === 0) portfolio.shortAvgCost = 0;
        break;
      }
    }
  },

  /** Record a fill in the database and update participant */
  async recordFill(fill, roomId, participantId) {
    const sb = getSupabase();

    // Insert execution
    const { error: exErr } = await sb.from('executions').insert({
      room_id: roomId,
      order_id: fill.orderId,
      participant_id: participantId,
      user_id: Auth.currentUser.id,
      side: fill.side,
      qty: fill.qty,
      fill_price: fill.fillPrice,
      value: fill.value
    });
    if (exErr) console.error('Execution insert error:', exErr);

    // Update order status
    await sb.from('orders')
      .update({ status: 'FILLED', filled_qty: fill.qty, avg_fill_price: fill.fillPrice, updated_at: new Date().toISOString() })
      .eq('id', fill.orderId);

    return fill;
  },

  /** Update participant portfolio in DB (with retry) */
  _pendingSync: null,
  async updateParticipant(participantId, updates) {
    // Debounce: store latest state and sync periodically
    this._pendingSync = { participantId, updates };
    if (this._syncTimer) return; // already scheduled
    this._syncTimer = setTimeout(() => this._flushSync(), 1500);
  },

  async _flushSync() {
    this._syncTimer = null;
    if (!this._pendingSync) return;
    const { participantId, updates } = this._pendingSync;
    this._pendingSync = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const sb = getSupabase();
        const { error } = await sb
          .from('participants')
          .update(updates)
          .eq('id', participantId);
        if (!error) return; // success
        console.warn('Participant sync attempt', attempt + 1, 'failed:', error.message);
      } catch (e) {
        console.warn('Participant sync attempt', attempt + 1, 'exception:', e.message);
      }
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); // backoff
    }
    console.error('Participant sync failed after 3 attempts');
  },

  /** Save session metrics at end */
  async saveMetrics(roomId, participantId, metrics) {
    const sb = getSupabase();
    const { error } = await sb.from('session_metrics').insert({
      room_id: roomId,
      participant_id: participantId,
      user_id: Auth.currentUser.id,
      final_cash: metrics.cash,
      final_shares: metrics.shares,
      final_equity: metrics.equity,
      total_pnl: metrics.pnl,
      pnl_pct: metrics.pnlPct,
      num_trades: metrics.numTrades,
      total_commissions: metrics.totalCommissions || 0,
      total_interest_earned: metrics.totalInterestEarned || 0,
      total_margin_interest: metrics.totalMarginInterest || 0,
      max_margin_used: metrics.maxMarginUsed || 0
    });
    if (error) console.error('Metrics save error:', error);
  }
};

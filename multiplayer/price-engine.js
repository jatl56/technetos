/* =========================================================
   Technetos Multiplayer — Price Engine
   Supports two modes:
   1. HISTORICAL (default): replays real market data
   2. GBM: generates synthetic prices via Geometric Brownian Motion
   Runs in the Master's browser, broadcasts via Realtime
   ========================================================= */

const PriceEngine = {
  // State
  price: 185.0,
  prevClose: 185.0,
  tickIndex: 0,
  _baseTime: 0,
  candles: [],

  // Mode: 'historical' or 'gbm'
  mode: 'historical',

  // Historical mode state
  _histScenarioName: null,   // fictitious name shown to users
  _histTotalCandles: 0,

  params: {
    ticker: 'AAPL',
    initialPrice: 185.0,
    drift: 0.08,
    volatility: 0.25,
    tickSpeedMs: 600,
    spreadBps: 10,
    patternFrequency: 30,
    patternSuccessRate: 0.70,
    selectedPattern: null,
    enabledPatterns: [
      'head_and_shoulders','inv_head_and_shoulders','double_top','double_bottom',
      'ascending_triangle','descending_triangle','bull_flag','bear_flag',
      'cup_and_handle','rising_wedge','falling_wedge','symmetrical_triangle'
    ]
  },

  // Pattern state
  _patternQueue: [],
  _patternIndex: 0,
  _patternActive: false,
  _patternBasePrice: 0,   // Fixed price at pattern start — all multipliers reference this
  _ticksSincePattern: 0,

  /** Normal random (Box-Muller) */
  _randn() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  },

  /** Generate realistic OHLC — normal mode (random direction candles) */
  _realisticOHLC(basePrice, vol, prevClose) {
    const dayVol = vol / Math.sqrt(252);
    // Open anchored to previous close with small gap
    const gapMult = 1 + (Math.random() - 0.5) * dayVol * 0.15;
    const open = prevClose * gapMult;

    // Close with random direction (NOT following drift)
    const direction = Math.random() < 0.5 ? 1 : -1;
    const bodySize = dayVol * (0.2 + Math.random() * 0.6);
    const close = open * (1 + direction * bodySize);

    // Wicks — proportional to body, not extreme
    const body = Math.abs(close - open);
    const wickFactor = 0.3 + Math.random() * 0.5; // 30-80% of body
    const high = Math.max(open, close) + body * wickFactor * Math.random();
    const low = Math.min(open, close) - body * wickFactor * Math.random();

    return {
      open: +open.toFixed(4),
      high: +high.toFixed(4),
      low: +low.toFixed(4),
      close: +close.toFixed(4)
    };
  },

  /**
   * Generate OHLC during pattern.
   * Close follows the pattern target, but candle color (green/red) is NOT
   * always aligned with the swing direction. ~25-35% of candles go against
   * the trend (counter-trend candles), just like real markets.
   */
  _patternOHLC(targetClose, prevClose) {
    const trendDir = targetClose >= prevClose ? 1 : -1; // overall swing direction

    // ~30% chance of a counter-trend candle (close goes opposite to trend)
    const counterTrend = Math.random() < 0.30;

    if (counterTrend) {
      // Counter-trend candle: open jumps past target, close pulls back to target
      // This creates a red candle in an upswing or green candle in a downswing
      const overshoot = Math.abs(targetClose - prevClose) * (0.3 + Math.random() * 0.5);
      const open = targetClose + trendDir * overshoot;
      const close = targetClose * (1 + (Math.random() - 0.5) * 0.001);

      const body = Math.abs(close - open);
      const wickSize = body * (0.1 + Math.random() * 0.3);
      const high = Math.max(open, close) + wickSize * Math.random();
      const low = Math.min(open, close) - wickSize * Math.random();

      return {
        open: +open.toFixed(4),
        high: +high.toFixed(4),
        low: +low.toFixed(4),
        close: +close.toFixed(4)
      };
    }

    // Normal trend-following candle
    const gapNoise = 1 + (Math.random() - 0.5) * 0.001;
    const open = prevClose * gapNoise;
    const microNoise = 1 + (Math.random() - 0.5) * 0.001;
    const close = targetClose * microNoise;

    const body = Math.abs(close - open);
    const wickSize = body * (0.15 + Math.random() * 0.35);
    const high = Math.max(open, close) + wickSize * Math.random();
    const low = Math.min(open, close) - wickSize * Math.random();

    return {
      open: +open.toFixed(4),
      high: +high.toFixed(4),
      low: +low.toFixed(4),
      close: +close.toFixed(4)
    };
  },

  /**
   * Swing-based pattern generator v2.
   * Defines a pattern as a sequence of swings { dir, pct, candles }.
   * Each swing is a move of `pct` percent over `candles` candles.
   * Noise is applied to duration (±25%), amplitude (±20%), and per-candle jitter.
   * Returns an array of multipliers relative to 1.0 (pattern start price).
   */
  _generateSwingPattern(swingDef) {
    const mults = [];
    let level = 1.0;

    for (const swing of swingDef) {
      // Apply noise to duration and amplitude
      const durationNoise = 1 + (Math.random() - 0.5) * 0.5;  // ±25%
      const ampNoise = 1 + (Math.random() - 0.5) * 0.4;        // ±20%
      const nCandles = Math.max(2, Math.round(swing.candles * durationNoise));
      const targetPct = swing.pct * ampNoise;
      const targetLevel = level * (1 + swing.dir * targetPct);

      // Generate candles along this swing with slight wobble
      for (let i = 1; i <= nCandles; i++) {
        const t = i / nCandles;
        // Ease function: slight acceleration/deceleration for natural look
        const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const idealLevel = level + (targetLevel - level) * eased;
        // Per-candle jitter: ±0.3% for realism
        const jitter = 1 + (Math.random() - 0.5) * 0.006;
        mults.push(idealLevel * jitter);
      }
      level = targetLevel;
    }
    return mults;
  },

  /** GBM step */
  _gbmStep() {
    const dt = 1 / 252;
    const z = this._randn();
    const mu = this.params.drift;
    const sigma = this.params.volatility;
    const drift = (mu - 0.5 * sigma * sigma) * dt;
    const diffusion = sigma * Math.sqrt(dt) * z;
    this.price = this.price * Math.exp(drift + diffusion);
    return this.price;
  },

  /** Check if pattern should inject */
  _shouldInjectPattern() {
    if (this._patternActive) return false;
    this._ticksSincePattern++;
    if (this._ticksSincePattern >= this.params.patternFrequency) {
      return Math.random() < 0.5; // 50% chance after frequency
    }
    return false;
  },

  /** Generate the next candle — dispatches to historical or GBM mode */
  nextCandle() {
    if (this.mode === 'historical') {
      return this._nextCandleHistorical();
    }
    return this._nextCandleGBM();
  },

  /** Historical mode: replay real market data */
  _nextCandleHistorical() {
    const raw = HistoricalData.nextCandle();
    if (!raw) {
      // Series exhausted — signal end
      return null;
    }

    this.price = raw.close;
    this.prevClose = raw.close;
    this.tickIndex = raw.tickIndex;

    const candle = {
      time: raw.time,
      open: raw.open,
      high: raw.high,
      low: raw.low,
      close: raw.close,
      volume: raw.volume,
      bid: raw.bid,
      ask: raw.ask,
      spread: raw.spread,
      ticker: this.params.ticker,
      tickIndex: raw.tickIndex
    };

    this.candles.push(candle);
    return candle;
  },

  /** GBM mode: generate synthetic prices */
  _nextCandleGBM() {
    let ohlc;
    let patternName = null;
    let patternPhase = null;

    if (this._patternActive && this._patternIndex < this._patternQueue.length) {
      const mult = this._patternQueue[this._patternIndex];
      const targetClose = this._patternBasePrice * mult;
      ohlc = this._patternOHLC(targetClose, this.prevClose);
      this._patternIndex++;
      patternPhase = 'active';

      if (this._patternIndex >= this._patternQueue.length) {
        this._patternActive = false;
        this._ticksSincePattern = 0;
      }
    } else {
      const basePrice = this._gbmStep();
      ohlc = this._realisticOHLC(basePrice, this.params.volatility, this.prevClose);

      if (this.params.selectedPattern && this.params.selectedPattern !== 'random') {
        this._startPattern();
      } else if (this._shouldInjectPattern() && this.params.enabledPatterns.length > 0) {
        this._startPattern();
      }
    }

    this.price = ohlc.close;
    this.prevClose = ohlc.close;
    this.tickIndex++;

    const spread = ohlc.close * (this.params.spreadBps / 10000);
    const bid = +(ohlc.close - spread / 2).toFixed(4);
    const ask = +(ohlc.close + spread / 2).toFixed(4);

    const candle = {
      time: this._baseTime + this.tickIndex,
      open: ohlc.open,
      high: ohlc.high,
      low: ohlc.low,
      close: ohlc.close,
      bid,
      ask,
      spread: +(ask - bid).toFixed(4),
      ticker: this.params.ticker,
      patternName,
      patternPhase,
      tickIndex: this.tickIndex
    };

    this.candles.push(candle);
    return candle;
  },

  /**
   * Swing definitions for v2 patterns.
   * Extracted from real market data (ETH double top).
   * Each swing: { dir: +1(up)/-1(down), pct: move size as decimal, candles: base count }
   *
   * Double Top from ETH chart analysis:
   *  - Rally from base to 1st peak: ~8% over ~15 candles (mix of sizes, some big green)
   *  - Pullback (valley): ~4% over ~5 candles (sharp red candles)
   *  - Rally to 2nd peak (same level ±): ~4% over ~6 candles
   *  - Small hesitation/flat: ~0.5% over ~3 candles
   *  - Breakdown: ~6% over ~6 candles (big red candles)
   *  - Continuation sell: ~4% over ~5 candles
   */
  _getSwingPatterns() {
    return {
      double_top: {
        swings: [
          { dir: +1, pct: 0.08, candles: 15 },  // Rally to 1st peak
          { dir: -1, pct: 0.04, candles: 5 },   // Pullback valley
          { dir: +1, pct: 0.04, candles: 6 },   // Rally to 2nd peak (approx same level)
          { dir: -1, pct: 0.005, candles: 3 },   // Hesitation/micro-drop
        ],
        successSwings: [
          { dir: -1, pct: 0.06, candles: 6 },   // Breakdown below neckline
          { dir: -1, pct: 0.04, candles: 5 },   // Continuation sell
        ],
        failSwings: [
          { dir: +1, pct: 0.03, candles: 4 },   // Fake breakdown, reverses up
          { dir: +1, pct: 0.05, candles: 5 },   // Bull continuation
        ]
      }
    };
  },

  /** Start a pattern */
  _startPattern() {
    let patternKey;
    let wasManualSelect = false;
    if (this.params.selectedPattern && this.params.selectedPattern !== 'random') {
      patternKey = this.params.selectedPattern;
      wasManualSelect = true;
    } else {
      const pool = this.params.enabledPatterns;
      patternKey = pool[Math.floor(Math.random() * pool.length)];
    }

    // Check if this is a v2 swing-based pattern
    const swingPatterns = this._getSwingPatterns();
    if (swingPatterns[patternKey]) {
      const sp = swingPatterns[patternKey];
      const success = Math.random() < this.params.patternSuccessRate;
      const allSwings = [...sp.swings, ...(success ? sp.successSwings : sp.failSwings)];
      this._patternQueue = this._generateSwingPattern(allSwings);
      this._patternIndex = 0;
      this._patternActive = true;
      this._patternBasePrice = this.price;
      // If manually selected, reset so it fires only once then returns to random
      if (wasManualSelect) {
        this.params.selectedPattern = null;
        if (this.onPatternReset) this.onPatternReset();
      }
      return;
    }

    // Legacy v1 fixed-array patterns
    const PATTERN_CORES = this._getPatternCores();
    const pattern = PATTERN_CORES[patternKey];
    if (!pattern || pattern === 'SWING_V2') return;

    this._patternQueue = [...pattern.core];
    const success = Math.random() < this.params.patternSuccessRate;
    this._patternQueue.push(...(success ? pattern.successTail : pattern.failTail));
    
    this._patternIndex = 0;
    this._patternActive = true;
    this._patternBasePrice = this.price;

    // If manually selected, reset so it fires only once then returns to random
    if (wasManualSelect) {
      this.params.selectedPattern = null;
      if (this.onPatternReset) this.onPatternReset();
    }
  },

  /** Get pattern core arrays */
  _getPatternCores() {
    return {
      head_and_shoulders: {
        core: [1.000,1.010,1.022,1.035,1.045,1.050,1.043,1.032,1.018,1.008,1.005,1.012,1.028,1.045,1.062,1.075,1.082,1.078,1.065,1.045,1.025,1.010,1.005,1.012,1.025,1.038,1.048,1.045,1.035,1.020],
        successTail: [0.985,0.978,0.970,0.960,0.952,0.945],
        failTail: [1.005,1.012,1.022,1.035,1.048,1.060]
      },
      inv_head_and_shoulders: {
        core: [1.000,0.990,0.978,0.965,0.955,0.950,0.957,0.968,0.982,0.992,0.995,0.988,0.972,0.955,0.938,0.925,0.918,0.922,0.935,0.955,0.975,0.990,0.995,0.988,0.975,0.962,0.952,0.955,0.965,0.980],
        successTail: [1.015,1.022,1.030,1.040,1.048,1.055],
        failTail: [0.995,0.988,0.978,0.965,0.952,0.940]
      },
      double_top: 'SWING_V2',  // Generated dynamically by _generateDoubleTop()
      double_bottom: {
        core: [1.000,0.992,0.982,0.970,0.958,0.948,0.942,0.940,0.945,0.955,0.968,0.980,0.988,0.992,0.985,0.972,0.958,0.948,0.942,0.940,0.945,0.952,0.962,0.975,0.985],
        successTail: [1.002,1.015,1.028,1.042,1.055,1.065],
        failTail: [0.980,0.965,0.950,0.935,0.922,0.912]
      },
      ascending_triangle: {
        core: [1.000,0.985,0.975,0.970,0.978,0.990,1.000,1.008,1.010,1.005,0.995,0.982,0.978,0.985,0.995,1.005,1.010,1.008,1.000,0.990,0.985,0.990,1.000,1.008,1.010],
        successTail: [1.018,1.028,1.040,1.052,1.062,1.070],
        failTail: [1.005,0.995,0.982,0.968,0.955,0.942]
      },
      descending_triangle: {
        core: [1.000,1.015,1.025,1.030,1.022,1.010,1.000,0.992,0.990,0.995,1.005,1.018,1.022,1.015,1.005,0.995,0.990,0.992,1.000,1.010,1.015,1.010,1.000,0.992,0.990],
        successTail: [0.982,0.972,0.960,0.948,0.938,0.930],
        failTail: [0.995,1.005,1.018,1.032,1.045,1.058]
      },
      bull_flag: {
        core: [1.000,1.012,1.025,1.040,1.055,1.068,1.078,1.082,1.075,1.070,1.065,1.062,1.058,1.055,1.052,1.050,1.048,1.050,1.055,1.060],
        successTail: [1.068,1.078,1.090,1.102,1.115,1.125],
        failTail: [1.048,1.038,1.025,1.012,1.000,0.990]
      },
      bear_flag: {
        core: [1.000,0.988,0.975,0.960,0.945,0.932,0.922,0.918,0.925,0.930,0.935,0.938,0.942,0.945,0.948,0.950,0.952,0.950,0.945,0.940],
        successTail: [0.932,0.922,0.910,0.898,0.885,0.875],
        failTail: [0.952,0.962,0.975,0.988,1.000,1.010]
      },
      cup_and_handle: {
        core: [1.000,1.005,1.008,1.004,0.995,0.982,0.968,0.955,0.948,0.945,0.948,0.955,0.968,0.982,0.995,1.004,1.008,1.005,1.000,0.995,0.992,0.990,0.992,0.998,1.005,1.008],
        successTail: [1.015,1.025,1.038,1.050,1.062,1.072],
        failTail: [1.002,0.995,0.985,0.972,0.960,0.950]
      },
      rising_wedge: {
        core: [1.000,1.008,1.018,1.025,1.015,1.010,1.015,1.022,1.030,1.035,1.025,1.020,1.025,1.030,1.035,1.038,1.032,1.028,1.032,1.035,1.038,1.040,1.036,1.034],
        successTail: [1.025,1.015,1.002,0.988,0.975,0.965],
        failTail: [1.042,1.050,1.060,1.072,1.082,1.090]
      },
      falling_wedge: {
        core: [1.000,0.992,0.982,0.975,0.985,0.990,0.985,0.978,0.970,0.965,0.975,0.980,0.975,0.970,0.965,0.962,0.968,0.972,0.968,0.965,0.962,0.960,0.964,0.966],
        successTail: [0.975,0.985,0.998,1.012,1.025,1.035],
        failTail: [0.958,0.950,0.940,0.928,0.918,0.910]
      },
      symmetrical_triangle: {
        core: [1.000,1.018,1.032,1.040,1.025,1.008,0.992,0.978,0.968,0.975,0.990,1.008,1.025,1.032,1.020,1.005,0.992,0.982,0.988,1.000,1.012,1.020,1.012,1.002,0.995,1.000],
        successTail: [1.012,1.025,1.040,1.055,1.068,1.078],
        failTail: [0.988,0.975,0.960,0.945,0.932,0.922]
      }
    };
  },

  /** Reset engine */
  reset(params) {
    if (params) Object.assign(this.params, params);
    this.tickIndex = 0;
    this.candles = [];

    if (this.mode === 'historical' && HistoricalData.isLoaded()) {
      // Historical mode: prepare a series
      const scenarioIndex = params && params.scenarioIndex != null ? params.scenarioIndex : null;
      const result = HistoricalData.prepareSeries(scenarioIndex, {
        maxCandles: 500,
        targetPrice: this.params.initialPrice || null
      });
      this._histScenarioName = result.scenarioName;
      this._histTotalCandles = result.totalCandles;
      this.price = result.initialPrice;
      this.prevClose = result.initialPrice;
      this.params.initialPrice = result.initialPrice;
    } else {
      // GBM mode
      this.mode = 'gbm';
      this.price = this.params.initialPrice;
      this.prevClose = this.params.initialPrice;
    }

    this._baseTime = Math.floor(Date.now() / 1000);
    this._patternQueue = [];
    this._patternIndex = 0;
    this._patternActive = false;
    this._patternBasePrice = 0;
    this._ticksSincePattern = 0;
  },

  /** Update params live */
  updateParams(newParams) {
    Object.assign(this.params, newParams);
  },

  /** Get scenario info (for UI display) */
  getScenarioInfo() {
    if (this.mode === 'historical') {
      return {
        mode: 'historical',
        scenarioName: this._histScenarioName,
        totalCandles: this._histTotalCandles,
        remaining: HistoricalData.remaining()
      };
    }
    return { mode: 'gbm', scenarioName: null };
  }
};

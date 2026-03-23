/* =========================================================
   Technetos — Technical Analysis Engine
   Indicators: SMA, EMA, Bollinger Bands, RSI, MACD, Volume
   Drawing tools: Trend Line, Horizontal Line, Channel
   ========================================================= */

const TAEngine = {
  // Candle history
  candles: [],

  // Active indicators: { id, type, params, series[] }
  indicators: [],

  // Active drawings: { id, type, points[], series }
  drawings: [],

  // Drawing mode state
  drawingMode: null,   // null | 'trendline' | 'horzline' | 'horzray'
  drawingPoints: [],
  _nextId: 1,

  // Chart references (set by init)
  chart: null,
  candleSeries: null,
  panes: {},  // { 'rsi': paneIndex, 'macd': paneIndex }

  /** Initialize with chart reference */
  init(chart, candleSeries) {
    this.chart = chart;
    this.candleSeries = candleSeries;
    this.candles = [];
    this.indicators = [];
    this.drawings = [];
    this.panes = {};
    this._nextId = 1;
  },

  /** Push a new candle (called on each tick) */
  pushCandle(candle) {
    // candle: { time, open, high, low, close, volume? }
    const existing = this.candles.findIndex(c => c.time === candle.time);
    if (existing >= 0) {
      this.candles[existing] = candle;
    } else {
      this.candles.push(candle);
    }
    // Update all active indicators
    this.updateAllIndicators();
    // Extend drawings (trendline, horizontal ray) to new candle
    this._extendDrawings(candle);
  },

  /** Extend active drawings to cover the new candle */
  _extendDrawings(candle) {
    for (const d of this.drawings) {
      if (d.type === 'trendline' && d.series && d.p1 && d.p2) {
        const slope = (d.p2.price - d.p1.price) / (d.p2.time - d.p1.time || 1);
        const price = d.p1.price + slope * (candle.time - d.p1.time);
        d.series.update({ time: candle.time, value: price });
      } else if (d.type === 'horzray' && d.series) {
        if (candle.time >= d.startTime) {
          d.series.update({ time: candle.time, value: d.price });
        }
      }
    }
  },

  /* ============================
     INDICATOR CALCULATIONS
     ============================ */

  _calcSMA(data, period) {
    const result = [];
    for (let i = 0; i < data.length; i++) {
      if (i < period - 1) {
        result.push({ time: data[i].time });
      } else {
        let sum = 0;
        for (let j = 0; j < period; j++) sum += data[i - j].close;
        result.push({ time: data[i].time, value: sum / period });
      }
    }
    return result;
  },

  _calcEMA(data, period) {
    const result = [];
    const k = 2 / (period + 1);
    let ema = null;
    for (let i = 0; i < data.length; i++) {
      if (i < period - 1) {
        result.push({ time: data[i].time });
      } else if (ema === null) {
        let sum = 0;
        for (let j = 0; j < period; j++) sum += data[i - j].close;
        ema = sum / period;
        result.push({ time: data[i].time, value: ema });
      } else {
        ema = data[i].close * k + ema * (1 - k);
        result.push({ time: data[i].time, value: ema });
      }
    }
    return result;
  },

  _calcBollinger(data, period, stdDev) {
    const sma = this._calcSMA(data, period);
    const upper = [], lower = [];
    for (let i = 0; i < data.length; i++) {
      if (i < period - 1) {
        upper.push({ time: data[i].time });
        lower.push({ time: data[i].time });
      } else {
        const mean = sma[i].value;
        let sumSq = 0;
        for (let j = 0; j < period; j++) {
          const diff = data[i - j].close - mean;
          sumSq += diff * diff;
        }
        const sd = Math.sqrt(sumSq / period);
        upper.push({ time: data[i].time, value: mean + stdDev * sd });
        lower.push({ time: data[i].time, value: mean - stdDev * sd });
      }
    }
    return { middle: sma, upper, lower };
  },

  _calcRSI(data, period) {
    const result = [];
    if (data.length < 2) return result;
    result.push({ time: data[0].time });

    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i < data.length; i++) {
      const change = data[i].close - data[i - 1].close;
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? -change : 0;

      if (i < period) {
        avgGain += gain;
        avgLoss += loss;
        result.push({ time: data[i].time });
      } else if (i === period) {
        avgGain = (avgGain + gain) / period;
        avgLoss = (avgLoss + loss) / period;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        result.push({ time: data[i].time, value: 100 - 100 / (1 + rs) });
      } else {
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        result.push({ time: data[i].time, value: 100 - 100 / (1 + rs) });
      }
    }
    return result;
  },

  _calcMACD(data, fast, slow, signal) {
    const emaFast = this._calcEMA(data, fast);
    const emaSlow = this._calcEMA(data, slow);

    // MACD line = fast EMA - slow EMA
    const macdLine = [];
    for (let i = 0; i < data.length; i++) {
      if (emaFast[i].value !== undefined && emaSlow[i].value !== undefined) {
        macdLine.push({ time: data[i].time, close: emaFast[i].value - emaSlow[i].value });
      } else {
        macdLine.push({ time: data[i].time, close: 0 });
      }
    }

    // Signal line = EMA of MACD line
    const signalData = this._calcEMA(macdLine, signal);

    // Histogram = MACD - Signal
    const macdResult = [], signalResult = [], histResult = [];
    for (let i = 0; i < data.length; i++) {
      const m = (emaFast[i].value !== undefined && emaSlow[i].value !== undefined)
        ? emaFast[i].value - emaSlow[i].value : undefined;
      const s = signalData[i] ? signalData[i].value : undefined;

      macdResult.push({ time: data[i].time, value: m });
      signalResult.push({ time: data[i].time, value: s });
      if (m !== undefined && s !== undefined) {
        const h = m - s;
        histResult.push({ time: data[i].time, value: h, color: h >= 0 ? 'rgba(0,200,83,0.6)' : 'rgba(255,61,87,0.6)' });
      } else {
        histResult.push({ time: data[i].time });
      }
    }
    return { macd: macdResult, signal: signalResult, histogram: histResult };
  },

  /* ============================
     INDICATOR MANAGEMENT
     ============================ */

  /** Add an indicator to the chart */
  addIndicator(type, params = {}) {
    const id = 'ind-' + (this._nextId++);
    const ind = { id, type, params, series: [] };

    switch (type) {
      case 'SMA': {
        const period = params.period || 20;
        const color = params.color || '#2196F3';
        const s = this.chart.addSeries(LightweightCharts.LineSeries, {
          color, lineWidth: 1, priceLineVisible: false,
          lastValueVisible: false, crosshairMarkerVisible: false,
          title: 'SMA(' + period + ')'
        });
        ind.series.push(s);
        break;
      }
      case 'EMA': {
        const period = params.period || 20;
        const color = params.color || '#FF9800';
        const s = this.chart.addSeries(LightweightCharts.LineSeries, {
          color, lineWidth: 1, priceLineVisible: false,
          lastValueVisible: false, crosshairMarkerVisible: false,
          title: 'EMA(' + period + ')'
        });
        ind.series.push(s);
        break;
      }
      case 'BOLL': {
        const period = params.period || 20;
        const stdDev = params.stdDev || 2;
        const color = params.color || '#9C27B0';
        // Middle (SMA)
        const mid = this.chart.addSeries(LightweightCharts.LineSeries, {
          color, lineWidth: 1, priceLineVisible: false,
          lastValueVisible: false, crosshairMarkerVisible: false,
          title: 'BB(' + period + ')'
        });
        // Upper
        const up = this.chart.addSeries(LightweightCharts.LineSeries, {
          color: 'rgba(156,39,176,0.4)', lineWidth: 1, lineStyle: 2,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false
        });
        // Lower
        const lo = this.chart.addSeries(LightweightCharts.LineSeries, {
          color: 'rgba(156,39,176,0.4)', lineWidth: 1, lineStyle: 2,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false
        });
        ind.series.push(mid, up, lo);
        break;
      }
      case 'RSI': {
        const period = params.period || 14;
        const paneIdx = this._getOrCreatePane('rsi');
        const s = this.chart.addSeries(LightweightCharts.LineSeries, {
          color: '#E040FB', lineWidth: 1, priceLineVisible: false,
          lastValueVisible: true, crosshairMarkerVisible: false,
          title: 'RSI(' + period + ')'
        }, paneIdx);
        // Add reference lines at 30 and 70
        s.createPriceLine({ price: 70, color: 'rgba(255,255,255,0.2)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '' });
        s.createPriceLine({ price: 30, color: 'rgba(255,255,255,0.2)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '' });
        ind.paneIdx = paneIdx;
        ind.series.push(s);
        break;
      }
      case 'MACD': {
        const fast = params.fast || 12;
        const slow = params.slow || 26;
        const signal = params.signal || 9;
        const paneIdx = this._getOrCreatePane('macd');
        // MACD line
        const macdS = this.chart.addSeries(LightweightCharts.LineSeries, {
          color: '#2196F3', lineWidth: 1, priceLineVisible: false,
          lastValueVisible: true, crosshairMarkerVisible: false,
          title: 'MACD'
        }, paneIdx);
        // Signal line
        const sigS = this.chart.addSeries(LightweightCharts.LineSeries, {
          color: '#FF9800', lineWidth: 1, priceLineVisible: false,
          lastValueVisible: false, crosshairMarkerVisible: false,
          title: 'Signal'
        }, paneIdx);
        // Histogram
        const histS = this.chart.addSeries(LightweightCharts.HistogramSeries, {
          priceLineVisible: false, lastValueVisible: false,
          priceFormat: { type: 'volume' }
        }, paneIdx);
        ind.paneIdx = paneIdx;
        ind.series.push(macdS, sigS, histS);
        break;
      }
      case 'VOL': {
        const paneIdx = this._getOrCreatePane('volume');
        const s = this.chart.addSeries(LightweightCharts.HistogramSeries, {
          priceLineVisible: false, lastValueVisible: false,
          priceFormat: { type: 'volume' },
          title: 'Volume'
        }, paneIdx);
        ind.paneIdx = paneIdx;
        ind.series.push(s);
        break;
      }
    }

    this.indicators.push(ind);
    this._updateIndicator(ind);
    return id;
  },

  /** Remove an indicator */
  removeIndicator(id) {
    const idx = this.indicators.findIndex(i => i.id === id);
    if (idx < 0) return;
    const ind = this.indicators[idx];
    for (const s of ind.series) {
      this.chart.removeSeries(s);
    }
    // Clean up pane if empty
    if (ind.paneIdx !== undefined) {
      const paneKey = Object.keys(this.panes).find(k => this.panes[k] === ind.paneIdx);
      const othersInPane = this.indicators.filter(i => i.id !== id && i.paneIdx === ind.paneIdx);
      if (othersInPane.length === 0 && paneKey) {
        try { this.chart.removePane(ind.paneIdx); } catch(e) {}
        delete this.panes[paneKey];
        // Reindex remaining panes
        for (const k of Object.keys(this.panes)) {
          if (this.panes[k] > ind.paneIdx) this.panes[k]--;
        }
        for (const other of this.indicators) {
          if (other.paneIdx !== undefined && other.paneIdx > ind.paneIdx) other.paneIdx--;
        }
      }
    }
    this.indicators.splice(idx, 1);
  },

  /** Get or create a pane for an indicator type */
  _getOrCreatePane(key) {
    if (this.panes[key] !== undefined) return this.panes[key];
    const pane = this.chart.addPane();
    const allPanes = this.chart.panes();
    const paneIdx = allPanes.length - 1;
    this.panes[key] = paneIdx;
    return paneIdx;
  },

  /** Update a single indicator with current data */
  _updateIndicator(ind) {
    const data = this.candles;
    if (data.length < 2) return;

    switch (ind.type) {
      case 'SMA': {
        const result = this._calcSMA(data, ind.params.period || 20);
        ind.series[0].setData(result);
        break;
      }
      case 'EMA': {
        const result = this._calcEMA(data, ind.params.period || 20);
        ind.series[0].setData(result);
        break;
      }
      case 'BOLL': {
        const bb = this._calcBollinger(data, ind.params.period || 20, ind.params.stdDev || 2);
        ind.series[0].setData(bb.middle);
        ind.series[1].setData(bb.upper);
        ind.series[2].setData(bb.lower);
        break;
      }
      case 'RSI': {
        const result = this._calcRSI(data, ind.params.period || 14);
        ind.series[0].setData(result);
        break;
      }
      case 'MACD': {
        const m = this._calcMACD(data, ind.params.fast || 12, ind.params.slow || 26, ind.params.signal || 9);
        ind.series[0].setData(m.macd);
        ind.series[1].setData(m.signal);
        ind.series[2].setData(m.histogram);
        break;
      }
      case 'VOL': {
        const volData = data.map(c => ({
          time: c.time,
          value: c.volume || Math.round(Math.random() * 500000 + 100000),
          color: c.close >= c.open ? 'rgba(0,200,83,0.3)' : 'rgba(255,61,87,0.3)'
        }));
        ind.series[0].setData(volData);
        break;
      }
    }
  },

  /** Update all indicators (called after each tick) */
  updateAllIndicators() {
    for (const ind of this.indicators) {
      this._updateIndicator(ind);
    }
  },

  /* ============================
     DRAWING TOOLS
     ============================ */

  /** Start drawing mode */
  startDrawing(type) {
    this.drawingMode = type;
    this.drawingPoints = [];
  },

  /** Cancel drawing */
  cancelDrawing() {
    this.drawingMode = null;
    this.drawingPoints = [];
    // Remove temp series if any
    if (this._tempSeries) {
      try { this.chart.removeSeries(this._tempSeries); } catch(e) {}
      this._tempSeries = null;
    }
  },

  /** Handle a click on the chart (for drawing tools) */
  handleClick(time, price) {
    if (!this.drawingMode) return false;

    this.drawingPoints.push({ time, price });

    switch (this.drawingMode) {
      case 'horzline':
        this._addHorizontalLine(price);
        this.drawingMode = null;
        this.drawingPoints = [];
        return true;

      case 'trendline':
        if (this.drawingPoints.length === 2) {
          this._addTrendLine(this.drawingPoints[0], this.drawingPoints[1]);
          this.drawingMode = null;
          this.drawingPoints = [];
          return true;
        }
        return true;  // waiting for second point

      case 'horzray':
        this._addHorizontalRay(price, time);
        this.drawingMode = null;
        this.drawingPoints = [];
        return true;
    }
    return false;
  },

  /** Add horizontal line at price */
  _addHorizontalLine(price) {
    const id = 'draw-' + (this._nextId++);
    // Use priceLine on the candle series
    const line = this.candleSeries.createPriceLine({
      price: price,
      color: '#FFD700',
      lineWidth: 1,
      lineStyle: 0, // solid
      axisLabelVisible: true,
      title: price.toFixed(2)
    });
    this.drawings.push({ id, type: 'horzline', priceLine: line, price });
    return id;
  },

  /** Add trend line between two points */
  _addTrendLine(p1, p2) {
    const id = 'draw-' + (this._nextId++);
    // Interpolate a line series between the two time points and extend
    const data = this._interpolateLine(p1, p2);
    const s = this.chart.addSeries(LightweightCharts.LineSeries, {
      color: '#FFD700', lineWidth: 1, lineStyle: 0,
      priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false, pointMarkersVisible: false
    });
    s.setData(data);
    this.drawings.push({ id, type: 'trendline', series: s, p1, p2 });
    return id;
  },

  /** Add channel (parallel lines) */
  _addChannel(p1, p2, p3) {
    const id = 'draw-' + (this._nextId++);
    // p1-p2 = main line, p3 = offset point for parallel line
    const data1 = this._interpolateLine(p1, p2);

    // Calculate offset from p3 to the p1-p2 line
    const slope = (p2.price - p1.price) / (p2.time - p1.time);
    const expectedPrice = p1.price + slope * (p3.time - p1.time);
    const offset = p3.price - expectedPrice;

    const p1b = { time: p1.time, price: p1.price + offset };
    const p2b = { time: p2.time, price: p2.price + offset };
    const data2 = this._interpolateLine(p1b, p2b);

    const s1 = this.chart.addSeries(LightweightCharts.LineSeries, {
      color: '#FFD700', lineWidth: 1, lineStyle: 0,
      priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false, pointMarkersVisible: false
    });
    const s2 = this.chart.addSeries(LightweightCharts.LineSeries, {
      color: '#FFD700', lineWidth: 1, lineStyle: 2,
      priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false, pointMarkersVisible: false
    });
    s1.setData(data1);
    s2.setData(data2);
    this.drawings.push({ id, type: 'channel', series: [s1, s2], p1, p2, p3 });
    return id;
  },

  /** Interpolate a trend line between two points, extending forward */
  _interpolateLine(p1, p2) {
    const data = [];
    const times = this.candles.map(c => c.time);
    if (times.length < 2) return data;

    const slope = (p2.price - p1.price) / (p2.time - p1.time || 1);

    // Only include points from p1 onward (not before)
    for (const t of times) {
      if (t < p1.time) continue;
      const price = p1.price + slope * (t - p1.time);
      data.push({ time: t, value: price });
    }
    return data;
  },

  /** Add horizontal ray (from clicked point extending right) */
  _addHorizontalRay(price, startTime) {
    const id = 'draw-' + (this._nextId++);
    const s = this.chart.addSeries(LightweightCharts.LineSeries, {
      color: '#FF9800', lineWidth: 1, lineStyle: 2, // dashed
      priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false, pointMarkersVisible: false
    });
    // Draw from startTime to the latest candle
    const data = [];
    for (const c of this.candles) {
      if (c.time >= startTime) {
        data.push({ time: c.time, value: price });
      }
    }
    s.setData(data);
    this.drawings.push({ id, type: 'horzray', series: s, price, startTime });
    return id;
  },

  /** Remove a drawing */
  removeDrawing(id) {
    const idx = this.drawings.findIndex(d => d.id === id);
    if (idx < 0) return;
    const drawing = this.drawings[idx];

    if (drawing.type === 'horzline') {
      try { this.candleSeries.removePriceLine(drawing.priceLine); } catch(e) {}
    } else if (drawing.type === 'trendline') {
      try { this.chart.removeSeries(drawing.series); } catch(e) {}
    } else if (drawing.type === 'horzray') {
      try { this.chart.removeSeries(drawing.series); } catch(e) {}
    }
    this.drawings.splice(idx, 1);
  },

  /** Remove all drawings */
  clearDrawings() {
    while (this.drawings.length > 0) {
      this.removeDrawing(this.drawings[0].id);
    }
  },

  /** Remove all indicators */
  clearIndicators() {
    while (this.indicators.length > 0) {
      this.removeIndicator(this.indicators[0].id);
    }
  },

  /** Clear everything */
  clearAll() {
    this.clearIndicators();
    this.clearDrawings();
  },

  /** Get list of active indicators for UI */
  getActiveIndicators() {
    return this.indicators.map(i => ({
      id: i.id,
      type: i.type,
      label: this._getLabel(i)
    }));
  },

  /** Get list of active drawings for UI */
  getActiveDrawings() {
    return this.drawings.map(d => ({
      id: d.id,
      type: d.type,
      label: d.type === 'horzline' ? ('H-Line @ ' + d.price.toFixed(2)) :
             d.type === 'trendline' ? 'Trend Line' : 'Channel'
    }));
  },

  _getLabel(ind) {
    switch (ind.type) {
      case 'SMA': return 'SMA(' + (ind.params.period || 20) + ')';
      case 'EMA': return 'EMA(' + (ind.params.period || 20) + ')';
      case 'BOLL': return 'BB(' + (ind.params.period || 20) + ',' + (ind.params.stdDev || 2) + ')';
      case 'RSI': return 'RSI(' + (ind.params.period || 14) + ')';
      case 'MACD': return 'MACD(' + (ind.params.fast || 12) + ',' + (ind.params.slow || 26) + ',' + (ind.params.signal || 9) + ')';
      case 'VOL': return 'Volume';
      default: return ind.type;
    }
  }
};

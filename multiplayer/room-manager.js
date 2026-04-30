/* =========================================================
   Technetos Multiplayer — Room Manager
   Create, join, manage trading rooms
   ========================================================= */

const RoomManager = {
  currentRoom: null,
  currentParticipant: null,
  _priceChannel: null,
  _roomChannel: null,

  /** Generate a 6-character room code */
  _generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I,O,0,1
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  },

  /* =====================================================
     MASTER METHODS
     ===================================================== */

  /** Create a new room (master only) */
  async createRoom(name, params = {}) {
    const sb = getSupabase();
    const code = this._generateCode();
    
    const roomData = {
      code,
      name,
      master_id: Auth.currentUser.id,
      // Explicit lifecycle: room starts in 'waiting' until master clicks START.
      // Students who join before START stay on the waiting screen.
      status: 'waiting',
      ticker: params.ticker || 'AAPL',
      initial_price: params.initialPrice || 185.0,
      drift: params.drift || 0.08,
      volatility: params.volatility || 0.25,
      tick_speed_ms: params.tickSpeed || 600,
      spread_bps: params.spreadBps || 10,
      starting_cash: params.startingCash || 100000,
      pattern_frequency: params.patternFrequency || 30,
      pattern_success_rate: params.patternSuccessRate || 0.70,
      selected_pattern: params.selectedPattern || null,
      enabled_patterns: params.enabledPatterns || [
        'head_and_shoulders','inv_head_and_shoulders','double_top','double_bottom',
        'ascending_triangle','descending_triangle','bull_flag','bear_flag',
        'cup_and_handle','rising_wedge','falling_wedge','symmetrical_triangle'
      ],
      // Margin, Short Selling, Commissions, Interest
      max_leverage: params.maxLeverage || 2.0,
      commission_per_share: params.commissionPerShare || 0.005,
      min_commission: params.minCommission || 1.00,
      cash_interest_rate: params.cashInterestRate || 0.02,
      margin_interest_rate: params.marginInterestRate || 0.08,
      short_selling_enabled: params.shortSellingEnabled !== false,
      maintenance_margin: params.maintenanceMargin || 0.25,
      // Margin call grace period (ticks before forced liquidation)
      margin_call_grace_ticks: params.marginCallGraceTicks || 30
    };

    const { data, error } = await sb.from('rooms').insert(roomData).select().single();
    if (error) throw error;
    this.currentRoom = data;
    return data;
  },

  /** Update room parameters (master only) */
  async updateRoom(updates) {
    if (!this.currentRoom) throw new Error('No active room');
    const sb = getSupabase();
    const { data, error } = await sb
      .from('rooms')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', this.currentRoom.id)
      .select()
      .single();
    if (error) throw error;
    this.currentRoom = data;
    return data;
  },

  /** Start the simulation (master only) */
  async startRoom() {
    return this.updateRoom({ status: 'active', started_at: new Date().toISOString() });
  },

  /** Pause the simulation */
  async pauseRoom() {
    return this.updateRoom({ status: 'paused' });
  },

  /** Resume the simulation */
  async resumeRoom() {
    return this.updateRoom({ status: 'active' });
  },

  /** End the simulation */
  async completeRoom() {
    return this.updateRoom({ status: 'completed', completed_at: new Date().toISOString() });
  },

  /** Get all participants in the current room */
  async getParticipants() {
    if (!this.currentRoom) return [];
    const sb = getSupabase();
    const { data, error } = await sb
      .from('participants')
      .select('*, profiles(email, display_name)')
      .eq('room_id', this.currentRoom.id)
      .order('joined_at', { ascending: true });
    if (error) throw error;
    return data || [];
  },

  /** Get master's room history */
  async getMasterRooms() {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('rooms')
      .select('*, participants(count)')
      .eq('master_id', Auth.currentUser.id)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    return data || [];
  },

  /* =====================================================
     STUDENT METHODS
     ===================================================== */

  /** Join a room by code */
  async joinRoom(code) {
    const sb = getSupabase();
    
    // Find room by code
    const { data: room, error: roomErr } = await sb
      .from('rooms')
      .select('*')
      .eq('code', code.toUpperCase().trim())
      .single();
    if (roomErr || !room) throw new Error('Room not found. Check the code and try again.');
    // Reject any terminal status. Soft-deleted sessions also count as gone.
    if (room.status === 'completed' || room.status === 'deleted') {
      throw new Error('This session has already ended.');
    }

    this.currentRoom = room;

    // Check if already a participant
    const { data: existing } = await sb
      .from('participants')
      .select('*')
      .eq('room_id', room.id)
      .eq('user_id', Auth.currentUser.id)
      .single();

    if (existing) {
      // Reconnecting
      this.currentParticipant = existing;
      await sb.from('participants')
        .update({ is_connected: true })
        .eq('id', existing.id);
      return { room, participant: existing, reconnected: true };
    }

    // Count current participants
    const { count } = await sb
      .from('participants')
      .select('*', { count: 'exact', head: true })
      .eq('room_id', room.id);
    if (count >= 50) throw new Error('This room is full (50 students max).');

    // Join as new participant
    const { data: participant, error: joinErr } = await sb
      .from('participants')
      .insert({
        room_id: room.id,
        user_id: Auth.currentUser.id,
        display_name: Auth.getDisplayName(),
        cash: room.starting_cash
      })
      .select()
      .single();
    if (joinErr) throw joinErr;

    this.currentParticipant = participant;
    return { room, participant, reconnected: false };
  },

  /** Get student's session history */
  async getStudentHistory() {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('participants')
      .select('*, rooms(name, code, ticker, status, created_at), session_metrics(*)')
      .eq('user_id', Auth.currentUser.id)
      .order('joined_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    return data || [];
  },

  /* =====================================================
     REALTIME — Price Broadcasting
     ===================================================== */

  /** Master: broadcast a price tick to all students */
  broadcastPriceTick(tickData) {
    if (!this._priceChannel) return;
    this._priceChannel.send({
      type: 'broadcast',
      event: 'price_tick',
      payload: tickData
    });
  },

  /** Master: broadcast room parameter changes */
  broadcastParamChange(params) {
    if (!this._priceChannel) return;
    this._priceChannel.send({
      type: 'broadcast',
      event: 'param_change',
      payload: params
    });
  },

  /** Master: broadcast simulation control (play/pause/stop) */
  broadcastControl(action) {
    if (!this._priceChannel) return;
    this._priceChannel.send({
      type: 'broadcast',
      event: 'sim_control',
      payload: { action }
    });
  },

  /** Subscribe to price ticks (student) */
  subscribeToPrices(roomId, onTick, onParamChange, onControl) {
    const sb = getSupabase();
    this._priceChannel = sb.channel(`room:${roomId}`, {
      config: { broadcast: { self: false } }
    });

    this._priceChannel
      .on('broadcast', { event: 'price_tick' }, ({ payload }) => {
        if (onTick) onTick(payload);
      })
      .on('broadcast', { event: 'param_change' }, ({ payload }) => {
        if (onParamChange) onParamChange(payload);
      })
      .on('broadcast', { event: 'sim_control' }, ({ payload }) => {
        if (onControl) onControl(payload);
      })
      .subscribe();

    return this._priceChannel;
  },

  /** Master: initialize broadcast channel */
  initBroadcast(roomId) {
    const sb = getSupabase();
    this._priceChannel = sb.channel(`room:${roomId}`, {
      config: { broadcast: { self: false } }
    });
    this._priceChannel.subscribe();
    return this._priceChannel;
  },

  /** Subscribe to participant changes (DB Realtime) */
  subscribeToParticipants(roomId, onChange) {
    const sb = getSupabase();
    this._roomChannel = sb.channel(`room_db:${roomId}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'participants', filter: `room_id=eq.${roomId}` },
        (payload) => { if (onChange) onChange(payload); }
      )
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'orders', filter: `room_id=eq.${roomId}` },
        (payload) => { if (onChange) onChange(payload); }
      )
      .subscribe();
    return this._roomChannel;
  },

  /** Cleanup channels */
  unsubscribeAll() {
    const sb = getSupabase();
    if (this._priceChannel) sb.removeChannel(this._priceChannel);
    if (this._roomChannel) sb.removeChannel(this._roomChannel);
    this._priceChannel = null;
    this._roomChannel = null;
  }
};

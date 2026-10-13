/*
 * event-registration — module.js
 *
 * Owns all live behaviour for the registration widget:
 *   1. Read live availability from the WORKER (never HubDB counts).
 *   2. Build a reserve request and POST it with a stable Idempotency-Key.
 *   3. Branch on the worker's response: waitlisted | confirmed | reserved.
 *   4. For `reserved`, poll GET /api/v1/orders/:id until a paymentUrl appears, then
 *      redirect to the HubSpot-hosted invoice.
 *
 * The worker base URL is configuration (module field / theme setting), injected via the
 * [data-evt-config] JSON block. Nothing here is portal- or tenant-specific.
 */
(function () {
  'use strict';

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function fmtMoney(cents, currency) {
    if (!cents || cents <= 0) return 'Free';
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'AUD' })
        .format(cents / 100);
    } catch (e) {
      return (cents / 100).toFixed(2) + ' ' + (currency || 'AUD');
    }
  }

  function EventRegistration(form) {
    var cfgEl = form.querySelector('[data-evt-config]');
    if (!cfgEl) return;
    var cfg;
    try {
      cfg = JSON.parse(cfgEl.textContent);
    } catch (e) {
      return;
    }

    this.form = form;
    this.cfg = cfg;
    this.statusEl = form.querySelector('[data-evt-status]');
    this.submitBtn = form.querySelector('[data-evt-submit]');
    this.ticketById = {};
    (cfg.ticketTypes || []).forEach(function (t) { this.ticketById[t.id] = t; }, this);

    // Reuse one Idempotency-Key for retries of the SAME logical submission. Cleared on a
    // terminal outcome so the next genuine attempt gets a fresh key.
    this.idemStorageKey = 'evt-idem:' + cfg.workerEventId;
    this.idempotencyKey = null;
    this.submitting = false;

    if (!cfg.workerBaseUrl || !cfg.workerEventId) {
      // Misconfigured — leave the server-rendered notice in place, disable submit.
      if (this.submitBtn) this.submitBtn.disabled = true;
      return;
    }

    this.bind();
    this.loadAvailability();
    this.syncAttendees();
  }

  EventRegistration.prototype.url = function (key, params) {
    var path = this.cfg.endpoints[key];
    Object.keys(params || {}).forEach(function (k) {
      path = path.replace('{' + k + '}', encodeURIComponent(params[k]));
    });
    return this.cfg.workerBaseUrl.replace(/\/$/, '') + path;
  };

  EventRegistration.prototype.headers = function (extra) {
    var h = { 'X-Portal-Id': this.cfg.portalId };
    Object.keys(extra || {}).forEach(function (k) { h[k] = extra[k]; });
    return h;
  };

  EventRegistration.prototype.setStatus = function (msg, kind) {
    if (!this.statusEl) return;
    this.statusEl.hidden = !msg;
    this.statusEl.textContent = msg || '';
    this.statusEl.dataset.kind = kind || '';
  };

  EventRegistration.prototype.bind = function () {
    var self = this;
    this.form.addEventListener('submit', function (e) {
      e.preventDefault();
      self.submit();
    });
    this.form.querySelectorAll('[data-evt-qty]').forEach(function (input) {
      input.addEventListener('change', function () { self.syncAttendees(); });
      input.addEventListener('input', function () { self.syncAttendees(); });
    });
  };

  // --- 1. Live availability from the worker --------------------------------
  EventRegistration.prototype.loadAvailability = function () {
    var self = this;
    fetch(this.url('availability', { slug: this.cfg.workerEventId }), {
      method: 'GET',
      headers: this.headers(),
      credentials: 'omit'
    })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r); })
      .then(function (data) { self.applyAvailability(data); })
      .catch(function () {
        // Availability is advisory for the UI; the worker is still authoritative at
        // reserve time. Let the buyer try rather than blocking on a transient read error.
        self.form.querySelectorAll('[data-evt-avail]').forEach(function (el) {
          el.textContent = '';
        });
      });
  };

  EventRegistration.prototype.applyAvailability = function (data) {
    var byId = {};
    (data && data.ticketTypes || []).forEach(function (t) { byId[t.ticketTypeId] = t; });
    this.availability = byId;

    this.form.querySelectorAll('[data-ticket-id]').forEach(function (row) {
      var id = row.getAttribute('data-ticket-id');
      var a = byId[id];
      var availEl = row.querySelector('[data-evt-avail]');
      var qty = row.querySelector('[data-evt-qty]');
      if (!a) { if (availEl) availEl.textContent = ''; return; }

      if (a.soldOut) {
        if (availEl) { availEl.textContent = a.waitlistAvailable ? 'Sold out — join the waitlist' : 'Sold out'; availEl.dataset.state = 'soldout'; }
        if (qty && !a.waitlistAvailable) { qty.value = '0'; qty.disabled = true; }
      } else if (typeof a.available === 'number' && a.available <= 5) {
        if (availEl) availEl.textContent = a.available + ' left';
      } else if (availEl) {
        availEl.textContent = 'Available';
      }
    });
    this.syncAttendees();
  };

  // --- Group registration: keep attendee rows in step with chosen quantities ----
  EventRegistration.prototype.totalsByTicket = function () {
    var totals = {};
    var total = 0;
    this.form.querySelectorAll('[data-evt-qty]').forEach(function (input) {
      var id = input.closest('[data-ticket-id]').getAttribute('data-ticket-id');
      var n = parseInt(input.value, 10) || 0;
      if (n > 0) { totals[id] = n; total += n; }
    });
    return { byTicket: totals, total: total };
  };

  EventRegistration.prototype.syncAttendees = function () {
    var list = this.form.querySelector('[data-evt-attendee-list]');
    var tpl = this.form.querySelector('[data-evt-attendee-template]');
    if (!list || !tpl || !this.cfg.allowGroup) return;

    var totals = this.totalsByTicket();
    // Flatten the per-ticket quantities into an ordered list of (ticketId) seats.
    var seats = [];
    Object.keys(totals.byTicket).forEach(function (id) {
      for (var i = 0; i < totals.byTicket[id]; i++) seats.push(id);
    });
    if (this.cfg.maxAttendees) seats = seats.slice(0, this.cfg.maxAttendees);

    var rows = list.querySelectorAll('[data-evt-attendee]');
    // Add missing rows.
    for (var i = rows.length; i < seats.length; i++) {
      var frag = tpl.content.cloneNode(true);
      var select = frag.querySelector('[data-evt-attendee-ticket]');
      this.cfg.ticketTypes.forEach(function (t) {
        var opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.name;
        select.appendChild(opt);
      });
      list.appendChild(frag);
    }
    // Remove surplus rows.
    rows = list.querySelectorAll('[data-evt-attendee]');
    for (var j = rows.length - 1; j >= seats.length; j--) rows[j].remove();
    // Default each row's ticket select to the seat's ticket type.
    rows = list.querySelectorAll('[data-evt-attendee]');
    seats.forEach(function (ticketId, idx) {
      var sel = rows[idx] && rows[idx].querySelector('[data-evt-attendee-ticket]');
      if (sel && !sel.dataset.touched) sel.value = ticketId;
      if (sel && !sel.dataset.touched) {
        sel.addEventListener('change', function () { sel.dataset.touched = '1'; });
      }
    });
  };

  // --- 2/3. Build + send the reserve request -------------------------------
  EventRegistration.prototype.buildBody = function () {
    var self = this;
    var buyerName = (this.form.querySelector('[name=buyer_name]') || {}).value || '';
    var buyerEmail = (this.form.querySelector('[name=buyer_email]') || {}).value || '';
    var abnEl = this.form.querySelector('[name=buyer_abn]');
    var buyer = { name: buyerName.trim(), email: buyerEmail.trim() };
    if (abnEl && abnEl.value.trim()) buyer.abn = abnEl.value.replace(/\s+/g, '');

    var body = { buyer: buyer };

    var attendeeRows = this.form.querySelectorAll('[data-evt-attendee]');
    if (this.cfg.allowGroup && attendeeRows.length > 0) {
      body.attendees = [];
      attendeeRows.forEach(function (row) {
        var name = (row.querySelector('[name=attendee_name]') || {}).value || '';
        var email = (row.querySelector('[name=attendee_email]') || {}).value || '';
        var ticket = (row.querySelector('[data-evt-attendee-ticket]') || {}).value || '';
        body.attendees.push({
          name: (name.trim() || buyer.name),
          email: (email.trim() || buyer.email),
          ticketTypeId: ticket
        });
      });
    } else {
      // Non-group path: there are no per-attendee rows, but the buyer can still choose
      // more than one seat (max_per_order > 1). Expand the chosen quantities into one
      // seat each so every selected seat is reserved — sending only the first ticket id
      // would silently drop the rest. A single seat keeps the simpler ticketTypeId shape.
      var totals = self.totalsByTicket();
      var seats = [];
      Object.keys(totals.byTicket).forEach(function (id) {
        for (var i = 0; i < totals.byTicket[id]; i++) seats.push(id);
      });
      if (seats.length > 1) {
        body.attendees = seats.map(function (id) {
          return { name: buyer.name, email: buyer.email, ticketTypeId: id };
        });
      } else {
        body.ticketTypeId = seats[0];
      }
    }
    return body;
  };

  EventRegistration.prototype.validate = function (body) {
    if (!body.buyer.name || !body.buyer.email) return 'Please enter your name and email.';
    var totals = this.totalsByTicket();
    if (totals.total === 0) return 'Please choose at least one ticket.';
    if (body.attendees) {
      for (var i = 0; i < body.attendees.length; i++) {
        if (!body.attendees[i].ticketTypeId) return 'Please choose a ticket for every attendee.';
      }
    } else if (!body.ticketTypeId) {
      return 'Please choose a ticket.';
    }
    return null;
  };

  EventRegistration.prototype.getIdempotencyKey = function () {
    if (this.idempotencyKey) return this.idempotencyKey;
    var stored = null;
    try { stored = sessionStorage.getItem(this.idemStorageKey); } catch (e) {}
    this.idempotencyKey = stored || uuid();
    try { sessionStorage.setItem(this.idemStorageKey, this.idempotencyKey); } catch (e) {}
    return this.idempotencyKey;
  };

  EventRegistration.prototype.clearIdempotencyKey = function () {
    this.idempotencyKey = null;
    try { sessionStorage.removeItem(this.idemStorageKey); } catch (e) {}
  };

  EventRegistration.prototype.submit = function () {
    if (this.submitting) return;
    var self = this;
    var body = this.buildBody();
    var err = this.validate(body);
    if (err) { this.setStatus(err, 'error'); return; }

    this.submitting = true;
    this.form.setAttribute('aria-busy', 'true');
    if (this.submitBtn) this.submitBtn.disabled = true;
    this.setStatus('Reserving your place…', 'pending');

    fetch(this.url('reserve', { slug: this.cfg.workerEventId }), {
      method: 'POST',
      headers: this.headers({
        'Content-Type': 'application/json',
        'Idempotency-Key': this.getIdempotencyKey()
      }),
      credentials: 'omit',
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, json: j }; }); })
      .then(function (res) { return self.handleReserveResponse(res); })
      .catch(function () {
        self.finishAttempt();
        self.setStatus('Something went wrong reaching the booking service. Please try again.', 'error');
      });
  };

  EventRegistration.prototype.handleReserveResponse = function (res) {
    var j = res.json || {};
    switch (j.status) {
      case 'waitlisted':
        this.clearIdempotencyKey();
        this.finishAttempt(true);
        this.setStatus(this.cfg.copy.waitlisted, 'waitlisted');
        return;

      case 'confirmed':
        this.clearIdempotencyKey();
        this.finishAttempt(true);
        this.setStatus(this.cfg.copy.confirmed, 'confirmed');
        return;

      case 'reserved':
        // Paid: a deal + HubSpot invoice are being created asynchronously. Poll the order
        // until the payment link is ready, then hand off to the HubSpot-hosted invoice.
        this.setStatus('Place held — preparing your invoice…', 'pending');
        this.pollOrder(j.orderId || (j.pollUrl || '').split('/').pop());
        return;

      default:
        // ReserveError shapes: members_only, membership_unverified, offer_expired, etc.
        this.clearIdempotencyKey();
        this.finishAttempt();
        this.setStatus(this.friendlyError(j), 'error');
    }
  };

  EventRegistration.prototype.friendlyError = function (j) {
    switch (j && j.status) {
      case 'members_only':
        return 'This ticket is for members only.';
      case 'membership_unverified':
        return 'We couldn’t verify your membership. Please contact support.';
      case 'offer_expired':
      case 'offer_not_open':
      case 'offer_seat_taken':
        return 'That waitlist offer is no longer available.';
      default:
        return (j && j.message) || 'We couldn’t complete your registration. Please try again.';
    }
  };

  // --- 4. Poll the order until the invoice payment link is ready -----------
  EventRegistration.prototype.pollOrder = function (orderId) {
    if (!orderId) { this.finishAttempt(); this.setStatus('Reserved, but we lost track of your order. Please contact support.', 'error'); return; }
    var self = this;
    var attempts = 0;
    var maxAttempts = 40;     // ~2 minutes at 3s
    var intervalMs = 3000;

    (function tick() {
      attempts++;
      fetch(self.url('order', { id: orderId }), {
        method: 'GET',
        headers: self.headers(),
        credentials: 'omit'
      })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(r); })
        .then(function (order) {
          if (order.paymentUrl) {
            // Terminal success — the seat hold is consumed by payment, not here.
            self.clearIdempotencyKey();
            self.setStatus('Redirecting you to payment…', 'confirmed');
            window.location.assign(order.paymentUrl);
            return;
          }
          if (order.status === 'cancelled' || order.status === 'expired') {
            self.clearIdempotencyKey();
            self.finishAttempt();
            self.setStatus('Your reservation expired before payment. Please try again.', 'error');
            return;
          }
          if (attempts >= maxAttempts) {
            self.finishAttempt();
            self.setStatus('Your place is held. We’ll email your invoice shortly.', 'pending');
            return;
          }
          setTimeout(tick, intervalMs);
        })
        .catch(function () {
          if (attempts >= maxAttempts) {
            self.finishAttempt();
            self.setStatus('Your place is held. We’ll email your invoice shortly.', 'pending');
            return;
          }
          setTimeout(tick, intervalMs);
        });
    })();
  };

  EventRegistration.prototype.finishAttempt = function (lock) {
    this.submitting = false;
    this.form.removeAttribute('aria-busy');
    if (this.submitBtn) this.submitBtn.disabled = !!lock;
  };

  function init() {
    document.querySelectorAll('[data-evt-reg]').forEach(function (form) {
      if (form.dataset.evtInit) return;
      form.dataset.evtInit = '1';
      new EventRegistration(form);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

import {
  BADGES,
  DEFAULT_BUILDING,
  DEFAULT_PRICING,
  DISTRICTS,
  RESERVATION_MINUTES,
  billboardPriceCents,
  districtById,
  inhabitantsFor,
  maxFloorsFor,
  plotPriceCents,
  upgradePriceCents,
} from '../../public/js/shared/catalog.js';
import { transaction } from '../db.js';
import { randomId } from './auth.js';
import { HttpError, badRequest, validateBillboardContent, validateBranding, validateDesign } from './validation.js';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const MAX_ACTIVE_RESERVATIONS = 3;

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

// Toute la logique métier de la ville : terrains, panneaux, commandes, social, statistiques.
export function createCityService({ db, live, payments, config }) {
  const q = (sql) => db.prepare(sql);

  // ---------------------------------------------------------------- réglages
  const getSetting = q('SELECT value FROM settings WHERE key = ?');
  const putSetting = q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

  function setting(key, fallback) {
    const row = getSetting.get(key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value);
    } catch {
      return fallback;
    }
  }
  const setSetting = (key, value) => putSetting.run(key, JSON.stringify(value));

  function pricing() {
    const custom = setting('pricing', {});
    return {
      ...DEFAULT_PRICING,
      ...(Number.isInteger(custom.pricePerFloorCents) ? { pricePerFloorCents: custom.pricePerFloorCents } : {}),
    };
  }

  const countByDistrict = q(
    "SELECT district, COUNT(*) AS total, SUM(status = 'owned') AS owned FROM plots GROUP BY district",
  );
  const countOwned = q("SELECT COUNT(*) AS n FROM plots WHERE status = 'owned'");

  function districts() {
    const overrides = setting('districts', {});
    const counts = Object.fromEntries(countByDistrict.all().map((r) => [r.district, r]));
    const ownedTotal = countOwned.get().n;
    return DISTRICTS.map((d) => {
      const o = overrides[d.id] || {};
      const unlocked = typeof o.unlocked === 'boolean' ? o.unlocked : ownedTotal >= d.unlockAt;
      return {
        id: d.id,
        name: d.name,
        color: d.color,
        description: d.description,
        basePriceCents: Number.isInteger(o.basePriceCents) ? o.basePriceCents : d.basePriceCents,
        billboardMonthCents: Number.isInteger(o.billboardMonthCents) ? o.billboardMonthCents : d.billboardMonthCents,
        unlockAt: d.unlockAt,
        unlocked,
        forced: typeof o.unlocked === 'boolean',
        total: counts[d.id]?.total ?? 0,
        owned: counts[d.id]?.owned ?? 0,
      };
    });
  }
  const district = (id) => districts().find((d) => d.id === id);

  // Détecte les quartiers qui viennent d'ouvrir et l'annonce à toute la ville.
  function checkUnlocks() {
    const known = new Set(setting('announced_districts', DISTRICTS.filter((d) => d.unlockAt === 0).map((d) => d.id)));
    let changed = false;
    for (const d of districts()) {
      if (d.unlocked && !known.has(d.id)) {
        known.add(d.id);
        changed = true;
        logEvent('district', null, 'district', null, `Nouveau quartier ouvert : ${d.name} !`);
        live.broadcast('districts', { districts: districts() });
      }
    }
    if (changed) setSetting('announced_districts', [...known]);
  }

  // ---------------------------------------------------------------- événements
  const insertEvent = q(
    'INSERT INTO events (type, user_id, target_type, target, message, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const recentEvents = q(
    `SELECT e.id, e.type, e.target_type, e.target, e.message, e.created_at, u.username
     FROM events e LEFT JOIN users u ON u.id = e.user_id ORDER BY e.id DESC LIMIT ?`,
  );

  function serializeEvent(row) {
    return {
      id: row.id,
      type: row.type,
      targetType: row.target_type,
      target: row.target,
      username: row.username ?? null,
      message: row.message,
      at: iso(row.created_at),
    };
  }

  function logEvent(type, user, targetType, target, message) {
    const now = Date.now();
    const info = insertEvent.run(type, user?.id ?? null, targetType, target, message, now);
    const event = serializeEvent({
      id: Number(info.lastInsertRowid),
      type,
      target_type: targetType,
      target,
      message,
      created_at: now,
      username: user?.username,
    });
    live.broadcast('event', event);
    return event;
  }

  // ---------------------------------------------------------------- sérialisation
  const plotRow = q(
    `SELECT p.*, u.username AS owner_name, (SELECT COUNT(*) FROM likes l WHERE l.plot_number = p.number) AS likes
     FROM plots p LEFT JOIN users u ON u.id = p.owner_id WHERE p.number = ?`,
  );
  const plotRowsActive = q(
    `SELECT p.number, p.x, p.y, p.district, p.facing, p.status, p.owner_id, p.reserved_by, p.reserved_until,
            p.purchased_at, p.floors, p.shape, p.roof_style, p.windows, p.color, p.roof_color, p.accent_color,
            p.brand_name, p.description, p.website, p.logo_mime, p.updated_at, u.username AS owner_name,
            (SELECT COUNT(*) FROM likes l WHERE l.plot_number = p.number) AS likes
     FROM plots p LEFT JOIN users u ON u.id = p.owner_id WHERE p.status != 'free' ORDER BY p.number`,
  );
  const billboardRow = q(
    `SELECT b.*, u.username AS renter_name FROM billboards b LEFT JOIN users u ON u.id = b.renter_id WHERE b.number = ?`,
  );
  const billboardRows = q(
    `SELECT b.number, b.x, b.y, b.district, b.facing, b.status, b.renter_id, b.reserved_by, b.reserved_until,
            b.rented_until, b.brand_name, b.message, b.website, b.color, b.image_mime, b.updated_at,
            u.username AS renter_name
     FROM billboards b LEFT JOIN users u ON u.id = b.renter_id ORDER BY b.number`,
  );

  function serializePlot(row) {
    if (!row) return null;
    const owned = row.status === 'owned';
    return {
      number: row.number,
      x: row.x,
      y: row.y,
      district: row.district,
      facing: row.facing,
      status: row.status,
      reservedUntil: row.status === 'reserved' ? iso(row.reserved_until) : null,
      owner: owned && row.owner_name ? row.owner_name : null,
      purchasedAt: owned ? iso(row.purchased_at) : null,
      likes: row.likes ?? 0,
      building: owned
        ? {
            floors: row.floors,
            shape: row.shape,
            roofStyle: row.roof_style,
            windows: row.windows,
            color: row.color,
            roofColor: row.roof_color,
            accentColor: row.accent_color,
            brandName: row.brand_name || '',
            description: row.description || '',
            website: row.website || '',
            logo: row.logo_mime ? `/api/media/plot/${row.number}?v=${row.updated_at}` : null,
          }
        : null,
    };
  }

  function serializeBillboard(row) {
    if (!row) return null;
    const rented = row.status === 'rented';
    return {
      number: row.number,
      x: row.x,
      y: row.y,
      district: row.district,
      facing: row.facing,
      status: row.status,
      reservedUntil: row.status === 'reserved' ? iso(row.reserved_until) : null,
      rentedUntil: rented ? iso(row.rented_until) : null,
      renter: rented ? row.renter_name ?? null : null,
      ad: rented
        ? {
            brandName: row.brand_name || '',
            message: row.message || '',
            website: row.website || '',
            color: row.color || '#1f2a44',
            image: row.image_mime ? `/api/media/billboard/${row.number}?v=${row.updated_at}` : null,
          }
        : null,
    };
  }

  const getPlot = (number) => serializePlot(plotRow.get(number));
  const getBillboard = (number) => serializeBillboard(billboardRow.get(number));

  function broadcastPlot(number) {
    live.broadcast('plot', { plot: getPlot(number) });
  }
  function broadcastBillboard(number) {
    live.broadcast('billboard', { billboard: getBillboard(number) });
  }

  // ---------------------------------------------------------------- état global
  function cityState() {
    return {
      seed: config.citySeed,
      currency: config.currency.toUpperCase(),
      payments: payments.mode,
      pricing: pricing(),
      districts: districts(),
      plots: plotRowsActive.all().map(serializePlot),
      billboards: billboardRows.all().map(serializeBillboard),
      stats: stats(),
      announcement: setting('announcement', null),
    };
  }

  const statsQuery = q(
    `SELECT COUNT(*) AS total, SUM(status = 'owned') AS owned, SUM(CASE WHEN status = 'owned' THEN floors ELSE 0 END) AS floors,
            COUNT(DISTINCT owner_id) AS owners
     FROM plots`,
  );
  const inhabitantsQuery = q("SELECT floors, shape FROM plots WHERE status = 'owned'");
  const usersCount = q('SELECT COUNT(*) AS n FROM users');
  const boardsCount = q("SELECT COUNT(*) AS total, SUM(status = 'rented') AS rented FROM billboards");
  const visits24 = q('SELECT COUNT(*) AS n FROM visits WHERE hour >= ?');
  const tallestQ = q("SELECT MAX(floors) AS m FROM plots WHERE status = 'owned'");

  function stats() {
    const s = statsQuery.get();
    const b = boardsCount.get();
    const inhabitants = inhabitantsQuery.all().reduce((sum, r) => sum + inhabitantsFor(r.floors, r.shape), 0);
    return {
      plotsTotal: s.total,
      plotsOwned: s.owned ?? 0,
      floors: s.floors ?? 0,
      owners: s.owners ?? 0,
      inhabitants,
      tallest: tallestQ.get().m ?? 0,
      citizens: usersCount.get().n,
      billboardsTotal: b.total,
      billboardsRented: b.rented ?? 0,
      visits24h: visits24.get(hourBucket() - 24).n,
      online: live.onlineCount(),
    };
  }

  // ---------------------------------------------------------------- maintenance
  const expirePlotReservations = q(
    "UPDATE plots SET status = 'free', reserved_by = NULL, reserved_until = NULL WHERE status = 'reserved' AND reserved_until <= ? RETURNING number",
  );
  const expireBoardReservations = q(
    "UPDATE billboards SET status = 'free', reserved_by = NULL, reserved_until = NULL WHERE status = 'reserved' AND reserved_until <= ? RETURNING number",
  );
  const expiredRentals = q("SELECT number, renter_id FROM billboards WHERE status = 'rented' AND rented_until <= ?");
  const expireOrders = q("UPDATE orders SET status = 'expired' WHERE status = 'pending' AND created_at <= ?");
  const purgeVisits = q('DELETE FROM visits WHERE hour < ?');

  function sweep() {
    const now = Date.now();
    const plots = expirePlotReservations.all(now);
    const boards = expireBoardReservations.all(now);
    for (const r of expiredRentals.all(now)) {
      resetBillboard(r.number);
      logEvent('billboard', null, 'billboard', r.number, `Le panneau #${r.number} est de nouveau à louer.`);
      boards.push({ number: r.number });
    }
    expireOrders.run(now - 2 * DAY);
    purgeVisits.run(hourBucket() - 24 * 30);
    for (const p of plots) broadcastPlot(p.number);
    for (const b of boards) broadcastBillboard(b.number);
  }

  // ---------------------------------------------------------------- commandes
  const insertOrder = q(
    `INSERT INTO orders (id, kind, target, user_id, amount_cents, currency, status, provider, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  );
  const getOrder = q('SELECT * FROM orders WHERE id = ?');
  const getOrderByRef = q('SELECT * FROM orders WHERE provider_ref = ?');
  const setOrderRef = q('UPDATE orders SET provider_ref = ? WHERE id = ?');
  const markOrderPaid = q("UPDATE orders SET status = 'paid', paid_at = ?, payload = ? WHERE id = ?");
  const markOrderCancelled = q("UPDATE orders SET status = 'cancelled' WHERE id = ? AND status = 'pending'");
  const activeReservations = q(
    "SELECT COUNT(*) AS n FROM plots WHERE status = 'reserved' AND reserved_by = ? AND reserved_until > ?",
  );

  function createOrder(kind, target, user, amount, payload) {
    const order = {
      id: `ord_${randomId(12)}`,
      kind,
      target,
      user_id: user.id,
      amount_cents: amount,
      currency: config.currency,
      provider: payments.mode,
      payload: JSON.stringify(payload),
      created_at: Date.now(),
    };
    insertOrder.run(order.id, kind, target, user.id, amount, order.currency, order.provider, order.payload, order.created_at);
    return order;
  }

  // Lance le paiement. En mode démo, la commande est honorée immédiatement.
  async function startPayment(order, user, title, description, rollback) {
    if (!payments.enabled) {
      const result = fulfillOrder(order.id);
      return { demo: true, fulfilled: true, orderId: order.id, ...result };
    }
    try {
      const session = await payments.createCheckout({ order, title, description, customerEmail: user.email });
      setOrderRef.run(session.ref, order.id);
      return { demo: false, url: session.url, orderId: order.id };
    } catch (err) {
      transaction(db, () => {
        markOrderCancelled.run(order.id);
        rollback();
      });
      throw err;
    }
  }

  const encodeImage = (img) => (img ? { mime: img.mime, data: img.data.toString('base64') } : img);
  const decodeStored = (img) => (img ? { mime: img.mime, data: Buffer.from(img.data, 'base64') } : img);

  const reservePlotStmt = q(
    "UPDATE plots SET status = 'reserved', reserved_by = ?, reserved_until = ? WHERE number = ? AND (status = 'free' OR (status = 'reserved' AND (reserved_by = ? OR reserved_until <= ?)))",
  );
  const releasePlotStmt = q(
    "UPDATE plots SET status = 'free', reserved_by = NULL, reserved_until = NULL WHERE number = ? AND status = 'reserved' AND reserved_by = ?",
  );

  // Résout le bénéficiaire d'une construction/location faite par un administrateur (lui-même par défaut).
  function adminBeneficiary(admin, username) {
    const name = String(username ?? '').trim();
    if (!name || name.toLowerCase() === admin.username.toLowerCase()) return admin;
    const target = findUserByName.get(name);
    if (!target || target.banned) throw new HttpError(404, `Habitant « ${name} » introuvable.`);
    return target;
  }

  // Construction gratuite par l'administration : pas de paiement, pas de restriction de quartier.
  function adminBuild(admin, number, body) {
    const row = plotRow.get(number);
    if (!row) throw new HttpError(404, 'Terrain introuvable.');
    if (row.status === 'owned') throw new HttpError(409, 'Ce terrain est déjà construit : modifiez l\'immeuble existant.');
    const design = validateDesign(body.design ?? body);
    const branding = validateBranding(body.branding ?? body);
    const owner = adminBeneficiary(admin, body.owner);
    transaction(db, () => {
      ownPlot.run(owner.id, Date.now(), 0, number);
      applyDesign(number, design);
      applyBranding(number, branding);
    });
    logEvent(
      'purchase',
      owner,
      'plot',
      number,
      owner.id === admin.id
        ? `La mairie construit ${branding.brandName ? `« ${branding.brandName} »` : 'un immeuble'} sur le terrain #${number}.`
        : `La mairie offre le terrain #${number} à ${owner.username} !`,
    );
    broadcastPlot(number);
    checkUnlocks();
    return { admin: true, fulfilled: true, kind: 'plot', target: number, plot: getPlot(number) };
  }

  async function checkoutPlot(user, number, body) {
    if (user.role === 'admin') return adminBuild(user, number, body);
    const row = plotRow.get(number);
    if (!row) throw new HttpError(404, 'Terrain introuvable.');
    const d = district(row.district);
    if (!d.unlocked) throw badRequest(`Le quartier ${d.name} n'est pas encore ouvert.`);
    const design = validateDesign(body.design ?? body);
    const branding = validateBranding(body.branding ?? body);
    const amount = plotPriceCents(d, design.floors, pricing());
    const now = Date.now();

    const order = transaction(db, () => {
      if (activeReservations.get(user.id, now).n >= MAX_ACTIVE_RESERVATIONS) {
        throw new HttpError(429, 'Trop de terrains réservés en même temps. Finalisez ou annulez vos paiements en cours.');
      }
      const res = reservePlotStmt.run(user.id, now + RESERVATION_MINUTES * 60_000, number, user.id, now);
      if (res.changes === 0) throw new HttpError(409, 'Ce terrain vient d\'être réservé par quelqu\'un d\'autre.');
      return createOrder('plot', number, user, amount, { design, branding: { ...branding, logo: encodeImage(branding.logo) } });
    });
    broadcastPlot(number);
    return startPayment(order, user, `Terrain #${number} — ${d.name}`, `Immeuble de ${design.floors} étage(s)`, () => {
      releasePlotStmt.run(number, user.id);
      broadcastPlot(number);
    });
  }

  const updatePlotBuilding = q(
    `UPDATE plots SET floors = ?, shape = ?, roof_style = ?, windows = ?, color = ?, roof_color = ?, accent_color = ?, updated_at = ?
     WHERE number = ?`,
  );
  const updatePlotText = q(
    'UPDATE plots SET brand_name = ?, description = ?, website = ?, updated_at = ? WHERE number = ?',
  );
  const updatePlotLogo = q('UPDATE plots SET logo_mime = ?, logo = ?, updated_at = ? WHERE number = ?');
  const ownPlot = q(
    "UPDATE plots SET status = 'owned', owner_id = ?, reserved_by = NULL, reserved_until = NULL, purchased_at = ?, price_paid_cents = ? WHERE number = ?",
  );
  const addPaid = q('UPDATE plots SET price_paid_cents = price_paid_cents + ? WHERE number = ?');

  function applyDesign(number, design) {
    updatePlotBuilding.run(
      design.floors,
      design.shape,
      design.roofStyle,
      design.windows,
      design.color,
      design.roofColor,
      design.accentColor,
      Date.now(),
      number,
    );
  }

  function applyBranding(number, branding, current = {}) {
    if (branding.brandName !== undefined || branding.description !== undefined || branding.website !== undefined) {
      updatePlotText.run(
        branding.brandName ?? current.brand_name ?? '',
        branding.description ?? current.description ?? '',
        branding.website ?? current.website ?? '',
        Date.now(),
        number,
      );
    }
    if (branding.logo !== undefined) {
      updatePlotLogo.run(branding.logo?.mime ?? null, branding.logo?.data ?? null, Date.now(), number);
    }
  }

  // Honore une commande payée. Idempotent : peut être appelé par le webhook ET par le retour navigateur.
  function fulfillOrder(orderId) {
    let notify = null;
    const result = transaction(db, () => {
      const order = getOrder.get(orderId);
      if (!order) throw new HttpError(404, 'Commande introuvable.');
      if (order.status === 'paid') return { order: order.id, kind: order.kind, target: order.target, already: true };
      const payload = JSON.parse(order.payload);
      const user = order.user_id ? db.prepare('SELECT id, username FROM users WHERE id = ?').get(order.user_id) : null;
      const now = Date.now();
      let conflict = false;

      if (order.kind === 'plot') {
        const row = plotRow.get(order.target);
        const available =
          user && (row.status === 'free' || (row.status === 'reserved' && (row.reserved_by === user.id || row.reserved_until <= now)));
        if (available) {
          ownPlot.run(user.id, now, order.amount_cents, order.target);
          applyDesign(order.target, payload.design);
          applyBranding(order.target, { ...payload.branding, logo: decodeStored(payload.branding.logo) });
          const label = payload.branding.brandName ? ` pour y installer « ${payload.branding.brandName} »` : '';
          notify = () => {
            logEvent('purchase', user, 'plot', order.target, `${user.username} a acquis le terrain #${order.target}${label}.`);
            broadcastPlot(order.target);
            checkUnlocks();
          };
        } else conflict = true;
      } else if (order.kind === 'upgrade') {
        const row = plotRow.get(order.target);
        if (user && row.status === 'owned' && row.owner_id === user.id) {
          // La forme a pu changer depuis la commande : on borne à ce qu'elle accepte.
          const current = rowToDesign(row);
          applyDesign(order.target, { ...current, floors: Math.min(payload.floors, maxFloorsFor(current.shape)) });
          addPaid.run(order.amount_cents, order.target);
          notify = () => {
            logEvent('upgrade', user, 'plot', order.target, `${user.username} a surélevé le terrain #${order.target} à ${payload.floors} étages.`);
            broadcastPlot(order.target);
          };
        } else conflict = true;
      } else if (order.kind === 'billboard') {
        const row = billboardRow.get(order.target);
        const extending = row.status === 'rented' && row.renter_id === user?.id;
        const available =
          user &&
          (extending ||
            row.status === 'free' ||
            (row.status === 'reserved' && (row.reserved_by === user.id || row.reserved_until <= now)));
        if (available) {
          const start = extending ? Math.max(now, row.rented_until) : now;
          rentBillboard.run(user.id, start + payload.months * MONTH, order.target);
          applyBillboardContent(order.target, { ...payload.content, image: decodeStored(payload.content.image) });
          notify = () => {
            const brand = payload.content.brandName || user.username;
            logEvent(
              'billboard',
              user,
              'billboard',
              order.target,
              extending ? `${brand} prolonge sa pub sur le panneau #${order.target}.` : `${brand} affiche sa pub sur le panneau #${order.target}.`,
            );
            broadcastBillboard(order.target);
          };
        } else conflict = true;
      }

      // Paiement reçu mais cible perdue entre-temps (réservation expirée et reprise) : on garde une trace
      // pour que l'administration procède au remboursement.
      markOrderPaid.run(now, JSON.stringify({ ...payload, conflict }), order.id);
      if (conflict) {
        notify = () =>
          logEvent('system', null, 'order', null, `Commande ${order.id} payée mais cible indisponible : remboursement à prévoir.`);
      }
      return { order: order.id, kind: order.kind, target: order.target, conflict };
    });
    notify?.();
    return result;
  }

  async function confirmStripeSession(sessionId) {
    const session = await payments.retrieveSession(sessionId);
    if (!session) throw badRequest('Session de paiement invalide.');
    const order = getOrderByRef.get(session.id) || getOrder.get(session.client_reference_id || '');
    if (!order) throw new HttpError(404, 'Commande introuvable.');
    if (session.payment_status !== 'paid') return { order: order.id, paid: false, kind: order.kind, target: order.target };
    return { ...fulfillOrder(order.id), paid: true };
  }

  function handleWebhookEvent(event) {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object;
      if (session.payment_status !== 'paid') return;
      const order = getOrderByRef.get(session.id) || getOrder.get(session.client_reference_id || '');
      if (order) fulfillOrder(order.id);
    } else if (event.type === 'checkout.session.expired') {
      const order = getOrderByRef.get(event.data.object.id);
      if (order) cancelOrder(order.id, order.user_id, { silent: true });
    }
  }

  function cancelOrder(orderId, userId) {
    const order = getOrder.get(orderId);
    if (!order || order.user_id !== userId) throw new HttpError(404, 'Commande introuvable.');
    if (order.status !== 'pending') return { cancelled: false };
    transaction(db, () => {
      markOrderCancelled.run(order.id);
      if (order.kind === 'plot') releasePlotStmt.run(order.target, userId);
      if (order.kind === 'billboard') releaseBoardStmt.run(order.target, userId);
    });
    if (order.kind === 'plot') broadcastPlot(order.target);
    if (order.kind === 'billboard') broadcastBillboard(order.target);
    return { cancelled: true };
  }

  // ---------------------------------------------------------------- immeubles
  function rowToDesign(row) {
    return {
      floors: row.floors ?? DEFAULT_BUILDING.floors,
      shape: row.shape ?? DEFAULT_BUILDING.shape,
      roofStyle: row.roof_style ?? DEFAULT_BUILDING.roofStyle,
      windows: row.windows ?? DEFAULT_BUILDING.windows,
      color: row.color ?? DEFAULT_BUILDING.color,
      roofColor: row.roof_color ?? DEFAULT_BUILDING.roofColor,
      accentColor: row.accent_color ?? DEFAULT_BUILDING.accentColor,
    };
  }

  function requireOwnedPlot(user, number) {
    const row = plotRow.get(number);
    if (!row) throw new HttpError(404, 'Terrain introuvable.');
    if (row.status !== 'owned' || (row.owner_id !== user.id && user.role !== 'admin')) {
      throw new HttpError(403, "Ce terrain ne vous appartient pas.");
    }
    return row;
  }

  // Modifie un immeuble. Les changements gratuits sont appliqués tout de suite ;
  // des étages supplémentaires déclenchent un paiement (différence de prix).
  async function updateBuilding(user, number, body) {
    const row = requireOwnedPlot(user, number);
    const current = rowToDesign(row);
    const design = validateDesign(body.design ?? {}, current);
    const branding = validateBranding(body.branding ?? {});
    const extra = upgradePriceCents(current.floors, design.floors, pricing());
    // L'administration ne paie jamais ; un propriétaire paie les étages supplémentaires.
    const paidFloors = extra > 0 && user.role !== 'admin' ? design.floors : null;
    const immediate = { ...design, floors: paidFloors ? current.floors : design.floors };
    // La forme choisie doit accepter la hauteur actuelle en attendant la surélévation.
    validateDesign(immediate, current);

    transaction(db, () => {
      applyDesign(number, immediate);
      applyBranding(number, branding, row);
    });
    const changed = JSON.stringify(immediate) !== JSON.stringify(current) || Object.keys(branding).length > 0;
    if (changed) {
      const name = branding.brandName ?? row.brand_name;
      logEvent('update', user, 'plot', number, `${user.username} a rénové ${name ? `« ${name} »` : `le terrain #${number}`}.`);
      broadcastPlot(number);
    }
    if (!paidFloors) return { plot: getPlot(number) };
    const order = createOrder('upgrade', number, user, extra, { floors: paidFloors });
    const payment = await startPayment(order, user, `Surélévation du terrain #${number}`, `${current.floors} → ${paidFloors} étages`, () => {});
    return { plot: getPlot(number), payment };
  }

  const resetPlotStmt = q(
    `UPDATE plots SET status = 'free', owner_id = NULL, reserved_by = NULL, reserved_until = NULL, purchased_at = NULL,
       price_paid_cents = 0, floors = NULL, shape = NULL, roof_style = NULL, windows = NULL, color = NULL, roof_color = NULL,
       accent_color = NULL, brand_name = NULL, description = NULL, website = NULL, logo_mime = NULL, logo = NULL, updated_at = ?
     WHERE number = ?`,
  );

  function resetPlot(number) {
    transaction(db, () => {
      db.prepare('DELETE FROM likes WHERE plot_number = ?').run(number);
      db.prepare('DELETE FROM guestbook WHERE plot_number = ?').run(number);
      resetPlotStmt.run(Date.now(), number);
    });
    broadcastPlot(number);
  }

  function demolish(user, number) {
    const row = requireOwnedPlot(user, number);
    resetPlot(number);
    logEvent('demolish', user, 'plot', number, `Le terrain #${number}${row.brand_name ? ` (« ${row.brand_name} »)` : ''} est de nouveau à vendre.`);
    return { ok: true };
  }

  const findUserByName = q('SELECT id, username, banned FROM users WHERE username = ?');
  const transferStmt = q('UPDATE plots SET owner_id = ?, updated_at = ? WHERE number = ?');

  function transfer(user, number, username) {
    const row = requireOwnedPlot(user, number);
    const target = findUserByName.get(String(username || '').trim());
    if (!target || target.banned) throw new HttpError(404, 'Habitant introuvable.');
    if (target.id === row.owner_id) throw badRequest('Ce terrain lui appartient déjà.');
    transferStmt.run(target.id, Date.now(), number);
    db.prepare('DELETE FROM likes WHERE plot_number = ? AND user_id = ?').run(number, target.id);
    logEvent('transfer', user, 'plot', number, `${user.username} a offert le terrain #${number} à ${target.username}.`);
    broadcastPlot(number);
    return { plot: getPlot(number) };
  }

  // ---------------------------------------------------------------- panneaux
  const reserveBoardStmt = q(
    "UPDATE billboards SET status = 'reserved', reserved_by = ?, reserved_until = ? WHERE number = ? AND (status = 'free' OR (status = 'reserved' AND (reserved_by = ? OR reserved_until <= ?)))",
  );
  const releaseBoardStmt = q(
    "UPDATE billboards SET status = 'free', reserved_by = NULL, reserved_until = NULL WHERE number = ? AND status = 'reserved' AND reserved_by = ?",
  );
  const rentBillboard = q(
    "UPDATE billboards SET status = 'rented', renter_id = ?, rented_until = ?, reserved_by = NULL, reserved_until = NULL WHERE number = ?",
  );
  const updateBoardText = q(
    'UPDATE billboards SET brand_name = ?, message = ?, website = ?, color = ?, updated_at = ? WHERE number = ?',
  );
  const updateBoardImage = q('UPDATE billboards SET image_mime = ?, image = ?, updated_at = ? WHERE number = ?');
  const resetBoardStmt = q(
    `UPDATE billboards SET status = 'free', renter_id = NULL, reserved_by = NULL, reserved_until = NULL, rented_until = NULL,
       brand_name = NULL, message = NULL, website = NULL, color = NULL, image_mime = NULL, image = NULL, updated_at = ?
     WHERE number = ?`,
  );

  function applyBillboardContent(number, content, current = {}) {
    updateBoardText.run(
      content.brandName ?? current.brand_name ?? '',
      content.message ?? current.message ?? '',
      content.website ?? current.website ?? '',
      content.color ?? current.color ?? '#1f2a44',
      Date.now(),
      number,
    );
    if (content.image !== undefined) updateBoardImage.run(content.image?.mime ?? null, content.image?.data ?? null, Date.now(), number);
  }

  function resetBillboard(number) {
    resetBoardStmt.run(Date.now(), number);
  }

  // Location gratuite par l'administration (campagnes de la mairie, partenaires…).
  function adminRent(admin, number, body) {
    const row = billboardRow.get(number);
    if (!row) throw new HttpError(404, 'Panneau introuvable.');
    const months = Number(body.months ?? 1);
    if (!Number.isInteger(months) || months < 1 || months > 120) throw badRequest('Durée invalide (1 à 120 mois).');
    const content = validateBillboardContent(body.content ?? body);
    if (!content.brandName && !content.image) throw badRequest('Indiquez au moins un nom de marque ou un visuel.');
    const renter = adminBeneficiary(admin, body.owner);
    const now = Date.now();
    const extending = row.status === 'rented' && row.renter_id === renter.id;
    if (row.status === 'rented' && !extending) resetBillboard(number);
    const start = extending ? Math.max(now, row.rented_until) : now;
    rentBillboard.run(renter.id, start + months * MONTH, number);
    applyBillboardContent(number, content);
    logEvent('billboard', renter, 'billboard', number, `${content.brandName || renter.username} affiche sa pub sur le panneau #${number}.`);
    broadcastBillboard(number);
    return { admin: true, fulfilled: true, kind: 'billboard', target: number, billboard: getBillboard(number) };
  }

  async function checkoutBillboard(user, number, body) {
    if (user.role === 'admin') return adminRent(user, number, body);
    const row = billboardRow.get(number);
    if (!row) throw new HttpError(404, 'Panneau introuvable.');
    const d = district(row.district);
    if (!d.unlocked) throw badRequest(`Le quartier ${d.name} n'est pas encore ouvert.`);
    const months = Number(body.months);
    const amount = billboardPriceCents(d, months, pricing());
    if (amount == null) throw badRequest('Durée de location invalide.');
    const content = validateBillboardContent(body.content ?? body);
    if (!content.brandName && !content.image) throw badRequest('Indiquez au moins un nom de marque ou un visuel.');
    const now = Date.now();
    const extending = row.status === 'rented' && row.renter_id === user.id;

    const order = transaction(db, () => {
      if (!extending) {
        const res = reserveBoardStmt.run(user.id, now + RESERVATION_MINUTES * 60_000, number, user.id, now);
        if (res.changes === 0) throw new HttpError(409, 'Ce panneau est déjà loué ou réservé.');
      }
      return createOrder('billboard', number, user, amount, { months, content: { ...content, image: encodeImage(content.image) } });
    });
    if (!extending) broadcastBillboard(number);
    return startPayment(order, user, `Panneau #${number} — ${d.name}`, `Location ${months} mois`, () => {
      if (!extending) {
        releaseBoardStmt.run(number, user.id);
        broadcastBillboard(number);
      }
    });
  }

  function requireRentedBillboard(user, number) {
    const row = billboardRow.get(number);
    if (!row) throw new HttpError(404, 'Panneau introuvable.');
    if (row.status !== 'rented' || (row.renter_id !== user.id && user.role !== 'admin')) {
      throw new HttpError(403, "Vous ne louez pas ce panneau.");
    }
    return row;
  }

  function updateBillboard(user, number, body) {
    const row = requireRentedBillboard(user, number);
    const content = validateBillboardContent(body);
    applyBillboardContent(number, content, row);
    broadcastBillboard(number);
    return { billboard: getBillboard(number) };
  }

  function releaseBillboard(user, number) {
    requireRentedBillboard(user, number);
    resetBillboard(number);
    logEvent('billboard', user, 'billboard', number, `Le panneau #${number} est de nouveau à louer.`);
    broadcastBillboard(number);
    return { ok: true };
  }

  // ---------------------------------------------------------------- médias
  const plotLogo = q('SELECT logo_mime, logo FROM plots WHERE number = ?');
  const boardImage = q('SELECT image_mime, image FROM billboards WHERE number = ?');
  function media(type, number) {
    const row = type === 'plot' ? plotLogo.get(number) : type === 'billboard' ? boardImage.get(number) : null;
    if (!row) return null;
    const mime = row.logo_mime ?? row.image_mime;
    const data = row.logo ?? row.image;
    return mime && data ? { mime, data: Buffer.from(data) } : null;
  }

  // ---------------------------------------------------------------- social
  function hourBucket(ms = Date.now()) {
    return Math.floor(ms / HOUR);
  }

  const insertVisit = q('INSERT OR IGNORE INTO visits (target_type, target, visitor, hour) VALUES (?, ?, ?, ?)');
  const visitsFor = q('SELECT COUNT(*) AS n FROM visits WHERE target_type = ? AND target = ? AND hour >= ?');
  function recordVisit(type, number, visitor) {
    if (type !== 'plot' && type !== 'billboard') throw badRequest('Type de visite invalide.');
    insertVisit.run(type, number, visitor, hourBucket());
    return { visits24h: visitsFor.get(type, number, hourBucket() - 24).n };
  }

  const likeStmt = q('INSERT OR IGNORE INTO likes (user_id, plot_number, created_at) VALUES (?, ?, ?)');
  const unlikeStmt = q('DELETE FROM likes WHERE user_id = ? AND plot_number = ?');
  const hasLiked = q('SELECT 1 FROM likes WHERE user_id = ? AND plot_number = ?');
  const likesCount = q('SELECT COUNT(*) AS n FROM likes WHERE plot_number = ?');

  function like(user, number, value) {
    const row = plotRow.get(number);
    if (!row || row.status !== 'owned') throw new HttpError(404, 'Immeuble introuvable.');
    if (row.owner_id === user.id) throw badRequest('Impossible d\'aimer son propre immeuble.');
    if (value) {
      const res = likeStmt.run(user.id, number, Date.now());
      if (res.changes) live.broadcast('like', { number, likes: likesCount.get(number).n });
    } else if (unlikeStmt.run(user.id, number).changes) {
      live.broadcast('like', { number, likes: likesCount.get(number).n });
    }
    return { liked: value, likes: likesCount.get(number).n };
  }

  const guestbookList = q(
    `SELECT g.id, g.body, g.created_at, u.username FROM guestbook g JOIN users u ON u.id = g.user_id
     WHERE g.plot_number = ? AND g.hidden = 0 ORDER BY g.id DESC LIMIT 30`,
  );
  const insertGuestbook = q('INSERT INTO guestbook (plot_number, user_id, body, created_at) VALUES (?, ?, ?, ?)');
  const getGuestbook = q(
    'SELECT g.*, p.owner_id FROM guestbook g JOIN plots p ON p.number = g.plot_number WHERE g.id = ?',
  );
  const deleteGuestbookStmt = q('DELETE FROM guestbook WHERE id = ?');

  const serializeMessage = (r) => ({ id: r.id, body: r.body, author: r.username, at: iso(r.created_at) });

  function postGuestbook(user, number, body, cleaned) {
    const row = plotRow.get(number);
    if (!row || row.status !== 'owned') throw new HttpError(404, 'Immeuble introuvable.');
    if (!cleaned) throw badRequest('Message vide.');
    const info = insertGuestbook.run(number, user.id, cleaned, Date.now());
    const message = serializeMessage({ id: Number(info.lastInsertRowid), body: cleaned, username: user.username, created_at: Date.now() });
    live.broadcast('guestbook', { number, message });
    return { message };
  }

  function deleteGuestbook(user, id) {
    const row = getGuestbook.get(id);
    if (!row) throw new HttpError(404, 'Message introuvable.');
    if (row.user_id !== user.id && row.owner_id !== user.id && user.role !== 'admin') {
      throw new HttpError(403, 'Action non autorisée.');
    }
    deleteGuestbookStmt.run(id);
    live.broadcast('guestbook-delete', { number: row.plot_number, id });
    return { ok: true };
  }

  function plotDetails(number, viewer) {
    const plot = getPlot(number);
    if (!plot) throw new HttpError(404, 'Terrain introuvable.');
    const row = plotRow.get(number);
    const d = district(plot.district);
    return {
      plot,
      district: d,
      price: plotPriceCents(d, plot.building?.floors ?? DEFAULT_BUILDING.floors, pricing()),
      visits24h: visitsFor.get('plot', number, hourBucket() - 24).n,
      liked: viewer ? Boolean(hasLiked.get(viewer.id, number)) : false,
      mine: Boolean(viewer && row.owner_id === viewer.id),
      reservedByMe: Boolean(viewer && row.status === 'reserved' && row.reserved_by === viewer.id),
      guestbook: plot.status === 'owned' ? guestbookList.all(number).map(serializeMessage) : [],
      ownerBadges: row.owner_id ? badgesFor(row.owner_id) : [],
    };
  }

  function billboardDetails(number, viewer) {
    const billboard = getBillboard(number);
    if (!billboard) throw new HttpError(404, 'Panneau introuvable.');
    const row = billboardRow.get(number);
    const d = district(billboard.district);
    const p = pricing();
    return {
      billboard,
      district: d,
      offers: p.billboardDurations.map((o) => ({ ...o, priceCents: billboardPriceCents(d, o.months, p) })),
      visits24h: visitsFor.get('billboard', number, hourBucket() - 24).n,
      mine: Boolean(viewer && row.renter_id === viewer.id && row.status === 'rented'),
      reservedByMe: Boolean(viewer && row.status === 'reserved' && row.reserved_by === viewer.id),
    };
  }

  const reportStmt = q(
    'INSERT INTO reports (target_type, target, reporter_id, reason, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const recentReport = q(
    "SELECT 1 FROM reports WHERE reporter_id = ? AND target_type = ? AND target = ? AND status = 'open'",
  );
  function report(user, type, target, reason) {
    if (!['plot', 'billboard', 'message'].includes(type)) throw badRequest('Signalement invalide.');
    if (recentReport.get(user.id, type, target)) return { ok: true, duplicate: true };
    reportStmt.run(type, target, user.id, reason, Date.now());
    return { ok: true };
  }

  // ---------------------------------------------------------------- classements & profils
  const topTallest = q(
    `SELECT p.number, p.floors, p.brand_name, p.district, u.username FROM plots p LEFT JOIN users u ON u.id = p.owner_id
     WHERE p.status = 'owned' ORDER BY p.floors DESC, p.purchased_at ASC LIMIT 10`,
  );
  const topLiked = q(
    `SELECT p.number, p.brand_name, p.district, u.username, COUNT(l.user_id) AS likes
     FROM plots p JOIN likes l ON l.plot_number = p.number LEFT JOIN users u ON u.id = p.owner_id
     WHERE p.status = 'owned' GROUP BY p.number ORDER BY likes DESC, p.number ASC LIMIT 10`,
  );
  const topVisited = q(
    `SELECT p.number, p.brand_name, p.district, u.username, COUNT(*) AS visits
     FROM visits v JOIN plots p ON p.number = v.target LEFT JOIN users u ON u.id = p.owner_id
     WHERE v.target_type = 'plot' AND v.hour >= ? AND p.status = 'owned'
     GROUP BY p.number ORDER BY visits DESC, p.number ASC LIMIT 10`,
  );
  const topOwners = q(
    `SELECT u.username, COUNT(*) AS plots, SUM(p.floors) AS floors FROM plots p JOIN users u ON u.id = p.owner_id
     WHERE p.status = 'owned' GROUP BY u.id ORDER BY plots DESC, floors DESC LIMIT 10`,
  );
  const newest = q(
    `SELECT p.number, p.brand_name, p.district, p.floors, p.purchased_at, u.username FROM plots p LEFT JOIN users u ON u.id = p.owner_id
     WHERE p.status = 'owned' ORDER BY p.purchased_at DESC LIMIT 10`,
  );

  function leaderboard() {
    return {
      tallest: topTallest.all().map((r) => ({ number: r.number, brandName: r.brand_name, owner: r.username, district: r.district, value: r.floors })),
      liked: topLiked.all().map((r) => ({ number: r.number, brandName: r.brand_name, owner: r.username, district: r.district, value: r.likes })),
      visited: topVisited.all(hourBucket() - 24 * 7).map((r) => ({ number: r.number, brandName: r.brand_name, owner: r.username, district: r.district, value: r.visits })),
      owners: topOwners.all().map((r) => ({ owner: r.username, value: r.plots, floors: r.floors })),
      newest: newest.all().map((r) => ({ number: r.number, brandName: r.brand_name, owner: r.username, district: r.district, value: r.floors, at: iso(r.purchased_at) })),
    };
  }

  const pioneers = q(
    `SELECT owner_id FROM (SELECT owner_id, MIN(purchased_at) AS first FROM plots WHERE status = 'owned' AND owner_id IS NOT NULL GROUP BY owner_id)
     ORDER BY first ASC LIMIT 25`,
  );
  const userPlots = q("SELECT number, floors, district FROM plots WHERE owner_id = ? AND status = 'owned'");
  const userLikes = q("SELECT COUNT(*) AS n FROM likes l JOIN plots p ON p.number = l.plot_number WHERE p.owner_id = ?");
  const userAds = q("SELECT COUNT(*) AS n FROM orders WHERE user_id = ? AND kind = 'billboard' AND status = 'paid'");

  function badgesFor(userId) {
    const plots = userPlots.all(userId);
    const badges = [];
    if (pioneers.all().some((r) => r.owner_id === userId)) badges.push('pioneer');
    if (plots.some((p) => p.floors >= 40)) badges.push('skyscraper');
    if (plots.length >= 5) badges.push('tycoon');
    if (userAds.get(userId).n > 0) badges.push('advertiser');
    if (userLikes.get(userId).n >= 25) badges.push('beloved');
    if (new Set(plots.map((p) => p.district)).size >= 3) badges.push('explorer');
    return badges.map((id) => ({ id, ...BADGES[id] }));
  }

  const profileQuery = q('SELECT id, username, bio, role, created_at, banned FROM users WHERE username = ?');
  const profileBoards = q("SELECT number FROM billboards WHERE renter_id = ? AND status = 'rented' ORDER BY number");
  const profilePlots = q("SELECT number FROM plots WHERE owner_id = ? AND status = 'owned' ORDER BY number");

  function profile(username) {
    const u = profileQuery.get(String(username || ''));
    if (!u || u.banned) throw new HttpError(404, 'Habitant introuvable.');
    const plots = profilePlots.all(u.id).map((r) => getPlot(r.number));
    return {
      username: u.username,
      bio: u.bio,
      role: u.role,
      memberSince: iso(u.created_at),
      plots,
      billboards: profileBoards.all(u.id).map((r) => getBillboard(r.number)),
      likesReceived: userLikes.get(u.id).n,
      floors: plots.reduce((s, p) => s + (p.building?.floors ?? 0), 0),
      badges: badgesFor(u.id),
    };
  }

  const searchPlots = q(
    `SELECT p.number FROM plots p LEFT JOIN users u ON u.id = p.owner_id
     WHERE p.status = 'owned' AND (p.brand_name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\')
     ORDER BY p.number LIMIT 20`,
  );
  const searchUsers = q(`SELECT username FROM users WHERE banned = 0 AND username LIKE ? ESCAPE '\\' ORDER BY username LIMIT 5`);

  function search(term) {
    const t = String(term || '').trim().slice(0, 60);
    if (!t) return { plots: [], users: [], billboards: [] };
    const like = `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const numeric = /^#?\d+$/.test(t) ? Number(t.replace('#', '')) : null;
    const plots = searchPlots.all(like, like, like).map((r) => getPlot(r.number));
    if (numeric && !plots.some((p) => p.number === numeric)) {
      const exact = getPlot(numeric);
      if (exact) plots.unshift(exact);
    }
    const billboards = billboardRows
      .all()
      .filter((b) => (numeric && b.number === numeric) || (b.status === 'rented' && (b.brand_name || '').toLowerCase().includes(t.toLowerCase())))
      .slice(0, 10)
      .map(serializeBillboard);
    return { plots: plots.slice(0, 20), users: searchUsers.all(like).map((r) => r.username), billboards };
  }

  return {
    setting,
    setSetting,
    pricing,
    districts,
    district,
    checkUnlocks,
    logEvent,
    recentEvents: (limit = 30) => recentEvents.all(limit).map(serializeEvent),
    getPlot,
    getBillboard,
    broadcastPlot,
    broadcastBillboard,
    cityState,
    stats,
    sweep,
    checkoutPlot,
    checkoutBillboard,
    fulfillOrder,
    confirmStripeSession,
    handleWebhookEvent,
    cancelOrder,
    updateBuilding,
    demolish,
    transfer,
    resetPlot,
    resetBillboard,
    updateBillboard,
    releaseBillboard,
    media,
    recordVisit,
    like,
    postGuestbook,
    deleteGuestbook,
    plotDetails,
    billboardDetails,
    report,
    leaderboard,
    profile,
    badgesFor,
    search,
    rowToDesign,
    applyDesign,
    applyBranding,
    hourBucket,
  };
}

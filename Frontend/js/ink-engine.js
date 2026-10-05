"use strict";

window.InkEngine = (() => {
  // 1. Gộp cấu hình: Giữ nguyên các thông số cũ, ghi đè/thêm mới các thông số của bản v10
  const profile = Object.freeze({
    version: 10,
    penSize: 1.6,
    minPressure: 0.86,
    maxPressure: 1.14,
    cornerRadius: 1.2,
    predictionDistance: 2,   
    predictionHorizon: 12,   
    predictionLifetime: 32,
    ropeSpacing: 0.75,
    ropeLimit: 3,
    ropeWindow: 48,
    ropeBending: 64,
    ropeCornerRadius: 2.2,
    ropeCornerDrift: 4,
    ropeCornerSupport: 6,
    inputMinCutoff: 3,       
    inputBeta: 0.06,         
    inputDerivativeCutoff: 1,
    inputMaxLag: 0.9,
    inputNormalCutoff: 3.5,
    inputNormalBeta: 0.015,
    inputNormalLimit: 2.2,
    ropeCurveBending: 16,
    ropeCurveSupport: 3
  });

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
  const mix = (a, b, amount) => a + (b - a) * amount;
  const alpha = (cutoff, dt) => 1 - Math.exp(-2 * Math.PI * cutoff * dt);
  const euroAlpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));

  // Bộ nhớ đệm của file gốc (Giữ nguyên cho các hàm không liên quan)
  const legacyCache = new WeakMap(); 
  const freehandCache = new WeakMap();
  const previewSources = new WeakMap();

  // Bộ nhớ đệm mới của bản v10
  const cache = new WeakMap();
  const sources = new WeakMap();

  // ==========================================================================
  // THAY ĐỔI HOÀN TOÀN: Hàm createInput theo bản v10
  // ==========================================================================
  function createInput(options = {}) {
    const scale = clamp(finite(options.scale, 1), 0.1, 4);
    const isPen = options.pointerType === "pen";
    const smooth = options.positionMode !== "raw";
    let prev = null;
    let fx = 0, fy = 0;
    let vx = 0, vy = 0;
    let direction = null, steady = 0;

    return {
      sample(input, endpoint = false) {
        const time = finite(input.time, prev ? prev.time + 8 : 0);
        const dt = prev ? clamp((time - prev.time) / 1000, 0.001, 0.05) : 0.008;
        const pressure = clamp(finite(input.pressure, 0.5), 0, 1);
        const tiltX = clamp(finite(input.tiltX, 0), -90, 90);
        const tiltY = clamp(finite(input.tiltY, 0), -90, 90);
        const sx = input.x * scale, sy = input.y * scale;

        if (!prev) {
          fx = sx; fy = sy;
        } else {
          const a = euroAlpha(profile.inputDerivativeCutoff, dt);
          vx = mix(vx, (sx - fx) / dt, a);
          vy = mix(vy, (sy - fy) / dt, a);
          const cutoff = profile.inputMinCutoff + profile.inputBeta * Math.hypot(vx, vy);
          const k = euroAlpha(cutoff, dt);
          if (endpoint || !smooth) { fx = sx; fy = sy; }
          else { fx = mix(fx, sx, k); fy = mix(fy, sy, k); }
        }

        const rawTravel = prev ? Math.hypot(input.x - prev.rawX, input.y - prev.rawY) * scale : 0;
        const elapsed = prev ? time - prev.time : 0;
        const nextDirection = rawTravel >= 0.1 && elapsed > 0 && elapsed <= 40
          ? { x: (input.x - prev.rawX) * scale / rawTravel, y: (input.y - prev.rawY) * scale / rawTravel }
          : null;
        const agrees = direction && nextDirection && direction.x * nextDirection.x + direction.y * nextDirection.y >= 0.85;
        steady = nextDirection ? (agrees ? steady + 1 : 1) : 0;
        direction = nextDirection;

        const filteredPressure = prev && isPen
          ? (endpoint ? prev.pressure : mix(prev.pressure, pressure, euroAlpha(18, dt)))
          : pressure;
        const target = options.type === "highlight" ? 1
          : isPen ? 0.92 + 0.16 * Math.pow(filteredPressure, 0.7) : 1;
        const p = clamp(target, profile.minPressure, profile.maxPressure);

        const x = fx / scale, y = fy / scale;
        prev = { x, y, rawX: input.x, rawY: input.y, time, elapsed, p,
          pressure: filteredPressure, tiltX, tiltY,
          ddx: nextDirection ? (input.x - (prev ? prev.rawX : input.x)) : 0,
          ddy: nextDirection ? (input.y - (prev ? prev.rawY : input.y)) : 0 };
        return { x, y, p, pressure: filteredPressure, tiltX, tiltY, t: time };
      },
      predict(predictions = []) {
        if (!prev || options.type === "highlight" || !smooth) return null;
        let tx = prev.rawX, ty = prev.rawY, tt = prev.time;
        if (steady >= 2 && direction) {
          let target = null;
          for (const q of predictions) {
            const ahead = q.time - prev.time;
            if (!Number.isFinite(q.x) || !Number.isFinite(q.y) || !Number.isFinite(ahead)
                || ahead <= 0 || ahead > profile.predictionHorizon) continue;
            const dx = q.x - prev.rawX, dy = q.y - prev.rawY, d = Math.hypot(dx, dy);
            if (d > 0 && (dx * direction.x + dy * direction.y) / d >= 0.85) { target = q; break; }
          }
          if (!target && prev.elapsed > 0) {
            const ahead = Math.min(8, prev.elapsed);
            target = { x: prev.rawX + prev.ddx * ahead / prev.elapsed,
              y: prev.rawY + prev.ddy * ahead / prev.elapsed, time: prev.time + ahead };
          }
          if (target) {
            const dx = target.x - prev.rawX, dy = target.y - prev.rawY;
            const dist = Math.hypot(dx, dy) * scale;
            const amount = dist > 0 ? Math.min(1, profile.predictionDistance / dist) : 0;
            tx = prev.rawX + dx * amount; ty = prev.rawY + dy * amount; tt = target.time;
          }
        }
        if (Math.hypot(tx - prev.x, ty - prev.y) * scale < 0.1) return null;
        return { x: tx, y: ty, p: prev.p, pressure: prev.pressure, tiltX: prev.tiltX, tiltY: prev.tiltY, t: tt };
      }
    };
  }

  // ==========================================================================
  // GIỮ NGUYÊN: Các hàm không liên quan từ file gốc
  // ==========================================================================
  const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, p: (finite(a.p, 1) + finite(b.p, 1)) / 2 });
  const number = value => String(Math.round(value * 10000) / 10000);
  const xy = point => `${number(point.x)} ${number(point.y)}`;
  const radius = (point, width) => width * clamp(finite(point.p, 1), 0.2, 2.2) / 2;

  function circle(point, r) {
    return `M${number(point.x - r)} ${number(point.y)}a${number(r)} ${number(r)} 0 1 1 ${number(2 * r)} 0a${number(r)} ${number(r)} 0 1 1 ${number(-2 * r)} 0Z`;
  }

  function edgePath(points) {
    let d = "";
    for (let i = 1; i < points.length - 1; i++) d += `Q${xy(points[i])} ${xy(midpoint(points[i], points[i + 1]))}`;
    return d + `L${xy(points[points.length - 1])}`;
  }

  function ribbon(a, control, b, width) {
    const span = Math.hypot(control.x - a.x, control.y - a.y) + Math.hypot(b.x - control.x, b.y - control.y);
    if (span < 1e-6) return circle(b, radius(b, width));
    const steps = clamp(Math.ceil(span / 3), 4, 32);
    const left = [], right = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, u = 1 - t;
      const center = { x: u * u * a.x + 2 * u * t * control.x + t * t * b.x,
        y: u * u * a.y + 2 * u * t * control.y + t * t * b.y,
        p: u * u * finite(a.p, 1) + 2 * u * t * finite(control.p, 1) + t * t * finite(b.p, 1) };
      let dx = u * (control.x - a.x) + t * (b.x - control.x);
      let dy = u * (control.y - a.y) + t * (b.y - control.y);
      if (Math.hypot(dx, dy) < 1e-6) { dx = b.x - a.x; dy = b.y - a.y; }
      const length = Math.hypot(dx, dy) || 1;
      const r = radius(center, width), nx = -dy / length * r, ny = dx / length * r;
      right.push({ x: center.x - nx, y: center.y - ny });
      left.push({ x: center.x + nx, y: center.y + ny });
    }
    left.reverse();
    return `M${xy(right[0])}${edgePath(right)}L${xy(left[0])}${edgePath(left)}Z`
      + circle(a, radius(a, width)) + circle(b, radius(b, width));
  }

  function geometry(object) {
    const points = object.points || [];
    if (!points.length) return { path: new Path2D(), entry: null };
    const width = Math.max(0.1, finite(object.width, 3)) * (object.type === "highlight" ? 6 : 1);
    let entry = legacyCache.get(points);
    if (!entry || entry.width !== width || entry.count > points.length - 1) {
      entry = { width, count: 0, path: new Path2D() };
      legacyCache.set(points, entry);
    }
    if (entry.sampleCount === points.length) return { path: entry.complete, entry };
    while (entry.count < points.length - 1) {
      const i = entry.count, control = points[i];
      const a = i ? midpoint(points[i - 1], control) : control;
      const d = ribbon(a, control, midpoint(control, points[i + 1]), width);
      entry.path.addPath(new Path2D(d));
      entry.count++;
    }
    const last = points[points.length - 1];
    const tail = points.length === 1 ? circle(last, radius(last, width))
      : ribbon(midpoint(points[points.length - 2], last), last, last, width);
    entry.complete = new Path2D(entry.path);
    entry.complete.addPath(new Path2D(tail));
    entry.sampleCount = points.length;
    return { path: entry.complete, entry };
  }

  function strokeOptions(settings = {}, pointerType, type) {
    return {
      smoothing: 0.65, streamline: 0, thinning: type === "highlight" ? 0 : 1, simulatePressure: false,
      rounding: profile.cornerRadius / clamp(finite(settings.scale, 1), 0.1, 4),
      ropeSpacing: profile.ropeSpacing / clamp(finite(settings.scale, 1), 0.1, 4),
      ropeLimit: profile.ropeLimit / clamp(finite(settings.scale, 1), 0.1, 4), ropeWindow: profile.ropeWindow,
      ropeBending: profile.ropeBending, ropeCurveBending: profile.ropeCurveBending,
      ropeCurveSupport: profile.ropeCurveSupport / clamp(finite(settings.scale, 1), 0.1, 4),
      ropeCornerRadius: profile.ropeCornerRadius / clamp(finite(settings.scale, 1), 0.1, 4),
      ropeCornerDrift: profile.ropeCornerDrift / clamp(finite(settings.scale, 1), 0.1, 4),
      ropeCornerSupport: profile.ropeCornerSupport / clamp(finite(settings.scale, 1), 0.1, 4),
    };
  }

  const lerpSample = (a, b, amount) => a.map((value, i) => mix(value, b[i], amount));

  function roundCorner(a, b, c, radius) {
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
    if (ab < 1e-6 || bc < 1e-6) return [b];
    const ux = (b[0] - a[0]) / ab, uy = (b[1] - a[1]) / ab;
    const vx = (c[0] - b[0]) / bc, vy = (c[1] - b[1]) / bc;
    const turn = 1 - clamp(ux * vx + uy * vy, -1, 1);
    if (turn < 0.025) return [b];
    const trim = Math.min(radius, ab * 0.25, bc * 0.25) * Math.min(1, turn * 2);
    const first = lerpSample(a, b, 1 - trim / ab);
    const last = lerpSample(b, c, trim / bc);
    const result = [first];
    for (let i = 1; i <= 4; i++) {
      const t = i / 4, u = 1 - t;
      result.push(first.map((value, axis) => u * u * value + 2 * u * t * b[axis] + t * t * last[axis]));
    }
    return result;
  }

  function splineHandle(before, point, after, limit) {
    const incoming = before ? [point[0] - before[0], point[1] - before[1]] : null;
    const outgoing = after ? [after[0] - point[0], after[1] - point[1]] : null;
    const a = incoming ? Math.hypot(...incoming) : Infinity;
    const b = outgoing ? Math.hypot(...outgoing) : Infinity;
    if (a < 1e-6 || b < 1e-6) return [0, 0];
    const u = incoming ? incoming.map(value => value / a) : outgoing.map(value => value / b);
    const v = outgoing ? outgoing.map(value => value / b) : u;
    const length = Math.min(limit, a / 3, b / 3);
    return u.map((value, axis) => (value + v[axis]) * length / 2);
  }

  function splineSegment(before, a, b, after, rounding) {
    const h1 = splineHandle(before, a, b, rounding * 0.6);
    const h2 = splineHandle(a, b, after, rounding * 0.6);
    const c1 = [a[0] + h1[0], a[1] + h1[1]];
    const c2 = [b[0] - h2[0], b[1] - h2[1]];
    const span = Math.hypot(...h1) + Math.hypot(c2[0] - c1[0], c2[1] - c1[1]) + Math.hypot(...h2);
    const steps = clamp(Math.ceil(span / Math.max(0.01, rounding * 0.65)), 1, 48);
    const result = [];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, u = 1 - t;
      result.push([u * u * u * a[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * b[0],
        u * u * u * a[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * b[1], mix(a[2], b[2], t)]);
    }
    return result;
  }

  function splineCenters(entry, samples, rounding) {
    if (samples.length <= 2) return samples;
    if (!entry.curve.length) entry.curve.push(samples[0]);
    while (entry.segments + 2 < entry.rounded.length) {
      const i = entry.segments++;
      entry.curve.push(...splineSegment(samples[i - 1], samples[i], samples[i + 1], samples[i + 2], rounding));
    }
    const centers = [...entry.curve];
    for (let i = entry.segments; i < samples.length - 1; i++) {
      centers.push(...splineSegment(samples[i - 1], samples[i], samples[i + 1], samples[i + 2], rounding));
    }
    return centers;
  }

  function taperSamples(samples, distance) {
    if (!distance || samples.length < 2) return samples;
    const lengths = [0];
    for (let i = 1; i < samples.length; i++) lengths.push(lengths[i - 1] + Math.hypot(samples[i][0] - samples[i - 1][0], samples[i][1] - samples[i - 1][1]));
    const total = lengths[lengths.length - 1];
    const strength = clamp((total - distance * 2) / (distance * 2), 0, 1);
    if (!strength) return samples;
    if (samples.length === 2) {
      const [a, b] = samples;
      const positions = [0, distance / 3, distance * 2 / 3, distance, total - distance, total - distance * 2 / 3, total - distance / 3, total];
      return taperSamples(positions.map(length => lerpSample(a, b, length / total)), distance);
    }
    return samples.map((sample, i) => {
      const edge = clamp(Math.min(lengths[i], total - lengths[i]) / distance, 0, 1);
      const eased = edge * edge * (3 - 2 * edge);
      return [sample[0], sample[1], sample[2] * (1 - 0.18 * strength * (1 - eased))];
    });
  }

  function freehandGeometry(object, prepareOnly = false) {
    const points = object.points || [];
    const settings = object.inkOptions || {};
    const rounded = object.inkVersion === 4 || object.inkVersion === 5;
    const spline = object.inkVersion === 5;
    const rope = [6, 7, 8, 9].includes(object.inkVersion);
    const width = Math.max(0.1, finite(object.width, 3)) * (object.type === "highlight" ? 6 : 1);
    const options = {
      inkVersion: object.inkVersion, size: width,
      smoothing: clamp(finite(settings.smoothing, 0.5), 0, 1),
      streamline: clamp(finite(settings.streamline, 0), 0, 0.5),
      thinning: object.type === "highlight" ? 0 : clamp(finite(settings.thinning, 1), 0, 1),
      simulatePressure: object.type !== "highlight" && settings.simulatePressure === true,
      rounding: rounded || rope ? Math.max(0, finite(settings.rounding, profile.cornerRadius)) : 0,
      spline,
      rope: rope ? { spacing: settings.ropeSpacing, limit: settings.ropeLimit, window: settings.ropeWindow, bending: settings.ropeBending, curveBending: settings.ropeCurveBending, curveSupport: settings.ropeCurveSupport, cornerRadius: settings.ropeCornerRadius, cornerDrift: settings.ropeCornerDrift, cornerSupport: settings.ropeCornerSupport } : null,
      last: true, start: { cap: true, taper: 0 }, end: { cap: true, taper: 0 },
    };
    const key = JSON.stringify(options);
    let entry = freehandCache.get(points);
    if (!entry || entry.key !== key || entry.samples.length > points.length) {
      const source = previewSources.get(points);
      const confirmed = source ? freehandGeometry(source, true) : null;
      entry = confirmed?.key === key
        ? { ...confirmed, samples: [...confirmed.samples], rounded: [...confirmed.rounded], curve: [...confirmed.curve], count: -1, path: null }
        : { key, samples: [], rounded: [], curve: [], segments: 0, finalized: 1, count: -1, hasMovement: false };
      freehandCache.set(points, entry);
    }
    if (entry.count === points.length && (prepareOnly || entry.path)) return entry;
    if (entry.count !== points.length) {
      for (let i = entry.samples.length; i < points.length; i++) {
        const point = points[i];
        if (i && Math.hypot(point.x - points[0].x, point.y - points[0].y) > 1e-6) entry.hasMovement = true;
        const p = rounded || rope ? clamp(finite(point.p, 1), profile.minPressure, profile.maxPressure) : finite(point.p, 1);
        entry.samples.push([point.x, point.y, clamp(p / 2, 0, 1)]);
      }
      let samples = entry.samples;
      if (rounded && samples.length) {
        if (!entry.rounded.length) entry.rounded.push(samples[0]);
        while (entry.finalized < samples.length - 1) {
          const i = entry.finalized++;
          entry.rounded.push(...roundCorner(samples[i - 1], samples[i], samples[i + 1], options.rounding));
        }
        samples = samples.length === 1 ? entry.rounded : [...entry.rounded, samples[samples.length - 1]];
      }
      if (spline && samples.length) samples = splineCenters(entry, samples, options.rounding);
      if (rope) {
        const string = RopeInk.geometry(object, previewSources.get(points));
        samples = string.centers;
        entry.hasMovement = string.hasMovement;
      }
      entry.centers = samples;
      entry.count = points.length;
      entry.path = null;
    }
    if (prepareOnly) return entry;
    let samples = entry.centers;
    if ((spline || rope) && object.type !== "highlight") samples = taperSamples(samples, options.rounding * 2.5);
    const path = new Path2D();
    if (points.length && !entry.hasMovement) {
      const point = points[points.length - 1];
      const r = options.simulatePressure ? width / 2 : rounded || rope
        ? width * clamp(finite(point.p, 1), profile.minPressure, profile.maxPressure) / 2 : radius(point, width);
      path.arc(point.x, point.y, r, 0, Math.PI * 2);
    } else if (points.length > 1) {
      if (samples.length === 2) {
        const [a, b] = samples;
        samples = [a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], b];
      }
      const outline = PerfectFreehand.getStroke(samples, options);
      if (outline.length) {
        const last = outline[outline.length - 1], first = outline[0];
        path.moveTo((last[0] + first[0]) / 2, (last[1] + first[1]) / 2);
        for (let i = 0; i < outline.length; i++) {
          const point = outline[i], next = outline[(i + 1) % outline.length];
          path.quadraticCurveTo(point[0], point[1], (point[0] + next[0]) / 2, (point[1] + next[1]) / 2);
        }
        path.closePath();
      }
    }
    entry.path = path;
    return entry;
  }

  // ==========================================================================
  // THAY ĐỔI HOÀN TOÀN: Các hàm API render nét vẽ theo bản v10
  // ==========================================================================
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const pw = point => clamp(finite(point.p, 1), profile.minPressure, profile.maxPressure);
  const baseWidth = object => Math.max(0.1, finite(object.width, 3)) * (object.type === "highlight" ? 6 : 1);

  function bucketFor(buckets, width, point, highlight) {
    const w = highlight ? width : width * pw(point);
    const key = highlight ? 0 : Math.round(w / (width * 0.02));
    let bucket = buckets.get(key);
    if (!bucket) { bucket = { path: new Path2D(), w: highlight ? w : key * width * 0.02 }; buckets.set(key, bucket); }
    return bucket;
  }

  function addSegment(buckets, points, i, width, highlight) {
    const c = points[i], a = i ? mid(points[i - 1], c) : c, b = mid(c, points[i + 1]);
    const { path } = bucketFor(buckets, width, c, highlight);
    path.moveTo(a.x, a.y);
    path.quadraticCurveTo(c.x, c.y, b.x, b.y);
  }

  function addTail(buckets, points, width, highlight) {
    const n = points.length, last = points[n - 1], a = mid(points[n - 2], last);
    const { path } = bucketFor(buckets, width, last, highlight);
    path.moveTo(a.x, a.y);
    path.lineTo(last.x, last.y);
  }

  function entryFor(points, width) {
    let entry = cache.get(points);
    if (!entry || entry.width !== width || entry.done > Math.max(0, points.length - 1)) {
      entry = { width, done: 0, scanned: 1, moved: false, buckets: new Map() };
      cache.set(points, entry);
    }
    return entry;
  }

  function strokeBuckets(context, buckets) {
    for (const { path, w } of buckets.values()) { context.lineWidth = w; context.stroke(path); }
  }

  function paint(context, object) {
    const points = object.points || [];
    if (!points.length) return;
    const highlight = object.type === "highlight";
    const width = baseWidth(object);
    const source = sources.get(points);
    const confirmed = source ? source.points : points;
    const entry = entryFor(confirmed, width);
    for (; entry.scanned < confirmed.length; entry.scanned++) {
      if (Math.hypot(confirmed[entry.scanned].x - confirmed[0].x, confirmed[entry.scanned].y - confirmed[0].y) > 1e-6) entry.moved = true;
    }
    while (entry.done < confirmed.length - 1) addSegment(entry.buckets, confirmed, entry.done++, width, highlight);

    let moved = entry.moved;
    const temp = new Map();
    if (source) {
      for (let i = confirmed.length - 1; i < points.length - 1; i++) addSegment(temp, points, i, width, highlight);
      if (points.length > 1) addTail(temp, points, width, highlight);
      for (let i = confirmed.length; i < points.length && !moved; i++) {
        if (Math.hypot(points[i].x - points[0].x, points[i].y - points[0].y) > 1e-6) moved = true;
      }
    } else if (points.length > 1) {
      addTail(temp, points, width, highlight);
    }

    context.save();
    context.globalAlpha = highlight ? 0.3 : 1;
    if (points.length === 1 || !moved) {
      const last = points[points.length - 1];
      context.beginPath();
      context.arc(last.x, last.y, (highlight ? width : width * pw(last)) / 2, 0, Math.PI * 2);
      context.fill();
    } else {
      context.strokeStyle = context.fillStyle;
      context.lineCap = "round";
      context.lineJoin = "round";
      strokeBuckets(context, entry.buckets);
      strokeBuckets(context, temp);
    }
    context.restore();
  }

  function previewStroke(object, point) {
    const preview = { ...object, points: [...object.points, point] };
    sources.set(preview.points, object);
    return preview;
  }

  function invalidate(object) {
    if (!object || !object.points) return;
    // Clear cả bộ nhớ đệm cũ và mới cho an toàn
    legacyCache.delete(object.points);
    freehandCache.delete(object.points);
    cache.delete(object.points);
    sources.delete(object.points);
    if ([6, 7, 8, 9].includes(object.inkVersion) && window.RopeInk) window.RopeInk.invalidate(object);
  }

  const centerline = object => (object.points || []).map(p => [p.x, p.y, pw(p) / 2]);
  const ropeState = object => ({ anchors: [], lockedCount: 0, spacing: profile.ropeSpacing });

  return { profile, createInput, strokeOptions, centerline, ropeState, previewStroke, paint, invalidate };
})();
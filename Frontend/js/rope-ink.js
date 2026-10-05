"use strict";

// A local elastic string attached to measured, equally spaced guide pegs.
// Confirmed pegs are replayed in order; previews only relax a separate tail.
window.RopeInk = (() => {
  const entries = new WeakMap();
  const previewSources = new WeakMap();
  const maxSegmentGuides = 4096;
  const maxStrokeGuides = 16384;
  const maxCoordinate = 1e12;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
  const mix = (a, b, amount) => a * (1 - amount) + b * amount;

  // ======================================================================
  // THÊM TỪ "THỬ NÉT VIẾT": Bộ lọc One Euro và hàm tính hệ số Low-Pass
  // ======================================================================
  const lp = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
  
  function makeFilter(minCut, beta) {
    let x = null, y = null, dx = 0, dy = 0;
    return (px, py, dt) => {
      if (x === null) { x = px; y = py; return [x, y]; }
      const a = lp(1, dt);
      dx = mix(dx, (px - x) / dt, a);
      dy = mix(dy, (py - y) / dt, a);
      const cutoff = minCut + beta * Math.hypot(dx, dy);
      const k = lp(cutoff, dt);
      x = mix(x, px, k); 
      y = mix(y, py, k);
      return [x, y];
    };
  }
  // ======================================================================

  function configuration(object) {
    const options = object.inkOptions || {};
    const rounded = object.inkVersion >= 7;
    const spacing = clamp(finite(options.ropeSpacing, 0.75), 0.05, 20);
    const limit = clamp(finite(options.ropeLimit, rounded ? 2 : 1.5), 0, spacing * 8);
    const window = clamp(Math.round(finite(options.ropeWindow, rounded ? 32 : 16)), 4, 48);
    const bending = clamp(finite(options.ropeBending, rounded ? 8 : 4), 0, 8);
    const cornerRadius = rounded ? clamp(finite(options.ropeCornerRadius, 2.2), 0, spacing * 8) : 0;
    const cornerDrift = rounded ? clamp(finite(options.ropeCornerDrift, 4), 0, spacing * 12) : 0;
    const cornerSupport = rounded ? clamp(finite(options.ropeCornerSupport, 6), spacing * 2, spacing * 16) : 0;
    return { spacing, limit, window, bending, cornerRadius, cornerDrift, cornerSupport,
      key: `${spacing}:${limit}:${window}:${bending}:${cornerRadius}:${cornerDrift}:${cornerSupport}` };
  }

  function measured(point, previous) {
    return {
      x: finite(point?.x, previous ? previous.x : 0),
      y: finite(point?.y, previous ? previous.y : 0),
      p: clamp(finite(point?.p, 1), 0.86, 1.14) / 2,
    };
  }

  function peg(point, s, locked = false) {
    return { x: point.x, y: point.y, sourceX: point.x, sourceY: point.y,
      p: point.p, s, locked };
  }

  function relax(nodes, fixedCount, options) {
    const end = nodes.length - 1;
    const start = Math.max(1, fixedCount);
    const count = end - start;
    if (end < 1) return;
    nodes[end].x = nodes[end].sourceX;
    nodes[end].y = nodes[end].sourceY;
    if (count <= 0) return;
    const diagonal = new Float64Array(count).fill(1);
    const lower1 = new Float64Array(count);
    const lower2 = new Float64Array(count);
    const rhsX = new Float64Array(count);
    const rhsY = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      rhsX[i] = nodes[start + i].sourceX;
      rhsY[i] = nodes[start + i].sourceY;
    }
    const coefficients = [1, -2, 1];
    const weight = options.bending;
    for (let center = Math.max(1, start - 1); center < end; center++) {
      let fixedX = 0, fixedY = 0;
      for (let k = 0; k < 3; k++) {
        const index = center + k - 1;
        if (index < start || index >= end) {
          fixedX += coefficients[k] * nodes[index].x;
          fixedY += coefficients[k] * nodes[index].y;
        }
      }
      for (let a = 0; a < 3; a++) {
        const row = center + a - 1 - start;
        if (row < 0 || row >= count) continue;
        const coefficient = coefficients[a];
        diagonal[row] += weight * coefficient * coefficient;
        rhsX[row] -= weight * coefficient * fixedX;
        rhsY[row] -= weight * coefficient * fixedY;
        for (let b = 0; b < a; b++) {
          const column = center + b - 1 - start;
          if (column < 0 || column >= count) continue;
          const value = weight * coefficient * coefficients[b];
          if (row - column === 1) lower1[row] += value;
          else lower2[row] += value;
        }
      }
    }
    for (let i = 0; i < count; i++) {
      if (i >= 2) lower2[i] /= diagonal[i - 2];
      if (i) lower1[i] = (lower1[i] - (i >= 2 ? lower2[i] * lower1[i - 1] : 0))
        / diagonal[i - 1];
      diagonal[i] = Math.sqrt(Math.max(1e-12,
        diagonal[i] - lower1[i] ** 2 - lower2[i] ** 2));
      rhsX[i] = (rhsX[i] - (i ? lower1[i] * rhsX[i - 1] : 0)
        - (i >= 2 ? lower2[i] * rhsX[i - 2] : 0)) / diagonal[i];
      rhsY[i] = (rhsY[i] - (i ? lower1[i] * rhsY[i - 1] : 0)
        - (i >= 2 ? lower2[i] * rhsY[i - 2] : 0)) / diagonal[i];
    }
    for (let i = count - 1; i >= 0; i--) {
      rhsX[i] = (rhsX[i] - (i + 1 < count ? lower1[i + 1] * rhsX[i + 1] : 0)
        - (i + 2 < count ? lower2[i + 2] * rhsX[i + 2] : 0)) / diagonal[i];
      rhsY[i] = (rhsY[i] - (i + 1 < count ? lower1[i + 1] * rhsY[i + 1] : 0)
        - (i + 2 < count ? lower2[i + 2] * rhsY[i + 2] : 0)) / diagonal[i];
      const node = nodes[start + i];
      const dx = rhsX[i] - node.sourceX, dy = rhsY[i] - node.sourceY;
      const distance = Math.hypot(dx, dy);
      const amount = distance > options.limit ? options.limit / distance : 1;
      node.x = node.sourceX + dx * amount;
      node.y = node.sourceY + dy * amount;
    }
  }

  const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
  const subtract = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const unit = vector => {
    const length = Math.hypot(...vector);
    return length > 1e-8 ? vector.map(value => value / length) : null;
  };

  function atDistance(nodes, distance, measured = false) {
    if (distance < nodes[0].s - 1e-8 || distance > nodes[nodes.length - 1].s + 1e-8) return null;
    let low = 0, high = nodes.length - 1;
    while (low + 1 < high) {
      const middle = (low + high) >> 1;
      if (nodes[middle].s < distance) low = middle;
      else high = middle;
    }
    const a = nodes[low], b = nodes[high];
    const amount = b.s > a.s ? clamp((distance - a.s) / (b.s - a.s), 0, 1) : 0;
    return measured ? [mix(a.sourceX, b.sourceX, amount), mix(a.sourceY, b.sourceY, amount)]
      : [mix(a.x, b.x, amount), mix(a.y, b.y, amount)];
  }

  function turnAt(nodes, index, reach) {
    const node = nodes[index];
    const a = atDistance(nodes, node.s - reach), b = [node.x, node.y];
    const c = atDistance(nodes, node.s + reach);
    if (!a || !c) return 0;
    const incoming = unit(subtract(b, a)), outgoing = unit(subtract(c, b));
    return incoming && outgoing
      ? Math.atan2(cross(incoming, outgoing), incoming[0] * outgoing[0] + incoming[1] * outgoing[1]) : 0;
  }

  function crossingDistance(nodes, from, to, point, direction, offset) {
    for (let i = from; i < to; i++) {
      const a = nodes[i], b = nodes[i + 1];
      const first = (a.sourceX - point[0]) * direction[0] + (a.sourceY - point[1]) * direction[1];
      const last = (b.sourceX - point[0]) * direction[0] + (b.sourceY - point[1]) * direction[1];
      if (first <= offset && last >= offset && last - first > 1e-8) {
        return mix(a.s, b.s, clamp((offset - first) / (last - first), 0, 1));
      }
    }
    return null;
  }

  function cornerFor(nodes, index, options) {
    const node = nodes[index], support = options.cornerSupport;
    const a = atDistance(nodes, node.s - support, true);
    const b = atDistance(nodes, node.s - support * 0.55, true);
    const c = atDistance(nodes, node.s + support * 0.55, true);
    const d = atDistance(nodes, node.s + support, true);
    if (!a || !b || !c || !d) return null;
    const incoming = unit(subtract(b, a)), outgoing = unit(subtract(d, c));
    if (!incoming || !outgoing) return null;
    const determinant = cross(incoming, outgoing);
    const cosine = clamp(incoming[0] * outgoing[0] + incoming[1] * outgoing[1], -1, 1);
    const angle = Math.atan2(determinant, cosine);
    if (Math.abs(angle) < 0.65 || Math.abs(angle) > Math.PI - 0.045 || Math.abs(determinant) < 0.045) return null;
    const intersection = cross(subtract(c, a), outgoing) / determinant;
    const vertex = [a[0] + incoming[0] * intersection, a[1] + incoming[1] * intersection];
    if (!vertex.every(Number.isFinite) || Math.hypot(vertex[0] - node.sourceX, vertex[1] - node.sourceY) > support * 0.7) return null;
    const half = Math.abs(angle) / 2, tangent = Math.tan(half);
    const radius = Math.min(options.cornerRadius,
      options.cornerDrift / Math.max(1e-8, 1 / Math.cos(half) - 1), support * 0.9 / tangent);
    if (radius < options.spacing * 0.1) return null;
    const trim = radius * tangent;
    const sign = Math.sign(angle);
    const first = [vertex[0] - incoming[0] * trim, vertex[1] - incoming[1] * trim];
    const center = [first[0] - incoming[1] * radius * sign, first[1] + incoming[0] * radius * sign];
    const reach = Math.ceil(support / options.spacing) + 3;
    const start = crossingDistance(nodes, Math.max(0, index - reach), index, vertex, incoming, -trim);
    const end = crossingDistance(nodes, index, Math.min(nodes.length - 1, index + reach), vertex, outgoing, trim);
    if (start === null || end === null || end - start < options.spacing * 2) return null;
    return Object.freeze({ start, end, center, radius, angle,
      firstAngle: Math.atan2(first[1] - center[1], first[0] - center[0]) });
  }

  function roundIsolatedCorners(nodes, fixedCount, options) {
    if (!options.cornerRadius || !options.cornerDrift || nodes.length < 5) return;
    const short = options.cornerSupport * 0.25;
    const start = Math.max(1, fixedCount - Math.ceil(options.cornerSupport * 2 / options.spacing) - 3);
    const end = nodes.length - 1;
    const corners = [];
    for (let i = start; i < end; i++) if (nodes[i].corner) corners.push(nodes[i].corner);
    const turns = new Map();
    for (let i = start; i < end; i++) turns.set(i, turnAt(nodes, i, short));
    const candidates = [];
    for (let i = Math.max(1, fixedCount); i < end; i++) {
      const node = nodes[i], local = turns.get(i) || 0;
      if (Math.abs(local) < 0.65 || nodes[i].sampleSpacing > options.spacing * 8) continue;
      if (corners.some(corner => node.s >= corner.start - short && node.s <= corner.end + short)) continue;
      let peak = true;
      for (let j = Math.max(start, i - Math.ceil(short / options.spacing));
        j <= Math.min(end - 1, i + Math.ceil(short / options.spacing)); j++) {
        if (Math.abs(turns.get(j) || 0) > Math.abs(local) + 1e-8) { peak = false; break; }
      }
      if (!peak) continue;
      const wide = turnAt(nodes, i, options.cornerSupport);
      if (local * wide <= 0 || Math.abs(local) < Math.abs(wide) * 0.48) continue;
      candidates.push({ index: i, strength: Math.abs(local) });
    }
    candidates.sort((a, b) => b.strength - a.strength || a.index - b.index);
    for (const candidate of candidates) {
      const corner = cornerFor(nodes, candidate.index, options);
      if (!corner || corners.some(existing => corner.start < existing.end + short
        && corner.end > existing.start - short)) continue;
      nodes[candidate.index].corner = corner;
      corners.push(corner);
    }
    for (const corner of corners) {
      for (let i = Math.max(1, fixedCount); i < end; i++) {
        const node = nodes[i];
        if (node.s <= corner.start || node.s >= corner.end) continue;
        const amount = (node.s - corner.start) / (corner.end - corner.start);
        const angle = corner.firstAngle + corner.angle * amount;
        node.x = corner.center[0] + Math.cos(angle) * corner.radius;
        node.y = corner.center[1] + Math.sin(angle) * corner.radius;
      }
    }
  }

  function fit(nodes, fixedCount, options) {
    relax(nodes, fixedCount, options);
    roundIsolatedCorners(nodes, fixedCount, options);
  }

  const sample = node => [node.x, node.y, node.p];
  const midpoint = (a, b) => [
    (a.x + b.x) / 2, (a.y + b.y) / 2, (a.p + b.p) / 2,
  ];

  function appendSpan(centers, nodes, index, spacing, final = false) {
    const node = nodes[index];
    const a = index ? midpoint(nodes[index - 1], node) : sample(node);
    const b = final ? sample(node) : midpoint(node, nodes[index + 1]);
    const span = Math.hypot(node.x - a[0], node.y - a[1])
      + Math.hypot(b[0] - node.x, b[1] - node.y);
    const localSpacing = Math.max(spacing, node.sampleSpacing || 0,
      nodes[index - 1]?.sampleSpacing || 0, nodes[index + 1]?.sampleSpacing || 0);
    const ratio = span / (localSpacing * 0.5);
    const steps = clamp(Math.ceil(ratio - 1e-8 * Math.max(1, ratio)), 2, 32);
    for (let step = 1; step <= steps; step++) {
      const t = step / steps, u = 1 - t;
      centers.push([
        u * u * a[0] + 2 * u * t * node.x + t * t * b[0],
        u * u * a[1] + 2 * u * t * node.y + t * t * b[1],
        u * u * a[2] + 2 * u * t * node.p + t * t * b[2],
      ]);
    }
  }

  function freezePrefix(entry) {
    const target = Math.max(1, entry.anchors.length - entry.options.window);
    while (entry.lockedCount < target) {
      entry.anchors[entry.lockedCount++].locked = true;
    }
    while (entry.curveNext + 1 < entry.lockedCount) {
      appendSpan(entry.curve, entry.anchors, entry.curveNext++, entry.options.spacing);
    }
  }

  function prepare(object) {
    const points = object.points || [];
    const options = configuration(object);
    let entry = entries.get(points);
    if (!entry || entry.options.key !== options.key || entry.count > points.length) {
      entry = { options, count: 0, anchors: [], lockedCount: 0, carry: 0,
        total: 0, last: null, curve: [], curveNext: 0, hasMovement: false,
        result: null, displayAnchors: [], rejected: false,
        
        // KHỞI TẠO BỘ LỌC TỪ "THỬ NÉT VIẾT"
        f: makeFilter(3.0, 0.06), prevP: null 
      };
      entries.set(points, entry);
    }
    if (entry.rejected) {
      entry.count = points.length;
      return entry;
    }
    for (; entry.count < points.length; entry.count++) {
      // ======================================================================
      // ĐOẠN ĐƯỢC CHỈNH SỬA: Lọc điểm đầu vào trước khi đưa vào sợi dây
      // ======================================================================
      const r = points[entry.count];
      const prevRaw = entry.count > 0 ? points[entry.count - 1] : null;
      const timeR = r.time !== undefined ? r.time : (r.t || 0);
      const timePrev = prevRaw ? (prevRaw.time !== undefined ? prevRaw.time : (prevRaw.t || 0)) : 0;
      const dt = prevRaw ? clamp((timeR - timePrev) / 1000, 0.001, 0.05) : 0.008;
      
      const rawP = r.p !== undefined ? r.p : 1;
      const clampedP = clamp(finite(rawP, 1), 0.86, 1.14) / 2;
      entry.prevP = entry.prevP === null ? clampedP : mix(entry.prevP, clampedP, lp(18, dt));
      
      const [fx, fy] = entry.f(r.x, r.y, dt);
      
      // Tạo điểm current (đã khử run và mượt áp lực) thay vì dùng hàm measured cũ
      const current = {
        x: finite(fx, entry.last ? entry.last.x : 0),
        y: finite(fy, entry.last ? entry.last.y : 0),
        p: entry.prevP
      };
      // ======================================================================

      entry.result = null;
      if (Math.abs(current.x) > maxCoordinate || Math.abs(current.y) > maxCoordinate) {
        entry.rejected = true;
        entry.count = points.length;
        break;
      }
      if (!entry.last) {
        entry.anchors.push(peg(current, 0, true));
        entry.lockedCount = 1;
        entry.curve.push(sample(entry.anchors[0]));
      } else {
        const previous = entry.last;
        const dx = current.x - previous.x, dy = current.y - previous.y;
        const length = Math.hypot(dx, dy);
        if (!Number.isFinite(length) || !Number.isFinite(entry.total + length)) {
          entry.rejected = true;
          entry.count = points.length;
          break;
        }
        const first = entry.anchors[0];
        if (Math.hypot(current.x - first.sourceX, current.y - first.sourceY) > 1e-6) {
          entry.hasMovement = true;
        }
        if (length > 0) {
          const spacing = options.spacing;
          const expected = Math.floor((entry.carry + length + spacing * 1e-9) / spacing);
          const remaining = maxStrokeGuides - entry.anchors.length;
          if (expected > maxSegmentGuides || expected > remaining) {
            const guides = Math.max(0, Math.min(expected, maxSegmentGuides, remaining));
            const coarseSpacing = guides ? Math.max(spacing, length / guides) : spacing;
            for (let i = 1; i <= guides; i++) {
              const t = i / guides;
              const point = { x: mix(previous.x, current.x, t),
                y: mix(previous.y, current.y, t), p: mix(previous.p, current.p, t) };
              const node = peg(point, entry.total + length * t);
              node.sampleSpacing = coarseSpacing;
              entry.anchors.push(node);
              fit(entry.anchors, entry.lockedCount, options);
              freezePrefix(entry);
            }
            entry.carry = 0;
          } else {
            let crossing = spacing - entry.carry, inserted = 0;
            while (crossing <= length + spacing * 1e-9) {
              const t = Math.min(1, crossing / length);
              const point = { x: mix(previous.x, current.x, t),
                y: mix(previous.y, current.y, t), p: mix(previous.p, current.p, t) };
              entry.anchors.push(peg(point, entry.total + Math.min(length, crossing)));
              fit(entry.anchors, entry.lockedCount, options);
              freezePrefix(entry);
              crossing += spacing;
              inserted++;
            }
            entry.carry = clamp(entry.carry + length - inserted * spacing, 0, spacing);
          }
          entry.total += length;
        }
      }
      entry.last = current;
    }
    return entry;
  }

  function tailCopy(entry) {
    const nodes = entry.anchors.slice();
    for (let i = entry.lockedCount; i < nodes.length; i++) nodes[i] = { ...nodes[i] };
    const last = nodes[nodes.length - 1];
    if (!last) return nodes;
    if (Math.hypot(last.sourceX - entry.last.x, last.sourceY - entry.last.y) > 1e-8) {
      nodes.push(peg(entry.last, entry.total));
    } else if (!last.locked) {
      last.p = entry.last.p;
    }
    return nodes;
  }

  function centersFor(entry, nodes) {
    if (!nodes.length) return [];
    if (nodes.length === 1) return [sample(nodes[0])];
    const centers = entry.curve.map(point => [...point]);
    for (let i = entry.curveNext; i < nodes.length - 1; i++) {
      appendSpan(centers, nodes, i, entry.options.spacing);
    }
    appendSpan(centers, nodes, nodes.length - 1, entry.options.spacing, true);
    return centers;
  }

  function actualGeometry(entry) {
    if (entry.result) return entry.result;
    if (!entry.last || entry.rejected) {
      entry.displayAnchors = [];
      entry.result = { centers: [], hasMovement: false };
      return entry.result;
    }
    const nodes = tailCopy(entry);
    fit(nodes, entry.lockedCount, entry.options);
    entry.displayAnchors = nodes.slice(0, entry.anchors.length);
    entry.result = { centers: entry.hasMovement ? centersFor(entry, nodes)
      : [[entry.last.x, entry.last.y, entry.last.p]], hasMovement: entry.hasMovement };
    return entry.result;
  }

  function geometry(object, source = null) {
    const points = object.points || [];
    source = source || previewSources.get(points);
    if (!source || source.points === points) return actualGeometry(prepare(object));
    previewSources.set(points, source);
    const entry = prepare(source);
    if (!entry.last || entry.rejected || points.length <= source.points.length) return actualGeometry(entry);
    const forecast = measured(points[points.length - 1], entry.last);
    const length = Math.hypot(forecast.x - entry.last.x, forecast.y - entry.last.y);
    if (!Number.isFinite(length) || Math.abs(forecast.x) > maxCoordinate
        || Math.abs(forecast.y) > maxCoordinate || length < 1e-8) return actualGeometry(entry);
    const nodes = tailCopy(entry);
    const guides = clamp(Math.ceil(length / entry.options.spacing), 1, 3);
    for (let i = 1; i <= guides; i++) {
      const t = i / guides;
      nodes.push(peg({ x: mix(entry.last.x, forecast.x, t),
        y: mix(entry.last.y, forecast.y, t), p: mix(entry.last.p, forecast.p, t) },
      entry.total + length * t));
    }
    fit(nodes, entry.lockedCount, entry.options);
    return { centers: centersFor(entry, nodes), hasMovement: true };
  }

  function state(object) {
    const source = previewSources.get(object.points);
    if (source) return state(source);
    const entry = prepare(object);
    actualGeometry(entry);
    return {
      anchors: entry.displayAnchors.map(node => ({ x: node.x, y: node.y,
        sourceX: node.sourceX, sourceY: node.sourceY, s: node.s, locked: node.locked })),
      lockedCount: entry.rejected ? 0 : entry.lockedCount,
      spacing: entry.options.spacing,
    };
  }

  function invalidate(object) {
    if (!object.points) return;
    entries.delete(object.points);
    previewSources.delete(object.points);
  }

  return { geometry, state, invalidate };
})();
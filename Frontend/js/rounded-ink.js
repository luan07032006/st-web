"use strict";

// Fit completed handwriting; live acquisition retains its low-latency path.
window.RoundedInk = (() => {
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const pressure = point => Number.isFinite(point.p) ? point.p : 1;
  const mix = (a, b, t) => ({ x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t, p: pressure(a) + (pressure(b) - pressure(a)) * t });

  function resample(points, step, closed = false) {
    if (!points.length) return [];
    const result = [{ ...points[0], p: pressure(points[0]) }];
    let carried = 0;
    const count = points.length + (closed ? 1 : 0);
    for (let i = 1; i < count; i++) {
      let a = points[i - 1], b = points[i % points.length];
      let span = distance(a, b);
      while (span + carried >= step && span > 1e-8) {
        a = mix(a, b, (step - carried) / span);
        result.push(a);
        span = distance(a, b);
        carried = 0;
      }
      carried += span;
    }
    if (!closed) {
      const last = points.at(-1);
      if (distance(result.at(-1), last) > 1e-6) result.push({ ...last, p: pressure(last) });
      else result[result.length - 1] = { ...last, p: pressure(last) };
    } else if (result.length > 1 && distance(result[0], result.at(-1)) < step * 0.5) result.pop();
    return result;
  }

  // Fit a small cubic B-spline model to the whole stroke, with a second-
  // difference penalty on its controls. This removes curvature ripples rather
  // than interpolating every remaining wobble in the measured coordinates.
  function fitSpline(points, spacing, scale, closed, reference = points, penaltyScale = 1) {
    const lengths = [0];
    for (let i = 1; i < reference.length; i++) lengths.push(lengths.at(-1) + distance(reference[i - 1], reference[i]));
    const total = lengths.at(-1) + (closed ? distance(reference.at(-1), reference[0]) : 0);
    const count = clamp(Math.ceil(total / spacing) + (closed ? 0 : 3), closed ? 8 : 6, 96);
    const knots = closed ? null : Array.from({ length: count + 4 }, (_, i) =>
      i <= 3 ? 0 : i >= count ? 1 : (i - 3) / (count - 3));
    const basisAt = t => {
      if (closed) {
        const position = (t % 1) * count, segment = Math.floor(position), u = position - segment;
        const weights = [(1-u)**3/6,(3*u**3-6*u*u+4)/6,(-3*u**3+3*u*u+3*u+1)/6,u**3/6];
        return weights.map((weight, i) => ({ index: (segment + i - 1 + count) % count, weight }));
      }
      if (t >= 1) return [{ index: count - 1, weight: 1 }];
      let span = 3;
      while (span < count - 1 && t >= knots[span + 1]) span++;
      const values = [1, 0, 0, 0], left = [], right = [];
      for (let j = 1; j <= 3; j++) {
        left[j] = t - knots[span + 1 - j]; right[j] = knots[span + j] - t;
        let saved = 0;
        for (let r = 0; r < j; r++) {
          const value = values[r] / (right[r + 1] + left[j - r] || 1);
          values[r] = saved + right[r + 1] * value; saved = left[j - r] * value;
        }
        values[j] = saved;
      }
      return values.map((weight, i) => ({ index: span - 3 + i, weight }));
    };
    const matrix = Array.from({ length: count }, () => new Float64Array(count));
    const rhs = Array.from({ length: 3 }, () => new Float64Array(count));
    points.forEach((point, i) => {
      const basis = basisAt(lengths[i] / total), values = [point.x, point.y, pressure(point)];
      for (const a of basis) {
        for (let axis = 0; axis < 3; axis++) rhs[axis][a.index] += a.weight * values[axis];
        for (const b of basis) matrix[a.index][b.index] += a.weight * b.weight;
      }
    });
    const penalty = points.length / count * 0.045 * penaltyScale;
    const differences = [1, -2, 1];
    for (let i = 0; i < (closed ? count : count - 2); i++) {
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
        matrix[(i+a)%count][(i+b)%count] += penalty * differences[a] * differences[b];
      }
    }
    if (!closed) {
      // Eliminate endpoint controls to keep the exact down/up coordinates.
      for (const [index, point] of [[0, points[0]], [count - 1, points.at(-1)]]) {
        const values = [point.x, point.y, pressure(point)];
        for (let i = 0; i < count; i++) {
          if (i === index) continue;
          for (let axis = 0; axis < 3; axis++) rhs[axis][i] -= matrix[i][index] * values[axis];
          matrix[i][index] = 0; matrix[index][i] = 0;
        }
        matrix[index][index] = 1;
        for (let axis = 0; axis < 3; axis++) rhs[axis][index] = values[axis];
      }
    }
    // The regularized normal matrix is positive definite and small (<=96).
    for (let i = 0; i < count; i++) for (let j = 0; j <= i; j++) {
      let value = matrix[i][j];
      for (let k = 0; k < j; k++) value -= matrix[i][k] * matrix[j][k];
      matrix[i][j] = i === j ? Math.sqrt(Math.max(value, 1e-10)) : value / matrix[j][j];
    }
    const solve = values => {
      const solution = new Float64Array(count);
      for (let i = 0; i < count; i++) {
        let value = values[i];
        for (let j = 0; j < i; j++) value -= matrix[i][j] * solution[j];
        solution[i] = value / matrix[i][i];
      }
      for (let i = count - 1; i >= 0; i--) {
        let value = solution[i];
        for (let j = i + 1; j < count; j++) value -= matrix[j][i] * solution[j];
        solution[i] = value / matrix[i][i];
      }
      return solution;
    };
    const coefficients = rhs.map(solve);
    // Keep the writer's own proportions. These are constraints in the spline
    // solve, not per-point clamps, so the resulting curve remains C2 smooth.
    for (let axis = 0; axis < 2; axis++) {
      const key = axis ? "y" : "x";
      let minimum = 0, maximum = 0;
      for (let i = 1; i < reference.length; i++) {
        if (reference[i][key] < reference[minimum][key]) minimum = i;
        if (reference[i][key] > reference[maximum][key]) maximum = i;
      }
      const indices = [...new Set([...(closed ? [0] : []), minimum, maximum])];
      const constraints = [];
      for (const index of indices) {
        const basis = new Float64Array(count);
        for (const q of basisAt(lengths[index] / total)) basis[q.index] = q.weight;
        const free = basis.slice();
        if (!closed) { free[0] = 0; free[count - 1] = 0; }
        if (free.every(value => Math.abs(value) < 1e-10)) continue;
        const inverse = solve(free);
        let actual = 0;
        for (let i = 0; i < count; i++) actual += basis[i] * coefficients[axis][i];
        constraints.push({ free, inverse, residual: reference[index][key] - actual });
      }
      // Schur complement: impose the small set of equality constraints while
      // retaining the globally smooth minimum of the original fit objective.
      const m = constraints.length;
      const schur = constraints.map(a => constraints.map(b =>
        a.free.reduce((sum, value, i) => sum + value * b.inverse[i], 0)));
      const multipliers = constraints.map(c => c.residual);
      for (let i = 0; i < m; i++) {
        const diagonal = schur[i][i];
        if (Math.abs(diagonal) < 1e-10) continue;
        for (let j = i + 1; j < m; j++) {
          const amount = schur[j][i] / diagonal;
          for (let k = i; k < m; k++) schur[j][k] -= amount * schur[i][k];
          multipliers[j] -= amount * multipliers[i];
        }
      }
      for (let i = m - 1; i >= 0; i--) {
        let value = multipliers[i];
        for (let j = i + 1; j < m; j++) value -= schur[i][j] * multipliers[j];
        multipliers[i] = Math.abs(schur[i][i]) < 1e-10 ? 0 : value / schur[i][i];
      }
      for (let j = 0; j < m; j++) for (let i = 0; i < count; i++) {
        coefficients[axis][i] += multipliers[j] * constraints[j].inverse[i];
      }
    }
    const evaluate = t => {
      const values = [0, 0, 0];
      for (const { index, weight } of basisAt(t)) {
        for (let axis = 0; axis < 3; axis++) values[axis] += weight * coefficients[axis][index];
      }
      return { x: values[0], y: values[1], p: clamp(values[2], .9, 1.1) };
    };
    const samples = clamp(Math.ceil(total * scale / 0.35), 24, 4096);
    const result = Array.from({ length: samples + 1 }, (_, i) => evaluate(i / samples));
    if (closed) {
      result[0] = { ...result[0], x: reference[0].x, y: reference[0].y };
      result[result.length - 1] = { ...result[0] };
    }
    else {
      result[0] = { ...result[0], x: points[0].x, y: points[0].y };
      result[result.length - 1] = { ...result.at(-1), x: points.at(-1).x, y: points.at(-1).y };
    }
    let error = 0;
    reference.forEach((point, i) => { error = Math.max(error, distance(evaluate(lengths[i] / total), point)); });
    return { points: result, error };
  }

  function smooth(points, { scale = 1, highlight = false, closed = false } = {}) {
    if (points.length < 3) return points.map(point => ({ ...point }));
    scale = clamp(Number.isFinite(scale) ? scale : 1, 0.1, 4);
    const source = points.filter((point, i) => !i || distance(point, points[i - 1]) > 1e-6);
    if (closed && source.length > 2 && distance(source[0], source.at(-1)) < 1e-5) source.pop();
    if (source.length < 3) return source;
    let total = closed ? distance(source.at(-1), source[0]) : 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    source.forEach((point, i) => {
      if (i) total += distance(source[i - 1], point);
      minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
    });
    // Preserve dots and short diacritics rather than rounding them away.
    if (total * scale < 5) return source;
    const w = maxX - minX, h = maxY - minY;
    const size = Math.max(1 / scale, Math.min(w || h, h || w));
    const sigma = Math.min(clamp(size * 0.13, 2.5 / scale, 7 / scale), size * 0.17, total * 0.065);
    const step = Math.max(0.5 / scale, total / 2048);
    const sampled = resample(source, step, closed);
    if (sampled.length < 3 || sigma < 1e-5) return source;
    const radius = Math.min(64, Math.ceil(sigma * 3 / step));
    const weights = Array.from({ length: radius * 2 + 1 }, (_, i) => Math.exp(-0.5 * ((i - radius) * step / sigma) ** 2));
    const sum = weights.reduce((a, b) => a + b, 0);
    const at = index => {
      const n = sampled.length;
      if (closed) return sampled[(index % n + n) % n];
      // Reflect around the endpoints. Unlike endpoint clamping this preserves
      // the incoming/outgoing tangent and doesn't pull a stem into a hook.
      if (index < 0) {
        const a = sampled[0], b = sampled[Math.min(n - 1, -index)];
        return { x: 2 * a.x - b.x, y: 2 * a.y - b.y, p: pressure(a) };
      }
      if (index >= n) {
        const a = sampled[n - 1], b = sampled[Math.max(0, 2 * n - index - 2)];
        return { x: 2 * a.x - b.x, y: 2 * a.y - b.y, p: pressure(a) };
      }
      return sampled[index];
    };
    let filtered = sampled.map((point, i) => {
      let x = 0, y = 0, p = 0;
      for (let j = -radius; j <= radius; j++) {
        const q = at(i + j), weight = weights[j + radius] / sum;
        x += q.x * weight; y += q.y * weight; p += pressure(q) * weight;
      }
      return { x, y, p: highlight ? 1 : clamp(1 + (p - 1) * 0.15, 0.9, 1.1) };
    });
    // A second Gaussian pass estimates the low-frequency shrinkage of loops.
    // Compensate that bias without restoring high-frequency hand tremor.
    const firstPass = filtered;
    filtered = firstPass.map((point, i) => {
      let x = 0, y = 0;
      for (let j = -radius; j <= radius; j++) {
        let index = i + j;
        if (closed) index = (index % firstPass.length + firstPass.length) % firstPass.length;
        else index = clamp(index, 0, firstPass.length - 1);
        const q = firstPass[index], weight = weights[j + radius] / sum;
        x += q.x * weight; y += q.y * weight;
      }
      return { ...point, x: 2 * point.x - x, y: 2 * point.y - y };
    });
    if (!closed) {
      filtered[0] = { ...filtered[0], x: source[0].x, y: source[0].y };
      filtered[filtered.length - 1] = { ...filtered.at(-1), x: source.at(-1).x, y: source.at(-1).y };
    }
    const spacing = Math.min(clamp(size * .26, 5 / scale, 13 / scale), size * .4);
    const tolerance = Math.min(2 / scale, Math.max(.6 / scale, size * .045));
    let best = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const target = filtered.map((point, i) => ({ ...mix(point, sampled[i], attempt * .2), p: point.p }));
      const fitted = fitSpline(target, Math.max(spacing * .7 ** attempt, 1 / scale),
        scale, closed, sampled, .6 ** attempt);
      if (!best || fitted.error < best.error) best = fitted;
      if (fitted.error <= tolerance) break;
    }
    return best.points;
  }

  return { smooth, resample };
})();

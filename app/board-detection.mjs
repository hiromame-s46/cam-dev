const DEFAULT_CORNERS = [
  { x: 0.06, y: 0.08 },
  { x: 0.94, y: 0.08 },
  { x: 0.94, y: 0.92 },
  { x: 0.06, y: 0.92 },
];

const clamp = (value, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

function percentile(sorted, ratio) {
  if (!sorted.length) return 0;
  const index = clamp(ratio) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function dilate(mask, width, height, radius) {
  const output = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let found = false;
      for (let oy = -radius; oy <= radius && !found; oy += 1) {
        const py = y + oy;
        if (py < 0 || py >= height) continue;
        for (let ox = -radius; ox <= radius; ox += 1) {
          const px = x + ox;
          if (px >= 0 && px < width && mask[py * width + px]) {
            found = true;
            break;
          }
        }
      }
      if (found) output[y * width + x] = 1;
    }
  }
  return output;
}

function erode(mask, width, height, radius) {
  const output = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let complete = true;
      for (let oy = -radius; oy <= radius && complete; oy += 1) {
        const py = y + oy;
        if (py < 0 || py >= height) {
          complete = false;
          break;
        }
        for (let ox = -radius; ox <= radius; ox += 1) {
          const px = x + ox;
          if (px < 0 || px >= width || !mask[py * width + px]) {
            complete = false;
            break;
          }
        }
      }
      if (complete) output[y * width + x] = 1;
    }
  }
  return output;
}

function collectComponents(mask, width, height) {
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const components = [];
  const offsets = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1],
  ];

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    const pixels = [];
    queue[tail++] = start;
    visited[start] = 1;

    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      pixels.push(index);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);

      for (const [ox, oy] of offsets) {
        const px = x + ox;
        const py = y + oy;
        if (px < 0 || px >= width || py < 0 || py >= height) continue;
        const next = py * width + px;
        if (mask[next] && !visited[next]) {
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
    }

    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    const boxArea = boxWidth * boxHeight;
    const areaRatio = boxArea / (width * height);
    if (areaRatio < 0.045 || pixels.length < width * height * 0.025) continue;
    const fill = pixels.length / boxArea;
    const aspect = boxWidth / boxHeight;
    const aspectScore = Math.exp(-Math.abs(Math.log(Math.max(0.2, aspect) / 1.75)) * 0.72);
    const centerX = (minX + maxX) / 2 / width;
    const centerY = (minY + maxY) / 2 / height;
    const centerScore = 1 - clamp(Math.hypot(centerX - 0.5, centerY - 0.5) / 0.72);
    const score = areaRatio * (0.58 + fill * 0.22 + aspectScore * 0.14 + centerScore * 0.06);

    components.push({
      pixels,
      minX,
      maxX,
      minY,
      maxY,
      boxWidth,
      boxHeight,
      areaRatio,
      fill,
      aspectScore,
      centerScore,
      score,
    });
  }

  return components.sort((a, b) => b.score - a.score).slice(0, 6);
}

function regress(points) {
  if (points.length < 2) return null;
  let candidates = points;
  if (points.length >= 8) {
    const ordered = [...points].sort((a, b) => a.independent - b.independent);
    const range = ordered.at(-1).independent - ordered[0].independent;
    const step = Math.max(1, Math.floor(ordered.length / 28));
    const inlierDistance = Math.max(2, range * 0.012);
    let bestInliers = [];
    let bestScore = -Infinity;
    for (let first = 0; first < ordered.length; first += step) {
      for (let second = first + step; second < ordered.length; second += step) {
        const dx = ordered[second].independent - ordered[first].independent;
        if (dx < range * 0.24) continue;
        const candidateSlope = (ordered[second].dependent - ordered[first].dependent) / dx;
        const candidateIntercept = ordered[first].dependent - candidateSlope * ordered[first].independent;
        const inliers = points.filter(
          (point) =>
            Math.abs(point.dependent - (candidateSlope * point.independent + candidateIntercept)) <=
            inlierDistance,
        );
        const residual = inliers.reduce(
          (sum, point) =>
            sum + Math.abs(point.dependent - (candidateSlope * point.independent + candidateIntercept)),
          0,
        ) / Math.max(1, inliers.length);
        const score = inliers.length - residual * 0.16;
        if (score > bestScore) {
          bestScore = score;
          bestInliers = inliers;
        }
      }
    }
    if (bestInliers.length >= Math.max(6, points.length * 0.32)) candidates = bestInliers;
  }
  let slope = 0;
  let intercept = 0;
  let meanResidual = Infinity;

  for (let iteration = 0; iteration < 4; iteration += 1) {
    let sumX = 0;
    let sumY = 0;
    let sumXX = 0;
    let sumXY = 0;
    for (const point of candidates) {
      sumX += point.independent;
      sumY += point.dependent;
      sumXX += point.independent * point.independent;
      sumXY += point.independent * point.dependent;
    }
    const denominator = candidates.length * sumXX - sumX * sumX;
    if (Math.abs(denominator) < 0.00001) return null;
    slope = (candidates.length * sumXY - sumX * sumY) / denominator;
    intercept = (sumY - slope * sumX) / candidates.length;
    const residuals = candidates
      .map((point) => Math.abs(point.dependent - (slope * point.independent + intercept)))
      .sort((a, b) => a - b);
    meanResidual = residuals.reduce((sum, value) => sum + value, 0) / residuals.length;
    const cutoff = Math.max(1.6, percentile(residuals, 0.72) * 1.65);
    const filtered = candidates.filter(
      (point) => Math.abs(point.dependent - (slope * point.independent + intercept)) <= cutoff,
    );
    if (filtered.length < Math.max(5, points.length * 0.28) || filtered.length === candidates.length) break;
    candidates = filtered;
  }

  return { slope, intercept, residual: meanResidual, samples: candidates.length };
}

function intersect(vertical, horizontal) {
  if (!vertical || !horizontal) return null;
  // vertical: x = a*y+b, horizontal: y = c*x+d
  const denominator = 1 - vertical.slope * horizontal.slope;
  if (Math.abs(denominator) < 0.05) return null;
  const x = (vertical.slope * horizontal.intercept + vertical.intercept) / denominator;
  return { x, y: horizontal.slope * x + horizontal.intercept };
}

function polygonArea(points) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    area += points[index].x * next.y - next.x * points[index].y;
  }
  return Math.abs(area) / 2;
}

function fallbackCorners(component, width, height) {
  const extremes = {
    topLeft: { value: Infinity, x: component.minX, y: component.minY },
    topRight: { value: -Infinity, x: component.maxX, y: component.minY },
    bottomRight: { value: -Infinity, x: component.maxX, y: component.maxY },
    bottomLeft: { value: Infinity, x: component.minX, y: component.maxY },
  };
  for (const index of component.pixels) {
    const x = index % width;
    const y = Math.floor(index / width);
    const sum = x + y;
    const diff = x - y;
    if (sum < extremes.topLeft.value) extremes.topLeft = { value: sum, x, y };
    if (diff > extremes.topRight.value) extremes.topRight = { value: diff, x, y };
    if (sum > extremes.bottomRight.value) extremes.bottomRight = { value: sum, x, y };
    if (diff < extremes.bottomLeft.value) extremes.bottomLeft = { value: diff, x, y };
  }
  return [extremes.topLeft, extremes.topRight, extremes.bottomRight, extremes.bottomLeft]
    .map(({ x, y }) => ({ x: x / width, y: y / height }));
}

function fitQuadrilateral(component, width, height) {
  const rows = new Map();
  const columns = new Map();
  for (const index of component.pixels) {
    const x = index % width;
    const y = Math.floor(index / width);
    if (!rows.has(y)) rows.set(y, []);
    if (!columns.has(x)) columns.set(x, []);
    rows.get(y).push(x);
    columns.get(x).push(y);
  }

  const leftPoints = [];
  const rightPoints = [];
  const topPoints = [];
  const bottomPoints = [];
  const minimumRowPixels = Math.max(5, Math.round(component.boxWidth * 0.1));
  const minimumColumnPixels = Math.max(5, Math.round(component.boxHeight * 0.1));

  for (const [y, values] of rows) {
    if (values.length < minimumRowPixels) continue;
    values.sort((a, b) => a - b);
    leftPoints.push({ independent: y, dependent: percentile(values, 0.025) });
    rightPoints.push({ independent: y, dependent: percentile(values, 0.975) });
  }
  for (const [x, values] of columns) {
    if (values.length < minimumColumnPixels) continue;
    values.sort((a, b) => a - b);
    topPoints.push({ independent: x, dependent: percentile(values, 0.025) });
    bottomPoints.push({ independent: x, dependent: percentile(values, 0.975) });
  }

  const lines = {
    left: regress(leftPoints),
    right: regress(rightPoints),
    top: regress(topPoints),
    bottom: regress(bottomPoints),
  };
  const pixelCorners = [
    intersect(lines.left, lines.top),
    intersect(lines.right, lines.top),
    intersect(lines.right, lines.bottom),
    intersect(lines.left, lines.bottom),
  ];

  let corners;
  if (pixelCorners.every(Boolean)) {
    corners = pixelCorners.map((point) => ({ x: point.x / width, y: point.y / height }));
  } else {
    corners = fallbackCorners(component, width, height);
  }

  const center = corners.reduce(
    (sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }),
    { x: 0, y: 0 },
  );
  corners = corners.map((point) => ({
    x: clamp(center.x + (point.x - center.x) * 1.018, 0.005, 0.995),
    y: clamp(center.y + (point.y - center.y) * 1.018, 0.005, 0.995),
  }));

  const area = polygonArea(corners);
  const ordered =
    (corners[0].y + corners[1].y) / 2 < (corners[2].y + corners[3].y) / 2 &&
    (corners[0].x + corners[3].x) / 2 < (corners[1].x + corners[2].x) / 2;
  const residuals = Object.values(lines)
    .filter(Boolean)
    .map((line) => line.residual);
  const residual = residuals.length
    ? residuals.reduce((sum, value) => sum + value, 0) / residuals.length
    : 8;

  if (!ordered || area < 0.045 || area > 0.99) {
    corners = fallbackCorners(component, width, height);
  }

  return { corners, area: polygonArea(corners), residual };
}

/**
 * Detect a dark green or black classroom board from RGBA pixels.
 * @param {Uint8ClampedArray | Uint8Array} data
 * @param {number} width
 * @param {number} height
 */
export function detectBoardFromImageData(data, width, height) {
  if (!data || width < 12 || height < 12 || data.length < width * height * 4) {
    return { corners: DEFAULT_CORNERS.map((point) => ({ ...point })), confident: false, score: 0 };
  }

  const luminances = [];
  for (let index = 0; index < width * height; index += 3) {
    const offset = index * 4;
    luminances.push(data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114);
  }
  luminances.sort((a, b) => a - b);
  const low = percentile(luminances, 0.12);
  const high = percentile(luminances, 0.88);
  const spread = Math.max(34, high - low);
  const mask = new Uint8Array(width * height);

  for (let index = 0; index < mask.length; index += 1) {
    const offset = index * 4;
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    const luminance = r * 0.299 + g * 0.587 + b * 0.114;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    const greenDominance = g - (r + b) / 2;
    const darkness = clamp((high + spread * 0.08 - luminance) / (spread * 0.92));
    const neutralAffinity = clamp(1 - chroma / 72);
    const greenAffinity = clamp((greenDominance + 8) / 42);
    const colorAffinity = Math.max(neutralAffinity * 0.9, greenAffinity);
    const score = darkness * 0.72 + colorAffinity * 0.28;
    const veryDark = luminance < Math.min(82, high * 0.58);
    if (
      luminance > 6 &&
      ((score > 0.48 && luminance < high + 12) || (veryDark && colorAffinity > 0.26))
    ) {
      mask[index] = 1;
    }
  }

  const closed = erode(dilate(mask, width, height, 2), width, height, 2);
  const components = collectComponents(closed, width, height);
  if (!components.length) {
    return { corners: DEFAULT_CORNERS.map((point) => ({ ...point })), confident: false, score: 0 };
  }

  let best = null;
  for (const component of components) {
    const shape = fitQuadrilateral(component, width, height);
    const edgeScore = clamp(1 - shape.residual / Math.max(5, Math.min(width, height) * 0.035));
    const areaScore = clamp(shape.area / 0.3);
    const confidence =
      areaScore * 0.31 +
      component.fill * 0.24 +
      component.aspectScore * 0.18 +
      component.centerScore * 0.11 +
      edgeScore * 0.16;
    const rank = component.score * (0.72 + confidence * 0.28);
    if (!best || rank > best.rank) best = { ...shape, component, confidence, rank };
  }

  const confident =
    best.confidence >= 0.54 &&
    best.area >= 0.075 &&
    best.component.fill >= 0.2;
  return {
    corners: best.corners,
    confident,
    score: Number(best.confidence.toFixed(3)),
  };
}

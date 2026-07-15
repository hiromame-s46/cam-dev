import assert from "node:assert/strict";
import test from "node:test";
import { detectBoardFromImageData } from "../app/board-detection.mjs";

function insideConvex(point, polygon) {
  let sign = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    const cross =
      (end.x - start.x) * (point.y - start.y) -
      (end.y - start.y) * (point.x - start.x);
    if (Math.abs(cross) < 0.001) continue;
    const current = Math.sign(cross);
    if (sign && current !== sign) return false;
    sign = current;
  }
  return true;
}

function syntheticBoard({
  width = 420,
  height = 280,
  corners,
  board = [35, 76, 63],
  glare = true,
  distractor = true,
}) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const polygon = corners.map(({ x, y }) => ({ x: x * width, y: y * height }));

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const onBoard = insideConvex({ x, y }, polygon);
      if (onBoard) {
        const lighting = (x / width) * 24 - (y / height) * 7;
        const reflection = glare && Math.abs(x - width * 0.64) < width * 0.055
          ? 48 * (1 - Math.abs(x - width * 0.64) / (width * 0.055))
          : 0;
        pixels[offset] = board[0] + lighting + reflection;
        pixels[offset + 1] = board[1] + lighting + reflection;
        pixels[offset + 2] = board[2] + lighting + reflection;

        const chalkLine =
          (Math.abs(y - height * 0.35) < 3 && x > width * 0.25 && x < width * 0.72) ||
          (Math.abs(y - height * 0.52) < 3 && x > width * 0.22 && x < width * 0.78) ||
          (Math.abs(y - height * 0.69) < 3 && x > width * 0.29 && x < width * 0.68);
        if (chalkLine) {
          pixels[offset] = 225;
          pixels[offset + 1] = 222;
          pixels[offset + 2] = 204;
        }
      } else {
        const wallLight = 212 + Math.round((x / width) * 22 - (y / height) * 13);
        pixels[offset] = wallLight;
        pixels[offset + 1] = wallLight - 5;
        pixels[offset + 2] = wallLight - 16;
      }
      pixels[offset + 3] = 255;
    }
  }

  if (distractor) {
    for (let y = Math.round(height * 0.55); y < height * 0.94; y += 1) {
      for (let x = 0; x < width * 0.12; x += 1) {
        const offset = (y * width + x) * 4;
        pixels[offset] = 24;
        pixels[offset + 1] = 29;
        pixels[offset + 2] = 31;
      }
    }
  }

  return pixels;
}

function assertCornersClose(actual, expected, tolerance = 0.09) {
  assert.equal(actual.length, 4);
  actual.forEach((point, index) => {
    const distance = Math.hypot(point.x - expected[index].x, point.y - expected[index].y);
    assert.ok(
      distance <= tolerance,
      `corner ${index} should be near ${JSON.stringify(expected[index])}, got ${JSON.stringify(point)} (${distance.toFixed(3)})`,
    );
  });
}

test("detects a green board through perspective, chalk gaps, glare, and a dark distractor", () => {
  const corners = [
    { x: 0.16, y: 0.13 },
    { x: 0.91, y: 0.08 },
    { x: 0.94, y: 0.88 },
    { x: 0.11, y: 0.91 },
  ];
  const pixels = syntheticBoard({ corners });
  const result = detectBoardFromImageData(pixels, 420, 280);

  assert.equal(result.confident, true);
  assert.ok(result.score >= 0.54);
  assertCornersClose(result.corners, corners);
});

test("detects a neutral blackboard under uneven classroom lighting", () => {
  const corners = [
    { x: 0.08, y: 0.19 },
    { x: 0.86, y: 0.1 },
    { x: 0.92, y: 0.82 },
    { x: 0.14, y: 0.9 },
  ];
  const pixels = syntheticBoard({
    width: 360,
    height: 300,
    corners,
    board: [43, 46, 47],
    glare: true,
    distractor: false,
  });
  const result = detectBoardFromImageData(pixels, 360, 300);

  assert.equal(result.confident, true);
  assertCornersClose(result.corners, corners, 0.1);
});

test("does not claim a bright page is a blackboard", () => {
  const width = 320;
  const height = 220;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    pixels[index * 4] = 235;
    pixels[index * 4 + 1] = 232;
    pixels[index * 4 + 2] = 220;
    pixels[index * 4 + 3] = 255;
  }
  const result = detectBoardFromImageData(pixels, width, height);
  assert.equal(result.confident, false);
});
